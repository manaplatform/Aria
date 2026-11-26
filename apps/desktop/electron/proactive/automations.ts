import { randomUUID } from 'node:crypto';
import {
  automationDraftSchema,
  proactiveTriggerSchema,
  type AutomationDraft,
  type ProactiveAutomation,
  type ProactiveTrigger,
} from '@aria/shared';
import { occurrence, preview, systemZone } from './schedule';
import { ProactiveError, type ProactiveStore } from './store';

type AutomationRow = {
  id: string;
  revision: number;
  state: ProactiveAutomation['state'];
  payload: Uint8Array;
  grant_id: string;
  expires: number | null;
  created: number;
  updated: number;
  last_run: number | null;
};
type TriggerRow = {
  automation: string;
  kind: string;
  schedule: string;
  next_due: number | null;
  condition: 'met' | 'not_met' | null;
  last_notification: number | null;
  event_kind: string | null;
  event_target: string | null;
  follows_zone: number;
};
type DueTrigger = TriggerRow & Pick<AutomationRow, 'revision' | 'grant_id' | 'expires'>;

export class Automations {
  constructor(
    private readonly store: ProactiveStore,
    private readonly stop: (id: string) => void,
  ) {}

  row(id: string) {
    return this.store.one<AutomationRow>('SELECT * FROM automation_definitions WHERE id=?', id);
  }
  trigger(id: string) {
    return this.store.one<TriggerRow>('SELECT * FROM automation_triggers WHERE automation=?', id);
  }
  async draft(row: AutomationRow) {
    return automationDraftSchema.parse(await this.store.open(row.payload));
  }

  async view(row: AutomationRow, provider?: string): Promise<ProactiveAutomation> {
    const trigger = this.trigger(row.id);
    return {
      id: row.id,
      revision: row.revision,
      state: row.state,
      created: row.created,
      updated: row.updated,
      ...(await this.draft(row)),
      nextDue: trigger?.next_due ?? null,
      lastRun: row.last_run,
      condition: trigger?.condition ?? null,
      permissionCurrent: !!provider && this.store.grantValid({ grant_id: row.grant_id }, provider),
    };
  }

  async list(offset: number, provider?: string) {
    return Promise.all(
      this.store
        .all<AutomationRow>(
          "SELECT * FROM automation_definitions WHERE state != 'deleted' ORDER BY updated DESC,id LIMIT 20 OFFSET ?",
          offset,
        )
        .map((row) => this.view(row, provider)),
    );
  }

  validate(draft: AutomationDraft) {
    const now = this.store.now();
    if (draft.expiresAt !== null && draft.expiresAt <= now)
      throw new ProactiveError('validation', 'Expiration must be in the future.');
    if (
      draft.trigger.kind === 'condition' &&
      !draft.scope.publicOrigins.includes(draft.trigger.origin)
    )
      throw new ProactiveError('validation', 'Authorize the exact public site being monitored.');
    if (
      draft.trigger.kind === 'task_event' &&
      !this.store.one('SELECT 1 FROM agenda_tasks WHERE id=?', draft.trigger.taskId)
    )
      throw new ProactiveError('validation', 'Select an existing Agenda task for this trigger.');
    const times = preview(draft.trigger, now);
    if (draft.trigger.kind === 'once' && !times.length)
      throw new ProactiveError('validation', 'Choose a future time for the one-time automation.');
    return times;
  }

  async prepare(draft: AutomationDraft, provider: string) {
    this.validate(draft);
    return {
      payload: await this.store.seal(draft),
      scope: await this.store.seal(draft.scope),
      provider,
    };
  }

