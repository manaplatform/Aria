import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Scope = { conversationId: string; assistantMessageId: string; requestId: string; fingerprint: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export class StandaloneDispatch {
  private db?: DatabaseSync;

  private database() {
    if (this.db) return this.db;
    const directory = resolve(process.env.ARIA_DISPATCH_DIRECTORY || join(homedir(), '.aria', 'runtime'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, 'standalone-dispatch.sqlite');
    closeSync(openSync(filename, 'a', 0o600));
    const db = new DatabaseSync(filename);
    try {
      db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 2000;
        CREATE TABLE IF NOT EXISTS owners (turn TEXT PRIMARY KEY, attempt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts (
          turn TEXT NOT NULL REFERENCES owners(turn), fingerprint TEXT NOT NULL,
          state TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER,
          PRIMARY KEY(turn, fingerprint)
        );
      `);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  reserve(scope: Scope) {
    const db = this.database();
    const turn = hash(JSON.stringify([scope.conversationId, scope.assistantMessageId]));
    const attempt = hash(scope.requestId);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT OR IGNORE INTO owners VALUES (?, ?)').run(turn, attempt);
      const owner = db.prepare('SELECT attempt FROM owners WHERE turn = ?').get(turn);
      const reserved = owner?.attempt === attempt && db.prepare(
        "INSERT OR IGNORE INTO receipts VALUES (?, ?, 'reserved', ?, NULL)",
      ).run(turn, scope.fingerprint, Date.now()).changes !== 0;
      db.exec('COMMIT');
      return reserved;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  settle(scope: Scope, state: 'completed' | 'failed' | 'uncertain' | 'not_started') {
    if (state === 'not_started') return false;
    return Boolean(this.database().prepare(`
      UPDATE receipts SET state = ?, finished = ?
      WHERE turn = ? AND fingerprint = ? AND state = 'reserved'
        AND EXISTS (SELECT 1 FROM owners WHERE owners.turn = receipts.turn AND attempt = ?)
    `).run(state, Date.now(), hash(JSON.stringify([scope.conversationId, scope.assistantMessageId])),
      scope.fingerprint, hash(scope.requestId)).changes);
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }
}
