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
    expect(stored).toMatchObject({ aiBrowser: true, history: true });
    expect(stored).not.toHaveProperty('encryptedKey');
    expect(stored).not.toHaveProperty('braveEnabled');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
