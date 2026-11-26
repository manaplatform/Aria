import { randomUUID } from 'node:crypto';
import {
  automationDraftSchema,
  defaultProactiveLimits,
  proactiveCommandSchema,
  proactiveOperations,
  proactiveReadOperations,
  type MediaAsset,
  type ConductorActivity,
  type AutomationDraft,
  type BrowserRequest,
  type CapabilityHostRequest,
  type githubResult,
  type ProactiveCommand,
  type ProactiveEvent,
  type ProactiveOperation,
  type ProactiveResult,
  type RuntimeResult,
} from '@aria/shared';
import { digest, RuntimeError } from '../runtime/store';
import { Agenda } from './agenda';
import { Automations } from './automations';
import type { ProactiveHost } from './host';
import { ProactiveNotifications } from './notifications';
import { Pulse } from './pulse';
import { preview, validateZone } from './schedule';
import { type Claim, type JobRow, ProactiveError, type ProactiveStore } from './store';
import { ProactiveSupervisor } from './supervisor';

const requestLifetime = 24 * 60 * 60_000;
type PendingRow = {
  id: string;
  revision: number;
  kind: 'automation' | 'clarification' | 'approval';
  job: string | null;
  state: string;
  provider: string | null;
  target: string | null;
  target_revision: number | null;
  payload: Uint8Array;
  expires: number;
  created: number;
  updated: number;
};
type PendingPayload = {
  message: string;
  review?: string;
  automation?: AutomationDraft;
  fingerprint?: string;
  receipt?: string;
  command?: Extract<
    ProactiveCommand,
    { action: 'automation_control' | 'task_update' | 'task_state' | 'job_control' | 'task_run' }
  >;
};
type Active = NonNullable<ReturnType<ProactiveSupervisor['live']>>;
type RuntimeCall = Extract<CapabilityHostRequest, { type: 'runtime' }>;
const allowedBrowser = new Set([
  'web_fetch',
  'web_search',
  'browser_open',
  'browser_navigate',
  'browser_get_tabs',
  'browser_get_page',
  'browser_extract',
  'browser_wait',
  'browser_scroll',
  'browser_close',
  'browser_click',
  'browser_type',
  'browser_submit',
]);

export class ProactiveService {
  readonly agenda: Agenda;
  readonly automations: Automations;
  readonly pulse: Pulse;
  readonly notifications: ProactiveNotifications;
  readonly supervisor: ProactiveSupervisor;
  private sequence = 0;
  private memoryEpoch = 0;
  private commands: Promise<unknown> = Promise.resolve();

  constructor(
    readonly store: ProactiveStore,
    private readonly host: ProactiveHost,
  ) {
    this.agenda = new Agenda(store, (type, id, ancestry) =>
      this.automations.publish(type, id, ancestry),
    );
    this.automations = new Automations(store, (id) => {
      for (const job of store.activeFor('automation', id)) {
        if (job.attempt) this.supervisor.stop(job.id, 'cancelled');
        else this.store.transition(job, 'cancelled', 'The owning automation was changed.');
      }
    });
    this.pulse = new Pulse(store);
    this.notifications = new ProactiveNotifications(store, host);
    this.supervisor = new ProactiveSupervisor(
      store,
      host,
      async () => {
        await this.automations.tick();
        this.pulse.tick();
        this.expireRequests();
        this.notifications.flush();
      },
      () => {
        const { due, value } = this.store.settings();
        const next = Math.min(
          this.automations.nextDue() ?? Infinity,
          value.pulseEnabled && !value.pulsePaused ? (due ?? Infinity) : Infinity,
        );
        return Number.isFinite(next) ? next : null;
      },
      this.prepare.bind(this),
      this.park.bind(this),
      this.commit.bind(this),
      this.changed.bind(this),
    );
  }

  changed(target?: ProactiveEvent['target']) {
    this.host.changed({ sequence: ++this.sequence, target });
  }

  start() {
    this.supervisor.start();
  }
  wake() {
    this.supervisor.wake();
  }
  suspend() {
    this.supervisor.suspend();
  }
  show() {
    this.supervisor.resume();
  }
  resume() {
    this.event('runtime.resumed');
    this.supervisor.resume();
  }
  close() {
    return this.supervisor.close();
  }
  background() {
    return this.store.settings().value.background;
  }
  event(kind: 'runtime.resumed' | 'desktop.unlocked') {
    if (!this.store.runtime.exists()) return;
    this.store.atomic(() => this.automations.publish(kind, null));
    this.wake();
  }

  private identity() {
    const identity = this.host.identity();
    if (!identity)
      throw new ProactiveError(
        'unavailable',
        'Configure and start your primary model in Settings.',
      );
    return identity;
  }

