// @vitest-environment node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CapabilityStorage } from '../electron/capability-storage';
import { inspectBundle } from '../electron/skill-bundles';

const instructions = 'Use the following method and reference the approved checklist.';
const manifest = `---\nname: review-notes\ndescription: Review notes for unsupported claims.\nmetadata:\n  aria.dependencies: sources\n---\n${instructions}\n`;
let temporary: string;
let root: string;

beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-tools-'));
  root = path.join(temporary, 'review-notes');
  await fs.mkdir(path.join(root, 'references'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts'));
  await fs.writeFile(path.join(root, 'SKILL.md'), manifest);
  await fs.writeFile(path.join(root, 'references', 'checklist.md'), '# Review checklist\n');
  await fs.writeFile(path.join(root, 'scripts', 'run.sh'), 'exit 1\n');
});
afterEach(async () => fs.rm(temporary, { recursive: true, force: true }));

it('uses an immutable approved copy and scopes readable resources to the enabled version', async () => {
  const storage = new CapabilityStorage(temporary);
  const preview = await storage.preview(root, 'directory');
  const { token, skill } = preview;
  const signal = new AbortController().signal;
  expect(await storage.read(skill, undefined, 0, signal)).toBeUndefined();
  await fs.writeFile(path.join(root, 'references', 'checklist.md'), 'Unapproved edit');
  await storage.approve(token);
  const restarted = new CapabilityStorage(temporary);
  await restarted.load();
  const content = await restarted.read(skill, undefined, 0, signal);
  expect(content).toMatchObject({
    text: instructions,
    resources: [{ id: expect.any(String), name: 'references/checklist.md' }],
  });
  const resourceId = content!.resources![0].id;
  expect((await restarted.read(skill, resourceId, 0, signal))?.text).toBe('# Review checklist\n');
  expect(
    await restarted.read(skill, '00000000-0000-4000-8000-000000000001', 0, signal),
  ).toBeUndefined();
  const edited = await restarted.preview(root, 'directory');
  expect(edited.skill.version).not.toEqual(skill.version);
  await restarted.approve(edited.token);
  expect(await restarted.read(skill, resourceId, 0, signal)).toBeUndefined();
  await restarted.manage(skill, 'enable');
  expect((await restarted.read(skill, resourceId, 0, signal))?.text).toContain('Review checklist');
  await restarted.manage(skill, 'remove');
  expect(restarted.skills().some((item) => item.version === skill.version)).toBe(false);
});

it('rejects duplicate YAML keys, aliases and incompatible bundle paths', async () => {
  await fs.writeFile(
    path.join(root, 'SKILL.md'),
    manifest.replace('description:', 'name: duplicate\ndescription:'),
  );
  await expect(inspectBundle(root, 'directory')).rejects.toThrow(/YAML/);
  await fs.writeFile(
    path.join(root, 'SKILL.md'),
    manifest.replace('description:', 'description: &desc'),
  );
  await expect(inspectBundle(root, 'directory')).rejects.toThrow(/anchors/);
});

it.skipIf(process.platform === 'win32')(
  'rejects symlinks and hard links in local skill directories',
  async () => {
    const outside = path.join(temporary, 'private.txt');
    await fs.writeFile(outside, 'Private file');
    const dangling = path.join(root, 'references', 'external.txt');
    await fs.symlink(outside, dangling);
    await expect(inspectBundle(root, 'directory')).rejects.toThrow(/linked/);
    await fs.unlink(dangling);
    await fs.link(outside, dangling);
    await expect(inspectBundle(root, 'directory')).rejects.toThrow(/unlinked/);
  },
);

it('imports a standard ZIP and rejects traversal, symlinks, and expansion beyond limits', async () => {
  const file = path.join(temporary, 'skill.zip');
  const start = { name: 'review-notes/SKILL.md', data: Buffer.from(manifest) };
  await fs.writeFile(
    file,
    archive([start, { name: 'review-notes/refs/readme.md', data: Buffer.from('example') }]),
  );
  expect((await inspectBundle(file, 'zip')).manifest.summary.name).toBe('review-notes');
  for (const entry of [
    { name: 'review-notes/../secret', data: Buffer.from('avoid') },
    { name: 'review-notes/references/link.txt', data: Buffer.from('/tmp/private'), mode: 0o120777 },
    { name: 'review-notes/references/too-large.txt', data: Buffer.alloc(1024 * 1024 + 1) },
  ]) {
    await fs.writeFile(file, archive([start, entry]));
    await expect(inspectBundle(file, 'zip')).rejects.toThrow();
  }
});

it('reserves a guarded operation durably and blocks later attempts even when arguments change', async () => {
  const signal = new AbortController().signal;
  const first = new CapabilityStorage(temporary);
  const concurrent = await Promise.all([
    first.reserve('chat', 'turn', 'attempt-a', 'same', signal),
    first.reserve('chat', 'turn', 'attempt-a', 'same', signal),
  ]);
  expect(concurrent).toEqual([true, false]);
  const restarted = new CapabilityStorage(temporary);
  expect(await restarted.reserve('chat', 'turn', 'attempt-a', 'other operation', signal)).toBe(
    true,
  );
  expect(await restarted.reserve('chat', 'turn', 'attempt-b', 'changed arguments', signal)).toBe(
    false,
  );
  expect(await restarted.reserve('chat', 'new turn', 'attempt-b', 'same', signal)).toBe(true);
  await expect(
    restarted.reserve('chat', 'cancelled', 'attempt-b', 'same', AbortSignal.abort()),
  ).rejects.toThrow();
  expect(await restarted.reserve('chat', 'cancelled', 'attempt-b', 'same', signal)).toBe(true);
});

function archive(files: { name: string; data: Buffer; mode?: number }[]) {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const { name, data, mode = 0o100644 } of files) {
    const filename = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, data);
    const metadata = Buffer.alloc(46);
    metadata.writeUInt32LE(0x02014b50);
    metadata.writeUInt16LE(0x0314, 4);
    metadata.writeUInt16LE(20, 6);
    local.copy(metadata, 16, 14, 28);
    metadata.writeUInt32LE((mode << 16) >>> 0, 38);
    metadata.writeUInt32LE(offset, 42);
    directory.push(metadata, filename);
    offset += local.length + filename.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(
    directory.reduce((size, part) => size + part.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}
