import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import {
  defaultProactiveSettings,
  loopCheckpointSchema,
  loopReceiptSchema,
  proactiveSettingsSchema,
  type LoopCheckpoint,
  type ProactiveJobState,
  type ProactiveSettings,
  type ProactiveRequest,
  type ProactiveJob,
  type ProactiveAttempt,
  type ProactiveSnapshot,
} from '@aria/shared';
import type { SecretCipher } from '../provider-storage';
import { digest, type RuntimeStore } from '../runtime/store';
import { systemZone } from './schedule';

type Row = Record<string, unknown>;
export type JobRow = Omit<ProactiveJob, 'ownerId' | 'result'> & {
  owner: string | null;
  owner_revision: number | null;
  occurrence: string;
  attempt: string | null;
  worker: string | null;
  fence: string | null;
  lease: number | null;
  provider: string | null;
  grant_id: string | null;
  retry_count: number;
  checkpoint: Uint8Array | null;
  checkpoint_revision: number | null;
  result: Uint8Array | null;
  answer: Uint8Array | null;
  activity: Uint8Array | null;
  memory_private: number;
  condition: 'met' | 'not_met' | null;
  condition_step: string | null;
  ancestry: string;
};
export type Claim = {
  job: JobRow;
  attempt: string;
  generation: number;
  fence: string;
  worker: string;
};
export type Usage = { input: number; output: number; cost: number; modelRequests: number };
export const leaseMs = 30_000;
const queued = "'scheduled','queued','retry_scheduled'";
const active =
  "'scheduled','queued','running','pausing','paused','waiting_approval','waiting_user','blocked','retry_scheduled','interrupted'";
const transitions: Partial<Record<ProactiveJobState, readonly ProactiveJobState[]>> = {
  scheduled: ['running', 'paused', 'cancelled', 'blocked', 'skipped'],
  queued: ['running', 'paused', 'cancelled', 'blocked', 'skipped'],
  retry_scheduled: ['running', 'paused', 'cancelled', 'blocked', 'skipped'],
  running: [
    'pausing',
    'waiting_approval',
    'waiting_user',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'uncertain',
    'blocked',
    'retry_scheduled',
  ],
  pausing: ['paused', 'completed', 'failed', 'cancelled', 'interrupted', 'uncertain'],
  paused: ['queued', 'cancelled'],
  waiting_approval: ['queued', 'blocked', 'cancelled'],
  waiting_user: ['queued', 'blocked', 'cancelled'],
  blocked: ['queued', 'cancelled'],
  interrupted: ['queued', 'cancelled', 'uncertain'],
  failed: ['queued'],
  uncertain: ['cancelled', 'completed'],
};