  private async prepare(job: JobRow, provider: string) {
    const scope = await this.store.scope(job, provider);
    const activity = job.activity ? await this.store.open<ConductorActivity[]>(job.activity) : [];
    const observations = activity
      .filter(({ status, outcomeUnverified }) => status === 'completed' && !outcomeUnverified)
      .slice(-8)
      .map(({ summary, stepId, resultSummary }) => ({ summary, stepId, resultSummary }));
    const reviewedActions = await Promise.all(
      this.store
        .all<PendingRow>(
          "SELECT * FROM proactive_requests WHERE job=? AND kind='approval' AND state='approved' AND provider=? AND expires>? ORDER BY updated DESC LIMIT 3",
          job.id,
          provider,
          this.store.now(),
        )
        .map(async (row) => (await this.store.open<PendingPayload>(row.payload)).message),
    );
    if (!scope) throw new ProactiveError('permission', 'Renew this responsibility’s permissions.');
    if (scope.connector) {
      try {
        if (!this.host.connectorValid?.(scope.connector, provider))
          throw new ProactiveError('permission', 'GitHub access changed. Reconnect and review the repository scope.');
        await this.host.verifyConnector?.(scope.connector, provider);
      } catch (error) {
        if (!this.host.connectorValid?.(scope.connector, provider)) this.blockConnectorJob(job);
        throw error;
      }
    }
    let context: unknown;
    let limits = defaultProactiveLimits;
    let spendingLimit = 150_000;
    let retries = 3;
    if (job.kind === 'automation' && job.owner) {
      const row = this.automations.row(job.owner);
      if (
        !row ||
        row.state !== 'enabled' ||
        row.revision !== job.owner_revision ||
        (row.expires !== null && row.expires <= this.store.now())
      )
        throw new ProactiveError('conflict', 'The automation changed or expired.');
      const draft = await this.automations.draft(row);
      context = {
        action: draft.action,
        githubWatch: draft.trigger.kind === 'github_watch' ? {
          repository: draft.trigger.repository,
          operation: draft.trigger.watch === 'release' ? 'github.list_releases' : 'github.list_workflow_runs',
          arguments: draft.trigger.watch === 'release' ? { page: 1 } : { page: 1, status: 'failure' },
          instruction: 'Call the designated GitHub read for the exact monitored repository to establish a verified observation.',
        } : undefined,
        instruction: draft.instruction,
        condition:
          draft.trigger.kind === 'condition'
            ? {
                origin: draft.trigger.origin,
                previous: this.automations.trigger(row.id)?.condition,
                guidance:
                  'Inspect the exact authorized origin and report the new condition with a step ID.',
              }
            : undefined,
      };
      limits = draft.limits;
      spendingLimit = draft.maxMicros;
      retries = draft.maxAttempts;
    } else if (job.kind === 'agenda' && job.owner) {
      const row = this.agenda.taskRow(job.owner);
      if (!row || !['ready', 'in_progress', 'blocked'].includes(row.state))
        throw new ProactiveError('conflict', 'This Agenda task is no longer runnable.');
      const task = await this.agenda.task(row);
      if (task.dependencies.some((id) => this.agenda.taskRow(id)?.state !== 'completed'))
        throw new ProactiveError(
          'conflict',
          'Complete the task’s prerequisites before running it.',
        );
      context = { task };
    } else {
      const [tasks, objectives, automations] = await Promise.all([
        this.agenda.tasks(0, 'ready'),
        this.agenda.objectives(0),
        this.automations.list(0, provider),
      ]);
      const jobs = this.store.all<JobRow>(
        `SELECT * FROM proactive_jobs WHERE id != ? ORDER BY updated DESC LIMIT 10`,
        job.id,
      );
      context = {
        tasks: tasks.tasks
          .slice(0, 12)
          .map(({ description, ...task }) => ({ ...task, description: description.slice(0, 240) })),
        objectives: objectives
          .slice(0, 5)
          .map(({ id, revision, title, state }) => ({ id, revision, title, state })),
        automations: automations
          .slice(0, 8)
          .map(({ id, title, nextDue, condition }) => ({ id, title, nextDue, condition })),
        jobs: jobs.map(({ id, state, reason, due, owner, revision }) => ({
          id,
          state,
          reason,
          due,
          owner,
          revision,
        })),
        guidance:
          'Stay silent when no useful action is needed. A new runnable responsibility requires user authorization.',
      };
      limits = {
        ...limits,
        iterations: 4,
        steps: 8,
        inputTokens: 32_000,
        outputTokens: 8192,
        activeMs: 65_000,
      };
      spendingLimit = 70_000;
      retries = 1;
    }
    return {
      scope,
      limits,
      spendingLimit,
      retries,
      context: JSON.stringify({
        now: new Date(this.store.now()).toISOString(),
        zone: this.store.settings().zone,
        kind: job.kind,
        data: context,
        scope,
        remainingLimits: limits,
        observations,
        reviewedActions,
      }).slice(0, 16_000),
    };
  }

  private pending(
    kind: PendingRow['kind'],
    payload: Buffer,
    job?: string,
    target?: string,
    targetRevision?: number,
    provider?: string,
    conversation?: string,
  ) {
    const id = randomUUID();
    const now = this.store.now();
    this.store.run(
      "INSERT INTO proactive_requests VALUES (?,1,?,'pending',?,?,?,?,?,?,?,?,?)",
      id,
      kind,
      job ?? null,
      payload,
      provider ?? null,
      target ?? null,
      targetRevision ?? null,
      now + requestLifetime,
      now,
      now,
      conversation ?? null,
    );
    this.notifications.add(
      kind === 'clarification' ? 'Clarification needed' : 'Approval needed',
      job ? this.store.job(job) : undefined,
      id,
    );
    return id;
  }

  removeConversation(id: string) {
    if (!this.store.runtime.exists()) return;
    this.store.run(
      "DELETE FROM proactive_requests WHERE source_conversation=? AND state='pending'",
      id,
    );
    this.changed();
  }

  private expireRequests() {
    for (const row of this.store.all<PendingRow>(
      "SELECT * FROM proactive_requests WHERE state='pending' AND expires<=? LIMIT 50",
      this.store.now(),
    )) {
      this.store.run(
        "UPDATE proactive_requests SET state='expired',updated=?,revision=revision+1 WHERE id=?",
        this.store.now(),
        row.id,
      );
      const job = row.job && this.store.job(row.job);
      if (job && ['waiting_approval', 'waiting_user'].includes(job.state))
        this.store.transition(job, 'blocked', 'The request expired. Review or retry the job.');
      this.changed();
    }
  }

  private async park(active: Active, kind: 'clarification', text: string) {
    const encoded = await this.store.seal({ message: text });
    if (!this.store.owns(active.claim) || active.controller.signal.aborted) return;
    this.store.atomic(() =>
      this.pending(
        kind,
        encoded,
        active.claim.job.id,
        undefined,
        undefined,
        this.host.identity()?.provider,
      ),
    );
    this.supervisor.stop(active.claim.job.id, 'waiting_user');
  }

  approveBrowser(request: BrowserRequest, fingerprint: string, message: string, signal: AbortSignal) {
    return this.approveAction({ ...request, operation: request.op }, fingerprint, message, signal);
  }

  async approveAction(
    request: { requestId: string; conversationId: string; stepId: string; operation: string },
    fingerprint: string,
    message: string,
    signal: AbortSignal,
  ) {
    const active = this.supervisor.live(request.requestId, request.conversationId);
    if (!active) return false;
    const job = active.claim.job;
    const provider = this.identity().provider;
    const prior = this.store.all<PendingRow>(
      "SELECT * FROM proactive_requests WHERE job=? AND kind='approval' AND state IN ('approved','declined') AND provider=? AND expires>? ORDER BY updated DESC LIMIT 8",
      job.id,
      provider,
      this.store.now(),
    );
    for (const row of prior) {
      const data = await this.store.open<PendingPayload>(row.payload);
      if (!this.supervisor.live(request.requestId, request.conversationId) || signal.aborted)
        return false;
      if (data.fingerprint !== fingerprint) continue;
      if (row.state === 'declined') return false;
      return Boolean(
        this.store.run(
          "UPDATE proactive_requests SET state='consumed',revision=revision+1,updated=? WHERE id=? AND state='approved'",
          this.store.now(),
          row.id,
        ).changes,
      );
    }
    const receipt = this.store.runtime.beginApproval(
      {
        conversation: job.id,
        request: request.requestId,
        step: request.stepId,
        operation: request.operation,
      },
      fingerprint,
    );
    const payload = await this.store.seal({
      message: message.slice(0, 3000),
      review: request.operation.startsWith('github.') ? message : message.slice(0, 8200),
      fingerprint,
      receipt,
    });
    if (!this.supervisor.live(request.requestId, request.conversationId) || signal.aborted) {
      this.store.runtime.finishApproval(receipt, 'cancelled');
      return false;
    }
    this.store.atomic(() =>
      this.pending('approval', payload, job.id, undefined, undefined, provider),
    );
    this.supervisor.stop(job.id, 'waiting_approval');
    return false;
  }

