import { randomUUID } from 'node:crypto';
import type { ProactiveNotification } from '@aria/shared';
import type { ProactiveHost } from './host';
import { quietUntil } from './schedule';
import type { JobRow, ProactiveStore } from './store';

type Row = {
  id: string;
  category: string;
  job: string | null;
  target: string | null;
  target_kind: ProactiveNotification['targetKind'];
  payload: Uint8Array | null;
  created: number;
  read_at: number | null;
};

export class ProactiveNotifications {
  constructor(
    private readonly store: ProactiveStore,
    private readonly host: ProactiveHost,
  ) {}

  add(category: string, job: JobRow | undefined, dedup: string, payload?: Buffer) {
    const kind = job?.owner ? (job.kind === 'automation' ? 'automation' : 'agenda') : 'job';
    this.store.run(
      `INSERT OR IGNORE INTO notification_outbox
      (id,dedup,category,job,target,target_kind,payload,created,native_state)
      VALUES (?,?,?,?,?,?,?,?,'pending')`,
      randomUUID(),
      dedup,
      category,
      job?.id ?? null,
      job?.owner ?? job?.id ?? null,
      kind,
      payload ?? null,
      this.store.now(),
    );
  }

  async list(offset: number) {
    return Promise.all(
      this.store
        .all<Row>(
          'SELECT * FROM notification_outbox ORDER BY created DESC,id LIMIT 20 OFFSET ?',
          offset,
        )
        .map(async (row): Promise<ProactiveNotification> => ({
          id: row.id,
          category: row.category,
          jobId: row.job,
          targetId: row.target,
          targetKind: row.target_kind,
          message: row.payload ? await this.store.open<string>(row.payload) : row.category,
          read: row.read_at !== null,
          created: row.created,
        })),
    );
  }

  flush() {
    const settings = this.store.settings().value;
    if (quietUntil(settings.quietHours, this.store.now())) return;
    for (const row of this.store.all<Row>(
      "SELECT * FROM notification_outbox WHERE native_state='pending' ORDER BY created LIMIT 25",
    )) {
      // Reserve delivery before invoking the OS. An interrupted native submission stays visible in-app.
      this.store.run(
        "UPDATE notification_outbox SET native_state='submitted' WHERE id=? AND native_state='pending'",
        row.id,
      );
      const sent =
        row.target &&
        settings.nativeNotifications &&
        this.host.notify(row.category, { id: row.target, kind: row.target_kind });
      if (!sent)
        this.store.run("UPDATE notification_outbox SET native_state='in_app' WHERE id=?", row.id);
    }
  }
}