export class ProactiveError extends Error {
  constructor(
    readonly code: 'validation' | 'conflict' | 'permission' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

export class ProactiveStore {
  constructor(
    readonly runtime: RuntimeStore,
    readonly cipher: SecretCipher,
    readonly now = Date.now,
  ) {}
  all<T = Row>(sql: string, ...args: SQLInputValue[]) {
    return this.runtime.db.prepare(sql).all(...args) as T[];
  }
  one<T = Row>(sql: string, ...args: SQLInputValue[]) {
    return this.runtime.db.prepare(sql).get(...args) as T | undefined;
  }
  run(sql: string, ...args: SQLInputValue[]) {
    return this.runtime.db.prepare(sql).run(...args);
  }
  atomic<T>(work: () => T) {
    return this.runtime.transaction(work);
  }

  async seal(value: unknown) {
    if (!(await this.cipher.available()))
      throw new ProactiveError(
        'unavailable',
        'Unlock OS-backed encrypted storage to use proactive responsibilities.',
      );
    return this.cipher.encrypt(JSON.stringify(value));
  }

  async open<T>(payload: Uint8Array): Promise<T> {
    const { result } = await this.cipher.decrypt(Buffer.from(payload));
    return JSON.parse(result) as T;
  }

  settings() {
    const row = this.runtime.exists()
      ? this.one<{ revision: number; settings: string; pulse_due: number | null; zone: string }>(
          'SELECT * FROM proactive_settings WHERE id = 1',
        )
      : undefined;
    return row
      ? {
          revision: row.revision,
          value: proactiveSettingsSchema.parse(JSON.parse(row.settings)),
          due: row.pulse_due,
          zone: row.zone,
        }
      : { revision: 1, value: defaultProactiveSettings, due: null, zone: systemZone() };
  }

  ensureSettings() {
    this.run(
      'INSERT OR IGNORE INTO proactive_settings VALUES (1,1,?,NULL,?)',
      JSON.stringify(defaultProactiveSettings),
      systemZone(),
    );
  }

  updateSettings(revision: number, settings: ProactiveSettings, due: number | null) {
    if (this.settings().revision !== revision)
      throw new ProactiveError('conflict', 'Settings changed. Reload and try again.');
    this.run(
      'INSERT OR REPLACE INTO proactive_settings VALUES (1,?,?,?,?)',
      revision + 1,
      JSON.stringify(settings),
      due,
      systemZone(),
    );
  }

  job(id: string) {
    return this.one<JobRow>('SELECT * FROM proactive_jobs WHERE id = ?', id);
  }

  async projectJob(row: JobRow): Promise<ProactiveJob> {
    return {
      id: row.id,
      kind: row.kind,
      ownerId: row.owner,
      due: row.due,
      state: row.state,
      generation: row.generation,
      reason: row.reason,
      revision: row.revision,
      created: row.created,
      updated: row.updated,
      ...(row.result && { result: await this.open<string>(row.result) }),
    };
  }

  attempts(id: string) {
    return this.all<ProactiveAttempt>(
      `SELECT id, generation, started, finished, state, cost,
      model_requests AS modelRequests, input AS inputTokens, output AS outputTokens
      FROM job_attempts WHERE job = ? ORDER BY generation DESC LIMIT 50`,
      id,
    );
  }

  metric(key: 'duplicate' | 'recovery') {
    this.run(
      `INSERT INTO proactive_metrics VALUES (?,1) ON CONFLICT(key) DO UPDATE SET count=count+1`,
      key,
    );
  }

  metrics(): ProactiveSnapshot['metrics'] {
    const start = this.now() - 86_400_000;
    const stats = this.one<
      Pick<
        ProactiveSnapshot['metrics'],
        | 'attempts'
        | 'pulseDurationMs'
        | 'pulseModelRequests'
        | 'jobDurationMs'
        | 'scheduleDelayMs'
        | 'inputTokens'
        | 'outputTokens'
        | 'cost'
      >
    >(
      `SELECT count(*) AS attempts, coalesce(sum(CASE WHEN j.kind='pulse' THEN a.finished-a.started END),0) AS pulseDurationMs,
        coalesce(sum(CASE WHEN j.kind='pulse' THEN a.model_requests END),0) AS pulseModelRequests,
        coalesce(sum(a.finished-a.started),0) AS jobDurationMs,
        coalesce(sum(max(a.started-a.due,0)),0) AS scheduleDelayMs,
        coalesce(sum(a.input),0) AS inputTokens, coalesce(sum(a.output),0) AS outputTokens, coalesce(sum(a.cost),0) AS cost
        FROM job_attempts a JOIN proactive_jobs j ON j.id=a.job WHERE a.started>=?`,
      start,
    )!;
    const count = (sql: string, ...args: SQLInputValue[]) =>
      this.one<{ count: number }>(sql, ...args)?.count ?? 0;
    return {
      ...stats,
      queued: count(`SELECT count(*) AS count FROM proactive_jobs WHERE state IN (${queued})`),
      retries: count(
        "SELECT count(*) AS count FROM job_events WHERE state='retry_scheduled' AND at>=?",
        start,
      ),
      recoveries: count("SELECT count FROM proactive_metrics WHERE key='recovery'"),
      pulseSkips: count(
        "SELECT count(*) AS count FROM pulse_runs WHERE state='skipped' AND at>=?",
        start,
      ),
      duplicateClaims: count("SELECT count FROM proactive_metrics WHERE key='duplicate'"),
    };
  }

  enqueue(input: {
    kind: ProactiveJob['kind'];
    owner?: string;
    revision?: number;
    occurrence: string;
    due: number;
    grant?: string;
    ancestry?: string[];
    state?: 'queued' | 'scheduled';
  }) {
    const id = randomUUID();
    const at = this.now();
    const result = this.run(
      `INSERT OR IGNORE INTO proactive_jobs
      (id, revision, kind, owner, owner_revision, occurrence, state, due, grant_id, ancestry, created, updated)
      VALUES (?,1,?,?,?,?,?,?,?,?,?,?)`,
      id,
      input.kind,
      input.owner ?? null,
      input.revision ?? null,
      input.occurrence,
      input.state ?? 'queued',
      input.due,
      input.grant ?? null,
      JSON.stringify(input.ancestry ?? []),
      at,
      at,
    );
    if (!result.changes) {
      this.metric('duplicate');
      return this.one<{ id: string }>(
        'SELECT id FROM proactive_jobs WHERE occurrence = ?',
        input.occurrence,
      )?.id;
    }
    this.record(id, input.state ?? 'queued');
    return id;
  }

  private record(id: string, state: ProactiveJobState, reason?: string) {
    this.run(
      'INSERT INTO job_events(job,at,state,reason) VALUES (?,?,?,?)',
      id,
      this.now(),
      state,
      reason ?? null,
    );
    this.run(
      'UPDATE pulse_runs SET state = ?, reason = ? WHERE job = ?',
      state,
      reason ?? null,
      id,
    );
  }

  transition(row: JobRow, state: ProactiveJobState, reason?: string, due = row.due) {
    if (!transitions[row.state]?.includes(state))
      throw new ProactiveError('conflict', 'This job cannot move to that state.');
    const changed = this.run(
      `UPDATE proactive_jobs SET state = ?, reason = ?, due = ?, revision = revision + 1,
      updated = ? WHERE id = ? AND revision = ?`,
      state,
      reason ?? null,
      due,
      this.now(),
      row.id,
      row.revision,
    ).changes;
    if (!changed) throw new ProactiveError('conflict', 'The job changed. Reload and try again.');
    this.record(row.id, state, reason);
    if (row.owner && row.kind === 'agenda') {
      const taskState =
        state === 'completed'
          ? 'completed'
          : ['running', 'pausing'].includes(state)
            ? 'in_progress'
            : ['queued', 'scheduled', 'retry_scheduled'].includes(state)
              ? 'ready'
              : 'blocked';
      this.run(
        `UPDATE agenda_tasks SET state = ?, revision = revision + 1, updated = ?,
        progress = CASE WHEN ? = 'completed' THEN 100 ELSE progress END,
        completion = CASE WHEN ? = 'completed' THEN 'verified_run' ELSE completion END
        WHERE id = ? AND state NOT IN ('cancelled','completed')`,
        taskState,
        this.now(),
        taskState,
        taskState,
        row.owner,
      );
    }
  }

  activeFor(kind: string, owner?: string) {
    return this.all<JobRow>(
      `SELECT * FROM proactive_jobs WHERE kind = ? AND (? IS NULL OR owner = ?)
      AND state IN (${active})`,
      kind,
      owner ?? null,
      owner ?? null,
    );
  }

  due(limit: number) {
    return this.all<JobRow>(
      `SELECT * FROM proactive_jobs WHERE state IN (${queued}) AND due <= ?
      ORDER BY due,id LIMIT ?`,
      this.now(),
      limit,
    );
  }

  nextDue() {
    return (
      this.one<{ due: number | null }>(
        `SELECT min(due) AS due FROM proactive_jobs WHERE state IN (${queued})`,
      )?.due ?? null
    );
  }

  claim(
    id: string,
    worker: string,
    provider: string,
    reserve: Pick<Usage, 'input' | 'output' | 'cost'>,
    settings: ProactiveSettings,
  ) {
    return this.atomic((): Claim | undefined => {
      const job = this.job(id);
      const now = this.now();
      if (!job || !['scheduled', 'queued', 'retry_scheduled'].includes(job.state) || job.due > now)
        return;
      if (job.provider && job.provider !== provider) {
        this.transition(
          job,
          'blocked',
          'Review this responsibility with the current primary model.',
        );
        return;
      }
      const active =
        this.one<{ count: number }>(
          'SELECT count(*) AS count FROM proactive_jobs WHERE lease > ?',
          now,
        )?.count ?? 0;
      if (active >= settings.concurrency) return;
      if (
        job.kind === 'automation' &&
        this.one(
          'SELECT 1 FROM proactive_jobs WHERE owner=? AND kind=? AND lease>? LIMIT 1',
          job.owner,
          job.kind,
          now,
        )
      )
        return;
      const day = Math.floor(now / 86_400_000);
      const usage = this.one<Usage>('SELECT * FROM proactive_budget_days WHERE day = ?', day);
      if (
        (usage?.cost ?? 0) + reserve.cost > settings.dailyMicros ||
        (usage?.input ?? 0) + reserve.input > settings.dailyInputTokens ||
        (usage?.output ?? 0) + reserve.output > settings.dailyOutputTokens
      ) {
        this.run(
          'UPDATE proactive_jobs SET due = ?, reason = ?, revision = revision + 1 WHERE id = ?',
          (day + 1) * 86_400_000,
          'Waiting for the next daily budget window.',
          job.id,
        );
        return;
      }
      const attempt = randomUUID();
      const fence = randomUUID();
      const generation = job.generation + 1;
      this.transition(job, 'running');
      this.run(
        `UPDATE proactive_jobs SET attempt = ?, worker = ?, fence = ?, lease = ?, provider = ?, generation = ?,
        checkpoint_revision = NULL, condition=NULL, condition_step=NULL WHERE id = ?`,
        attempt,
        worker,
        fence,
        now + leaseMs,
        provider,
        generation,
        id,
      );
      this.run(
        `INSERT INTO job_attempts (id,job,generation,state,started,day,due,reserve_input,reserve_output,reserve_cost)
        VALUES (?,?,?,'running',?,?,?,?,?,?)`,
        attempt,
        id,
        generation,
        now,
        day,
        job.due,
        reserve.input,
        reserve.output,
        reserve.cost,
      );
      this.run(
        `INSERT INTO proactive_budget_days VALUES (?,?,?,?)
        ON CONFLICT(day) DO UPDATE SET input=input+excluded.input,output=output+excluded.output,cost=cost+excluded.cost`,
        day,
        reserve.input,
        reserve.output,
        reserve.cost,
      );
      this.run(
        `UPDATE dispatch_turns SET attempt = ? WHERE conversation = ? AND turn = ?`,
        digest(attempt),
        digest(id),
        digest(id),
      );
      return { job, attempt, generation, fence, worker };
    });
  }

  owns(claim: Claim) {
    const job = this.job(claim.job.id);
    return job &&
      job.attempt === claim.attempt &&
      job.worker === claim.worker &&
      job.generation === claim.generation &&
      job.fence === claim.fence &&
      (job.lease ?? 0) > this.now() &&
      ['running', 'pausing'].includes(job.state)
      ? job
      : undefined;
  }

  renew(claim: Claim) {
    if (!this.owns(claim)) return false;
    return Boolean(
      this.run(
        'UPDATE proactive_jobs SET lease = ? WHERE id = ? AND fence = ? AND lease > ?',
        this.now() + leaseMs,
        claim.job.id,
        claim.fence,
        this.now(),
      ).changes,
    );
  }

  async checkpoint(claim: Claim, checkpoint: LoopCheckpoint, signal: AbortSignal) {
    if (
      checkpoint.executionId !== claim.job.id ||
      checkpoint.generation !== claim.generation ||
      checkpoint.userMessageId !== claim.job.id ||
      !this.owns(claim)
    )
      return false;
    const encoded = await this.seal(checkpoint);
    signal.throwIfAborted();
    if (!this.owns(claim)) return false;
    return Boolean(
      this.run(
        `UPDATE proactive_jobs SET checkpoint = ?, checkpoint_revision = ? WHERE id = ?
      AND fence = ? AND (checkpoint_revision IS NULL OR checkpoint_revision < ?)`,
        encoded,
        checkpoint.revision,
        claim.job.id,
        claim.fence,
        checkpoint.revision,
      ).changes,
    );
  }

  async restore(row: JobRow) {
    if (!row.checkpoint) return undefined;
    const checkpoint = loopCheckpointSchema.parse(await this.open(row.checkpoint));
    const receipts = new Map(checkpoint.receipts.map((receipt) => [receipt.id, receipt]));
    const journal = this.receipts(row.id);
    for (const receipt of journal) receipts.set(receipt.id, receipt);
    const reserved = new Set(journal.map((receipt) => receipt.id));
    return {
      ...checkpoint,
      question: undefined,
      receipts: [...receipts.values()].slice(-48).flatMap((receipt) => {
        if (receipt.state !== 'pending') return [receipt];
        if (receipt.operation.startsWith('browser.') && !reserved.has(receipt.id)) return [];
        return [{ ...receipt, state: 'uncertain' as const }];
      }),
    };
  }

  receipts(id: string) {
    return this.all(
      `SELECT step AS id, operation, state FROM dispatch_receipts
       WHERE conversation = ? AND turn = ? AND step IS NOT NULL ORDER BY started DESC LIMIT 48`,
      digest(id),
      digest(id),
    ).flatMap((row) => {
      const receipt = loopReceiptSchema.safeParse(row);
      return receipt.success ? [receipt.data] : [];
    });
  }

  hasAmbiguousEffect(row: JobRow) {
    return !!this.one(
      `SELECT 1 FROM dispatch_receipts WHERE conversation = ? AND turn = ?
      AND state IN ('reserved','uncertain') AND (operation IN ('browser.browser_click','browser.browser_type','browser.browser_submit')
      OR operation IS NULL) LIMIT 1`,
      digest(row.id),
      digest(row.id),
    );
  }

  hasDispatchedAction(row: JobRow) {
    return !!this.one(
      `SELECT 1 FROM dispatch_receipts WHERE conversation=? AND turn=? AND
       operation IN ('browser.browser_click','browser.browser_type','browser.browser_submit') LIMIT 1`,
      digest(row.id),
      digest(row.id),
    );
  }

  private settleAttempt(attempt: string, state: string, usage?: Usage) {
    const current = this.one<{
      day: number;
      reserve_input: number;
      reserve_output: number;
      reserve_cost: number;
    }>(
      'SELECT day,reserve_input,reserve_output,reserve_cost FROM job_attempts WHERE id = ? AND finished IS NULL',
      attempt,
    );
    if (!current) return;
    const input = usage?.input ?? current.reserve_input;
    const output = usage?.output ?? current.reserve_output;
    const cost = usage?.cost ?? current.reserve_cost;
    this.run(
      'UPDATE job_attempts SET state=?,finished=?,input=?,output=?,cost=?,model_requests=? WHERE id=?',
      state,
      this.now(),
      input,
      output,
      cost,
      usage?.modelRequests ?? 0,
      attempt,
    );
    this.run(
      'UPDATE proactive_budget_days SET input=input+?,output=output+?,cost=cost+? WHERE day=?',
      input - current.reserve_input,
      output - current.reserve_output,
      cost - current.reserve_cost,
      current.day,
    );
  }

  finish(
    claim: Claim,
    state: ProactiveJobState,
    options: {
      reason?: string;
      result?: Buffer;
      usage?: Usage;
      due?: number;
      activity?: Buffer;
    } = {},
  ) {
    const row = this.owns(claim);
    if (!row) return false;
    this.transition(row, state, options.reason, options.due);
    this.settleAttempt(claim.attempt, state, options.usage);
    this.run(
      `UPDATE proactive_jobs SET attempt=NULL,worker=NULL,fence=NULL,lease=NULL,answer=NULL,
      result=coalesce(?,result),activity=coalesce(?,activity),retry_count=retry_count+? WHERE id=?`,
      options.result ?? null,
      options.activity ?? null,
      state === 'retry_scheduled' ? 1 : 0,
      row.id,
    );
    if (row.owner && row.kind === 'automation')
      this.run('UPDATE automation_definitions SET last_run=? WHERE id=?', this.now(), row.owner);
    return true;
  }

  reconcile(worker?: string, recoverAll = false) {
    if (!this.runtime.exists()) return 0;
    return this.atomic(() => {
      const stale = this.all<JobRow>(
        `SELECT * FROM proactive_jobs WHERE lease IS NOT NULL AND
        (? OR lease <= ? OR (? IS NOT NULL AND worker = ?))`,
        recoverAll ? 1 : 0,
        this.now(),
        worker ?? null,
        worker ?? null,
      );
      for (const row of stale) {
        if (!row.attempt) continue;
        this.runtime.interruptDispatches(row.attempt);
        this.metric('recovery');
        const state =
          this.hasAmbiguousEffect(row) || this.hasDispatchedAction(row)
            ? 'uncertain'
            : 'interrupted';
        this.transition(
          row,
          state,
          state === 'uncertain'
            ? 'Review the interrupted external effect.'
            : 'The previous worker stopped before committing the outcome.',
        );
        this.settleAttempt(row.attempt, state);
        this.run(
          'UPDATE proactive_jobs SET attempt=NULL,worker=NULL,fence=NULL,lease=NULL WHERE id=?',
          row.id,
        );
      }
      return stale.length;
    });
  }

  async scope(row: JobRow, provider: string): Promise<ProactiveRequest['scope'] | undefined> {
    if (!row.grant_id)
      return {
        publicSearch: false,
        publicOrigins: [],
        memory: row.kind === 'pulse' && this.settings().value.pulseMemory,
      };
    const grant = this.one<{ payload: Uint8Array }>(
      'SELECT payload FROM proactive_grants WHERE id=? AND provider=? AND revoked IS NULL AND (expires IS NULL OR expires>?)',
      row.grant_id,
      provider,
      this.now(),
    );
    return grant ? this.open(grant.payload) : undefined;
  }

  grantValid(row: Pick<JobRow, 'grant_id'>, provider: string) {
    return (
      !row.grant_id ||
      !!this.one(
        'SELECT 1 FROM proactive_grants WHERE id=? AND provider=? AND revoked IS NULL AND (expires IS NULL OR expires>?)',
        row.grant_id,
        provider,
        this.now(),
      )
    );
  }

  requeueInterrupted() {
    if (!this.runtime.exists()) return;
    for (const row of this.all<JobRow>(
      "SELECT * FROM proactive_jobs WHERE state='interrupted' AND reason IN ('The previous worker stopped before committing the outcome.','Execution stopped at a recoverable boundary.')",
    )) {
      if (!this.hasAmbiguousEffect(row) && !this.hasDispatchedAction(row))
        this.transition(row, 'queued', undefined, this.now());
    }
  }

  prune(days: number) {
    const cutoff = this.now() - days * 86_400_000;
    const removable = this.all<{ id: string }>(
      `SELECT a.id FROM proactive_artifacts a JOIN proactive_jobs j ON a.job=j.id
      WHERE j.updated<? AND j.state IN ('completed','failed','cancelled','skipped')
      AND NOT EXISTS (SELECT 1 FROM proactive_requests r WHERE r.job=j.id AND r.state='pending')`,
      cutoff,
    );
    this.run('DELETE FROM proactive_commands WHERE created<?', cutoff);
    this.run('DELETE FROM proactive_requests WHERE state != ? AND updated<?', 'pending', cutoff);
    this.run(
      "DELETE FROM pulse_runs WHERE at<? AND (job IS NULL OR state IN ('completed','failed','cancelled','skipped'))",
      cutoff,
    );
    this.run('DELETE FROM proactive_events WHERE at<?', cutoff);
    this.run('DELETE FROM notification_outbox WHERE created<?', cutoff);
    this.run(
      `DELETE FROM proactive_jobs WHERE updated<? AND state IN ('completed','failed','cancelled','skipped')
      AND id NOT IN (SELECT job FROM proactive_requests WHERE job IS NOT NULL AND state='pending')`,
      cutoff,
    );
    this.run('DELETE FROM proactive_budget_days WHERE day<?', Math.floor(cutoff / 86_400_000));
    return removable.map(({ id }) => id);
  }
}