  private blockConnectorJob(job: JobRow) {
    if (job.kind === 'automation' && job.owner) {
      this.store.run("UPDATE automation_definitions SET state='paused',updated=? WHERE id=? AND state='enabled'",
        this.store.now(), job.owner);
      this.store.run('UPDATE automation_triggers SET next_due=NULL WHERE automation=?', job.owner);
    }
    if (job.kind === 'agenda' && job.owner)
      this.store.run("UPDATE agenda_tasks SET state='blocked',revision=revision+1,updated=? WHERE id=? AND state IN ('ready','in_progress')",
        this.store.now(), job.owner);
    this.notifications.add('GitHub connection needs review', job, job.id + ':github-review');
  }

  connectorChanged() {
    const provider = this.host.identity()?.provider;
    if (!provider) return;
    this.supervisor.fenceConnectors((job, grant) => {
      if (this.host.connectorValid?.(grant, provider)) return false;
      this.blockConnectorJob(job);
      return true;
    });
    this.wake();
  }

  authorizeBrowser(request: BrowserRequest) {
    const active = this.supervisor.live(request.requestId, request.conversationId);
    if (
      !active ||
      active.privateContent ||
      !allowedBrowser.has(request.op) ||
      (!active.prepared.scope.publicSearch && !active.prepared.scope.publicOrigins.length)
    )
      return undefined;
    if (request.op === 'web_search' && !active.prepared.scope.publicSearch) return undefined;
    if (typeof request.args.url === 'string' && !this.canVisit(active, request.args.url))
      return undefined;
    return active.controller.signal;
  }

  markPrivate(id: string) {
    const row = this.store.job(id);
    const live = row?.attempt && this.supervisor.live(row.attempt, id);
    if (!live) return;
    live.privateContent = true;
    this.store.run(
      'UPDATE proactive_jobs SET memory_private=1 WHERE id=? AND fence=?',
      id,
      live.claim.fence,
    );
  }

  invalidateMemory() {
    this.memoryEpoch++;
    if (!this.store.runtime.exists()) return;
    for (const row of this.store.all<JobRow>(
      'SELECT * FROM proactive_jobs WHERE memory_private=1 AND attempt IS NOT NULL',
    ))
      this.supervisor.stop(row.id, 'interrupted');
    this.store.run(
      'UPDATE proactive_jobs SET result=NULL,activity=NULL,checkpoint=NULL,checkpoint_revision=NULL WHERE memory_private=1',
    );
    this.store.run(
      'DELETE FROM proactive_artifacts WHERE job IN (SELECT id FROM proactive_jobs WHERE memory_private=1)',
    );
    this.changed();
  }

  canVisit(active: Active, url: string) {
    if (!URL.canParse(url)) return false;
    return (
      !active.privateContent &&
      (active.prepared.scope.publicSearch ||
        active.prepared.scope.publicOrigins.includes(new URL(url).origin))
    );
  }

  checkpoint(request: Extract<CapabilityHostRequest, { type: 'checkpoint' }>, signal: AbortSignal) {
    const live = this.supervisor.live(request.requestId, request.conversationId);
    return live
      ? this.store.checkpoint(live.claim, request.checkpoint, signal)
      : Promise.resolve(false);
  }

  private async commit(
    claim: Claim,
    outcome: Parameters<ConstructorParameters<typeof ProactiveSupervisor>[6]>[1],
  ) {
    const row = this.store.owns(claim);
    if (!row) return;
    const automation =
      row.kind === 'automation' && row.owner ? this.automations.row(row.owner) : undefined;
    const draft =
      automation && automation.state !== 'deleted'
        ? await this.automations.draft(automation)
        : undefined;
    const epoch = this.memoryEpoch;
    const attempted = outcome.state === 'completed';
    const result =
      outcome.text && (attempted || outcome.state === 'blocked')
        ? await this.store.seal(outcome.text)
        : undefined;
    const activity =
      outcome.activity.length && !(row.memory_private && !outcome.usage)
        ? await this.store.seal(outcome.activity)
        : undefined;
    if (row.memory_private)
      for (const asset of outcome.artifacts)
        await this.host.removeArtifact?.(asset.id).catch(() => undefined);
    const artifacts = row.memory_private
      ? []
      : await Promise.all(
          outcome.artifacts.map(async (asset) => [asset.id, await this.store.seal(asset)] as const),
        );
    this.store.atomic(() => {
      if (
        outcome.state === 'completed' &&
        row.kind === 'agenda' &&
        row.owner &&
        !this.agenda.canCompleteTask(row.owner)
      ) {
        outcome.state = 'blocked';
        outcome.reason = 'The task has unresolved subtasks or dependencies.';
      }
      if (outcome.state === 'completed' && draft?.trigger.kind === 'github_watch' && outcome.githubWatch === undefined) {
        outcome.state = 'blocked';
        outcome.reason = 'The run produced no verified GitHub observation for the watched repository.';
      }
      if (outcome.state === 'completed' && draft?.trigger.kind === 'condition' && !row.condition) {
        outcome.state = 'blocked';
        outcome.reason = 'The run produced no verified condition for the authorized target.';
      }
      const memoryCurrent = !row.memory_private || epoch === this.memoryEpoch;
      if (!memoryCurrent) {
        outcome.state = 'interrupted';
        outcome.reason = 'A recalled memory changed before the result was saved.';
      }
      if (
        !this.store.finish(claim, outcome.state, {
          ...outcome,
          result: memoryCurrent ? result : undefined,
          activity: memoryCurrent ? activity : undefined,
        })
      )
        return;
      for (const [id, payload] of artifacts)
        this.store.run(
          'INSERT OR IGNORE INTO proactive_artifacts VALUES (?,?,?)',
          row.id,
          id,
          payload,
        );
      if (outcome.state === 'completed' && row.kind === 'agenda' && row.owner)
        this.agenda.completed(row.owner, JSON.parse(row.ancestry) as string[]);
      if (
        outcome.state === 'completed' &&
        draft?.trigger.kind === 'condition' &&
        row.owner &&
        row.condition
      ) {
        const trigger = this.automations.trigger(row.owner);
        if (trigger) {
          const changed = !!trigger.condition && trigger.condition !== row.condition;
          const notify =
            changed &&
            draft.notifications !== 'none' &&
            (trigger.last_notification === null ||
              trigger.last_notification + draft.trigger.cooldownMinutes * 60_000 <=
                this.store.now());
          this.store.run(
            'UPDATE automation_triggers SET condition=?,last_notification=coalesce(?,last_notification) WHERE automation=?',
            row.condition,
            notify ? this.store.now() : null,
            row.owner,
          );
          if (notify) this.notifications.add('Condition changed', row, row.id + ':condition');
        }
      } else if (outcome.state === 'completed' && draft?.trigger.kind === 'github_watch' && row.owner && automation &&
          outcome.githubWatch !== undefined) {
        const current = this.store.one<{ evidence: string }>(
          'SELECT evidence FROM connector_watch_baseline WHERE automation=? AND revision=?',
          row.owner, automation.revision);
        if (current && current.evidence !== outcome.githubWatch && outcome.githubWatch !== 'none' && draft.notifications !== 'none')
          this.notifications.add(draft.trigger.watch === 'release' ? 'New GitHub release' : 'GitHub workflow failed',
            row, row.owner + ':github:' + automation.revision + ':' + outcome.githubWatch);
        this.store.run('INSERT OR REPLACE INTO connector_watch_baseline VALUES (?,?,?)',
          row.owner, automation.revision, outcome.githubWatch);
      } else if (
        outcome.state === 'completed' &&
        row.kind !== 'pulse' &&
        draft?.notifications !== 'none'
      ) {
        this.notifications.add('Responsibility completed', row, row.id + ':completed');
      }
      if (
        ['failed', 'uncertain', 'blocked'].includes(outcome.state) &&
        draft?.notifications !== 'none'
      )
        this.notifications.add('Responsibility needs attention', row, row.id + ':' + outcome.state);
    });
  }

