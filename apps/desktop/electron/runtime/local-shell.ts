import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { executionLimits, workspaceFilename } from '@aria/shared';
import { RuntimeError } from './store';

const shell = '/bin/sh';
export const localShellSupported = process.platform === 'darwin' || process.platform === 'linux';

async function directory(location: string) {
  return (await lstat(location).catch(() => undefined))?.isDirectory() === true;
}

function commandPreview(command: string) {
  // Keep terminal and bidirectional controls visible in the native approval dialog.
  return JSON.stringify(command).replace(
    /[\p{Cf}\u007f-\u009f\u2028\u2029]/gu,
    (character) => '\\u{' + character.codePointAt(0)!.toString(16) + '}',
  );
}

export class LocalShell {
  readonly endpoint = 'desktop-native-shell';
  private readonly root: string;

  constructor(profileDirectory: string) {
    this.root = path.join(profileDirectory, 'local-shell');
  }

  async probe(signal: AbortSignal) {
    if (
      !localShellSupported ||
      !(await access(shell, constants.X_OK).then(
        () => true,
        () => false,
      ))
    )
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Local Shell requires /bin/sh on macOS or Linux.',
      );
    signal.throwIfAborted();
    return {
      os: process.platform,
      architecture: process.arch,
      runtime: shell,
      network: 'host',
      approval: 'each command',
    };
  }

  async create(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await mkdir(this.root, { mode: 0o700, recursive: true });
    if (!(await directory(this.root)))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The local workspace folder is unavailable.',
      );
    const workspace = path.join(this.root, id);
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(path.join(workspace, 'working'), { mode: 0o700 });
    await mkdir(path.join(workspace, 'outputs'), { mode: 0o700 });
    signal.throwIfAborted();
  }

  async owns(id: string) {
    return (
      (await directory(this.root)) &&
      (await directory(path.join(this.root, id))) &&
      (await directory(this.workingDirectory(id))) &&
      (await directory(path.join(this.root, id, 'outputs')))
    );
  }

  workingDirectory(id: string) {
    return path.join(this.root, id, 'working');
  }

  review(id: string, command: string) {
    return [
      'This command runs with your account’s access to files, apps, and the network. Its output is sent to the chat model.',
      'Working folder: ' + this.workingDirectory(id),
      commandPreview(command),
    ].join('\n\n');
  }

  async run(id: string, command: string, signal: AbortSignal, timeoutMs: number) {
    if (!(await this.owns(id)))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The local workspace folder is unavailable.',
      );
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const active = AbortSignal.any([signal, timeout]);
    const child = spawn(shell, ['-c', command], {
      cwd: this.workingDirectory(id),
      detached: true,
      env: {
        HOME: homedir(),
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Promise<{
      code: number | null;
      stdout: Buffer;
      stderr: Buffer;
      truncated: boolean;
      aborted: boolean;
      timedOut: boolean;
      recycled: boolean;
    }>((resolve, reject) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let remaining: number = executionLimits.commandOutputBytes;
      let truncated = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const capture = (chunks: Buffer[]) => (bytes: Buffer) => {
        if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
        if (bytes.length > remaining) truncated = true;
        remaining = Math.max(0, remaining - bytes.length);
      };
      const stopGroup = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* The group may already have exited. */
        }
      };
      const cleanup = () => {
        clearTimeout(deadline);
        active.removeEventListener('abort', abort);
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const finish = (code: number | null) => {
        cleanup();
        resolve({
          code,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          truncated,
          aborted: active.aborted,
          timedOut: timeout.aborted && !signal.aborted,
          recycled: active.aborted || code === null,
        });
      };
      const abort = () => {
        stopGroup();
        deadline ??= setTimeout(() => finish(null), 1000);
      };
      child.stdout.on('data', capture(stdout));
      child.stderr.on('data', capture(stderr));
      child.once('error', () => {
        cleanup();
        reject(new RuntimeError('EXECUTION_FAILED', 'Aria could not start the local shell.'));
      });
      child.once('exit', (code) => {
        if (!active.aborted) stopGroup();
        // A process can detach and keep a pipe open after the shell exits.
        deadline ??= setTimeout(() => finish(code), 250);
      });
      child.once('close', finish);
      active.addEventListener('abort', abort, { once: true });
      if (active.aborted) abort();
    });
  }

  async output(id: string, filename: string, signal: AbortSignal) {
    const file = path.join(this.root, id, 'outputs', workspaceFilename.parse(filename));
    try {
      if (!(await this.owns(id))) throw new Error();
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          !stat.size ||
          stat.size > executionLimits.assetBytes
        )
          throw new Error();
        const bytes = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== bytes.length || (await handle.stat()).size !== stat.size)
          throw new Error();
        return bytes;
      } finally {
        await handle.close();
      }
    } catch {
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'Choose a readable regular file in the local workspace outputs within the size limit.',
      );
    } finally {
      signal.throwIfAborted();
    }
  }

  async remove(id: string) {
    if (!(await directory(this.root))) return false;
    return rm(path.join(this.root, id), { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
  }
}
