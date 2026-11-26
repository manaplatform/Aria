import type { DatabaseSync } from 'node:sqlite';

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
