import type { DatabaseSync } from 'node:sqlite';

export function migrateProactive(db: DatabaseSync) {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS proactive_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, settings TEXT NOT NULL,
      pulse_due INTEGER, zone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS objectives (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL,
      payload BLOB NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agenda_tasks (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, priority TEXT NOT NULL,
      objective TEXT REFERENCES objectives(id), parent TEXT REFERENCES agenda_tasks(id), deadline INTEGER,
      progress INTEGER NOT NULL DEFAULT 0, manual_blocker INTEGER NOT NULL DEFAULT 0, completion TEXT, payload BLOB NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proactive_task_state ON agenda_tasks(state, deadline, updated);
    CREATE INDEX IF NOT EXISTS proactive_task_parent ON agenda_tasks(parent);
    CREATE INDEX IF NOT EXISTS proactive_task_objective ON agenda_tasks(objective);
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task TEXT NOT NULL REFERENCES agenda_tasks(id), prerequisite TEXT NOT NULL REFERENCES agenda_tasks(id),
      PRIMARY KEY(task, prerequisite), CHECK(task != prerequisite)
    );
    CREATE INDEX IF NOT EXISTS proactive_dependency_reverse ON task_dependencies(prerequisite, task);
    CREATE TABLE IF NOT EXISTS proactive_grants (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, payload BLOB NOT NULL, expires INTEGER, revoked INTEGER
    );
    CREATE TABLE IF NOT EXISTS automation_definitions (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL,
      payload BLOB NOT NULL, grant_id TEXT NOT NULL REFERENCES proactive_grants(id), expires INTEGER,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, last_run INTEGER
    );
    CREATE INDEX IF NOT EXISTS proactive_automation_expiry ON automation_definitions(expires) WHERE state IN ('enabled','paused','disabled');
    CREATE TABLE IF NOT EXISTS automation_triggers (
      automation TEXT PRIMARY KEY REFERENCES automation_definitions(id), kind TEXT NOT NULL,
      schedule TEXT NOT NULL, next_due INTEGER, condition TEXT, last_notification INTEGER,
      event_kind TEXT, event_target TEXT, follows_zone INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proactive_trigger_due ON automation_triggers(next_due) WHERE next_due IS NOT NULL;
    CREATE INDEX IF NOT EXISTS proactive_trigger_event ON automation_triggers(event_kind, event_target);
    CREATE TABLE IF NOT EXISTS proactive_jobs (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, kind TEXT NOT NULL, owner TEXT, owner_revision INTEGER,
      occurrence TEXT NOT NULL UNIQUE, state TEXT NOT NULL, due INTEGER NOT NULL, reason TEXT,
      generation INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
      attempt TEXT, worker TEXT, fence TEXT, lease INTEGER, provider TEXT, grant_id TEXT REFERENCES proactive_grants(id),
      memory_private INTEGER NOT NULL DEFAULT 0, checkpoint BLOB, checkpoint_revision INTEGER, result BLOB, answer BLOB, condition TEXT, condition_step TEXT, activity BLOB,
      ancestry TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, updated INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proactive_job_due ON proactive_jobs(due, id) WHERE state IN ('scheduled','queued','retry_scheduled');
    CREATE INDEX IF NOT EXISTS proactive_job_owner ON proactive_jobs(kind, owner, created DESC);
    CREATE INDEX IF NOT EXISTS proactive_job_lease ON proactive_jobs(lease) WHERE lease IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS proactive_active_pulse ON proactive_jobs(kind)
      WHERE kind = 'pulse' AND state NOT IN ('completed','failed','cancelled','skipped','uncertain');
    CREATE UNIQUE INDEX IF NOT EXISTS proactive_active_task ON proactive_jobs(owner)
      WHERE kind = 'agenda' AND state NOT IN ('completed','failed','cancelled','skipped');
    CREATE TABLE IF NOT EXISTS proactive_artifacts (
      job TEXT NOT NULL REFERENCES proactive_jobs(id) ON DELETE CASCADE,
      id TEXT PRIMARY KEY, payload BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proactive_artifacts_job ON proactive_artifacts(job);
    CREATE TABLE IF NOT EXISTS job_attempts (
      id TEXT PRIMARY KEY, job TEXT NOT NULL REFERENCES proactive_jobs(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL, state TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER,
      day INTEGER NOT NULL, due INTEGER NOT NULL, reserve_input INTEGER NOT NULL, reserve_output INTEGER NOT NULL,
      reserve_cost INTEGER NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cost INTEGER NOT NULL DEFAULT 0, model_requests INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job, generation)
    );
    CREATE INDEX IF NOT EXISTS proactive_attempts_started ON job_attempts(started);
    CREATE TABLE IF NOT EXISTS proactive_metrics (key TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS job_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, job TEXT NOT NULL REFERENCES proactive_jobs(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT
    );
    CREATE INDEX IF NOT EXISTS proactive_job_events ON job_events(job, sequence);
    CREATE TABLE IF NOT EXISTS proactive_events (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT, ancestry TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proactive_requests (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      job TEXT REFERENCES proactive_jobs(id) ON DELETE CASCADE, payload BLOB NOT NULL,
      provider TEXT, target TEXT, target_revision INTEGER, expires INTEGER NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, source_conversation TEXT
    );
    CREATE INDEX IF NOT EXISTS proactive_request_state ON proactive_requests(state, expires);
    CREATE INDEX IF NOT EXISTS proactive_request_job ON proactive_requests(job, state);
    CREATE TABLE IF NOT EXISTS pulse_runs (
      at INTEGER NOT NULL, job TEXT UNIQUE REFERENCES proactive_jobs(id) ON DELETE SET NULL, state TEXT NOT NULL, reason TEXT
    );
    CREATE INDEX IF NOT EXISTS proactive_pulse_recent ON pulse_runs(at DESC);
    CREATE TABLE IF NOT EXISTS proactive_budget_days (
      day INTEGER PRIMARY KEY, input INTEGER NOT NULL, output INTEGER NOT NULL, cost INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_outbox (
      id TEXT PRIMARY KEY, dedup TEXT NOT NULL UNIQUE, category TEXT NOT NULL,
      job TEXT REFERENCES proactive_jobs(id) ON DELETE SET NULL,
      target TEXT, target_kind TEXT NOT NULL, payload BLOB, created INTEGER NOT NULL,
      read_at INTEGER, native_state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS proactive_native_outbox ON notification_outbox(created) WHERE native_state = 'pending';
    CREATE TABLE IF NOT EXISTS proactive_commands (
      id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT, created INTEGER NOT NULL
    );
    PRAGMA user_version = 9;
    COMMIT;
  `);
}
