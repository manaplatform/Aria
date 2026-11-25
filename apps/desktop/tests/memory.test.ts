// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { defaultMemorySettings, type MemoryScope } from '@aria/shared';
import { MemoryStore, type MemoryIntake } from '../electron/memory/store';
import { LocalStorage, emptyData } from '../electron/storage';

let directory: string;
let store: MemoryStore;
const profile: MemoryScope = { kind: 'profile' };
const management = { management: true };
const choose = (id: string): MemoryScope => ({ kind: 'project', id });
const source = { conversationId: 'first-chat', messageId: 'first-message' };
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'aria-memory-'));
  store = new MemoryStore(directory);
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function enabled() {
  return store.saveSettings({ ...defaultMemorySettings, enabled: true }).epoch;
}
function event(
  epoch: number,
  candidates: MemoryIntake['candidates'],
  scope = profile,
): MemoryIntake {
  return { id: randomUUID(), epoch, observedAt: Date.now() + 10, scope, source, candidates };
}

it('scopes indexed search, aliases and record IDs to the current project or conversation', () => {
  const epoch = enabled();
  const north = store.remember(
    choose('north'),
    {
      category: 'project',
      content: 'Orchid uses SQLite',
      entities: [{ name: 'Orchid', kind: 'repository', aliases: ['orch'] }],
    },
    source,
    epoch,
  );
  const south = store.remember(
    choose('south'),
    {
      category: 'project',
      content: 'Orchid uses PostgreSQL',
      entities: [{ name: 'Orchid', kind: 'repository', aliases: ['orch'] }],
    },
    source,
    epoch,
  );
  store.remember(
    profile,
    { category: 'preference', content: 'Orchid preferences use Farsi' },
    source,
    epoch,
  );
  const query = { query: 'Orchid' };
  expect(
    store
      .search({ conversationId: 'second-chat' }, query)
      .records.map(({ value }) => value.content),
  ).toEqual(['Orchid preferences use Farsi']);
  const access = { conversationId: 'second-chat', projectId: 'north' };
  expect(store.search(access, query).records.map(({ id }) => id)).toContain(north.id);
  expect(store.read(south.id, access)).toBeUndefined();
  expect(store.resolve(access, 'orch').matches).toHaveLength(1);
  expect(store.resolve(management, 'orch')).toMatchObject({ ambiguous: true });
});

it('preserves historical decisions and keeps confirmed facts ahead of conflicting inferences', () => {
  const epoch = enabled();
  const fact = {
    category: 'fact' as const,
    factKey: 'protocol',
    content: 'Release protocol version 1',
  };
  const first = store.remember(profile, fact, source, epoch);
  const inferred = event(epoch, [{ ...fact, content: 'Release protocol version 9' }]);
  store.enqueue([inferred]);
  store.process();
  const search = () => store.search({}, { query: 'Release protocol' }).records;
  expect(search()[0]).toMatchObject({ id: first.id, confirmation: 'confirmed' });
  expect(search()[1]).toMatchObject({ state: 'conflicting', confirmation: 'inferred' });
  const changed = store.edit(
    first.id,
    first.revision,
    { ...fact, content: 'Release protocol version 2' },
    management,
  );
  expect(changed.supersedes).toBe(first.id);
  expect(search().map(({ id }) => id)).toEqual([changed.id]);
  expect(store.read(first.id, {}, true)?.state).toBe('superseded');
  expect(() => store.edit(first.id, first.revision, fact, management)).toThrow(/changed/);
  expect(
    store
      .search({}, { from: first.observedAt, to: changed.observedAt, historical: true })
      .records.map(({ id }) => id),
  ).toContain(first.id);
});

it('persists queued events across restart, invalidates cached answers, and fences replay after deletion', () => {
  const epoch = enabled();
  const paused = event(epoch, [
    { category: 'fact', content: 'Cedar staging uses a separate domain' },
  ]);
  store.enqueue([paused]);
  store.close();
  store = new MemoryStore(directory);
  expect(store.process()).toBe(1);
  const query = { query: 'Cedar staging' };
  const [first] = store.search({}, query).records;
  expect(first).toBeDefined();
  store.search({}, query);
  expect(store.diagnostics().hits).toBe(1);
  store.enqueue([paused]);
  expect(store.process()).toBe(0);
  store.forget(first.id, first.revision, management);
  expect(store.search({}, query).records).toEqual([]);
  store.enqueue([paused, { ...paused, id: randomUUID(), epoch: store.state.epoch }]);
  store.process();
  expect(store.search({}, query).records).toEqual([]);
  expect(store.db.prepare('SELECT count(*) AS count FROM memory_fts').get()?.count).toBe(0);
});

it('rejects secrets, isolates vector spaces, and removes embeddings on deletion', () => {
  const epoch = enabled();
  expect(() =>
    store.remember(
      profile,
      { category: 'fact', content: 'The password is fake-password' },
      source,
      epoch,
    ),
  ).toThrow(/secrets/);
  const record = store.remember(
    profile,
    { category: 'fact', content: 'Delivery is through courier service' },
    source,
    epoch,
  );
  const [{ checksum }] = store.embeddingBatch({}, {}, 'local-v1', 8);
  const embedding = [1, 0, 1, 0, 0, 0, 0, 1];
  store.saveVectors('local-v1', epoch, [{ checksum, embedding }]);
  expect(store.dense({}, {}, 'local-v1', embedding)[0].id).toBe(record.id);
  expect(store.dense({}, {}, 'local-v2', embedding)).toEqual([]);
  expect(() => store.dense({}, {}, 'local-v1', embedding, 0)).toThrow(/time budget/);
  store.forget(record.id, record.revision, management);
  expect(store.db.prepare('SELECT count(*) AS count FROM vectors').get()?.count).toBe(0);
});

