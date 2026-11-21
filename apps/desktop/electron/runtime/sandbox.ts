import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { executionLimits, workspaceFilename } from '@aria/shared';
import { RuntimeError, digest } from './store';

export const sandboxImage =
  'docker.io/library/python@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89';
const workspaceLabel = 'com.aria.workspace';
const desktopLabel = 'com.aria.virtual-desktop';
const user = '10001:10001';
const sandboxPath = '/workspace';
const executable = '/usr/local/bin/python3';
const controlTimeout = 8_000;

type ProcessResult = {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  truncated: boolean;
  aborted: boolean;
};

function localEndpoint(value: string) {
  if (process.platform === 'win32') return /^npipe:\/\/\/\/\.\/pipe\/[a-zA-Z0-9_-]+$/.test(value);
  return value.startsWith('unix:///') && path.isAbsolute(value.slice(7)) && !/[\r\n\0]/.test(value);
}

function dockerExecutable() {
  const locations =
    process.platform === 'win32'
      ? [
          path.join(
            process.env.ProgramFiles ?? 'C:\\Program Files',
            'Docker',
            'Docker',
            'resources',
            'bin',
            'docker.exe',
          ),
        ]
      : [
          '/usr/local/bin/docker',
          '/opt/homebrew/bin/docker',
          '/usr/bin/docker',
          '/Applications/Docker.app/Contents/Resources/bin/docker',
        ];
  const found = locations.find((location) => existsSync(location));
  if (!found)
    throw new RuntimeError(
      'CAPABILITY_UNAVAILABLE',
      'Install Docker and configure its local engine socket in Tools settings.',
    );
  return found;
}

function dockerEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'].includes(key.toUpperCase()),
    ),
  );
}

function execute(
  binary: string,
  args: string[],
  signal: AbortSignal,
  limit: number,
  input?: Buffer,
) {
  signal.throwIfAborted();
  return new Promise<ProcessResult>((resolve, reject) => {
    // A fixed Docker invocation controls the sandbox. User shell code is only an argument to docker exec.
    const env = dockerEnvironment();
    const child = spawn(binary, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let remaining = limit;
    let truncated = false;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    function append(destination: Buffer[], bytes: Buffer) {
      if (remaining > 0) destination.push(bytes.subarray(0, remaining));
      if (remaining < bytes.length) truncated = true;
      remaining = Math.max(0, remaining - bytes.length);
    }
    child.stdout.on('data', (bytes: Buffer) => append(stdout, bytes));
    child.stderr.on('data', (bytes: Buffer) => append(stderr, bytes));
    child.stdin.on('error', () => undefined);
    const abort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        truncated,
        aborted: signal.aborted,
      });
    });
    child.stdin.end(input);
  });
}

const stopProcesses = `
import os, signal, time
for _ in range(10):
    found = []
    for pid in os.listdir('/proc'):
        if not pid.isdecimal():
            continue
        try:
            if os.stat('/proc/' + pid).st_uid == 10001:
                found.append(int(pid))
        except FileNotFoundError:
            pass
    if not found:
        break
    for pid in found:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    time.sleep(0.025)
else:
    raise SystemExit(1)
`;

const stageBytes = `
import os, shutil, sys
folder, name = sys.argv[1:]
directory = os.open(folder, os.O_DIRECTORY | os.O_NOFOLLOW)
fd = os.open(name, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o444, dir_fd=directory)
with os.fdopen(fd, 'wb') as target:
    shutil.copyfileobj(sys.stdin.buffer, target)
`;

const readOutput = `
import os, stat, sys
directory = os.open('/workspace/outputs', os.O_DIRECTORY | os.O_NOFOLLOW)
fd = os.open(sys.argv[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
info = os.fstat(fd)
if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= int(sys.argv[2]):
    raise SystemExit(1)
with os.fdopen(fd, 'rb') as handle:
    sys.stdout.buffer.write(handle.read(int(sys.argv[2]) + 1))
`;

export class DockerSandbox {
  private verified?: { at: number; binary: string; os: string; architecture: string };

  constructor(readonly endpoint: string) {}