  handle(input: unknown): Promise<ProactiveResult> {
    const parsed = proactiveCommandSchema.safeParse(input);
    if (!parsed.success)
      return Promise.resolve({
        kind: 'error',
        code: 'validation',
        message: parsed.error.issues[0]?.message ?? 'Invalid proactive command.',
      });
    const command = parsed.data;
    const read = [
      'snapshot',
      'detail',
      'automation_preview',
      'artifact_export',
      'memory_save',
    ].includes(command.action);
    const task = (
      read ? this.command(command) : this.commands.then(() => this.command(command))
    ).catch((error: unknown): ProactiveResult => ({
      kind: 'error',
      code: error instanceof ProactiveError ? error.code : 'validation',
      message:
        error instanceof Error
          ? error.message.slice(0, 1000)
          : 'The proactive command could not be completed.',
    }));
    if (!read) this.commands = task;
    return task;
  }

  private async snapshot(
    command: Extract<ProactiveCommand, { action: 'snapshot' }>,
  ): Promise<ProactiveResult> {
    const { value: settings, revision } = this.store.settings();
    const ready = await this.store.cipher.available();
    const offset = command.offset ?? 0;
    const tasks = ready
      ? await this.agenda.tasks(offset, command.taskState, command.priority, command.query)
      : { tasks: [], next: null };
    const rows = this.store.all<JobRow>(
      'SELECT * FROM proactive_jobs ORDER BY created DESC,id LIMIT 20 OFFSET ?',
      offset,
    );
    const pending = ready
      ? this.store.all<PendingRow>(
          "SELECT * FROM proactive_requests WHERE state='pending' AND expires>? ORDER BY created DESC LIMIT 20 OFFSET ?",
          this.store.now(),
          offset,
        )
      : [];
    const identity = this.host.identity();
    return {
      kind: 'snapshot',
      value: {
        settings,
        revision,
        ready,
        status: !ready
          ? 'Unlock OS-backed encrypted storage.'
          : !identity
            ? 'Start the configured primary to run proactive work.'
            : undefined,
        pulse: this.pulse.status(),
        counts: this.agenda.counts(),
        metrics: this.store.metrics(),
        tasks: tasks.tasks,
        nextOffset: tasks.next,
        objectives: ready ? await this.agenda.objectives(offset) : [],
        automations: ready ? await this.automations.list(offset, identity?.provider) : [],
        jobs: await Promise.all(
          rows.map((row) => this.store.projectJob(ready ? row : { ...row, result: null })),
        ),
        requests: await Promise.all(
          pending.map(async (row) => {
            const data = await this.store.open<PendingPayload>(row.payload);
            return {
              id: row.id,
              kind: row.kind,
              jobId: row.job,
              revision: row.revision,
              created: row.created,
              updated: row.updated,
              message: data.review ?? data.message,
              automation: data.automation,
            };
          }),
        ),
        notifications: ready ? await this.notifications.list(offset) : [],
      },
    };
  }

  private async detail(id: string): Promise<ProactiveResult> {
    const task = this.agenda.taskRow(id);
    const objective = this.agenda.objectiveRow(id);
    const job = this.store.job(id);
    const automation = this.automations.row(id);
    const history = this.store.all<JobRow>(
      'SELECT * FROM proactive_jobs WHERE owner=? ORDER BY created DESC LIMIT 40',
      id,
    );
    return {
      kind: 'detail',
      task: task && (await this.agenda.task(task)),
      objective: objective && (await this.agenda.objective(objective)),
      job: job && (await this.store.projectJob(job)),
      automation:
        automation?.state !== 'deleted' && automation
          ? await this.automations.view(automation, this.host.identity()?.provider)
          : undefined,
      activity:
        job &&
        (job.attempt
          ? this.supervisor.activity(id)
          : job.activity
            ? await this.store.open<ConductorActivity[]>(job.activity)
            : undefined),
      artifacts:
        job &&
        (await Promise.all(
          this.store
            .all<{ payload: Uint8Array }>('SELECT payload FROM proactive_artifacts WHERE job=?', id)
            .map((row) => this.store.open<MediaAsset>(row.payload)),
        )),
      attempts: this.store.attempts(id),
      history: await Promise.all(history.map((row) => this.store.projectJob(row))),
    };
  }

