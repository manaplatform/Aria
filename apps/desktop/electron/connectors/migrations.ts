import type { DatabaseSync } from 'node:sqlite';
import { githubRegistration } from './github/config';

export function migrateConnectors(db: DatabaseSync) {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS connector_accounts (
      id TEXT PRIMARY KEY, registration TEXT NOT NULL, user INTEGER NOT NULL,
      metadata TEXT NOT NULL, credentials BLOB, approved_primary TEXT, grants_primary TEXT,
      UNIQUE(registration, user)
    );
    CREATE TABLE IF NOT EXISTS connector_settings (registration TEXT PRIMARY KEY, active TEXT);
    CREATE TABLE IF NOT EXISTS connector_activity (
      id INTEGER PRIMARY KEY, connection TEXT NOT NULL, repository INTEGER,
      operation TEXT NOT NULL, state TEXT NOT NULL, occurred INTEGER NOT NULL, url TEXT
    );
    CREATE INDEX IF NOT EXISTS connector_activity_account ON connector_activity(connection, id DESC);
    CREATE TABLE IF NOT EXISTS connector_watch_baseline (
      automation TEXT PRIMARY KEY REFERENCES automation_definitions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, evidence TEXT NOT NULL
    );
    PRAGMA user_version = 10;
    COMMIT;
  `);
}

export function migrateGithubDeviceFlow(db: DatabaseSync) {
  db.exec('PRAGMA secure_delete = ON; BEGIN IMMEDIATE;');
  try {
    const rows = db.prepare(`
      SELECT a.id, a.registration, s.active = a.id AS is_active
      FROM connector_accounts a LEFT JOIN connector_settings s ON s.registration = a.registration
      ORDER BY is_active DESC, a.registration, a.id
    `).all();
    const move = db.prepare('UPDATE OR IGNORE connector_accounts SET registration=? WHERE id=?');
    const select = db.prepare('INSERT OR IGNORE INTO connector_settings (registration, active) VALUES (?, ?)');
    const fence = db.prepare(`
      UPDATE connector_accounts SET credentials=NULL, approved_primary=NULL, grants_primary=NULL,
        metadata=json_set(metadata, '$.state', 'reconnect', '$.reconnectReason', 'device_flow',
          '$.generation', json_extract(metadata, '$.generation') + 1, '$.policy', 'read_only',
          '$.grants', json('[]'), '$.repositories', json('[]'))
      WHERE id=?
    `);
    for (const row of rows) {
      const parts = /^https:\/\/[^|]+\|([A-Za-z0-9_.]{8,120})\|([a-z0-9-]{1,100})$/.exec(String(row.registration));
      if (!parts) continue;
      const registration = githubRegistration({ clientId: parts[1], slug: parts[2] });
      fence.run(row.id);
      // Multiple legacy broker origins can refer to the same App and account. Keep
      // the selected row first and leave duplicates fenced with their history intact.
      if (move.run(registration, row.id).changes && row.is_active) select.run(registration, row.id);
    }
    db.exec('PRAGMA user_version = 11; COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}