  private invoke(args: string[], signal: AbortSignal, limit = 16_000, input?: Buffer) {
    if (!localEndpoint(this.endpoint))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Configure a local Docker Unix socket or named pipe in Settings → Tools.',
      );
    return execute(
      this.verified?.binary ?? dockerExecutable(),
      ['--host', this.endpoint, ...args],
      signal,
      limit,
      input,
    );
  }

  private async verifyEngine(signal: AbortSignal) {
    const result = await this.invoke(['info', '--format', '{{json .}}'], signal, 200_000);
    if (result.code !== 0 || result.truncated)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The configured Docker endpoint did not respond. Start Docker and check its socket.',
      );
    const info = JSON.parse(result.stdout.toString('utf8'));
    const security = Array.isArray(info.SecurityOptions) ? info.SecurityOptions.join(' ') : '';
    const trustedEngine =
      process.platform === 'linux'
        ? security.includes('name=rootless')
        : info.OperatingSystem === 'Docker Desktop';
    if (
      !trustedEngine ||
      info.OSType !== 'linux' ||
      info.CgroupVersion !== '2' ||
      !info.MemoryLimit ||
      !info.SwapLimit ||
      !info.CpuCfsQuota ||
      !info.PidsLimit ||
      !security.includes('name=seccomp')
    ) {
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Aria requires Docker Desktop Linux containers or rootless Linux Docker with cgroup and seccomp limits.',
      );
    }
    return {
      binary: dockerExecutable(),
      at: Date.now(),
      os: info.OSType as string,
      architecture: info.Architecture as string,
    };
  }

  async probe(signal: AbortSignal) {
    if (this.verified && Date.now() - this.verified.at < 30_000) return this.verified;
    const engine = await this.verifyEngine(signal);
    const image = await this.invoke(
      ['image', 'inspect', sandboxImage, '--format', '{{.Id}}'],
      signal,
    );
    if (image.code !== 0)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        `Install the pinned workspace image using docker pull ${sandboxImage}.`,
      );
    this.verified = engine;
    return this.verified;
  }

  async create(id: string, profile: string, signal: AbortSignal) {
    await this.probe(signal);
    const thumb = (name: string, size: string, writable = false) =>
      `${sandboxPath}/${name}:rw,nosuid,nodev,noexec,size=${size},mode=${writable ? '0700,uid=10001,gid=10001' : '0755'}`;
    const result = await this.invoke(
      [
        'run',
        '--detach',
        '--rm',
        '--pull=never',
        '--name',
        `aria-${id}`,
        '--label',
        `${workspaceLabel}=${profile}`,
        '--network=none',
        '--ipc=none',
        '--init',
        '--read-only',
        '--cap-drop=ALL',
        '--cap-add=KILL',
        '--security-opt=no-new-privileges',
        '--memory=512m',
        '--memory-swap=512m',
        '--cpus=1',
        '--pids-limit=64',
        '--ulimit=nofile=256:256',
        '--log-driver=none',
        '--tmpfs',
        thumb('inputs', '40m'),
        '--tmpfs',
        thumb('skills', '16m'),
        '--tmpfs',
        thumb('working', '64m', true),
        '--tmpfs',
        thumb('outputs', '64m', true),
        '--tmpfs',
        thumb('temporary', '32m', true),
        '--entrypoint',
        '/bin/sleep',
        sandboxImage,
        '2700',
      ],
      signal,
    );
    if (result.code !== 0)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Docker could not start the isolated workspace.',
      );
    const probe = await this.run(
      id,
      [
        '/bin/sh',
        '-c',
        'test "$(id -u)" = 10001 && grep -q "^CapEff:.*0000000000000000$" /proc/self/status && test ! -w /workspace/inputs && test -w /workspace/working && python3 --version',
      ],
      signal,
      5000,
    );
    if (probe.code !== 0 || probe.aborted) {
      await this.remove(id);
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The workspace failed its isolation or runtime check.',
      );
    }
    return {
      runtimes: ['/bin/sh', probe.stdout.toString('utf8').trim()],
      architecture: this.verified?.architecture,
    };
  }

  async createDesktop(id: string, profile: string, image: string, signal: AbortSignal) {
    await this.verifyEngine(signal);
    if (!/^sha256:[a-f0-9]{64}$/.test(image))
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'Select the immutable image ID of the Aria graphical desktop.',
      );
    const metadata = await this.invoke(
      ['image', 'inspect', image, '--format', '{{json .Config.Labels}}'],
      signal,
    );
    if (
      metadata.code !== 0 ||
      JSON.parse(metadata.stdout.toString())?.['com.aria.desktop.protocol'] !== '1'
    )
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Build the reviewed Aria virtual desktop image and enter its immutable image ID.',
      );
    const result = await this.invoke(
      [
        'run',
        '--detach',
        '--rm',
        '--pull=never',
        '--name',
        `aria-${id}`,
        '--label',
        `${desktopLabel}=${profile}`,
        '--network=none',
        '--ipc=none',
        '--init',
        '--read-only',
        '--user',
        user,
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--memory=2g',
        '--memory-swap=2g',
        '--cpus=2',
        '--pids-limit=128',
        '--ulimit=nofile=512:512',
        '--log-driver=none',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,noexec,size=128m,mode=1777',
        '--tmpfs',
        '/workspace/inputs:rw,nosuid,nodev,noexec,size=40m,mode=0755',
        '--tmpfs',
        '/workspace/working:rw,nosuid,nodev,noexec,size=128m,mode=0700,uid=10001,gid=10001',
        '--tmpfs',
        '/workspace/outputs:rw,nosuid,nodev,noexec,size=64m,mode=0700,uid=10001,gid=10001',
        image,
      ],
      signal,
    );
    try {
      if (result.code !== 0 || !(await this.ownsDesktop(id, profile, image, signal)))
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'The virtual desktop did not start with its required isolation profile.',
        );
      const probe = await this.desktopCommand(
        id,
        [
          '/bin/sh',
          '-c',
          'for i in $(seq 1 50); do xdpyinfo >/dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1',
        ],
        signal,
      );
      if (probe.code !== 0)
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'The virtual display did not become ready.',
        );
    } catch (error) {
      await this.remove(id);
      throw error;
    }
  }

  async ownsDesktop(id: string, profile: string, image: string, signal: AbortSignal) {
    const result = await this.invoke(
      ['inspect', '--format', '{{json .}}', `aria-${id}`],
      signal,
      64_000,
    );
    if (result.code !== 0 || result.truncated) return false;
    const record = JSON.parse(result.stdout.toString('utf8'));
    const config = record.HostConfig;
    return (
      record.State?.Running === true &&
      record.Config?.Labels?.[desktopLabel] === profile &&
      record.Image === image &&
      record.Config?.User === user &&
      config?.NetworkMode === 'none' &&
      config?.Privileged === false &&
      config?.ReadonlyRootfs === true &&
      !config?.Binds?.length &&
      !config?.Devices?.length &&
      config?.CapDrop?.includes('ALL') &&
      !config?.CapAdd?.length &&
      config?.SecurityOpt?.includes('no-new-privileges') &&
      config?.Memory === 2 * 1024 ** 3 &&
      config?.PidsLimit === 128
    );
  }

  desktopCommand(
    id: string,
    command: readonly string[],
    signal: AbortSignal,
    limit = 6000,
    detached = false,
  ) {
    return this.invoke(
      ['exec', ...(detached ? ['--detach'] : []), '--user', user, `aria-${id}`, ...command],
      signal,
      limit,
    );
  }

  async computerScript(
    profile: string,
    script: string,
    operation: (request: unknown, signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ) {
    const id = randomUUID();
    const lifetime = new AbortController();
    const active = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(80_000)]);
    let pending: Promise<unknown> | undefined;
    await this.create(id, profile, active);
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(
          this.verified?.binary ?? dockerExecutable(),
          [
            '--host',
            this.endpoint,
            'exec',
            '-i',
            '--user',
            user,
            '--workdir',
            '/workspace/working',
            `aria-${id}`,
            executable,
            '-I',
            '-u',
            '-c',
            script,
          ],
          { env: dockerEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
        );
        let buffered = '';
        let requestCount = 0;
        let reading = false;
        let result: string | undefined;
        let finished = false;
        const stop = (error?: unknown) => {
          if (finished) return;
          finished = true;
          active.removeEventListener('abort', aborted);
          lifetime.abort();
          child.kill('SIGKILL');
          if (error) reject(error);
          else if (result !== undefined) resolve(result);
          else reject(new RuntimeError('EXECUTION_FAILED', 'The script ended without a result.'));
        };
        const aborted = () => stop(active.reason);
        const receive = async () => {
          if (reading || finished) return;
          const end = buffered.indexOf('\n');
          if (end < 0) return;
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (++requestCount > 16)
            throw new RuntimeError(
              'BUDGET_EXCEEDED',
              'The script exceeded its computer request budget.',
            );
          reading = true;
          const value = JSON.parse(line) as unknown;
          if (
            value &&
            typeof value === 'object' &&
            'result' in value &&
            typeof value.result === 'string'
          ) {
            result = value.result.slice(0, 4000);
            stop();
            return;
          }
          active.throwIfAborted();
          pending = operation(value, active);
          const reply = await pending;
          pending = undefined;
          if (!finished) child.stdin.write(`${JSON.stringify(reply)}\n`);
          reading = false;
          await receive();
        };
        active.addEventListener('abort', aborted, { once: true });
        if (active.aborted) aborted();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          if (finished) return;
          buffered += chunk;
          if (buffered.length > 16_000)
            stop(new RuntimeError('BUDGET_EXCEEDED', 'The script exceeded its broker buffer.'));
          else void receive().catch(stop);
        });
        child.stdin.on('error', stop);
        child.once('error', stop);
        child.once('close', () => stop());
      });
    } finally {
      lifetime.abort();
      await pending?.catch(() => undefined);
      await this.remove(id);
    }
  }

  async stageDesktop(id: string, filename: string, bytes: Buffer, signal: AbortSignal) {
    const result = await this.invoke(
      [
        'exec',
        '-i',
        '--user',
        '0:0',
        `aria-${id}`,
        '/usr/bin/python3',
        '-I',
        '-c',
        stageBytes,
        '/workspace/inputs',
        workspaceFilename.parse(filename),
      ],
      signal,
      2000,
      bytes,
    );
    if (result.code !== 0)
      throw new RuntimeError(
        'EXECUTION_FAILED',
        'Could not stage the input in the virtual desktop.',
      );
  }

  async desktopOutput(id: string, filename: string, signal: AbortSignal) {
    const result = await this.desktopCommand(
      id,
      [
        '/usr/bin/python3',
        '-I',
        '-c',
        readOutput,
        workspaceFilename.parse(filename),
        String(executionLimits.assetBytes),
      ],
      signal,
      executionLimits.assetBytes,
    );
    if (result.code !== 0 || result.truncated || !result.stdout.length)
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'Select a readable regular file in /workspace/outputs.',
      );
    return result.stdout;
  }

  async run(id: string, command: string[], signal: AbortSignal, timeoutMs: number) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const result = await this.invoke(
      [
        'exec',
        '--user',
        user,
        '--workdir',
        '/workspace/working',
        '--env',
        'HOME=/workspace/temporary',
        '--env',
        'TMPDIR=/workspace/temporary',
        '--env',
        'PYTHONNOUSERSITE=1',
        `aria-${id}`,
        ...command,
      ],
      AbortSignal.any([signal, timeout]),
      executionLimits.commandOutputBytes,
    );
    if (result.aborted) {
      await this.remove(id);
      return { ...result, timedOut: timeout.aborted && !signal.aborted, recycled: true };
    }
    const cleanup = await this.invoke(
      ['exec', `aria-${id}`, executable, '-I', '-c', stopProcesses],
      AbortSignal.timeout(controlTimeout),
    ).catch(() => undefined);
    if (cleanup?.code !== 0) {
      await this.remove(id);
      throw new RuntimeError(
        'OUTCOME_UNCERTAIN',
        'The process tree could not be verified. The workspace was revoked.',
      );
    }
    return { ...result, timedOut: false, recycled: false };
  }

  async stage(
    id: string,
    area: 'inputs' | 'skills',
    filename: string,
    bytes: Buffer,
    signal: AbortSignal,
  ) {
    const name = workspaceFilename.parse(filename);
    const result = await this.invoke(
      [
        'exec',
        '-i',
        `aria-${id}`,
        executable,
        '-I',
        '-c',
        stageBytes,
        `${sandboxPath}/${area}`,
        name,
      ],
      signal,
      2000,
      bytes,
    );
    if (result.code !== 0)
      throw new RuntimeError(
        'EXECUTION_FAILED',
        'The workspace could not stage the approved file.',
      );
  }

  async output(id: string, filename: string, signal: AbortSignal) {
    const name = workspaceFilename.parse(filename);
    const result = await this.invoke(
      [
        'exec',
        '--user',
        user,
        `aria-${id}`,
        executable,
        '-I',
        '-c',
        readOutput,
        name,
        String(executionLimits.assetBytes),
      ],
      signal,
      executionLimits.assetBytes,
    );
    if (result.code !== 0 || result.truncated || !result.stdout.length)
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'Choose a readable regular file in the workspace outputs within the size limit.',
      );
    return result.stdout;
  }

  async owns(id: string, profile: string, signal: AbortSignal) {
    const result = await this.invoke(
      ['inspect', '--format', '{{json .}}', `aria-${id}`],
      AbortSignal.any([signal, AbortSignal.timeout(controlTimeout)]),
      64_000,
    );
    if (result.code !== 0 || result.truncated) return false;
    const record = JSON.parse(result.stdout.toString('utf8'));
    const config = record.HostConfig;
    return (
      record.State?.Running === true &&
      record.Config?.Labels?.[workspaceLabel] === profile &&
      record.Config?.Image === sandboxImage &&
      config?.ReadonlyRootfs === true &&
      config?.NetworkMode === 'none' &&
      config?.Privileged === false &&
      (config.Binds?.length ?? 0) === 0 &&
      config.Memory === 512 * 1024 * 1024 &&
      config.PidsLimit === 64
    );
  }

  async remove(id: string) {
    const result = await this.invoke(
      ['rm', '-f', `aria-${id}`],
      AbortSignal.timeout(controlTimeout),
      2000,
    ).catch(() => undefined);
    return (
      result?.code === 0 || Boolean(result?.stderr.toString('utf8').includes('No such container'))
    );
  }

  profile(profileDirectory: string) {
    return digest(profileDirectory).slice(0, 32);
  }
}