  save(
    draft: AutomationDraft,
    encrypted: Awaited<ReturnType<Automations['prepare']>>,
    id: string = randomUUID(),
    revision?: number,
  ) {
    const next = this.validate(draft)[0] ?? null;
    this.store.ensureSettings();
    const now = this.store.now();
    const prior = this.row(id);
    if (
      revision !== undefined &&
      (!prior || prior.revision !== revision || prior.state === 'deleted')
    )
      throw new ProactiveError('conflict', 'The automation changed. Reload it to continue.');
    const grantId = randomUUID();
    this.store.run(
      'INSERT INTO proactive_grants VALUES (?,?,?,?,NULL)',
      grantId,
      encrypted.provider,
      encrypted.scope,
      draft.expiresAt,
    );
    if (prior) {
      this.revoke(prior);
      this.store.run(
        "UPDATE automation_definitions SET revision=revision+1,state='enabled',payload=?,grant_id=?,expires=?,updated=? WHERE id=?",
        encrypted.payload,
        grantId,
        draft.expiresAt,
        now,
        id,
      );
    } else {
      this.store.run(
        "INSERT INTO automation_definitions VALUES (?,1,'enabled',?,?,?,?,?,NULL)",
        id,
        encrypted.payload,
        grantId,
        draft.expiresAt,
        now,
        now,
      );
    }
    const trigger = draft.trigger;
    this.store.run(
      'INSERT OR REPLACE INTO automation_triggers VALUES (?,?,?,?,NULL,NULL,?,?,?)',
      id,
      trigger.kind,
      JSON.stringify(trigger),
      next,
      'event' in trigger ? trigger.event : null,
      trigger.kind === 'task_event' ? trigger.taskId : null,
      'followSystem' in trigger && trigger.followSystem ? 1 : 0,
    );
    return id;
  }

  private revoke(row: AutomationRow) {
    this.store.run(
      'UPDATE proactive_grants SET revoked=? WHERE id=?',
      this.store.now(),
      row.grant_id,
    );
    this.stop(row.id);
  }

  control(
    id: string,
    revision: number,
    control: 'enable' | 'disable' | 'pause' | 'resume' | 'delete' | 'run_now',
    commandId: string,
    provider?: string,
  ) {
    const row = this.row(id);
    if (!row || row.revision !== revision || row.state === 'deleted')
      throw new ProactiveError('conflict', 'The automation changed or was deleted.');
    if (control === 'run_now') {
      if (row.state !== 'enabled' || (row.expires !== null && row.expires <= this.store.now()))
        throw new ProactiveError('conflict', 'Enable this automation before running it.');
      return (
        this.enqueue(
          { automation: id, revision, grant_id: row.grant_id },
          'manual:' + commandId,
          this.store.now(),
          [],
        ) ?? id
      );
    }
    const now = this.store.now();
    const nextState = {
      enable: 'enabled',
      resume: 'enabled',
      disable: 'disabled',
      pause: 'paused',
      delete: 'deleted',
    } as const;
    const state = nextState[control];
    let next = null;
    if (state === 'enabled') {
      if (
        (row.expires !== null && row.expires <= now) ||
        !provider ||
        !this.store.grantValid({ grant_id: row.grant_id }, provider)
      )
        throw new ProactiveError(
          'permission',
          'Review and renew this automation’s scope with the current primary.',
        );
      const trigger = this.trigger(id);
      next = trigger ? (occurrence(this.parse(trigger), now)?.at ?? null) : null;
    } else {
      this.stop(id);
      if (state === 'deleted') this.revoke(row);
    }
    this.store.run(
      'UPDATE automation_definitions SET state=?,updated=? WHERE id=?',
      state,
      now,
      id,
    );
    this.store.run('UPDATE automation_triggers SET next_due=? WHERE automation=?', next, id);
    if (state === 'deleted') {
      this.store.run("UPDATE automation_definitions SET payload=X'' WHERE id=?", id);
      this.store.run('DELETE FROM automation_triggers WHERE automation=?', id);
    }
    return id;
  }

  private parse(row: TriggerRow): ProactiveTrigger {
    return proactiveTriggerSchema.parse(JSON.parse(row.schedule));
  }
  private enqueue(
    row: Pick<DueTrigger, 'automation' | 'revision' | 'grant_id'>,
    key: string,
    due: number,
    ancestry: string[],
  ) {
    if (ancestry.length >= 10 || ancestry.includes(row.automation)) return undefined;
    return this.store.enqueue({
      kind: 'automation',
      owner: row.automation,
      revision: row.revision,
      due,
      grant: row.grant_id,
      occurrence: row.automation + ':' + row.revision + ':' + key,
      ancestry: [...ancestry, row.automation],
    });
  }

