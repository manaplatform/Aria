import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { executionLimits, workspaceFilename } from '@aria/shared';
import { RuntimeError, digest } from './store';

export const sandboxImage =
  'docker.io/library/python@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89';
const workspaceLabel = 'com.aria.workspace';
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
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP'].includes(key.toUpperCase()),
      ),
    );
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

  async probe(signal: AbortSignal) {
    if (this.verified && Date.now() - this.verified.at < 30_000) return this.verified;
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
    const image = await this.invoke(
      ['image', 'inspect', sandboxImage, '--format', '{{.Id}}'],
      signal,
    );
    if (image.code !== 0)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        `Install the pinned workspace image using docker pull ${sandboxImage}.`,
      );
    this.verified = {
      binary: dockerExecutable(),
      at: Date.now(),
      os: info.OSType,
      architecture: info.Architecture,
    };
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
