import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  defaultMemorySettings,
  memoryInput,
  memorySettingsSchema,
  type MemoryInput,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearch,
  type MemorySearchResult,
  type MemorySettings,
  type MemorySource,
} from '@aria/shared';

export interface MemoryAccess {
  conversationId?: string;
  projectId?: string;
  management?: boolean;
}

export interface MemoryIntake {
  id: string;
  epoch: number;
  observedAt: number;
  scope: MemoryScope;
  source: MemorySource;
  candidates: MemoryInput[];
}

type Ranked = { id: string; rank: number };
type Entry = MemoryRecord & { checksum: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const normalize = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const day = 86_400_000;
const maxCandidates = 180;
const cacheSize = 80;

export function containsSecret(value: string): boolean {
  return /-----BEGIN[ A-Z]*PRIVATE KEY-----|\b(?:sk-[a-z0-9_-]{16,}|(?:gh[pousr]_|github_pat_|xox[baprs]-|AKIA)[a-z0-9_-]{12,})\b|\b(?:password|passwd|passphrase|(?:api|access|secret|private)[ _-]?key|(?:auth|access|refresh)[ _-]?token|client[ _-]?secret|seed phrase)\s*(?::|=|is\b)\s*\S|\b(?:authorization\s*:\s*)?bearer\s+[a-z0-9._~-]{12,}|:\/\/[^\s/:]+:[^\s/@]+@/iu.test(
    value,
  );
}

function rowPayload(row: Record<string, unknown>): MemoryRecord {
  return JSON.parse(String(row.payload)) as MemoryRecord;
}

function rowRecord(row: Record<string, unknown>): Entry {
  return { ...rowPayload(row), checksum: String(row.checksum) };
}

function projectRecord(entry: Entry): MemoryRecord {
  const record: MemoryRecord & { checksum?: string } = { ...entry };
  delete record.checksum;
  return record;
}

function scopeKey(scope: MemoryScope) {
  return scope.kind === 'profile' ? 'profile' : `${scope.kind}:${scope.id}`;
}

function searchable(query: string, exact: boolean, operator = 'OR') {
  const terms = [...new Set(query.match(/[\p{L}\p{N}\p{M}_]+/gu) ?? [])].slice(0, 18);
  if (!terms.length) return undefined;
  return exact ? `"${terms.join(' ')}"` : terms.map((term) => `"${term}"`).join(` ${operator} `);
}

export class MemoryStore {
  readonly db: DatabaseSync;
  readonly profile: string;
  private readonly searchCache = new Map<string, { value: MemorySearchResult; until: number }>();
  private readonly metrics = { searches: 0, hits: 0, searchMs: 0, candidates: 0, duplicates: 0 };
  private readonly filename: string;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.filename = path.join(directory, 'memory.sqlite');
    closeSync(openSync(this.filename, 'a', 0o600));
    this.db = new DatabaseSync(this.filename);
    try {
      this.db.exec(
        'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;',
      );
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 1) throw new Error('This memory database requires a newer version of Aria.');
      if (!version) this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.profile = String(this.db.prepare('SELECT profile FROM state').get()?.profile);
  }

  private migrate() {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE state (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), profile TEXT NOT NULL,
          settings TEXT NOT NULL, epoch INTEGER NOT NULL, revision INTEGER NOT NULL, cutoff INTEGER NOT NULL
        );
        CREATE TABLE memories (
          rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, profile TEXT NOT NULL, scope TEXT NOT NULL,
          category TEXT NOT NULL, checksum TEXT NOT NULL, fact_key TEXT, state TEXT NOT NULL,
          observed INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER, task_state TEXT,
          content TEXT NOT NULL, payload TEXT NOT NULL
        );
        CREATE INDEX memory_scope ON memories(profile,scope,state,observed DESC,id);
        CREATE INDEX memory_checksum ON memories(profile,scope,category,checksum,state);
        CREATE INDEX memory_fact ON memories(profile,scope,category,fact_key,state);
        CREATE INDEX memory_expiry ON memories(expires) WHERE expires IS NOT NULL;
        CREATE INDEX memory_tasks ON memories(profile,scope,task_state,state);
        CREATE VIRTUAL TABLE memory_fts USING fts5(content, tokenize='unicode61');
        INSERT INTO memory_fts(memory_fts,rank) VALUES ('secure-delete',1);
        CREATE TRIGGER memory_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER memory_delete AFTER DELETE ON memories BEGIN
          DELETE FROM memory_fts WHERE rowid=old.rowid;
        END;
        CREATE TRIGGER memory_text AFTER UPDATE OF content ON memories WHEN new.content != old.content BEGIN
          DELETE FROM memory_fts WHERE rowid=old.rowid;
          INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TABLE sources (
          memory TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          conversation TEXT NOT NULL, message TEXT NOT NULL, PRIMARY KEY(memory,conversation,message)
        );
        CREATE INDEX source_message ON sources(conversation,message);
        CREATE TABLE entities (
          id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
          normalized TEXT NOT NULL
        );
        CREATE TABLE aliases (
          entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, alias TEXT NOT NULL,
          normalized TEXT NOT NULL, PRIMARY KEY(entity,normalized)
        );
        CREATE INDEX alias_name ON aliases(normalized,entity);
        CREATE TABLE memory_entities (
          memory TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          entity TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE, PRIMARY KEY(memory,entity)
        );
        CREATE INDEX entity_memories ON memory_entities(entity,memory);
        CREATE TABLE relationships (
          memory TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          source TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          target TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          relation TEXT NOT NULL, PRIMARY KEY(memory,source,target,relation)
        );
        CREATE INDEX relationship_source ON relationships(source,target);
        CREATE INDEX relationship_target ON relationships(target,source);
        CREATE TABLE vectors (
          checksum TEXT NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL,
          vector BLOB NOT NULL, PRIMARY KEY(checksum,model)
        );
        CREATE TABLE jobs (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, data TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE receipts (id TEXT PRIMARY KEY, created INTEGER NOT NULL, state TEXT NOT NULL);
        CREATE TABLE blocked_sources (conversation TEXT NOT NULL, message TEXT NOT NULL,
          PRIMARY KEY(conversation,message));
        CREATE TABLE blocked_facts (scope TEXT NOT NULL, category TEXT NOT NULL, fact_key TEXT NOT NULL,
          PRIMARY KEY(scope,category,fact_key));
        PRAGMA user_version=1;
      `);
      this.db
        .prepare('INSERT INTO state VALUES (1,?,?,1,0,0)')
        .run(randomUUID(), JSON.stringify(defaultMemorySettings));
    });
  }

  transaction<T>(execute: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = execute();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  get state() {
    const row = this.db.prepare('SELECT settings,epoch,revision,cutoff FROM state').get()!;
    return {
      settings: memorySettingsSchema.parse(JSON.parse(String(row.settings))),
      epoch: Number(row.epoch),
      revision: Number(row.revision),
      cutoff: Number(row.cutoff),
    };
  }

  status() {
    return {
      ...this.state,
      records: Number(
        this.db
          .prepare("SELECT count(*) AS total FROM memories WHERE state IN ('active','conflicting')")
          .get()?.total,
      ),
      pending: Number(this.db.prepare('SELECT count(*) AS total FROM jobs').get()?.total),
      failures: Number(
        this.db.prepare("SELECT count(*) AS total FROM receipts WHERE state='failed'").get()?.total,
      ),
    };
  }

  diagnostics() {
    const size = (file: string) => statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    return {
      ...this.metrics,
      databaseBytes: size(this.filename),
      walBytes: size(`${this.filename}-wal`),
      workerHeapBytes: process.memoryUsage().heapUsed,
    };
  }

  private changed(fence = false) {
    this.db
      .prepare(
        'UPDATE state SET revision=revision+1, epoch=epoch+?, cutoff=CASE WHEN ? THEN max(cutoff,?) ELSE cutoff END',
      )
      .run(Number(fence), Number(fence), Date.now());
    if (fence) this.db.exec('DELETE FROM jobs');
    this.searchCache.clear();
  }

  saveSettings(settings: MemorySettings) {
    this.transaction(() => {
      const previous = this.state.settings;
      this.db.prepare('UPDATE state SET settings=?').run(JSON.stringify(settings));
      if (JSON.stringify(previous.embedding) !== JSON.stringify(settings.embedding))
        this.db.exec('DELETE FROM vectors');
      this.changed(previous.enabled !== settings.enabled);
    });
    this.maintain();
    return this.status();
  }

  private scopeWhere(access: MemoryAccess, query: MemorySearch = {}) {
    const args: SQLInputValue[] = [this.profile];
    let sql = 'm.profile=?';
    if (!access.management) {
      const permitted = ['profile'];
      if (access.conversationId) permitted.push(`conversation:${access.conversationId}`);
      if (access.projectId) permitted.push(`project:${access.projectId}`);
      const scopes = query.scope
        ? permitted.filter((scope) => scope === query.scope || scope.startsWith(`${query.scope}:`))
        : permitted;
      sql += scopes.length ? ` AND m.scope IN (${scopes.map(() => '?').join(',')})` : ' AND 0';
      args.push(...scopes);
      if (access.projectId) sql += " AND (m.scope!='profile' OR m.category='preference')";
    } else if (query.projectId || query.conversationId || query.scope) {
      const scope = query.projectId
        ? `project:${query.projectId}`
        : query.conversationId
          ? `conversation:${query.conversationId}`
          : query.scope;
      if (scope === 'project' || scope === 'conversation') {
        sql += ' AND m.scope LIKE ?';
        args.push(`${scope}:%`);
      } else {
        sql += ' AND m.scope=?';
        args.push(scope!);
      }
    }
    return { sql, args };
  }

  private visibility(access: MemoryAccess, query: MemorySearch) {
    const { sql, args } = this.scopeWhere(access, query);
    const clauses = [sql];
    if (!query.historical && query.from === undefined && query.to === undefined) {
      clauses.push("m.state IN ('active','conflicting')", '(m.expires IS NULL OR m.expires>?)');
      args.push(Date.now());
    } else {
      clauses.push("m.state!='expired'", '(m.expires IS NULL OR m.expires>?)');
      args.push(Date.now());
    }
    const retention = this.state.settings.retentionDays;
    if (retention) {
      clauses.push('m.observed>=?');
      args.push(Date.now() - retention * day);
    }
    if (query.category) {
      clauses.push('m.category=?');
      args.push(query.category);
    }
    if (query.from !== undefined) {
      clauses.push('m.observed>=?');
      args.push(query.from);
    }
    if (query.to !== undefined) {
      clauses.push('m.observed<=?');
      args.push(query.to);
    }
    if (query.pending) clauses.push("m.task_state IN ('pending','in-progress','waiting')");
    return { sql: clauses.join(' AND '), args };
  }

  read(id: string, access: MemoryAccess, historical = false): MemoryRecord | undefined {
    const { sql, args } = this.visibility(access, { historical });
    const row = this.db
      .prepare(`SELECT m.payload,m.checksum FROM memories m WHERE ${sql} AND m.id=?`)
      .get(...args, id);
    return row && rowPayload(row);
  }

  private writable(scope: MemoryScope, access: MemoryAccess) {
    return (
      access.management ||
      scope.kind === 'profile' ||
      (scope.kind === 'conversation' && scope.id === access.conversationId) ||
      (scope.kind === 'project' && scope.id === access.projectId)
    );
  }

  private validate(value: MemoryInput, scope: MemoryScope) {
    const parsed = memoryInput.parse(value);
    if (containsSecret(JSON.stringify(parsed)))
      throw new Error('Memory cannot contain credentials or authentication secrets.');
    if (parsed.category !== 'task' && (parsed.taskState || parsed.dependsOn?.length))
      throw new Error('Task state and dependencies require a task memory.');
    if (
      parsed.relationships?.some(
        ({ from, to }) => from === to || !parsed.entities?.[from] || !parsed.entities[to],
      )
    )
      throw new Error('Memory relationships require two distinct listed entities.');
    if (parsed.expiresAt !== undefined && parsed.expiresAt <= Date.now())
      throw new Error('Choose an expiration in the future.');
    for (const id of parsed.dependsOn ?? []) {
      const record = this.db
        .prepare("SELECT id FROM memories WHERE scope=? AND id=? AND category='task'")
        .get(scopeKey(scope), id);
      if (!record) throw new Error('A task dependency must belong to the same memory scope.');
    }
    return parsed;
  }

  private insert(record: MemoryRecord, checksum: string) {
    this.db
      .prepare(
        `
      INSERT INTO memories (id,profile,scope,category,checksum,fact_key,state,observed,created,expires,task_state,content,payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET category=excluded.category,checksum=excluded.checksum,
        fact_key=excluded.fact_key,state=excluded.state,observed=excluded.observed,expires=excluded.expires,
        task_state=excluded.task_state,content=excluded.content,payload=excluded.payload
    `,
      )
      .run(
        record.id,
        this.profile,
        scopeKey(record.scope),
        record.value.category,
        checksum,
        record.value.factKey ? normalize(record.value.factKey) : null,
        record.state,
        record.observedAt,
        record.createdAt,
        record.value.expiresAt ?? null,
        record.value.taskState ?? null,
        record.value.content,
        JSON.stringify(record),
      );
    for (const source of record.sources)
      this.db
        .prepare('INSERT OR IGNORE INTO sources VALUES (?,?,?)')
        .run(record.id, source.conversationId, source.messageId);
  }

  private associate(record: MemoryRecord) {
    this.db.prepare('DELETE FROM relationships WHERE memory=?').run(record.id);
    this.db.prepare('DELETE FROM memory_entities WHERE memory=?').run(record.id);
    const key = scopeKey(record.scope);
    const ids = (record.value.entities ?? []).map((entity) => {
      const normalized = normalize([entity.name, entity.qualifier].filter(Boolean).join(' · '));
      const found = entity.id
        ? this.db
            .prepare('SELECT id FROM entities WHERE id=? AND scope=? AND kind=?')
            .get(entity.id, key, entity.kind)
        : this.db
            .prepare('SELECT id FROM entities WHERE scope=? AND kind=? AND normalized=? LIMIT 2')
            .all(key, entity.kind, normalized);
      if (entity.id && !found) throw new Error('The entity is outside this memory scope.');
      const id = Array.isArray(found)
        ? found.length === 1
          ? String(found[0].id)
          : randomUUID()
        : String(found!.id);
      this.db
        .prepare('INSERT OR IGNORE INTO entities VALUES (?,?,?,?,?)')
        .run(
          id,
          key,
          entity.kind,
          [entity.name, entity.qualifier].filter(Boolean).join(' · '),
          normalized,
        );
      this.db.prepare('INSERT OR IGNORE INTO memory_entities VALUES (?,?)').run(record.id, id);
      return id;
    });
    for (const { from, to, relation } of record.value.relationships ?? [])
      this.db
        .prepare('INSERT OR IGNORE INTO relationships VALUES (?,?,?,?)')
        .run(record.id, ids[from], ids[to], relation);
    this.rebuildAliases(ids);
  }

  private rebuildAliases(ids: string[]) {
    for (const id of new Set(ids)) {
      this.db.prepare('DELETE FROM aliases WHERE entity=?').run(id);
      const entity = this.db.prepare('SELECT name FROM entities WHERE id=?').get(id);
      if (!entity) continue;
      const name = String(entity.name);
      const values = [name];
      const records = this.db
        .prepare(
          `
        SELECT m.payload FROM memories m JOIN memory_entities me ON m.id=me.memory WHERE me.entity=?
      `,
        )
        .iterate(id);
      for (const row of records) {
        const record = JSON.parse(String(row.payload)) as MemoryRecord;
        for (const item of record.value.entities ?? [])
          if (
            item.id === id ||
            normalize([item.name, item.qualifier].filter(Boolean).join(' · ')) === normalize(name)
          )
            values.push(item.name, ...(item.aliases ?? []));
      }
      for (const alias of values)
        this.db
          .prepare('INSERT OR IGNORE INTO aliases VALUES (?,?,?)')
          .run(id, alias, normalize(alias));
    }
  }

  private updateState(previous: Entry, state: MemoryRecord['state']) {
    const { checksum, ...record } = previous;
    this.insert(
      { ...record, state, revision: record.revision + 1, updatedAt: Date.now() },
      checksum,
    );
  }

  private write(
    value: MemoryInput,
    scope: MemoryScope,
    source: MemorySource | undefined,
    origin: MemoryRecord['origin'],
    observedAt: number,
    previous?: MemoryRecord,
  ) {
    const parsed = this.validate(value, scope);
    const key = scopeKey(scope);
    const now = Date.now();
    const checksum = digest(normalize(parsed.content));
    const fact = parsed.factKey ? normalize(parsed.factKey) : undefined;
    if (
      origin === 'extractive' &&
      ((source &&
        this.db
          .prepare('SELECT 1 FROM blocked_sources WHERE conversation=? AND message=?')
          .get(source.conversationId, source.messageId)) ||
        (fact &&
          this.db
            .prepare('SELECT 1 FROM blocked_facts WHERE scope=? AND category=? AND fact_key=?')
            .get(key, parsed.category, fact)))
    )
      return undefined;
    const duplicate =
      !previous &&
      this.db
        .prepare(
          `
      SELECT payload,checksum FROM memories WHERE profile=? AND scope=? AND category=? AND checksum=?
        AND state IN ('active','conflicting') LIMIT 1
    `,
        )
        .get(this.profile, key, parsed.category, checksum);
    if (duplicate) {
      this.metrics.duplicates++;
      const matched = rowPayload(duplicate);
      const promote = origin === 'user' && matched.confirmation !== 'confirmed';
      const alreadyLinked =
        source && matched.sources.some((item) => item.messageId === source.messageId);
      if (!promote && (!source || alreadyLinked)) return matched;
      const record: MemoryRecord = {
        ...matched,
        ...(promote && { origin, confidence: 1, confirmation: 'confirmed' }),
        sources:
          source && !alreadyLinked ? [...matched.sources, source].slice(-12) : matched.sources,
        revision: matched.revision + 1,
        updatedAt: now,
      };
      this.insert(record, checksum);
      return record;
    }
    const conflicts = fact
      ? this.db
          .prepare(
            `
      SELECT payload,checksum FROM memories WHERE profile=? AND scope=? AND category=? AND fact_key=?
        AND state IN ('active','conflicting') AND (expires IS NULL OR expires>?) ORDER BY observed DESC LIMIT 40
    `,
          )
          .all(this.profile, key, parsed.category, fact, now)
          .map(rowRecord)
      : [];
    const confirmed = conflicts.find((record) => record.confirmation === 'confirmed');
    const supersedes =
      previous?.id ?? (origin === 'user' ? (confirmed ?? conflicts[0])?.id : undefined);
    const record: MemoryRecord = {
      id: randomUUID(),
      revision: 1,
      scope,
      value: parsed,
      sources: [...(previous?.sources ?? []), ...(source ? [source] : [])].slice(-12),
      origin,
      confirmation: origin === 'user' ? 'confirmed' : 'inferred',
      confidence: origin === 'user' ? 1 : 0.55,
      sensitivity: 'private',
      state: origin === 'extractive' && conflicts.length ? 'conflicting' : 'active',
      ...(supersedes && { supersedes }),
      createdAt: now,
      updatedAt: now,
      observedAt,
    };
    if (origin === 'user') {
      for (const conflict of conflicts) this.updateState(conflict, 'superseded');
      if (previous && !conflicts.some(({ id }) => id === previous.id)) {
        const row = this.db.prepare('SELECT checksum FROM memories WHERE id=?').get(previous.id)!;
        this.updateState({ ...previous, checksum: String(row.checksum) }, 'superseded');
      }
    }
    this.insert(record, checksum);
    this.associate(record);
    return record;
  }

  remember(
    scope: MemoryScope,
    value: MemoryInput,
    source: MemorySource | undefined,
    epoch: number,
    observedAt = Date.now(),
  ) {
    return this.transaction(() => {
      const state = this.state;
      if (!state.settings.enabled || state.epoch !== epoch)
        throw new Error('Memory settings changed.');
      if (
        state.settings.retentionDays &&
        observedAt < Date.now() - state.settings.retentionDays * day
      )
        throw new Error('The source predates the current memory retention window.');
      const result = this.write(
        value,
        scope,
        source,
        'user',
        Number.isFinite(observedAt) ? observedAt : Date.now(),
      )!;
      this.changed();
      return result;
    });
  }

  edit(
    id: string,
    revision: number,
    value: MemoryInput,
    access: MemoryAccess,
    source?: MemorySource,
    epoch?: number,
  ) {
    return this.transaction(() => {
      if (!access.management && (!this.state.settings.enabled || this.state.epoch !== epoch))
        throw new Error('Memory settings changed.');
      const record = this.read(id, access, true);
      if (
        !record ||
        record.revision !== revision ||
        record.state === 'superseded' ||
        !this.writable(record.scope, access)
      )
        throw new Error('The memory changed or is unavailable. Refresh and try again.');
      if (value.dependsOn?.includes(id)) throw new Error('A task cannot depend on itself.');
      const edit = this.write(value, record.scope, source, 'user', Date.now(), record)!;
      const priorEntities = this.entityIds(id);
      this.db.prepare('DELETE FROM memory_entities WHERE memory=?').run(id);
      this.db.prepare('DELETE FROM relationships WHERE memory=?').run(id);
      this.collectOrphans(priorEntities);
      this.changed(true);
      return edit;
    });
  }

  private entityIds(id: string) {
    return this.db
      .prepare('SELECT entity FROM memory_entities WHERE memory=?')
      .all(id)
      .map(({ entity }) => String(entity));
  }

  private collectOrphans(ids: string[]) {
    this.db.exec(
      'DELETE FROM entities WHERE NOT EXISTS (SELECT 1 FROM memory_entities me WHERE me.entity=entities.id)',
    );
    this.rebuildAliases(ids);
    this.db.exec(
      'DELETE FROM vectors WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.checksum=vectors.checksum)',
    );
  }

  private erase(ids: string[]) {
    const touched = new Set<string>();
    for (const id of ids) {
      for (const entity of this.entityIds(id)) touched.add(entity);
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO blocked_sources SELECT conversation,message FROM sources WHERE memory=?
      `,
        )
        .run(id);
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO blocked_facts
        SELECT scope,category,fact_key FROM memories WHERE id=? AND fact_key IS NOT NULL
      `,
        )
        .run(id);
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
    }
    this.collectOrphans([...touched]);
  }

  forget(id: string, revision: number, access: MemoryAccess, epoch?: number) {
    return this.transaction(() => {
      if (!access.management && (!this.state.settings.enabled || this.state.epoch !== epoch))
        throw new Error('Memory settings changed.');
      const record = this.read(id, access, true);
      if (!record || record.revision !== revision || !this.writable(record.scope, access))
        throw new Error('The memory changed or is unavailable. Refresh and try again.');
      this.erase([id]);
      this.changed(true);
    });
  }

  clear(filter: { category?: MemoryInput['category']; projectId?: string }) {
    return this.transaction(() => {
      const { sql, args } = this.scopeWhere({ management: true }, filter);
      const category = filter.category ? ' AND m.category=?' : '';
      if (filter.category) args.push(filter.category);
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO blocked_sources
        SELECT s.conversation,s.message FROM sources s JOIN memories m ON m.id=s.memory WHERE ${sql}${category}
      `,
        )
        .run(...args);
      this.db
        .prepare(
          `
        INSERT OR IGNORE INTO blocked_facts
        SELECT m.scope,m.category,m.fact_key FROM memories m WHERE ${sql}${category} AND m.fact_key IS NOT NULL
      `,
        )
        .run(...args);
      const result = this.db
        .prepare(`DELETE FROM memories AS m WHERE ${sql}${category}`)
        .run(...args);
      this.collectOrphans(
        this.db
          .prepare('SELECT id FROM entities')
          .all()
          .map(({ id }) => String(id)),
      );
      this.changed(true);
      return Number(result.changes);
    });
  }

  removeConversation(conversationId: string) {
    this.transaction(() => {
      const ids = this.db
        .prepare('SELECT id FROM memories WHERE scope=?')
        .all(`conversation:${conversationId}`)
        .map(({ id }) => String(id));
      if (ids.length) this.erase(ids);
      this.changed(true);
    });
  }

  enqueue(events: MemoryIntake[]) {
    return this.transaction(() => {
      const { epoch, cutoff, settings } = this.state;
      if (!settings.enabled) return events.map(({ id }) => id);
      const pending = Number(this.db.prepare('SELECT count(*) AS value FROM jobs').get()?.value);
      const accepted: string[] = [];
      for (const event of events.slice(0, Math.max(0, 128 - pending))) {
        if (
          event.epoch === epoch &&
          event.observedAt > cutoff &&
          !this.db.prepare('SELECT 1 FROM receipts WHERE id=?').get(event.id)
        )
          this.db
            .prepare('INSERT OR IGNORE INTO jobs(id,epoch,data) VALUES (?,?,?)')
            .run(event.id, event.epoch, JSON.stringify(event));
        accepted.push(event.id);
      }
      return accepted;
    });
  }

  process() {
    const { epoch, settings } = this.state;
    if (!settings.enabled) return 0;
    const jobs = this.db
      .prepare('SELECT id,epoch,data,attempts FROM jobs WHERE retry_at<=? ORDER BY rowid LIMIT 6')
      .all(Date.now());
    for (const job of jobs) {
      const id = String(job.id);
      try {
        this.transaction(() => {
          if (job.epoch === epoch) {
            const event = JSON.parse(String(job.data)) as MemoryIntake;
            for (const candidate of event.candidates)
              this.write(candidate, event.scope, event.source, 'extractive', event.observedAt);
            this.changed();
          }
          this.db
            .prepare("INSERT OR IGNORE INTO receipts VALUES (?,?,'completed')")
            .run(id, Date.now());
          this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
        });
      } catch {
        const attempts = Number(job.attempts) + 1;
        this.transaction(() => {
          if (attempts < 3) {
            this.db
              .prepare('UPDATE jobs SET attempts=?,retry_at=? WHERE id=?')
              .run(attempts, Date.now() + 1000 * 2 ** attempts, id);
          } else {
            this.db
              .prepare("INSERT OR IGNORE INTO receipts VALUES (?,?,'failed')")
              .run(id, Date.now());
            this.db.prepare('DELETE FROM jobs WHERE id=?').run(id);
          }
        });
      }
    }
    return jobs.length;
  }

  maintain() {
    this.transaction(() => {
      const retention = this.state.settings.retentionDays;
      const now = Date.now();
      const rows = this.db
        .prepare(
          `
        SELECT id FROM memories WHERE expires<=? OR observed<? ORDER BY observed LIMIT 128
      `,
        )
        .all(now, retention ? now - retention * day : 0);
      if (rows.length) {
        this.erase(rows.map(({ id }) => String(id)));
        this.changed(true);
      }
      this.db.prepare('DELETE FROM receipts WHERE created<?').run(now - 45 * day);
    });
  }

  private entityMatches(access: MemoryAccess, query: MemorySearch) {
    const { sql, args } = this.visibility(access, query);
    const rows = this.db
      .prepare(
        `
      SELECT DISTINCT e.id, e.name, e.kind, e.scope FROM aliases a JOIN entities e ON e.id=a.entity
      JOIN memory_entities me ON me.entity=e.id JOIN memories m ON m.id=me.memory
      WHERE a.normalized=? AND ${sql} ORDER BY e.name,e.id LIMIT 18
    `,
      )
      .all(normalize(query.entity ?? query.query ?? ''), ...args);
    return rows.map(({ id, name, kind, scope }) => ({
      id: String(id),
      name: String(name),
      kind: String(kind),
      scope: String(scope),
    }));
  }

  resolve(access: MemoryAccess, name: string, kind?: string) {
    const matches = this.entityMatches(access, { entity: name }).filter(
      (entity) => !kind || entity.kind === kind,
    );
    return { matches, ambiguous: matches.length > 1 };
  }

  search(access: MemoryAccess, query: MemorySearch, dense: Ranked[] = []): MemorySearchResult {
    const started = performance.now();
    const { revision } = this.state;
    const historical = query.historical || query.from !== undefined || query.to !== undefined;
    const rankedQuery = Boolean(query.query || query.entity);
    const requested = Math.min(query.limit ?? 8, access.management ? 30 : 6);
    const cacheKey = JSON.stringify([revision, access, query]);
    this.metrics.searches++;
    const cached = dense.length ? undefined : this.searchCache.get(cacheKey);
    if (cached && cached.until > Date.now()) {
      this.metrics.hits++;
      this.searchCache.delete(cacheKey);
      this.searchCache.set(cacheKey, cached);
      return cached.value;
    }
    const cursorKey = digest(JSON.stringify([access, { ...query, cursor: undefined }])).slice(
      0,
      20,
    );
    const [cursorRevision, cursorScope, position] = query.cursor?.split('.') ?? [];
    const offset = query.cursor ? Number(position) : 0;
    if (
      query.cursor &&
      (Number(cursorRevision) !== revision ||
        cursorScope !== cursorKey ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        (rankedQuery && offset >= maxCandidates))
    )
      throw new Error('Search results changed. Start again from the first page.');
    const scope = this.visibility(access, query);
    const terms = query.query && searchable(query.query, query.match === 'phrase');
    const ranking = new Map<string, number>();
    const collect = (list: { id?: unknown }[], weight: number) => {
      list.forEach(({ id }, position) => {
        const key = String(id);
        ranking.set(key, (ranking.get(key) ?? 0) + weight / (30 + position));
      });
    };
    if (terms && query.match !== 'semantic') {
      const search = this.db.prepare(`
        SELECT m.id FROM memory_fts f JOIN memories m ON m.rowid=f.rowid
        WHERE memory_fts MATCH ? AND ${scope.sql} ORDER BY rank LIMIT ?
      `);
      const phrase = query.query && searchable(query.query, true);
      if (phrase && phrase !== terms) collect(search.all(phrase, ...scope.args, 60), 1.2);
      const conjunction =
        query.query && query.match !== 'phrase' && searchable(query.query, false, 'AND');
      if (conjunction && conjunction !== terms)
        collect(search.all(conjunction, ...scope.args, maxCandidates), 1);
      if (ranking.size < requested + offset + 1 || !conjunction || conjunction === terms)
        collect(search.all(terms, ...scope.args, maxCandidates), 0.9);
    }
    if (dense.length) collect(dense, 1.1);
    if (query.entity || (query.query && query.match !== 'semantic')) {
      const entities = this.entityMatches(access, query).map(({ id }) => id);
      if (entities.length) {
        const placeholders = entities.map(() => '?').join(',');
        collect(
          this.db
            .prepare(
              `
          SELECT DISTINCT m.id FROM memory_entities me JOIN memories m ON m.id=me.memory
          WHERE me.entity IN (${placeholders}) AND ${scope.sql} ORDER BY m.observed DESC,m.id LIMIT 90
        `,
            )
            .all(...entities, ...scope.args),
          1.3,
        );
        if (query.expand)
          collect(
            this.db
              .prepare(
                `
          WITH adjacent(id) AS (
            SELECT r.target FROM relationships r JOIN memories m ON m.id=r.memory
            WHERE r.source IN (${placeholders}) AND ${scope.sql}
            UNION
            SELECT r.source FROM relationships r JOIN memories m ON m.id=r.memory
            WHERE r.target IN (${placeholders}) AND ${scope.sql}
          )
          SELECT DISTINCT m.id FROM adjacent a JOIN memory_entities me ON me.entity=a.id
          JOIN memories m ON m.id=me.memory
          WHERE ${scope.sql} ORDER BY m.observed DESC,m.id LIMIT 60
        `,
              )
              .all(...entities, ...scope.args, ...entities, ...scope.args, ...scope.args),
            0.6,
          );
      }
    }
    let ordered: MemoryRecord[];
    if (rankedQuery) {
      const ids = [...ranking.keys()].slice(0, 350);
      const rows = ids.length
        ? this.db
            .prepare(
              `
        SELECT m.payload,m.checksum FROM memories m
        WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${scope.sql}
      `,
            )
            .all(...ids, ...scope.args)
            .map(rowRecord)
        : [];
      this.metrics.candidates += rows.length;
      const now = Date.now();
      const score = (item: MemoryRecord) =>
        (ranking.get(item.id) ?? 0) *
        (1 +
          0.32 * item.confidence +
          0.04 * (item.value.importance ?? 0) +
          (item.scope.kind === 'conversation' ? 0.17 : 0) +
          (!historical && item.state !== 'conflicting' ? 0.08 : 0) +
          (!historical ? 0.08 / (1 + Math.max(0, now - item.observedAt) / (30 * day)) : 0));
      const seen = new Set<string>();
      ordered = rows
        .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
        .filter(({ checksum }) => !seen.has(checksum) && Boolean(seen.add(checksum)))
        .slice(0, maxCandidates)
        .map(projectRecord);
    } else {
      ordered = this.db
        .prepare(
          `
        SELECT m.payload FROM memories m WHERE ${scope.sql} ORDER BY m.observed DESC,m.id LIMIT ? OFFSET ?
      `,
        )
        .all(...scope.args, requested + 1, offset)
        .map(({ payload }) => JSON.parse(String(payload)) as MemoryRecord);
    }
    const start = rankedQuery ? offset : 0;
    const result = {
      records: ordered.slice(start, start + requested),
      ...(start + requested < ordered.length && {
        cursor: `${revision}.${cursorKey}.${offset + requested}`,
      }),
    };
    this.metrics.searchMs += performance.now() - started;
    if (!dense.length) {
      const retention = this.state.settings.retentionDays;
      const until = Math.min(
        Date.now() + 5000,
        ...result.records.map((item) =>
          Math.min(
            item.value.expiresAt ?? Infinity,
            retention ? item.observedAt + retention * day : Infinity,
          ),
        ),
      );
      this.searchCache.set(cacheKey, { value: result, until });
      if (this.searchCache.size > cacheSize)
        this.searchCache.delete(this.searchCache.keys().next().value!);
    }
    return result;
  }

  embeddingBatch(access: MemoryAccess, query: MemorySearch, model: string, limit: number) {
    const { sql, args } = this.visibility(access, query);
    return this.db
      .prepare(
        `
      SELECT m.checksum, min(m.content) AS content FROM memories m
      WHERE ${sql} AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.model=? AND v.checksum=m.checksum)
      GROUP BY m.checksum ORDER BY max(m.observed) DESC LIMIT ?
    `,
      )
      .all(...args, model, limit)
      .map(({ checksum, content }) => ({ checksum: String(checksum), content: String(content) }));
  }

  saveVectors(model: string, epoch: number, vectors: { checksum: string; embedding: number[] }[]) {
    this.transaction(() => {
      if (this.state.epoch !== epoch || !this.state.settings.enabled) return;
      const statement = this.db.prepare(`
        INSERT OR IGNORE INTO vectors(checksum,model,dimensions,vector)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM memories WHERE checksum=?)
      `);
      for (const { checksum, embedding } of vectors) {
        const magnitude = Math.hypot(...embedding);
        if (
          embedding.length < 8 ||
          embedding.length > 4096 ||
          !Number.isFinite(magnitude) ||
          !magnitude
        )
          throw new Error('The embedding backend returned an invalid vector.');
        const bytes = Buffer.allocUnsafe(embedding.length * 4);
        embedding.forEach((value, index) => bytes.writeFloatLE(value / magnitude, index * 4));
        statement.run(checksum, model, embedding.length, bytes, checksum);
      }
    });
  }

  dense(
    access: MemoryAccess,
    query: MemorySearch,
    model: string,
    vector: number[],
    milliseconds?: number,
  ) {
    const magnitude = Math.hypot(...vector);
    if (!magnitude || !Number.isFinite(magnitude))
      throw new Error('The query embedding is invalid.');
    const normalized = Float32Array.from(vector, (number) => number / magnitude);
    const { sql, args } = this.visibility(access, query);
    const rows = this.db
      .prepare(
        `
      SELECT m.id, v.vector FROM memories m JOIN vectors v ON v.checksum=m.checksum
      WHERE ${sql} AND v.model=? AND v.dimensions=?
    `,
      )
      .iterate(...args, model, vector.length);
    const best: Ranked[] = [];
    const limit = maxCandidates;
    let threshold = -Infinity;
    const deadline = milliseconds === undefined ? Infinity : performance.now() + milliseconds;
    let scanned = 0;
    for (const { id, vector: bytes } of rows) {
      if ((scanned++ & 255) === 0 && performance.now() >= deadline) {
        throw new Error(
          'The semantic memory scan exceeded its time budget. Narrow the scope or use lexical search.',
        );
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== vector.length * 4) continue;
      let rank = 0;
      if (bytes.byteOffset % 4 === 0) {
        const values = new Float32Array(bytes.buffer, bytes.byteOffset, normalized.length);
        for (let index = 0; index < normalized.length; index++)
          rank += values[index] * normalized[index];
      } else {
        const values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < normalized.length; index++)
          rank += values.getFloat32(index * 4, true) * normalized[index];
      }
      if (rank <= threshold) continue;
      best.push({ id: String(id), rank });
      if (best.length >= 2 * limit) {
        best.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
        best.length = limit;
        threshold = best[limit - 1].rank;
      }
    }
    return best.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id)).slice(0, limit);
  }

  exportPage(after = '') {
    const { sql, args } = this.visibility({ management: true }, { historical: true });
    return this.db
      .prepare(`SELECT m.payload FROM memories m WHERE ${sql} AND m.id>? ORDER BY m.id LIMIT 100`)
      .all(...args, after)
      .map(rowPayload);
  }
}
