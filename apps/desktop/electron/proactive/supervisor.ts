import { randomUUID } from 'node:crypto';
import {
  defaultProactiveLimits,
  type ConnectorJobGrant,
  type MediaAsset,
  type ConductorActivity,
  type ChatEvent,
  type ProactiveJobState,
  type ProactiveRequest,
} from '@aria/shared';
import type { ProactiveHost } from './host';
import { type Claim, type JobRow, type ProactiveStore, type Usage } from './store';

type Prepared = Pick<ProactiveRequest, 'scope' | 'context' | 'limits' | 'spendingLimit'> & {
  retries: number;
};
type Live = {
  claim: Claim;
  controller: AbortController;
  prepared: Prepared;
  stop?: 'blocked' | 'paused' | 'cancelled' | 'interrupted' | 'waiting_user' | 'waiting_approval';
  activities: Map<string, Extract<ChatEvent, { type: 'activity' }>['activity']>;
  observations: Map<string, string>;
  githubWatch?: string;
  privateContent?: boolean;
};
type Outcome = {
  state: ProactiveJobState;
  text: string;
  reason?: string;
  usage?: Usage;
  due?: number;
  artifacts: MediaAsset[];
  activity: ConductorActivity[];
  githubWatch?: string;
};

export class ProactiveSupervisor {
  private readonly worker = randomUUID();
  private readonly active = new Map<string, Live>();
  private readonly work = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private working = false;
  private rerun = false;
  private suspended = false;
  private resumeSequence = 0;
  private closed = false;
  private nextPrune = 0;
  private failureDelay = 0;

  constructor(
    private readonly store: ProactiveStore,
    private readonly host: ProactiveHost,
    private readonly schedule: () => Promise<void>,
    private readonly nextSchedule: () => number | null,
    private readonly prepare: (job: JobRow, provider: string) => Promise<Prepared>,
    private readonly park: (attempt: Live, kind: 'clarification', text: string) => Promise<void>,
    private readonly commit: (claim: Claim, outcome: Outcome) => Promise<void>,
    private readonly change: () => void,
  ) {}

  start() {
    if (!this.store.runtime.exists()) return;
    this.store.reconcile(undefined, true);
    this.store.atomic(() => this.store.requeueInterrupted());
    this.wake();
  }

  wake() {
    if (this.closed || this.suspended || !this.store.runtime.exists()) return;
    clearTimeout(this.timer);
    if (this.working) {
      this.rerun = true;
      return;
    }
    this.timer = setTimeout(() => void this.tick(), 0);
    this.timer.unref();
  }