  publish(kind: string, target: string | null, ancestry: string[] = []) {
    const id = randomUUID();
    this.store.run(
      'INSERT INTO proactive_events VALUES (?,?,?,?,?)',
      id,
      kind,
      target,
      JSON.stringify(ancestry),
      this.store.now(),
    );
    if (this.store.settings().value.emergencyPaused) return;
    const matching = this.store.all<DueTrigger>(
      `SELECT t.*, a.revision, a.grant_id, a.expires
      FROM automation_triggers t JOIN automation_definitions a ON t.automation=a.id
      WHERE a.state='enabled' AND t.event_kind=? AND t.event_target IS ? AND (a.expires IS NULL OR a.expires>?)`,
      kind,
      target,
      this.store.now(),
    );
    for (const row of matching) this.enqueue(row, 'event:' + id, this.store.now(), ancestry);
  }

  nextDue() {
    return (
      this.store.one<{ due: number | null }>(`SELECT min(v) AS due FROM (
      SELECT min(next_due) AS v FROM automation_triggers WHERE next_due IS NOT NULL
      UNION ALL SELECT min(expires) FROM automation_definitions WHERE state IN ('enabled','paused','disabled'))`)
        ?.due ?? null
    );
  }

  async tick() {
    const now = this.store.now();
    for (const row of this.store.all<AutomationRow>(
      "SELECT * FROM automation_definitions WHERE expires<=? AND state IN ('enabled','paused','disabled') LIMIT 50",
      now,
    )) {
      this.store.atomic(() => {
        this.revoke(row);
        this.store.run(
          "UPDATE automation_definitions SET state='expired',revision=revision+1,updated=? WHERE id=?",
          now,
          row.id,
        );
        this.store.run('UPDATE automation_triggers SET next_due=NULL WHERE automation=?', row.id);
      });
    }
    const currentZone = systemZone();
    const { value, zone } = this.store.settings();
    if (currentZone !== zone)
      this.store.atomic(() => {
        for (const row of this.store.all<TriggerRow>(`SELECT t.* FROM automation_triggers t
        JOIN automation_definitions a ON t.automation=a.id WHERE t.follows_zone=1 AND a.state='enabled'`))
          this.store.run(
            'UPDATE automation_triggers SET next_due=? WHERE automation=?',
            occurrence(this.parse(row), now, false, currentZone)?.at ?? null,
            row.automation,
          );
        this.store.run('UPDATE proactive_settings SET zone=? WHERE id=1', currentZone);
      });
    const due = this.store.all<DueTrigger>(
      `SELECT t.*,a.revision,a.grant_id,a.expires
      FROM automation_triggers t JOIN automation_definitions a ON t.automation=a.id
      WHERE t.next_due<=? AND a.state='enabled' ORDER BY t.next_due LIMIT 32`,
      now,
    );
    for (const row of due) {
      const definition = this.row(row.automation);
      if (!definition) continue;
      const draft = await this.draft(definition);
      const cursor = row.next_due;
      if (cursor === null) continue;
      const trigger = draft.trigger;
      const latest = occurrence(trigger, now, true, currentZone);
      if (!latest) continue;
      const policy = draft.missed ?? value.missed;
      const misses = now - cursor > 45_000;
      const eligible = misses && policy === 'skip' ? [] : [latest];
      if (misses && policy === 'catch_up') {
        for (let i = 0; i < 2; i++) {
          const prior = occurrence(trigger, eligible[0].at - 1, true, currentZone);
          if (!prior || prior.at < cursor || now - prior.at > 86_400_000) break;
          eligible.unshift(prior);
        }
      }
      const next = occurrence(trigger, now, false, currentZone);
      this.store.atomic(() => {
        const current = this.row(row.automation);
        if (
          current?.revision !== row.revision ||
          current.state !== 'enabled' ||
          this.trigger(row.automation)?.next_due !== cursor
        )
          return;
        if (!value.emergencyPaused && !this.store.settings().value.emergencyPaused) {
          for (const item of eligible) {
            if (row.expires === null || item.at < row.expires)
              this.enqueue(row, 'time:' + item.key, item.at, []);
          }
        }
        this.store.run(
          'UPDATE automation_triggers SET next_due=? WHERE automation=?',
          next?.at ?? null,
          row.automation,
        );
      });
    }
  }
}
