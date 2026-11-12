// @vitest-environment node
import { beforeEach, afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { emptyData, legacyDataSchema, LocalStorage } from '../electron/storage';
import { ProviderStorage, type SecretCipher } from '../electron/provider-storage';

let directory: string;
const cipher: SecretCipher = {
  available: async () => true,
  encrypt: async (value) => Buffer.from(`encrypted:${value}`),
  decrypt: async (value) => ({ result: value.toString().slice('encrypted:'.length) }),
};
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-chat-storage-'));
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
it('migrates legacy drafts and preferences once, retaining the original document and project data', async () => {
  const data = emptyData();
  data.workspaces = [
    {
      id: 'old-project',
      name: 'Old project',
      root: '/tmp/old-project',
      branch: 'main',
      updatedAt: '',
    },
  ];
  data.conversations = [
    {
      id: 'draft',
      workspaceId: 'old-project',
      title: 'An old draft',
      draft: 'Keep this text',
      mode: 'plan',
      attachments: [{ id: 'file', name: 'notes.txt', path: 'notes.txt', size: 10 }],
      updatedAt: '',
    },
  ];
  const legacy = legacyDataSchema.parse({
    ...data,
    version: 1,
    preferences: { ...data.preferences, theme: 'light', route: '/tasks' },
  });
  const original = JSON.stringify(legacy);
  await fs.writeFile(path.join(directory, 'workspace-v1.json'), original);
  const store = new LocalStorage(directory);
  const migrated = await store.load();
  expect(migrated.data).toMatchObject({
    version: 3,
    conversations: legacy.conversations,
    workspaces: legacy.workspaces,
    preferences: { theme: 'light', route: '/chat' },
    chat: { conversations: [], messages: [] },
  });
  expect(await fs.readFile(path.join(directory, 'workspace-v1.json'), 'utf8')).toBe(original);
  migrated.data.preferences.profileName = 'Alex';
  await store.save(migrated.data);
  expect((await new LocalStorage(directory).load()).data.preferences.profileName).toBe('Alex');
});
it('restores partial messages as interrupted and rejects orphaned chat messages', async () => {
  const store = new LocalStorage(directory);
  await store.load();
  const data = emptyData();
  data.chat.conversations = [
    { id: 'chat', title: 'Hello', draft: 'Follow-up', pinned: true, createdAt: '', updatedAt: '' },
  ];
  data.chat.selectedId = 'chat';
  data.chat.messages = [
    {
      id: 'message',
      conversationId: 'chat',
      requestId: 'request',
      role: 'assistant',
      content: 'Partial answer',
      status: 'streaming',
      sequence: 3,
      createdAt: '',
    },
  ];
  await store.save(data);
  expect((await new LocalStorage(directory).load()).data.chat.messages[0]).toMatchObject({
    content: 'Partial answer',
    status: 'interrupted',
  });
  expect(() => store.save({ ...data, chat: { ...data.chat, conversations: [] } })).toThrow(
    'missing conversation',
  );
});
it('saves only encrypted key bytes, never reads keys back to the renderer, and honors environment precedence', async () => {
  const store = new ProviderStorage(directory, cipher, {});
  await store.save({
    baseUrl: 'https://provider.example/v1',
    model: 'saved-model',
    systemPrompt: 'Be helpful',
    apiKey: 'private-test-key',
  });
  expect(await fs.readFile(path.join(directory, 'provider.json'), 'utf8')).not.toContain(
    'private-test-key',
  );
  expect(JSON.stringify(await store.get())).not.toContain('private-test-key');
  expect(await store.resolve()).toMatchObject({ apiKey: 'private-test-key', model: 'saved-model' });
  const overridden = new ProviderStorage(directory, cipher, {
    OPENAI_API_KEY: 'environment-key',
    OPENAI_MODEL: 'environment-model',
  });
  expect(await overridden.get()).toMatchObject({
    model: 'environment-model',
    sources: { apiKey: 'environment', model: 'environment' },
  });
  expect(await overridden.resolve()).toMatchObject({ apiKey: 'environment-key' });
});
it('preserves saved settings when encryption fails and never falls back to plaintext', async () => {
  const store = new ProviderStorage(directory, cipher, {});
  const settings = {
    baseUrl: 'https://provider.example/v1',
    model: 'model',
    systemPrompt: '',
    apiKey: 'original-secret',
  };
  await store.save(settings);
  const before = await fs.readFile(path.join(directory, 'provider.json'), 'utf8');
  const unavailable = new ProviderStorage(
    directory,
    { ...cipher, available: async () => false },
    {},
  );
  await expect(unavailable.save({ ...settings, apiKey: 'new-secret' })).rejects.toThrow(
    'encryption is unavailable',
  );
  expect(await fs.readFile(path.join(directory, 'provider.json'), 'utf8')).toBe(before);
  await store.save({ ...settings, apiKey: undefined, removeKey: true });
  expect((await store.get()).keyConfigured).toBe(false);
});
it('migrates provider defaults and resolves preview keys with environment precedence', async () => {
  const original = {
    baseUrl: 'https://proxy.example/v1',
    model: 'legacy-chat',
    systemPrompt: 'Keep instructions',
    encryptedKey: Buffer.from('encrypted:saved-secret').toString('base64'),
  };
  await fs.writeFile(path.join(directory, 'provider.json'), JSON.stringify(original));
  const store = new ProviderStorage(directory, cipher, {});
  expect(await store.get()).toMatchObject({
    provider: 'openai',
    models: { chat: 'legacy-chat', image: '', live: '' },
  });
  expect(
    await store.resolve({
      provider: 'openai',
      baseUrl: 'https://preview.example/v1',
      apiKey: 'preview-key',
    }),
  ).toMatchObject({ apiKey: 'preview-key', baseUrl: 'https://preview.example/v1' });
  expect(await fs.readFile(path.join(directory, 'provider.json'), 'utf8')).toBe(
    JSON.stringify(original),
  );
  const managed = new ProviderStorage(directory, cipher, {
    OPENAI_API_KEY: 'env-key',
    OPENAI_BASE_URL: 'https://managed.example/v1',
    OPENAI_MODEL: 'env-model',
  });
  expect(
    await managed.resolve({
      provider: 'openai',
      baseUrl: 'https://preview.example/v1',
      apiKey: 'preview-key',
    }),
  ).toMatchObject({
    apiKey: 'env-key',
    baseUrl: 'https://managed.example/v1',
    models: { chat: 'env-model' },
  });
  await expect(
    store.resolve({ provider: 'unsupported' as 'openai', baseUrl: original.baseUrl }),
  ).rejects.toThrow();
  expect(
    await store.resolve({ provider: 'openai', baseUrl: original.baseUrl, removeKey: true }),
  ).toMatchObject({ apiKey: '' });
});
