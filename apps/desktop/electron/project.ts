import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DirectoryEntry, FilePreview, RepositoryInfo } from '@aria/shared';
const run = promisify(execFile);
export async function scopedPath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes('\0'))
    throw new Error('Use a relative project path.');
  const base = await fs.realpath(root);
  const resolved = await fs.realpath(path.resolve(base, relative || '.'));
  const within = path.relative(base, resolved);
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within))
    throw new Error('Path is outside the selected project.');
  return resolved;
}
export async function repository(root: string): Promise<RepositoryInfo> {
  await fs.access(root);
  try {
    await run('git', ['--no-optional-locks', '-C', root, 'rev-parse', '--show-toplevel'], {
      timeout: 3000,
    });
    try {
      const { stdout } = await run(
        'git',
        ['--no-optional-locks', '-C', root, 'symbolic-ref', '--short', '-q', 'HEAD'],
        { timeout: 3000 },
      );
      return { branch: stdout.trim(), isGit: true };
    } catch {
      const { stdout } = await run(
        'git',
        ['--no-optional-locks', '-C', root, 'rev-parse', '--short', 'HEAD'],
        { timeout: 3000 },
      );
      return { branch: `detached@${stdout.trim()}`, isGit: true };
    }
  } catch {
    return {
      branch: null,
      isGit: false,
      error:
        'No Git branch is available. This may be a non-Git folder or Git may not be installed.',
    };
  }
}
export async function listFiles(root: string, relative: string): Promise<DirectoryEntry[]> {
  const directory = await scopedPath(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length > 5000)
    throw new Error('This directory has more than 5,000 entries. Open a smaller project folder.');
  const visible = entries.filter(
    (entry) =>
      !['.git', 'node_modules', '.DS_Store'].includes(entry.name) && !entry.isSymbolicLink(),
  );
  return (
    await Promise.all(
      visible.map(async (entry) => {
        const relativePath = path.join(relative, entry.name);
        const stat = await fs.stat(await scopedPath(root, relativePath));
        return {
          name: entry.name,
          path: relativePath,
          kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
          size: stat.size,
        };
      }),
    )
  ).sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
  );
}
export async function readFile(root: string, relative: string): Promise<FilePreview> {
  const filename = await scopedPath(root, relative);
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Select a regular file.');
    const buffer = Buffer.alloc(Math.min(stat.size, 1_048_576));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const binary = bytes.includes(0);
    return {
      path: relative,
      content: binary ? '' : bytes.toString('utf8'),
      truncated: stat.size > buffer.length,
      binary,
    };
  } finally {
    await handle.close();
  }
}
export function safeExternalUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP and HTTPS links without embedded credentials are allowed.');
  return url.href;
}
export async function checkHealth(
  base: string,
): Promise<{ reachable: boolean; message: string; checkedAt: string }> {
  try {
    const url = new URL(safeExternalUrl(base));
    url.pathname = `${url.pathname.replace(/\/$/, '')}/health`;
    url.search = '';
    url.hash = '';
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    const body: unknown = await response.json();
    if (
      !response.ok ||
      typeof body !== 'object' ||
      body === null ||
      !('status' in body) ||
      body.status !== 'ok'
    )
      throw new Error(`Unexpected health response (${response.status}).`);
    return {
      reachable: true,
      message: 'API reachable. Legacy workspace execution services are not implemented.',
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      reachable: false,
      message: error instanceof Error ? error.message : 'Connection failed.',
      checkedAt: new Date().toISOString(),
    };
  }
}