  private async command(command: ProactiveCommand): Promise<ProactiveResult> {
    if (command.action === 'snapshot') return this.snapshot(command);
    if (command.action === 'detail') return this.detail(command.id);
    if (command.action === 'memory_save') {
      const row = this.store.job(command.jobId);
      const attempt =
        row && this.store.attempts(row.id).find((entry) => entry.state === 'completed');
      if (
        !row ||
        row.revision !== command.revision ||
        row.state !== 'completed' ||
        !row.result ||
        row.memory_private ||
        !attempt ||
        !this.host.saveMemory
      )
        throw new ProactiveError('permission', 'Select a verified job result eligible for memory.');
      const result = await this.store.open<string>(row.result);
      await this.host.saveMemory(
        { kind: 'job', jobId: row.id, attemptId: attempt.id },
        result.slice(0, 1400),
        row.updated,
        () => this.store.job(row.id)?.revision === row.revision && !!this.store.job(row.id)?.result,
      );
      return { kind: 'accepted' };
    }
    if (command.action === 'artifact_export') {
      if (
        !this.store.one(
          'SELECT 1 FROM proactive_artifacts WHERE id=? AND job=?',
          command.id,
          command.jobId,
        )
      )
        throw new ProactiveError('permission', 'The artifact does not belong to this job.');
      if (!(await this.host.exportArtifact?.(command.id))) return { kind: 'accepted' };
      return { kind: 'accepted', id: command.id };
    }
    if (command.action === 'automation_preview')
      return { kind: 'preview', times: preview(command.trigger, this.store.now()) };
    const finger = digest(JSON.stringify(command));
    const prior = this.store.one<{ fingerprint: string; result: string | null }>(
      'SELECT fingerprint,result FROM proactive_commands WHERE id=?',
      command.commandId,
    );
    if (prior && prior.fingerprint !== finger)
      throw new ProactiveError('conflict', 'This command identifier was already used.');
    if (prior) return { kind: 'accepted', id: prior.result ?? undefined };

    const mutate = await this.prepareCommand(command);
    const id = this.store.atomic(() => {
      const id = mutate();
      this.store.run(
        'INSERT INTO proactive_commands VALUES (?,?,?,?)',
        command.commandId,
        finger,
        id ?? null,
        this.store.now(),
      );
      return id;
    });
    this.changed();
    this.wake();
    return { kind: 'accepted', id };
  }

  private async prepareCommand(
    command: Exclude<
      ProactiveCommand,
      { action: 'snapshot' | 'detail' | 'automation_preview' | 'artifact_export' | 'memory_save' }
    >,
  ): Promise<() => string | undefined> {
    switch (command.action) {
      case 'settings': {
        const { value, revision } = command;
        if (value.quietHours) validateZone(value.quietHours.zone);
        return () => {
          const previous = this.store.settings();
          const cadenceChanged =
            previous.value.intervalMinutes !== value.intervalMinutes ||
            !previous.value.pulseEnabled ||
            previous.value.pulsePaused;
          const due =
            value.pulseEnabled && !value.pulsePaused
              ? cadenceChanged
                ? this.store.now() + value.intervalMinutes * 60_000
                : previous.due
              : null;
          this.store.updateSettings(revision, value, due);
          if (
            previous.value.dailyMicros < value.dailyMicros ||
            previous.value.dailyInputTokens < value.dailyInputTokens ||
            previous.value.dailyOutputTokens < value.dailyOutputTokens
          )
            this.store.run(
              "UPDATE proactive_jobs SET due=?,revision=revision+1 WHERE reason='Waiting for the next daily budget window.'",
              this.store.now(),
            );
          if (value.emergencyPaused || value.pulsePaused || !value.pulseEnabled)
            for (const job of this.store.activeFor('pulse')) this.hold(job, 'cancelled');
          if (value.emergencyPaused)
            for (const job of [
              ...this.store.activeFor('agenda'),
              ...this.store.activeFor('automation'),
            ])
              this.hold(job, 'paused');
          return undefined;
        };
      }
      case 'pulse':
        return () => {
          const settings = this.store.settings().value;
          if (settings.emergencyPaused || settings.pulsePaused)
            throw new ProactiveError('conflict', 'Resume proactive execution first.');
          this.identity();
          return this.pulse.enqueue(command.commandId);
        };
      case 'task_create':
      case 'task_update': {
        const payload = await this.agenda.prepareTask(command.task);
        return () =>
          this.agenda.saveTask(
            command.task,
            payload,
            'id' in command ? command.id : undefined,
            'revision' in command ? command.revision : undefined,
          );
      }
      case 'task_state':
        return () => this.agenda.completeOrCancel(command.id, command.revision, command.state);
      case 'task_run': {
        const provider = this.identity().provider;
        if (command.scope.connector && !this.host.connectorValid?.(command.scope.connector, provider))
          throw new ProactiveError('permission', 'Review an available GitHub connection and repositories.');
        const payload = await this.store.seal(command.scope);
        return () => {
          const task = this.agenda.taskRow(command.id);
          if (
            this.store.one('SELECT 1 FROM agenda_tasks WHERE id=? AND manual_blocker=1', command.id)
          )
            throw new ProactiveError('conflict', 'Clear the task’s recorded blocker first.');
          if (
            !task ||
            task.revision !== command.revision ||
            !['ready', 'blocked'].includes(task.state) ||
            this.store.activeFor('agenda', command.id).length ||
            this.store.one(
              `SELECT 1 FROM task_dependencies d JOIN agenda_tasks t ON t.id=d.prerequisite
                WHERE d.task=? AND t.state!='completed' LIMIT 1`,
              command.id,
            )
          )
            throw new ProactiveError('conflict', 'The task must be ready before running it.');
          const id = randomUUID();
          if (task.state === 'blocked')
            this.store.run(
              "UPDATE agenda_tasks SET state='ready',revision=revision+1,updated=? WHERE id=?",
              this.store.now(),
              task.id,
            );
          this.store.run(
            'INSERT INTO proactive_grants VALUES (?,?,?,NULL,NULL)',
            id,
            provider,
            payload,
          );
          return this.store.enqueue({
            kind: 'agenda',
            owner: task.id,
            revision: task.revision,
            occurrence: 'task:' + command.commandId,
            due: this.store.now(),
            grant: id,
          });
        };
      }
      case 'objective_create':
      case 'objective_update': {
        const payload = await this.store.seal(command.objective);
        return () =>
          this.agenda.saveObjective(
            payload,
            'id' in command ? command.id : undefined,
            'revision' in command ? command.revision : undefined,
          );
      }
      case 'objective_state':
        return () => this.agenda.finishObjective(command.id, command.revision, command.state);
      case 'automation_create':
      case 'automation_update': {
        const provider = this.identity().provider;
        const grant = command.automation.scope.connector;
        if (grant && !this.host.connectorValid?.(grant, provider))
          throw new ProactiveError('permission', 'Review an available GitHub connection and repositories.');
        const prepared = await this.automations.prepare(command.automation, provider);
        return () =>
          this.automations.save(
            command.automation,
            prepared,
            'id' in command ? command.id : undefined,
            'revision' in command ? command.revision : undefined,
          );
      }
      case 'automation_control':
        return () =>
          this.automations.control(
            command.id,
            command.revision,
            command.control,
            command.commandId,
            this.host.identity()?.provider,
          );
      case 'job_reconcile':
        return () => {
          const job = this.store.job(command.id);
          if (!job || job.revision !== command.revision || job.state !== 'uncertain')
            throw new ProactiveError('conflict', 'The uncertain job changed.');
          if (
            command.status === 'effect_verified' &&
            job.kind === 'agenda' &&
            job.owner &&
            !this.agenda.canCompleteTask(job.owner)
          )
            throw new ProactiveError(
              'conflict',
              'Complete outstanding prerequisites and subtasks first.',
            );
          this.store.transition(
            job,
            command.status === 'effect_verified' ? 'completed' : 'cancelled',
            command.status === 'effect_verified'
              ? 'The user verified the external effect.'
              : 'The user closed the uncertain run.',
          );
          if (command.status === 'effect_verified' && job.kind === 'agenda' && job.owner) {
            this.store.run("UPDATE agenda_tasks SET completion='user' WHERE id=?", job.owner);
            this.agenda.completed(job.owner, JSON.parse(job.ancestry) as string[]);
          }
          return job.id;
        };
      case 'job_control':
        return () => {
          const job = this.store.job(command.id);
          if (!job || job.revision !== command.revision)
            throw new ProactiveError('conflict', 'The job changed.');
          if (command.control === 'cancel' || command.control === 'pause')
            this.hold(job, command.control === 'cancel' ? 'cancelled' : 'paused');
          else {
            if (this.store.hasAmbiguousEffect(job))
              throw new ProactiveError(
                'permission',
                'Reconcile the external effect before retrying.',
              );
            if (
              job.kind === 'automation' &&
              job.owner &&
              this.automations.row(job.owner)?.state !== 'enabled'
            )
              throw new ProactiveError(
                'conflict',
                'Enable the automation before resuming its job.',
              );
            this.store.transition(job, 'queued', undefined, this.store.now());
          }
          return job.id;
        };
      case 'request_resolve':
        return this.resolve(command);
      case 'notification_read':
        return () => {
          this.store.run(
            'UPDATE notification_outbox SET read_at=? WHERE id=?',
            this.store.now(),
            command.id,
          );
          return command.id;
        };
    }
  }

