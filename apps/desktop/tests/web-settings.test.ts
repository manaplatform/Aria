import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultWebPolicy } from '@aria/shared';
import { expect, it } from 'vitest';
import { WebSettingsStorage } from '../electron/web-settings-storage';

it('removes old search API credentials while preserving browser access and history preferences', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-web-settings-'));
  const file = path.join(directory, 'web-settings-v1.json');
  try {
    await fs.writeFile(
      file,
      JSON.stringify({
        ...defaultWebPolicy,
        version: 1,
        revision: randomUUID(),
        aiBrowser: true,
        history: true,
        braveEnabled: true,
        encryptedKey: 'old-encrypted-key',
        language: 'en',
      }),
    );
    const storage = new WebSettingsStorage(directory);
    await storage.load();
    expect(storage.get()).toMatchObject({ aiBrowser: true, history: true });
    expect(await storage.runtime()).not.toHaveProperty('braveKey');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(stored).toMatchObject({ aiBrowser: true, history: true, version: 2 });
    expect(stored).not.toHaveProperty('encryptedKey');
    expect(stored).not.toHaveProperty('braveEnabled');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('migrates v1 ceiling defaults to higher turn limits while preserving stricter or v2 choices', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-web-settings-migrate-'));
  const file = path.join(directory, 'web-settings-v1.json');
  try {
    await fs.writeFile(
      file,
      JSON.stringify({
        ...defaultWebPolicy,
        searches: 2,
        fetches: 4,
        version: 1,
        revision: randomUUID(),
      }),
    );
    const upgraded = new WebSettingsStorage(directory);
    await upgraded.load();
    expect(upgraded.get()).toMatchObject({
      searches: defaultWebPolicy.searches,
      fetches: defaultWebPolicy.fetches,
    });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).version).toBe(2);

    await fs.writeFile(
      file,
      JSON.stringify({
        ...defaultWebPolicy,
        searches: 1,
        fetches: 3,
        version: 1,
        revision: randomUUID(),
      }),
    );
    const restricted = new WebSettingsStorage(directory);
    await restricted.load();
    expect(restricted.get()).toMatchObject({ searches: 1, fetches: 3 });

    await restricted.save({ ...defaultWebPolicy, searches: 2, fetches: 4, searchEngine: 'bing' });
    const explicit = new WebSettingsStorage(directory);
    await explicit.load();
    expect(explicit.get()).toMatchObject({ searches: 2, fetches: 4, searchEngine: 'bing' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
