import { quietUntil } from './schedule';
import type { ProactiveStore } from './store';

export class Pulse {
  constructor(private readonly store: ProactiveStore) {}

  status() {
    return {
      last:
        this.store.one<{ at: number }>('SELECT at FROM pulse_runs ORDER BY at DESC LIMIT 1')?.at ??
        null,
      next: this.store.settings().due,
      history: this.store.all<{ at: number; state: string; reason: string | null }>(
        'SELECT at,state,reason FROM pulse_runs ORDER BY at DESC LIMIT 30',
      ),
    };
  }

  enqueue(key: string) {
    const now = this.store.now();
    const existing = this.store.activeFor('pulse')[0];
    if (existing) {
      this.store.metric('duplicate');
      return existing.id;
    }
    const id = this.store.enqueue({ kind: 'pulse', occurrence: 'pulse:' + key, due: now });
    if (id) this.store.run("INSERT OR IGNORE INTO pulse_runs VALUES (?,?,'queued',NULL)", now, id);
    return id;
  }

  tick() {
    const settings = this.store.settings();
    const { due, value } = settings;
    const now = this.store.now();
    if (!value.pulseEnabled || value.pulsePaused || due === null || due > now) return;
    this.store.atomic(() => {
      const quiet = quietUntil(value.quietHours, now);
      this.store.run(
        'UPDATE proactive_settings SET pulse_due=? WHERE id=1',
        quiet ?? now + value.intervalMinutes * 60_000,
      );
      if (quiet) return;
      const tasks = this.store.one(
        "SELECT 1 FROM agenda_tasks WHERE state IN ('pending','ready') LIMIT 1",
      );
      const responsibilities =
        value.mode === 'adaptive' &&
        this.store.one(
          "SELECT 1 FROM proactive_jobs WHERE state IN ('waiting_user','waiting_approval','blocked','uncertain') UNION ALL SELECT 1 FROM automation_triggers WHERE next_due<=? LIMIT 1",
          now + value.intervalMinutes * 60_000,
        );
      const reason = value.emergencyPaused
        ? 'Emergency pause is active.'
        : value.mode !== 'always' && !tasks && !responsibilities
          ? 'No eligible responsibilities.'
          : this.store.activeFor('pulse').length
            ? 'An evaluation is already active.'
            : undefined;
      if (reason) this.store.run("INSERT INTO pulse_runs VALUES (?,NULL,'skipped',?)", now, reason);
      else this.enqueue(String(due));
    });
  }
}