  private async tick() {
    if (this.closed || this.suspended || this.working) return;
    this.working = true;
    try {
      const now = this.store.now();
      if (this.store.reconcile()) {
        this.store.atomic(() => this.store.requeueInterrupted());
        this.change();
      }
      if (now >= this.nextPrune) {
        const expired = this.store.atomic(() =>
          this.store.prune(this.store.settings().value.retentionDays),
        );
        for (const id of expired) await this.host.removeArtifact?.(id).catch(() => undefined);
        this.nextPrune = now + 3_600_000;
      }
      const encrypted = await this.store.cipher.available();
      if (encrypted) await this.schedule();
      const identity = this.host.identity();
      const settings = this.store.settings().value;
      if (!encrypted || !identity || settings.emergencyPaused || this.closed || this.suspended)
        return;
      for (const job of this.store.due(settings.concurrency + 8)) {
        if (this.active.size >= settings.concurrency || this.closed || this.suspended) break;
        if (this.active.has(job.id)) continue;
        if (!this.store.grantValid(job, identity.provider)) {
          this.store.transition(
            job,
            'blocked',
            'Renew this responsibility’s permission with the configured primary.',
          );
          this.change();
          continue;
        }
        let prepared: Prepared;
        try {
          prepared = await this.prepare(job, identity.provider);
        } catch (error) {
          const current = this.store.job(job.id);
          if (current?.revision === job.revision)
            this.store.transition(
              current,
              'blocked',
              error instanceof Error ? error.message : 'This responsibility needs review.',
            );
          this.change();
          continue;
        }
        if (
          this.closed ||
          this.suspended ||
          this.store.settings().value.emergencyPaused ||
          this.host.identity()?.provider !== identity.provider ||
          this.store.job(job.id)?.revision !== job.revision ||
          !this.store.grantValid(job, identity.provider)
        )
          continue;
        const claim = this.store.claim(
          job.id,
          this.worker,
          identity.provider,
          {
            input: prepared.limits.inputTokens,
            output: prepared.limits.outputTokens,
            cost: prepared.spendingLimit,
          },
          this.store.settings().value,
        );
        if (!claim) continue;
        const live: Live = {
          claim,
          prepared,
          controller: new AbortController(),
          activities: new Map(),
          observations: new Map(),
          privateContent: Boolean(job.memory_private),
        };
        this.active.set(job.id, live);
        this.startHeartbeat();
        this.change();
        const admittedBefore = this.resumeSequence;
        const task = this.execute(live, identity.revision).finally(() => {
          if (admittedBefore !== this.resumeSequence && !this.suspended && !this.closed)
            this.store.atomic(() => this.store.requeueInterrupted());
          this.active.delete(job.id);
          if (!this.active.size) {
            clearInterval(this.heartbeat);
            this.heartbeat = undefined;
          }
          this.host.closeJob?.(job.id);
          this.work.delete(task);
          this.change();
          this.wake();
        });
        this.work.add(task);
      }
      this.failureDelay = 0;
    } catch {
      this.failureDelay = 10_000;
    } finally {
      this.working = false;
      if (!this.closed && !this.suspended) {
        const now = this.store.now();
        const settings = this.store.settings();
        const canRun =
          this.host.identity() &&
          !settings.value.emergencyPaused &&
          this.active.size < settings.value.concurrency;
        const next = Math.min(
          this.nextSchedule() ?? Infinity,
          canRun ? (this.store.nextDue() ?? Infinity) : Infinity,
          now + 60_000,
        );
        const delay = this.rerun ? 0 : Math.max(250, next - now);
        this.rerun = false;
        this.timer = setTimeout(() => void this.tick(), Math.max(this.failureDelay, delay));
        this.timer.unref();
      }
    }
  }

  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const live of this.active.values())
        if (!this.store.renew(live.claim)) this.stop(live.claim.job.id, 'interrupted');
    }, 5000);
    this.heartbeat.unref();
  }

  live(attemptId: string, owner: string) {
    const live = this.active.get(owner);
    const current = live && this.store.owns(live.claim);
    if (
      !live ||
      !current ||
      live.claim.attempt !== attemptId ||
      live.controller.signal.aborted ||
      live.stop ||
      this.store.settings().value.emergencyPaused ||
      this.suspended ||
      this.closed ||
      current.provider !== this.host.identity()?.provider ||
      !this.store.grantValid(current, current.provider!)
    )
      return;
    return live;
  }

  activity(id: string) {
    return [...(this.active.get(id)?.activities.values() ?? [])];
  }

  stop(id: string, mode: NonNullable<Live['stop']>) {
    const live = this.active.get(id);
    if (!live) return;
    live.stop ??= mode;
    live.controller.abort();
  }

  fenceConnectors(invalid: (job: JobRow, grant: ConnectorJobGrant) => boolean) {
    for (const live of this.active.values()) {
      const grant = live.prepared.scope.connector;
      if (grant && invalid(live.claim.job, grant)) this.stop(live.claim.job.id, 'blocked');
    }
  }

  suspend() {
    this.suspended = true;
    clearTimeout(this.timer);
    for (const id of this.active.keys()) this.stop(id, 'interrupted');
  }

  resume() {
    this.resumeSequence++;
    this.suspended = false;
    if (this.store.runtime.exists()) this.store.atomic(() => this.store.requeueInterrupted());
    this.wake();
  }

  async close() {
    this.closed = true;
    this.suspend();
    await Promise.allSettled(this.work);
    this.store.reconcile(this.worker);
  }

  private async execute(live: Live, revision: string) {
    const { claim, controller, prepared } = live;
    const job = claim.job;
    let text = '';
    let terminal: Extract<ChatEvent, { type: 'completed' | 'failed' | 'stopped' }> | undefined;
    let pending: Promise<void> | undefined;
    let priorUsage: Usage | undefined;
    let runStarted = false;
    const artifacts = new Map<string, MediaAsset>();
    try {
      const recovery = await this.store.restore(job);
      priorUsage = recovery && {
        input: recovery.budget.inputTokens ?? recovery.budget.inputReserved,
        output: recovery.budget.outputTokens ?? recovery.budget.outputReserved,
        cost: recovery.budget.cost,
        modelRequests: recovery.budget.providerRequests,
      };
      const answer = job.answer ? await this.store.open<string>(job.answer) : undefined;
      controller.signal.throwIfAborted();
      runStarted = true;
      await this.host.run(
        {
          kind: job.kind,
          attemptId: claim.attempt,
          jobId: job.id,
          expectedRevision: revision,
          execution: {
            executionId: job.id,
            generation: claim.generation,
            userMessageId: job.id,
            recovery,
          },
          context: prepared.context,
          limits: prepared.limits,
          spendingLimit: prepared.spendingLimit,
          scope: prepared.scope,
          answer,
        },
        AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(prepared.limits.activeMs + 12_000),
        ]),
        (event) => {
          if (event.type === 'activity') {
            live.activities.set(event.activity.stepId, event.activity);
            if (live.activities.size > 36)
              live.activities.delete(live.activities.keys().next().value!);
            if (event.activity.status === 'running' || event.activity.status === 'completed')
              this.change();
          } else if (event.type === 'asset') {
            artifacts.set(event.asset.id, event.asset);
          } else if (event.type === 'delta') {
            text = (text + event.text).slice(0, 20_000);
          } else if (event.type === 'reset') {
            text = '';
          } else if (event.type === 'execution' && event.execution.question && !pending) {
            pending = this.park(live, 'clarification', event.execution.question.text).catch(() => {
              this.stop(job.id, 'interrupted');
            });
          } else if (
            event.type === 'completed' ||
            event.type === 'failed' ||
            event.type === 'stopped'
          ) {
            terminal = event;
          }
        },
      );
      await pending;
    } catch {
      if (!live.stop) live.stop = 'interrupted';
    }

    let state: ProactiveJobState;
    let due: number | undefined;
    let reason: string | undefined;
    if (this.store.hasAmbiguousEffect(job)) {
      state = 'uncertain';
      reason = 'Review the interrupted external effect before proceeding.';
    } else if (live.stop === 'interrupted' && this.store.hasDispatchedAction(job)) {
      state = 'uncertain';
      reason = 'The browser accepted an action before the run could verify its outcome.';
    } else if (live.stop) {
      state = live.stop;
      reason = state === 'interrupted' ? 'Execution stopped at a recoverable boundary.' :
        state === 'blocked' ? 'GitHub access changed. Reconnect and review the repository scope.' : undefined;
    } else if (terminal?.type === 'completed') {
      state = 'partial' in terminal && terminal.partial ? 'blocked' : 'completed';
      if ('partial' in terminal && terminal.partial)
        reason = 'The responsibility has a partial result.';
    } else if (terminal?.type === 'failed' && terminal.settingsHelp) {
      state = 'blocked';
      reason = terminal.error;
    } else if (terminal?.type === 'failed' && terminal.problem?.code === 'BUDGET_EXCEEDED') {
      state = 'blocked';
      reason = terminal.error;
    } else if (
      terminal?.type === 'failed' &&
      job.retry_count + 1 < prepared.retries &&
      !this.store.hasDispatchedAction(job)
    ) {
      state = 'retry_scheduled';
      reason = 'The provider or an authorized operation failed. A retry is scheduled.';
      due = this.store.now() + [60_000, 300_000, 900_000, 1_800_000][Math.min(job.retry_count, 3)];
    } else {
      state = 'failed';
      reason =
        terminal?.type === 'failed'
          ? terminal.error
          : 'The execution ended without a verified result.';
    }

    const run = terminal && 'run' in terminal ? terminal.run : undefined;
    const usage =
      run?.usage &&
      typeof run.usage.accountedCostUsdMicros === 'number' &&
      typeof run.usage.inputTokens === 'number' &&
      typeof run.usage.outputTokens === 'number'
        ? {
            input: Math.max(0, run.usage.inputTokens - (priorUsage?.input ?? 0)),
            output: Math.max(0, run.usage.outputTokens - (priorUsage?.output ?? 0)),
            cost: Math.max(0, run.usage.accountedCostUsdMicros - (priorUsage?.cost ?? 0)),
            modelRequests: Math.max(
              0,
              (run.usage.providerRequests ?? 0) - (priorUsage?.modelRequests ?? 0),
            ),
          }
        : !runStarted || run?.usage?.providerRequests === 0
          ? { input: 0, output: 0, cost: 0, modelRequests: 0 }
          : undefined;
    try {
      await this.commit(claim, {
        state,
        text,
        reason,
        usage,
        due,
        artifacts: [...artifacts.values()],
        activity: [...live.activities.values()],
        githubWatch: live.githubWatch,
      });
    } catch {
      this.store.atomic(() =>
        this.store.finish(claim, state === 'uncertain' ? state : 'interrupted', {
          reason: 'The execution result could not be committed.',
        }),
      );
    }
  }
}

export { defaultProactiveLimits };
