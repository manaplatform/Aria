import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import {
  executionLimits,
  programJournalSchema,
  runtimeSettingsSchema,
  type CapabilityHostRequest,
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
      if (version > 6) throw new Error('This runtime profile requires a newer version of Aria.');
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
      if (version < 2) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE computer_sessions (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, environment TEXT NOT NULL, target TEXT NOT NULL,
            provider TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, lease INTEGER NOT NULL,
            created INTEGER NOT NULL, touched INTEGER NOT NULL, restore_url TEXT
          );
          CREATE INDEX computer_sessions_owner ON computer_sessions(conversation, state);
          CREATE TABLE computer_approvals (
            id TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES computer_sessions(id) ON DELETE CASCADE,
            step TEXT NOT NULL, fingerprint TEXT NOT NULL, decision TEXT NOT NULL, at INTEGER NOT NULL
          );
          CREATE TABLE computer_artifact_sources (
            id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE, source TEXT NOT NULL
          );
          CREATE TABLE computer_provider_calls (
            session TEXT NOT NULL REFERENCES computer_sessions(id) ON DELETE CASCADE,
            response TEXT NOT NULL, item TEXT NOT NULL, call TEXT NOT NULL, step TEXT NOT NULL,
            observation TEXT, state TEXT NOT NULL, PRIMARY KEY(session, response, call)
          );
          PRAGMA user_version = 2;
          COMMIT;
        `);
      }
      if (version < 3) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE programs (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, turn TEXT NOT NULL,
            request TEXT NOT NULL, provider TEXT NOT NULL, revision TEXT NOT NULL,
            backend TEXT NOT NULL, state TEXT NOT NULL, started INTEGER NOT NULL,
            deadline INTEGER NOT NULL, finished INTEGER
          );
          CREATE INDEX programs_conversation ON programs(conversation, started);
          CREATE TABLE program_children (
            program TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
            call TEXT NOT NULL, tool TEXT NOT NULL, version TEXT NOT NULL,
            fingerprint TEXT NOT NULL, step TEXT, state TEXT NOT NULL,
            started INTEGER NOT NULL, finished INTEGER,
            PRIMARY KEY(program, call), UNIQUE(program, fingerprint)
          );
          PRAGMA user_version = 3;
          COMMIT;
        `);
      }
      if (version < 4) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE program_results (
            program TEXT PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
            payload BLOB NOT NULL,
            expires INTEGER NOT NULL
          );
          PRAGMA user_version = 4;
          COMMIT;
        `);
      }
      if (version < 5) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE dispatch_turns (
            conversation TEXT NOT NULL, turn TEXT NOT NULL, attempt TEXT NOT NULL,
            PRIMARY KEY(conversation, turn)
          );
          CREATE TABLE dispatch_receipts (
            conversation TEXT NOT NULL, turn TEXT NOT NULL, fingerprint TEXT NOT NULL,
            request TEXT, operation TEXT, step TEXT, call TEXT, revision TEXT,
            state TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER,
            PRIMARY KEY(conversation, turn, fingerprint),
            FOREIGN KEY(conversation, turn) REFERENCES dispatch_turns(conversation, turn) ON DELETE CASCADE
          );
          CREATE INDEX dispatch_receipts_request ON dispatch_receipts(request, state);
          PRAGMA user_version = 5;
          COMMIT;
        `);
      }
      if (version < 6) {
        db.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE provider_checkpoints (
            conversation TEXT NOT NULL, turn TEXT NOT NULL, request TEXT NOT NULL,
            provider TEXT NOT NULL, revision TEXT NOT NULL,
            payload BLOB NOT NULL, expires INTEGER NOT NULL,
            PRIMARY KEY(conversation, turn, request)
          );
          CREATE TABLE approval_receipts (
            id TEXT PRIMARY KEY, conversation TEXT NOT NULL, request TEXT NOT NULL,
            step TEXT NOT NULL, operation TEXT NOT NULL, fingerprint TEXT NOT NULL,
            state TEXT NOT NULL, created INTEGER NOT NULL, decided INTEGER
          );
          CREATE INDEX approval_receipts_conversation ON approval_receipts(conversation, created);
          PRAGMA user_version = 6;
          COMMIT;
        `);
      }
      db.exec(`
        DELETE FROM program_results WHERE expires <= unixepoch() * 1000;
        DELETE FROM provider_checkpoints WHERE expires <= unixepoch() * 1000;
        UPDATE program_children SET state = 'uncertain' WHERE state = 'reserved';
        UPDATE programs SET state = 'uncertain' WHERE state = 'running';
        UPDATE attempts SET state = 'uncertain' WHERE state = 'running';
        UPDATE dispatch_receipts SET state = 'uncertain', finished = unixepoch() * 1000
          WHERE state = 'reserved';
        UPDATE approval_receipts SET state = 'expired', decided = unixepoch() * 1000 WHERE state = 'pending';
        UPDATE sessions SET state = 'cleanup' WHERE state = 'active'
          AND id IN (SELECT session FROM attempts WHERE state = 'uncertain');
        UPDATE computer_sessions SET state = 'recovering', lease = lease + 1
          WHERE state IN ('initializing', 'ready', 'running', 'waiting-for-approval', 'waiting-for-user', 'paused');
        UPDATE computer_provider_calls SET state = 'interrupted' WHERE state = 'received';
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

  reserveDispatch(
    conversation: string, turn: string, attempt: string, fingerprint: string,
    legacy?: { attempt: string; fingerprints: string[] },
    operation?: { id: string; stepId: string; callId: string; revision: string },
  ) {
    const owner = digest(conversation);
    const logicalTurn = digest(turn);
    const request = digest(attempt);
    return this.transaction(() => {
      const now = Date.now();
      const inserted = this.db.prepare('INSERT OR IGNORE INTO dispatch_turns VALUES (?, ?, ?)')
        .run(owner, logicalTurn, legacy?.attempt ?? request);
      if (inserted.changes && legacy) {
        const migrate = this.db.prepare(`
          INSERT OR IGNORE INTO dispatch_receipts
          (conversation, turn, fingerprint, state, started, finished)
          VALUES (?, ?, ?, 'uncertain', ?, ?)
        `);
        for (const key of legacy.fingerprints) migrate.run(owner, logicalTurn, key, now, now);
      }
      const active = this.db.prepare('SELECT attempt FROM dispatch_turns WHERE conversation = ? AND turn = ?')
        .get(owner, logicalTurn);
      if (active?.attempt !== request) return false;
      return Boolean(this.db.prepare(`
        INSERT OR IGNORE INTO dispatch_receipts
        (conversation, turn, fingerprint, request, operation, step, call, revision, state, started)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)
      `).run(owner, logicalTurn, digest(fingerprint), attempt, operation?.id ?? null,
        operation?.stepId ?? null, operation?.callId ?? null, operation?.revision ?? null, now).changes);
    });
  }

  settleDispatch(
    conversation: string, turn: string, request: string, fingerprint: string,
    state: 'completed' | 'failed' | 'uncertain',
  ) {
    return Boolean(this.db.prepare(`
      UPDATE dispatch_receipts SET state = ?, finished = ?
      WHERE conversation = ? AND turn = ? AND request = ? AND fingerprint = ? AND state = 'reserved'
    `).run(state, Date.now(), digest(conversation), digest(turn), request, digest(fingerprint)).changes);
  }

  interruptDispatches(request: string) {
    this.database?.prepare(`
      UPDATE dispatch_receipts SET state = 'uncertain', finished = ?
      WHERE request = ? AND state = 'reserved'
    `).run(Date.now(), request);
  }

  hasHostedResources(request?: string) {
    return Boolean(this.database?.prepare(`
      SELECT 1 FROM hosted_resources WHERE (? IS NULL OR request = ?) LIMIT 1
    `).get(request ?? null, request ?? null));
  }

  beginApproval(scope: { conversation: string; request: string; step: string; operation: string }, fingerprint: string) {
    const id = randomUUID();
    this.db.prepare("INSERT INTO approval_receipts VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)")
      .run(id, scope.conversation, scope.request, scope.step, scope.operation, fingerprint, Date.now());
    return id;
  }

  finishApproval(id: string, decision: 'approved' | 'declined' | 'cancelled' | 'expired') {
    this.db.prepare("UPDATE approval_receipts SET state = ?, decided = ? WHERE id = ? AND state = 'pending'")
      .run(decision, Date.now(), id);
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
    if (this.db.prepare(`
      SELECT 1 FROM attempts WHERE conversation = ? AND turn = ?
        AND (state = 'uncertain' OR (state = 'running' AND request <> ?)) LIMIT 1
    `).get(scope.conversationId, scope.assistantMessageId, scope.requestId))
      throw new RuntimeError('OUTCOME_UNCERTAIN', 'Reconcile the earlier outcome before dispatching another operation.');
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
      .prepare("UPDATE attempts SET state = ?, elapsed = ? - started, exit_code = ? WHERE id = ? AND state = 'running'")
      .run(state, Date.now(), exitCode ?? null, id);
  }

  journalProgram(request: Extract<CapabilityHostRequest, { type: 'runtime' }>, provider: string, sealed?: Buffer) {
    const command = programJournalSchema.safeParse(request.input);
    if (!command.success) throw new RuntimeError('INVALID_ARGUMENT', 'Invalid program journal request.');
    const input = command.data;
    const { stepId, conversationId, assistantMessageId, requestId, revision } = request;
    const now = Date.now();
    if (input.action === 'open') {
      if (input.deadline <= now || input.deadline - now > 120_000)
        throw new RuntimeError('BUDGET_EXCEEDED', 'The program deadline is invalid or expired.');
      this.db.prepare('DELETE FROM programs WHERE started < ?').run(now - 30 * 86_400_000);
      this.db.prepare('DELETE FROM program_results WHERE expires <= ?').run(now);
      const write = this.db.prepare(`
        INSERT OR IGNORE INTO programs VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, NULL)
      `).run(stepId, conversationId, assistantMessageId, requestId, provider, revision, input.backend, now, input.deadline);
      if (write.changes) return;
      throw new RuntimeError('DUPLICATE_DISPATCH', 'The program already has a dispatch record.');
    }
    const record = this.db.prepare(`
      SELECT deadline FROM programs
      WHERE id = ? AND conversation = ? AND turn = ? AND request = ? AND provider = ?
        AND revision = ? AND state = 'running'
    `).get(stepId, conversationId, assistantMessageId, requestId, provider, revision);
    if (!record)
      throw new RuntimeError('PERMISSION_DENIED', 'The program journal belongs to another scope or is closed.');
    if (input.action === 'reserve') {
      if (Number(record.deadline) <= now)
        throw new RuntimeError('TIMEOUT', 'The program expired before dispatch.');
      if (input.mutable && this.db.prepare(`
        SELECT 1 FROM program_children c JOIN programs p ON p.id = c.program
        WHERE p.conversation = ? AND p.turn = ? AND c.fingerprint = ?
        AND c.state IN ('reserved', 'completed', 'uncertain')
      `).get(conversationId, assistantMessageId, input.fingerprint))
        throw new RuntimeError('DUPLICATE_DISPATCH', 'This operation already ran or needs reconciliation.');
      const write = this.db.prepare(`
        INSERT OR IGNORE INTO program_children (program, call, tool, version, fingerprint, state, started)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?)
      `).run(stepId, input.callId, input.tool, input.version, input.fingerprint, now);
      if (write.changes) return;
      throw new RuntimeError('DUPLICATE_DISPATCH', 'This program operation already has a dispatch record.');
    }
    if (input.action === 'receipt') {
      const write = this.db.prepare(`
        UPDATE program_children SET state = ?, step = ?, finished = ?
        WHERE program = ? AND call = ? AND state = 'reserved'
      `).run(input.state, input.stepId, now, stepId, input.callId);
      if (write.changes) return;
      throw new RuntimeError('CALLER_MISMATCH', 'The child result has no pending dispatch record.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE program_children SET state = 'uncertain', finished = ?
        WHERE program = ? AND state = 'reserved'
      `).run(now, stepId);
      const uncertain = this.db.prepare(`
        SELECT 1 FROM program_children WHERE program = ? AND state = 'uncertain'
      `).get(stepId);
      this.db.prepare('UPDATE programs SET state = ?, finished = ? WHERE id = ?')
        .run(uncertain ? 'uncertain' : input.state, now, stepId);
      const save = Boolean(sealed && !uncertain && (input.state === 'complete' || input.state === 'partial'));
      if (save && sealed)
        this.db.prepare('INSERT INTO program_results VALUES (?, ?, ?)').run(stepId, sealed, now + 86_400_000);
      this.db.exec('COMMIT');
      return save;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  programResult(conversation: string, id: string) {
    this.db.prepare('DELETE FROM program_results WHERE expires <= ?').run(Date.now());
    const payload = this.db.prepare(`
      SELECT r.payload FROM program_results r JOIN programs p ON p.id = r.program
      WHERE p.id = ? AND p.conversation = ? AND p.state IN ('complete', 'partial')
    `).get(id, conversation)?.payload;
    return types.isUint8Array(payload) ? Buffer.from(payload) : undefined;
  }

  interruptPrograms(request: string) {
    this.database?.prepare(`
      UPDATE program_children SET state = 'uncertain' WHERE state = 'reserved'
        AND program IN (SELECT id FROM programs WHERE request = ? AND state = 'running')
    `).run(request);
    this.database?.prepare("UPDATE programs SET state = 'uncertain' WHERE request = ? AND state = 'running'")
      .run(request);
  }

  assertProgramChild(request: Extract<CapabilityHostRequest, { type: 'runtime' }>, provider: string | undefined) {
    if (!provider || !request.programId) throw new RuntimeError('PERMISSION_DENIED', 'Missing program authorization.');
    const match = this.db.prepare(`
      SELECT 1 FROM program_children c JOIN programs p ON p.id = c.program
      WHERE c.program = ? AND c.call = ? AND c.tool = ? AND c.state = 'reserved'
        AND p.conversation = ? AND p.turn = ? AND p.request = ? AND p.revision = ?
        AND p.provider = ? AND p.state = 'running' AND p.deadline > ?
    `).get(request.programId, request.callId, request.operation, request.conversationId,
      request.assistantMessageId, request.requestId, request.revision, provider, Date.now());
    if (!match) throw new RuntimeError('PERMISSION_DENIED', 'This tool call was not reserved for the active program.');
  }

  deletePrograms(conversation: string) {
    this.db.prepare('DELETE FROM programs WHERE conversation = ?').run(conversation);
    this.db.prepare('DELETE FROM provider_checkpoints WHERE conversation = ?').run(conversation);
    this.db.prepare('DELETE FROM approval_receipts WHERE conversation = ?').run(conversation);
  }

  close() {
    this.database?.close();
    this.database = undefined;
  }
}
