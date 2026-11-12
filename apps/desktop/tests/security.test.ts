// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { checkHealth, listFiles, readFile, safeExternalUrl, scopedPath } from '../electron/project';
import { emptyData, LocalStorage } from '../electron/storage';
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-test-'));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
describe('project boundary', () => {
  it('rejects traversal, absolute paths, and escaping symlinks', async () => {
    const root = path.join(directory, 'project');
    await fs.mkdir(root);
    await fs.writeFile(path.join(directory, 'private.txt'), 'private');
    await fs.symlink(path.join(directory, 'private.txt'), path.join(root, 'link'));
    await expect(scopedPath(root, '../private.txt')).rejects.toThrow('outside');
    await expect(scopedPath(root, path.join(directory, 'private.txt'))).rejects.toThrow('relative');
    await expect(scopedPath(root, 'link')).rejects.toThrow('outside');
    expect(await listFiles(root, '')).toEqual([]);
  });
  it('bounds previews and identifies binary files and missing folders', async () => {
    await fs.writeFile(path.join(directory, 'large.txt'), 'a'.repeat(1_100_000));
    await fs.writeFile(path.join(directory, 'binary'), Buffer.from([0, 1]));
    const preview = await readFile(directory, 'large.txt');
    expect(preview.truncated).toBe(true);
    expect(preview.content.length).toBe(1_048_576);
    expect((await readFile(directory, 'binary')).binary).toBe(true);
    await expect(listFiles(path.join(directory, 'missing'), '')).rejects.toThrow();
  });
});
describe('local persistence', () => {
  it('round-trips data atomically and refuses renderer-supplied project roots', async () => {
    const store = new LocalStorage(directory);
    await store.load();
    const data = emptyData();
    data.preferences.theme = 'light';
    await store.save(data);
    expect((await new LocalStorage(directory).load()).data.preferences.theme).toBe('light');
    expect(() =>
      store.save({
        ...data,
        workspaces: [{ id: 'unregistered', name: 'bad', root: '/', branch: null, updatedAt: '' }],
      }),
    ).toThrow('registered');
  });
  it('preserves unreadable data in a recovery copy', async () => {
    const store = new LocalStorage(directory);
    await fs.writeFile(store.filename, '{broken');
    const result = await store.load();
    expect(result.warning).toContain('recovery copy');
    expect(result.data.workspaces).toEqual([]);
    const recovery = (await fs.readdir(directory)).find((name) => name.includes('.recovery-'))!;
    expect(await fs.readFile(path.join(directory, recovery), 'utf8')).toBe('{broken');
  });
});
it('rejects unsafe external URLs', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:password@example.com',
  ])
    expect(() => safeExternalUrl(url)).toThrow();
  expect(safeExternalUrl('https://example.com')).toBe('https://example.com/');
});
it('distinguishes health reachability from AI capabilities and reports failures', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end('{"status":"ok"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    const health = await checkHealth(`http://127.0.0.1:${address.port}`);
    expect(health.reachable).toBe(true);
    expect(health.message).toContain('not implemented');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  expect((await checkHealth('file:///bad')).reachable).toBe(false);
});
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'reports a permission-denied project directory',
  async () => {
    const blocked = path.join(directory, 'blocked');
    await fs.mkdir(blocked);
    await fs.chmod(blocked, 0);
    try {
      await expect(listFiles(blocked, '')).rejects.toThrow();
    } finally {
      await fs.chmod(blocked, 0o700);
    }
  },
);
