import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultWebPolicy } from '@aria/shared';
import { expect, it } from 'vitest';
import { WebSettingsStorage } from '../electron/web-settings-storage';

it('persists encrypted credentials separately and never includes them in the settings sent to the renderer', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-web-settings-'));
  const cipher = {
    available: async () => true,
    encrypt: async (value: string) => Buffer.from(value.split('').reverse().join('')),
    decrypt: async (value: Buffer) => ({ result: value.toString().split('').reverse().join('') }),
  };
  try {
    const storage = new WebSettingsStorage(directory, cipher);
    await storage.load();
    expect(storage.get()).toMatchObject({ braveEnabled: false, aiBrowser: false, hasKey: false });
    const { enabled, ...policy } = defaultWebPolicy;
    await expect(storage.save({ ...policy, enabled, braveEnabled: true })).rejects.toThrow(
      /API key/,
    );
    const settings = await storage.save({
      ...policy,
      enabled,
      braveEnabled: true,
      apiKey: 'test-brave-key',
    });
    expect(settings).toMatchObject({ braveEnabled: true, hasKey: true });
    expect(JSON.stringify(settings)).not.toContain('test-brave-key');
    const stored = await fs.readFile(path.join(directory, 'web-settings-v1.json'), 'utf8');
    expect(stored).not.toContain('test-brave-key');
    const reloaded = new WebSettingsStorage(directory, cipher);
    await reloaded.load();
    expect((await reloaded.runtime()).braveKey).toBe('test-brave-key');
    await reloaded.save({ ...policy, enabled, apiKey: null });
    expect(reloaded.get().hasKey).toBe(false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