it('invalidates async work when memory is disabled and keeps management available', () => {
  const epoch = enabled();
  const record = store.remember(
    profile,
    { category: 'task', content: 'Follow up with the courier', taskState: 'waiting' },
    source,
    epoch,
  );
  store.enqueue([
    event(epoch, [{ category: 'fact', content: 'An unprocessed fact should be discarded' }]),
  ]);
  store.saveSettings(defaultMemorySettings);
  expect(store.status().pending).toBe(0);
  expect(() => store.remember(profile, record.value, source, epoch)).toThrow(/settings changed/);
  expect(store.search(management, { pending: true }).records.map(({ id }) => id)).toEqual([
    record.id,
  ]);
});

it('keeps temporary chats out of persisted chat history and desktop outbox', async () => {
  const archive = new LocalStorage(directory);
  const data = emptyData();
  data.chat.conversations.push({
    id: source.conversationId,
    title: 'Temporary',
    draft: 'transient-marker',
    pinned: false,
    createdAt: '',
    updatedAt: '',
    temporary: true,
  });
  data.chat.selectedId = source.conversationId;
  await archive.save(data, [
    { ...event(1, [{ category: 'fact', content: 'transient-marker' }]), id: 'a'.repeat(64) },
  ]);
  expect(readFileSync(archive.filename, 'utf8')).not.toContain('transient-marker');
  expect((await new LocalStorage(directory).load()).data.chat).toMatchObject({
    conversations: [],
    messages: [],
    selectedId: null,
  });
});

it('ranks a compact relevance corpus and expands only in-scope relationships', () => {
  const epoch = enabled();
  const fixtures = [
    {
      project: 'orchid',
      content: 'On Windows, desktop packages use the pinned signing certificate.',
      entities: [
        { name: 'Windows', kind: 'technology' as const },
        { name: 'Signing service', kind: 'application' as const },
      ],
      relationships: [{ from: 0, to: 1, relation: 'uses' }],
    },
    {
      project: 'orchid',
      content: 'The signing service runs on the protected build runner.',
      entities: [{ name: 'Signing service', kind: 'application' as const }],
    },
    {
      project: 'fern',
      content: 'Windows packages for Fern are distributed by the vendor.',
      entities: [{ name: 'Windows', kind: 'technology' as const }],
    },
    { project: 'orchid', content: 'For architectural reports use sentence case.', entities: [] },
  ];
  const records = fixtures.map(({ project, content, entities, ...other }) =>
    store.remember(
      choose(project),
      { category: 'project', content, entities, ...other },
      source,
      epoch,
    ),
  );
  const access = { projectId: 'orchid' };
  const cases = [
    [{ query: 'pinned signing certificate' }, records[0].id],
    [{ query: 'architectural reports' }, records[3].id],
    [{ query: 'protected build runner' }, records[1].id],
  ] as const;
  for (const [query, expected] of cases)
    expect(store.search(access, { ...query }).records[0]?.id).toBe(expected);
  const expanded = store
    .search(access, { entity: 'Windows', expand: true })
    .records.map(({ id }) => id);
  expect(expanded).toEqual([records[0].id, records[1].id]);
  expect(store.search(access, { query: 'alpine meadow' }).records).toEqual([]);
});

it('distinguishes equal display names with user-provided identity qualifiers', () => {
  const epoch = enabled();
  for (const qualifier of ['designer', 'legal']) {
    store.remember(
      profile,
      {
        category: 'fact',
        content: `Jordan is the ${qualifier} contact.`,
        entities: [{ name: 'Jordan', kind: 'person', qualifier }],
      },
      source,
      epoch,
    );
  }
  expect(store.resolve({}, 'Jordan')).toMatchObject({
    ambiguous: true,
    matches: [{ name: 'Jordan · designer' }, { name: 'Jordan · legal' }],
  });
});

it('filters elapsed retention immediately and paginates beyond the retrieval candidate limit', () => {
  const epoch = enabled();
  store.remember(
    profile,
    { category: 'episode', content: 'An old issue to expire' },
    source,
    epoch,
    Date.now() - 80 * 86_400_000,
  );
  const { epoch: seedEpoch } = store.saveSettings({
    ...defaultMemorySettings,
    enabled: true,
    retentionDays: 30,
  });
  expect(store.exportPage()).toEqual([]);

  // Avoid a WAL sync for each insert while seeding the temporary database.
  store.db.exec('PRAGMA synchronous=NORMAL');
  for (let i = 0; i < 188; i++)
    store.remember(
      profile,
      { category: 'episode', content: `Timeline note ${i}` },
      undefined,
      seedEpoch,
    );
  store.db.exec('PRAGMA synchronous=FULL');

  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = store.search(management, { cursor, limit: 30 });
    page.records.forEach(({ id }) => seen.add(id));
    cursor = page.cursor;
  } while (cursor);
  expect(seen.size).toBe(188);
});
