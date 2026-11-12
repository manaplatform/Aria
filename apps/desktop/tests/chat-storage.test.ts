// @vitest-environment node
import { beforeEach, afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  modelReference,
  registryDraft,
  type DiscoveredModel,
  type RegistryInput,
} from '@aria/shared';
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
const discovery = async (): Promise<DiscoveredModel[]> => [
  {
    id: 'saved-model',
    capabilities: ['chat', 'tools'],
    source: 'provider',
  },
];
const newConnection = (apiKey: string) => ({
  id: randomUUID(),
  baseUrl: 'https://provider.example/v1',
  name: 'Provider',
  apiKey,
  webSearch: false,
  models: [{ id: 'saved-model', enabled: true, delegate: true, declared: [] }],
});

it('persists multiple encrypted connections and imports environment values only on request', async () => {
  const store = new ProviderStorage(directory, cipher, {
    OPENAI_API_KEY: 'environment-secret',
    OPENAI_MODEL: 'environment-model',
  });
  const initial = registryDraft(await store.get());
  expect((await store.get()).environmentImportAvailable).toBe(true);
  const one = newConnection('private-test-key');
  const two = newConnection('secondary-key');
  const input: RegistryInput = {
    ...initial,
    connections: [one, two],
    primary: modelReference(one.id, 'saved-model'),
  };
  await store.save(input, discovery);
  const onDisk = await fs.readFile(path.join(directory, 'provider-v2.json'), 'utf8');
  expect(onDisk).not.toContain('private-test-key');
  expect(onDisk).not.toContain('secondary-key');
  expect(JSON.stringify(await store.get())).not.toContain('private-test-key');
  expect((await store.resolve()).connections.map((item) => item.apiKey)).toEqual([
    'private-test-key',
    'secondary-key',
  ]);
  expect(await store.resolve()).toMatchObject({ primary: input.primary });
  await store.importEnvironment();
  expect((await store.resolve()).connections.at(-1)).toMatchObject({
    apiKey: 'environment-secret',
  });
  expect((await store.resolve()).primary).toBe(input.primary);
  await expect(store.importEnvironment()).rejects.toThrow('unavailable');
});
it('preserves saved settings on encryption failure, rejects stale writes, and does not reuse a key at a new URL', async () => {
  const store = new ProviderStorage(directory, cipher, {});
  const initial = registryDraft(await store.get());
  const connection = newConnection('original-secret');
  const input = { ...initial, connections: [connection] };
  const saved = await store.save(input, discovery);
  const before = await fs.readFile(path.join(directory, 'provider-v2.json'), 'utf8');
  const unavailable = new ProviderStorage(
    directory,
    { ...cipher, available: async () => false },
    {},
  );
  await expect(
    unavailable.save(
      {
        ...input,
        revision: saved.revision,
        connections: [{ ...connection, apiKey: 'new-secret' }],
      },
      discovery,
    ),
  ).rejects.toThrow('could not be encrypted');
  expect(await fs.readFile(path.join(directory, 'provider-v2.json'), 'utf8')).toBe(before);
  await expect(store.save(input, discovery)).rejects.toThrow('settings changed');
  await expect(
    store.preview({ ...connection, baseUrl: 'https://other.example/v1', apiKey: undefined }),
  ).rejects.toThrow('Enter an API key');
});
it('migrates the selected defaults and keeps the original encrypted provider file intact', async () => {
  const original = {
    provider: 'openai',
    baseUrl: 'https://proxy.example/v1',
    model: 'legacy-chat',
    models: {
      chat: 'legacy-chat',
      image: 'legacy-image',
      speech: '',
      transcription: '',
      live: 'legacy-live',
    },
    systemPrompt: 'Keep instructions',
    encryptedKey: Buffer.from('encrypted:saved-secret').toString('base64'),
  };
  await fs.writeFile(path.join(directory, 'provider.json'), JSON.stringify(original));
  const store = new ProviderStorage(directory, cipher, {});
  const migrated = await store.get();
  const [connection] = migrated.connections;
  expect(migrated).toMatchObject({
    primary: modelReference(connection.id, 'legacy-chat'),
    live: { model: modelReference(connection.id, 'legacy-live'), voice: 'marin' },
    systemPrompt: 'Keep instructions',
  });
  expect(connection.models).toContainEqual({
    id: 'legacy-image',
    enabled: true,
    delegate: true,
    declared: ['image', 'image-edit'],
  });
  expect((await store.resolve()).connections[0].apiKey).toBe('saved-secret');
  expect(await fs.readFile(path.join(directory, 'provider.json'), 'utf8')).toBe(
    JSON.stringify(original),
  );
  expect((await new ProviderStorage(directory, cipher, {}).get()).revision).toBe(migrated.revision);
});
it('requires an exact endpoint and key match for a compatible primary verification', async () => {
  const store = new ProviderStorage(directory, cipher, {});
  const initial = registryDraft(await store.get());
  const connection = {
    ...newConnection('secret'),
    models: [
      { id: 'saved-model', enabled: true, delegate: true, declared: ['chat', 'tools'] as const },
    ],
  };
  const configured: RegistryInput = {
    ...initial,
    primary: modelReference(connection.id, 'saved-model'),
    connections: [
      {
        ...connection,
        models: connection.models.map((item) => ({ ...item, declared: [...item.declared] })),
      },
    ],
  };
  const unknown = async (): Promise<DiscoveredModel[]> => [
    { id: 'saved-model', capabilities: [], source: 'unknown' },
  ];
  await expect(store.save(configured, unknown)).rejects.toThrow('Verify unknown capabilities');
  store.markVerified(configured.connections[0], 'different-key', 'saved-model');
  await expect(store.save(configured, unknown)).rejects.toThrow('Verify unknown capabilities');
  store.markVerified(configured.connections[0], 'secret', 'saved-model');
  expect((await store.save(configured, unknown)).connections[0].verified).toEqual(['saved-model']);
});
