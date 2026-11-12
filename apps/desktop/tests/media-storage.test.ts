// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MediaStorage, pcmWav } from '../electron/media-storage';
import { emptyData, LocalStorage } from '../electron/storage';
let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-media-'));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
it('keeps binary assets outside JSON, rejects unsafe IDs and formats, and detects missing assets', async () => {
  const media = new MediaStorage(directory);
  const bytes = pcmWav(Buffer.alloc(480));
  const asset = await media.put(bytes, 'speech.wav', 'audio/wav');
  expect((await media.get(asset.id)).bytes).toEqual(bytes);
  await expect(media.get('../private-file')).rejects.toThrow('missing');
  await expect(
    media.put(Buffer.from('<script>bad</script>'), 'payload.png', 'image/png'),
  ).rejects.toThrow('supported');
  await fs.rm(path.join(media.directory, asset.id));
  await expect(media.get(asset.id)).rejects.toThrow('missing');
});
it('retains assets still referenced by history and removes them only after a successful saved deletion', async () => {
  const media = new MediaStorage(directory);
  const asset = await media.put(pcmWav(Buffer.alloc(40)), 'reply.wav');
  const previous = emptyData();
  previous.chat.conversations = [
    { id: 'chat', title: 'Voice', draft: '', pinned: false, createdAt: '', updatedAt: '' },
  ];
  previous.chat.messages = [
    {
      id: 'message',
      requestId: 'request',
      conversationId: 'chat',
      role: 'assistant',
      content: 'Reply',
      status: 'completed',
      sequence: 0,
      createdAt: '',
      assets: [asset],
    },
  ];
  const store = new LocalStorage(directory);
  await store.load();
  await store.save(previous);
  await media.prune(previous, previous);
  expect((await media.get(asset.id)).asset).toEqual(asset);
  const next = emptyData();
  await store.save(next);
  await media.prune(previous, next);
  await expect(media.get(asset.id)).rejects.toThrow('missing');
});
it('migrates version 2 conversations and leaves the original file intact', async () => {
  const original = { ...emptyData(), version: 2 };
  original.chat.newDraft = 'Keep my draft';
  const serialized = JSON.stringify(original);
  await fs.writeFile(path.join(directory, 'aria-v2.json'), serialized);
  const store = new LocalStorage(directory);
  const result = await store.load();
  expect(result.data.version).toBe(3);
  expect(result.data.chat.newDraft).toBe('Keep my draft');
  expect(await fs.readFile(path.join(directory, 'aria-v2.json'), 'utf8')).toBe(serialized);
  expect(JSON.parse(await fs.readFile(store.filename, 'utf8')).version).toBe(3);
});