  private hold(job: JobRow, state: 'paused' | 'cancelled') {
    if (job.attempt) {
      if (state === 'paused' && job.state === 'running') this.store.transition(job, 'pausing');
      this.supervisor.stop(job.id, state);
    } else if (
      state === 'cancelled' ||
      ['queued', 'scheduled', 'retry_scheduled'].includes(job.state)
    ) {
      this.store.transition(job, state);
    }
  }

  private async resolve(command: Extract<ProactiveCommand, { action: 'request_resolve' }>) {
    const row = this.store.one<PendingRow>(
      'SELECT * FROM proactive_requests WHERE id=?',
      command.id,
    );
    if (
      !row ||
      row.state !== 'pending' ||
      row.revision !== command.revision ||
      row.expires <= this.store.now()
    )
      throw new ProactiveError('conflict', 'The request changed or expired.');
    const data = await this.store.open<PendingPayload>(row.payload);
    const valid =
      row.kind === 'clarification'
        ? command.decision === 'answer' || command.decision === 'decline'
        : command.decision !== 'answer';
    if (!valid || (command.decision === 'answer' && !command.text))
      throw new ProactiveError('validation', 'Choose a valid decision.');
    if (command.decision !== 'decline' && this.identity().provider !== row.provider)
      throw new ProactiveError(
        'permission',
        'The configured primary changed. Request a new review.',
      );
    const connector = data.automation?.scope.connector;
    if (connector && command.decision === 'approve' && !this.host.connectorValid?.(connector, this.identity().provider))
      throw new ProactiveError('permission', 'Review an available GitHub connection and repositories.');
    const config =
      data.automation && command.decision === 'approve'
        ? await this.automations.prepare(data.automation, this.identity().provider)
        : undefined;
    const answer = command.text ? await this.store.seal(command.text) : undefined;
    const change =
      data.command && command.decision === 'approve'
        ? await this.prepareCommand(data.command)
        : undefined;
    return () => {
      const state =
        command.decision === 'decline'
          ? 'declined'
          : row.kind === 'approval'
            ? 'approved'
            : 'consumed';
      if (
        !this.store.run(
          "UPDATE proactive_requests SET state=?,revision=revision+1,updated=? WHERE id=? AND state='pending' AND revision=?",
          state,
          this.store.now(),
          row.id,
          command.revision,
        ).changes
      )
        throw new ProactiveError('conflict', 'The request changed.');
      if (data.receipt)
        this.store.runtime.finishApproval(
          data.receipt,
          state === 'declined' ? 'declined' : 'approved',
        );
      if (config && data.automation)
        return this.automations.save(
          data.automation,
          config,
          row.target ?? undefined,
          row.target_revision ?? undefined,
        );
      if (data.command) return change?.() ?? row.id;
      if (row.job && row.kind !== 'automation') {
        const job = this.store.job(row.job);
        if (!job || !['waiting_approval', 'waiting_user'].includes(job.state))
          throw new ProactiveError('conflict', 'The waiting job changed.');
        this.store.transition(
          job,
          command.decision === 'decline' ? 'blocked' : 'queued',
          command.decision === 'decline' ? 'The user declined the request.' : undefined,
          this.store.now(),
        );
        if (answer) this.store.run('UPDATE proactive_jobs SET answer=? WHERE id=?', answer, job.id);
      }
      return row.id;
    };
  }

