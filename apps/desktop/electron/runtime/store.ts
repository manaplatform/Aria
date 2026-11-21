import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  executionLimits,
  runtimeSettingsSchema,
  type RuntimeSettings,
  type ToolProblem,
} from '@aria/shared';

export class RuntimeError extends Error {
  constructor(
    readonly code: ToolProblem['code'],
    message: string,
  ) {
    super(message);
  }
}

export function digest(bytes: string | Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export class RuntimeStore {
  private database?: DatabaseSync;

  constructor(private readonly directory: string) {}

  get db() {
    if (this.database) return this.database;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const databaseFile = path.join(this.directory, 'runtime.sqlite');
    closeSync(openSync(databaseFile, 'a', 0o600));
    const db = new DatabaseSync(databaseFile);
    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL;');
      const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
      if (version > 1) throw new Error('This runtime profile requires a newer version of Aria.');
      if (version === 0) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
          CREATE TABLE sessions (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, engine TEXT NOT NULL, provider TEXT NOT NULL,
            created INTEGER NOT NULL, touched INTEGER NOT NULL, state TEXT NOT NULL
          );
          CREATE TABLE attempts (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, turn TEXT NOT NULL, request TEXT NOT NULL,
            step TEXT NOT NULL, call TEXT NOT NULL, session TEXT, fingerprint TEXT NOT NULL,
            operation TEXT NOT NULL, state TEXT NOT NULL, started INTEGER NOT NULL,
            elapsed INTEGER, exit_code INTEGER,
            UNIQUE(conversation, turn, fingerprint)
          );
          CREATE TABLE hosted_resources (
            path TEXT NOT NULL, provider TEXT NOT NULL, conversation TEXT NOT NULL, request TEXT NOT NULL,
            created INTEGER NOT NULL, PRIMARY KEY(path, provider)
          );
          CREATE TABLE staged_inputs (
            session TEXT NOT NULL REFERENCES sessions(id), asset TEXT NOT NULL,
            name TEXT NOT NULL, version TEXT NOT NULL, area TEXT NOT NULL,
            PRIMARY KEY (session, asset), UNIQUE(session, name)
          );
          CREATE TABLE artifacts (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, request TEXT NOT NULL,
            execution TEXT NOT NULL, session TEXT NOT NULL, filename TEXT NOT NULL,
            mime TEXT NOT NULL, size INTEGER NOT NULL, version TEXT NOT NULL, created INTEGER NOT NULL,
            state TEXT NOT NULL, provenance TEXT NOT NULL
          );
          CREATE TABLE collections (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE documents (
            id TEXT PRIMARY KEY, conversation TEXT, collection TEXT REFERENCES collections(id) ON DELETE CASCADE,
            name TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL
          );
          CREATE TABLE chunks (
            rowid INTEGER PRIMARY KEY, document TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            version TEXT NOT NULL, sequence INTEGER NOT NULL, text TEXT NOT NULL, location TEXT NOT NULL,
            UNIQUE(document, version, sequence)
          );
          CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='rowid', tokenize='unicode61');
          CREATE TRIGGER chunks_add AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
          END;
          CREATE TRIGGER chunks_remove AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          END;
          CREATE TABLE embeddings (
            chunk INTEGER NOT NULL REFERENCES chunks(rowid) ON DELETE CASCADE,
            model TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (chunk, model)
          );
          CREATE TABLE evidence (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, document TEXT NOT NULL,
            version TEXT NOT NULL, payload TEXT NOT NULL
          );
          PRAGMA user_version = 1;
          COMMIT;
        `);
      }
      db.exec(`
        UPDATE attempts SET state = 'uncertain' WHERE state = 'running';
        UPDATE sessions SET state = 'cleanup' WHERE state = 'active'
          AND id IN (SELECT session FROM attempts WHERE state = 'uncertain');
      `);
      this.database = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  get settings(): RuntimeSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE id = 1').get();
    return row
      ? runtimeSettingsSchema.parse(JSON.parse(String(row.value)))
      : { engineSocket: '', commandMs: executionLimits.commandMs };
  }

  set settings(value: RuntimeSettings) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (1, ?)').run(JSON.stringify(value));
  }

  transaction<T>(work: () => T): T {
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  begin(
    scope: {
      conversationId: string;
      assistantMessageId: string;
      requestId: string;
      callId: string;
      stepId: string;
      operation: string;
    },
    session: string | null,
    identity: unknown,
  ) {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `
      INSERT OR IGNORE INTO attempts
      (id, conversation, turn, request, step, call, session, fingerprint, operation, state, started)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
    `,
      )
      .run(
        id,
        scope.conversationId,
        scope.assistantMessageId,
        scope.requestId,
        scope.stepId,
        scope.callId,
        session,
        digest(JSON.stringify(identity)),
        scope.operation,
        Date.now(),
      );
    if (result.changes !== 1)
      throw new RuntimeError(
        'DUPLICATE_DISPATCH',
        'This operation already ran or its earlier outcome is uncertain.',
      );
    return id;
  }

  finish(id: string, state: string, exitCode?: number) {
    this.db
      .prepare('UPDATE attempts SET state = ?, elapsed = ? - started, exit_code = ? WHERE id = ?')
      .run(state, Date.now(), exitCode ?? null, id);
  }

  close() {
    this.database?.close();
    this.database = undefined;
  }
}
