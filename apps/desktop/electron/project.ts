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
  const candidate = path.resolve(base, relative || '.');
  const lexical = path.relative(base, candidate);
  if (lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical))
    throw new Error('Path is outside the selected project.');
  const resolved = await fs.realpath(candidate);
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

export async function readFileLines(
  root: string,
  relative: string,
  startLine = 1,
  maxLines = 200,
) {
  const preview = await readFile(root, relative);
  if (preview.binary) {
    return {
      path: relative,
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      truncated: false,
      binary: true,
      content: '',
    };
  }
  const lines = preview.content.split(/\r?\n/);
  const from = Math.max(1, Math.min(startLine, Math.max(1, lines.length)));
  const end = Math.min(lines.length, from + maxLines - 1);
  const slice = lines.slice(from - 1, end).join('\n');
  const maxChars = 10_000;
  const content = slice.length > maxChars ? slice.slice(0, maxChars) : slice;
  return {
    path: relative,
    startLine: from,
    endLine: end,
    totalLines: lines.length,
    truncated: preview.truncated || end < lines.length || slice.length > maxChars,
    binary: false,
    content,
  };
}

const ignoredWorkspaceEntries = new Set(['.git', 'node_modules', 'dist', 'out', '.DS_Store']);

export async function searchFiles(
  root: string,
  relative: string,
  query: string,
  limit = 20,
  signal?: AbortSignal,
) {
  const startDir = await scopedPath(root, relative);
  const base = await fs.realpath(root);
  const needle = query.toLowerCase();
  const matches: { path: string; line?: number; excerpt: string }[] = [];
  const queue = [startDir];
  let filesScanned = 0;
  let truncated = false;
  const maxFiles = 1500;
  while (queue.length && matches.length < limit) {
    signal?.throwIfAborted();
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (ignoredWorkspaceEntries.has(entry.name) || entry.isSymbolicLink()) continue;
      const candidate = path.join(current, entry.name);
      let real: string;
      try {
        real = await fs.realpath(candidate);
      } catch {
        continue;
      }
      const rel = path.relative(base, real);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
      if (entry.isDirectory()) {
        queue.push(real);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++filesScanned > maxFiles) {
        truncated = true;
        break;
      }
      if (rel.toLowerCase().includes(needle)) {
        matches.push({ path: rel, excerpt: `Filename match: ${rel}` });
        if (matches.length >= limit) break;
      }
      const stat = await fs.stat(real).catch(() => undefined);
      if (!stat || !stat.isFile() || stat.size === 0 || stat.size > 524_288) continue;
      const bytes = await fs.readFile(real).catch(() => undefined);
      if (!bytes || bytes.includes(0)) continue;
      const lines = bytes.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (lines[index].toLowerCase().includes(needle)) {
          matches.push({
            path: rel,
            line: index + 1,
            excerpt: lines[index].trim().slice(0, 240),
          });
          if (matches.length >= limit) break;
        }
      }
      if (matches.length >= limit) break;
    }
    if (truncated) break;
  }
  return { matches, filesScanned, truncated: truncated || matches.length >= limit };
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