  async dispatch(
    request: RuntimeCall,
    signal: AbortSignal,
    live: Active | undefined,
    trustedUserInstruction?: string,
  ): Promise<RuntimeResult> {
    if (!Object.hasOwn(proactiveOperations, request.operation))
      throw new RuntimeError('PERMISSION_DENIED', 'This operation is outside the proactive scope.');
    const operation = request.operation as ProactiveOperation;
    const input = proactiveOperations[operation].parse(request.input) as Record<string, unknown>;
    const job = live?.claim.job;
    const verify = () => {
      signal.throwIfAborted();
      if (job && !this.supervisor.live(request.requestId, job.id))
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'The background execution lost its lease or permission.',
        );
    };
    verify();
    const write = (work: () => Record<string, unknown>) => {
      const fingerprint = digest(JSON.stringify([operation, input]));
      const owner = job?.id ?? request.requestId;
      const key = 'tool:' + owner + ':' + fingerprint;
      return this.store.atomic(() => {
        verify();
        const recorded = this.store.one<{ result: string }>(
          'SELECT result FROM proactive_commands WHERE id=?',
          key,
        );
        if (recorded) return JSON.parse(recorded.result) as Record<string, unknown>;
        const result = work();
        this.store.run(
          'INSERT INTO proactive_commands VALUES (?,?,?,?)',
          key,
          fingerprint,
          JSON.stringify(result),
          this.store.now(),
        );
        return result;
      });
    };
    const rows = await this.tool(
      operation,
      input,
      job,
      live,
      trustedUserInstruction,
      verify,
      write,
      job ? undefined : request.conversationId,
    );
    verify();
    this.changed();
    this.wake();
    return { data: rows };
  }

  private async tool(
    operation: ProactiveOperation,
    input: Record<string, unknown>,
    job: JobRow | undefined,
    live: Active | undefined,
    userInstruction: string | undefined,
    verify: () => void,
    write: (work: () => Record<string, unknown>) => Record<string, unknown>,
    conversation?: string,
  ): Promise<Record<string, unknown>> {
    const id = input.id as string;
    const revision = input.revision as number;
    if (proactiveReadOperations.has(operation)) {
      switch (operation) {
        case 'agenda.list_tasks': {
          const page = await this.agenda.tasks(Number(input.offset ?? 0), input.state as string);
          return {
            tasks: page.tasks.map(({ description, ...task }) => ({
              ...task,
              description: description.slice(0, 250),
            })),
            next: page.next,
          };
        }
        case 'agenda.get_task': {
          const row = this.agenda.taskRow(id);
          return { task: row ? await this.agenda.task(row) : null };
        }
        case 'agenda.list_objectives':
          return {
            objectives: (await this.agenda.objectives(Number(input.offset ?? 0))).map(
              ({ id, title, state, revision }) => ({ id, title, state, revision }),
            ),
          };
        case 'agenda.get_job': {
          const row = this.store.job(id);
          return {
            job: row
              ? {
                  ...(await this.store.projectJob({ ...row, result: null })),
                  attempts: this.store.attempts(id).slice(0, 8),
                }
              : null,
          };
        }
        case 'automation.list':
          return {
            automations: (
              await this.automations.list(Number(input.offset ?? 0), this.host.identity()?.provider)
            ).map(({ id, title, state, nextDue, revision }) => ({
              id,
              title,
              state,
              nextDue,
              revision,
            })),
          };
        case 'pulse.get_status':
          return { pulse: this.pulse.status() };
        default:
          break;
      }
    }
    if (live?.privateContent && !['automation.report_condition'].includes(operation))
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'This turn can use recalled memory for its result. Persistent changes need a separate reviewed request.',
      );
    if (operation === 'automation.create' || operation === 'automation.update') {
      const config = automationDraftSchema.parse(
        operation === 'automation.create' ? input : input.automation,
      );
      if (userInstruction) config.instruction = userInstruction.slice(0, 4000);
      this.automations.validate(config);
      const payload = await this.store.seal({
        message: 'Review this automation before activating it.',
        automation: config,
      });
      verify();
      return write(() => ({
        proposalId: this.pending(
          'automation',
          payload,
          job?.id,
          operation === 'automation.update' ? id : undefined,
          operation === 'automation.update' ? revision : undefined,
          this.identity().provider,
          conversation,
        ),
      }));
    }
    if (
      operation === 'automation.report_condition' &&
      job?.kind === 'automation' &&
      job.owner &&
      live
    ) {
      const row = this.automations.row(job.owner);
      const trigger = row && (await this.automations.draft(row)).trigger;
      if (trigger?.kind !== 'condition')
        throw new RuntimeError('INVALID_ARGUMENT', 'This automation does not have a condition.');
      if (input.result === 'unknown') return { recorded: false };
      const target = live.observations.get(String(input.evidenceStepId));
      if (target !== trigger.origin)
        throw new RuntimeError(
          'INVALID_REFERENCE',
          'Use the verified observation for the monitored origin.',
        );
      verify();
      this.store.run(
        'UPDATE proactive_jobs SET condition=?,condition_step=? WHERE id=? AND fence=?',
        String(input.result),
        String(input.evidenceStepId),
        job.id,
        live.claim.fence,
      );
      return { recorded: true };
    }
    if (
      operation.startsWith('automation.') &&
      ['automation.pause', 'automation.resume', 'automation.delete', 'automation.run_now'].includes(
        operation,
      ) &&
      !job &&
      userInstruction
    ) {
      const automation = this.automations.row(id);
      if (!automation || automation.revision !== revision)
        throw new RuntimeError('INVALID_REFERENCE', 'The automation changed.');
      const { title } = await this.automations.draft(automation);
      const control = operation.split('.')[1] as 'pause' | 'resume' | 'delete' | 'run_now';
      const command: ProactiveCommand = {
        action: 'automation_control',
        id,
        revision,
        control,
        commandId: randomUUID(),
      };
      const payload = await this.store.seal({
        command,
        message: title + ' — ' + control.replace('_', ' '),
      });
      verify();
      return write(() => ({
        proposalId: this.pending(
          'approval',
          payload,
          undefined,
          id,
          revision,
          this.identity().provider,
          conversation,
        ),
      }));
    }
    if (operation === 'notification.propose' && job) {
      const automation = job.owner && this.automations.row(job.owner);
      if (automation && (await this.automations.draft(automation)).notifications === 'none')
        return { proposed: false };
      const payload = await this.store.seal(input.message);
      verify();
      this.notifications.add(
        'Important finding',
        job,
        job.id + ':finding:' + digest(String(input.message)),
        payload,
      );
      return { proposed: true };
    }
    if (operation === 'pulse.submit_actions' && job?.kind === 'pulse' && live)
      return this.pulseActions(input, live, verify, write);
    if (operation === 'agenda.create_task' && !job && userInstruction) {
      const task = proactiveOperations[operation].parse(input);
      const payload = await this.agenda.prepareTask(task);
      verify();
      return write(() => ({ id: this.agenda.saveTask(task, payload) }));
    }
    if (operation === 'agenda.create_objective' && !job && userInstruction) {
      const objective = proactiveOperations[operation].parse(input);
      const payload = await this.store.seal(objective);
      verify();
      return write(() => ({ id: this.agenda.saveObjective(payload) }));
    }
    if (
      operation === 'agenda.complete_task' &&
      job?.owner === id &&
      job.kind === 'agenda' &&
      live
    ) {
      if (!this.agenda.canCompleteTask(id))
        throw new RuntimeError('INVALID_REFERENCE', 'Prerequisites or subtasks are incomplete.');
      this.store.run(
        'UPDATE agenda_tasks SET progress=90 WHERE id=? AND state=?',
        id,
        'in_progress',
      );
      return { accepted: true, status: 'Awaiting verification in the final Conductor result.' };
    }
    if (
      !job &&
      userInstruction &&
      ['agenda.update_task', 'agenda.complete_task', 'agenda.cancel_task'].includes(operation)
    ) {
      const row = this.agenda.taskRow(id);
      if (!row || row.revision !== revision)
        throw new RuntimeError('INVALID_REFERENCE', 'The task changed.');
      const { title } = await this.agenda.task(row);
      const command: ProactiveCommand =
        operation === 'agenda.update_task'
          ? {
              action: 'task_update',
              id,
              revision,
              commandId: randomUUID(),
              task: proactiveOperations[operation].parse(input).task,
            }
          : {
              action: 'task_state',
              id,
              revision,
              commandId: randomUUID(),
              state: operation === 'agenda.complete_task' ? 'completed' : 'cancelled',
            };
      const payload = await this.store.seal({
        command,
        message: operation.replace('agenda.', '').replace('_', ' ') + ' · ' + title,
      });
      verify();
      return write(() => ({
        proposalId: this.pending(
          'approval',
          payload,
          undefined,
          id,
          revision,
          this.identity().provider,
          conversation,
        ),
      }));
    }
    throw new RuntimeError('PERMISSION_DENIED', 'Review this change in Agenda or Automations.');
  }

  private async pulseActions(
    input: Record<string, unknown>,
    live: Active,
    verify: () => void,
    write: (work: () => Record<string, unknown>) => Record<string, unknown>,
  ) {
    const { actions } = proactiveOperations['pulse.submit_actions'].parse(input);
    if (actions.some((item) => item.action === 'no_action') && actions.length !== 1)
      throw new RuntimeError('INVALID_ARGUMENT', 'No action must stand alone.');
    if (
      actions.filter(
        (item) => item.action === 'request_clarification' || item.action === 'request_approval',
      ).length > 1
    )
      throw new RuntimeError('INVALID_ARGUMENT', 'Ask one question or request one approval.');
    const job = live.claim.job;
    const encoded = await Promise.all(
      actions.map((item) =>
        item.action === 'no_action'
          ? undefined
          : item.action === 'create_task' || item.action === 'update_task'
            ? this.agenda.prepareTask(item.task)
            : this.store.seal(
                item.action === 'schedule_follow_up'
                  ? { message: 'Review this follow-up.', automation: item.automation }
                  : item.action === 'request_clarification'
                    ? { message: item.question }
                    : item.action === 'request_approval'
                      ? { message: item.message }
                      : item.action === 'notify_user'
                        ? item.message
                        : item.action === 'execute_task' || item.action === 'continue_task'
                          ? {
                              message:
                                'Authorize the requested Agenda task to run with local capabilities.',
                              command: {
                                action: 'task_run',
                                commandId: randomUUID(),
                                id: item.id,
                                revision: item.revision,
                                scope: { publicSearch: false, publicOrigins: [], memory: false },
                              },
                            }
                          : item,
              ),
      ),
    );
    verify();
    const result = write(() => {
      actions.forEach((item, index) => {
        const payload = encoded[index];
        switch (item.action) {
          case 'no_action':
            break;
          case 'create_task':
            this.agenda.saveTask(item.task, payload!);
            break;
          case 'update_task':
            this.agenda.saveTask(item.task, payload!, item.id, item.revision);
            break;
          case 'execute_task':
          case 'continue_task': {
            const task = this.agenda.taskRow(item.id);
            if (!task || task.revision !== item.revision)
              throw new RuntimeError('INVALID_REFERENCE', 'The task changed.');
            const prior = this.store
              .activeFor('agenda', task.id)
              .find((row) => row.state === 'interrupted' || row.state === 'paused');
            if (
              item.action === 'continue_task' &&
              prior?.grant_id &&
              !this.store.hasAmbiguousEffect(prior) &&
              this.store.grantValid(prior, this.identity().provider)
            ) {
              this.store.transition(prior, 'queued', undefined, this.store.now());
            } else {
              this.pending(
                'approval',
                payload!,
                undefined,
                task.id,
                task.revision,
                this.identity().provider,
              );
            }
            break;
          }
          case 'schedule_follow_up':
            this.automations.validate(item.automation);
            this.pending(
              'automation',
              payload!,
              job.id,
              undefined,
              undefined,
              this.identity().provider,
            );
            break;
          case 'notify_user':
            this.notifications.add(
              'Important finding',
              job,
              job.id + ':pulse:' + digest(item.message),
              payload,
            );
            break;
          case 'request_clarification':
            this.pending(
              'clarification',
              payload!,
              job.id,
              undefined,
              undefined,
              this.identity().provider,
            );
            break;
          case 'request_approval':
            this.pending(
              'approval',
              payload!,
              job.id,
              undefined,
              undefined,
              this.identity().provider,
            );
            break;
          case 'complete_objective':
            if (
              !this.store.one(
                "SELECT 1 FROM agenda_tasks WHERE objective=? AND state='completed'",
                item.id,
              )
            )
              throw new RuntimeError(
                'PERMISSION_DENIED',
                'Complete verified objective work before closing it.',
              );
            this.agenda.finishObjective(item.id, item.revision, 'completed');
            break;
        }
      });
      return { accepted: actions.length };
    });
    const waiting = actions.find(
      (item) => item.action === 'request_clarification' || item.action === 'request_approval',
    );
    if (waiting)
      this.supervisor.stop(
        job.id,
        waiting.action === 'request_clarification' ? 'waiting_user' : 'waiting_approval',
      );
    return result;
  }

  async observeGithub(request: RuntimeCall, result: ReturnType<typeof githubResult.parse>) {
    const live = this.supervisor.live(request.requestId, request.conversationId);
    const job = live?.claim.job;
    const owner = job?.kind === 'automation' && job.owner ? this.automations.row(job.owner) : undefined;
    if (!result.verified || !live || !job || !owner || owner.revision !== job.owner_revision ||
        request.input.page !== undefined && request.input.page !== 1 || !result.observation) return;
    const { trigger } = await this.automations.draft(owner);
    if (this.supervisor.live(request.requestId, request.conversationId) !== live ||
        trigger.kind !== 'github_watch' || trigger.repository !== result.repositoryId ||
        live.prepared.scope.connector?.connection !== result.connection) return;
    const release = trigger.watch === 'release';
    if (request.operation !== (release ? 'github.list_releases' : 'github.list_workflow_runs') ||
        !release && (request.input.status !== 'failure' || request.input.workflowId !== undefined)) return;
    live.githubWatch = result.observation;
  }

  observations(request: BrowserRequest, result: { url?: string; ok: boolean }) {
    const live = this.supervisor.live(request.requestId, request.conversationId);
    if (
      live &&
      result.ok &&
      result.url &&
      ['web_fetch', 'browser_open', 'browser_navigate', 'browser_get_page'].includes(request.op)
    )
      live.observations.set(request.stepId, new URL(result.url).origin);
  }
}
