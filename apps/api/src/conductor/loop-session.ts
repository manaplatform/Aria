import { randomUUID } from 'node:crypto';
import {
  executionTerminalStates,
  loopCheckpointLifetime,
  loopLimitsSchema,
  type ConductorActivity,
  type ConductorEvent,
  type ExecutionSnapshot,
  type LoopBudget,
  type LoopCheckpoint,
  type LoopCommand,
  type LoopLimits,
  type ManagedExecution,
} from '@aria/shared';
import { ToolError } from './capability-host';

export function executionLimits(current: LoopLimits, previous?: LoopLimits) {
  if (!previous) return current;
  return loopLimitsSchema.parse(
    Object.fromEntries(
      (Object.keys(current) as (keyof LoopLimits)[]).map((key) => [
        key,
        Math.min(current[key], previous[key]),
      ]),
    ),
  );
}

type CheckpointState = Pick<
  LoopCheckpoint,
  'budget' | 'privateContent' | 'memoryContent' | 'spendingLimit'
>;
const checkpointInterval = 5000;

export class LoopSession {
  private readonly deadline = new AbortController();
  private readonly commands = new Set<string>();
  private readonly receipts = new Map<string, LoopCheckpoint['receipts'][number]>();
  private readonly approvals = new Set<string>();
  private readonly steering: string[];
  private readonly pending: string[] = [];
  private timer?: NodeJS.Timeout;
  private wake?: () => void;
  private started?: number;
  private elapsed: number;
  private revision = 0;
  private saving = Promise.resolve();
  private paused = false;
  private state: ExecutionSnapshot['state'];
  private durability: ExecutionSnapshot['durability'];
  private question?: ExecutionSnapshot['question'];
  private waitForQuestionOnRecovery: boolean;
  private waiting = false;
  private toolPhase = false;
  private lastSnapshot = '';
  iteration: number;
  stagnant: number;
  pendingProviderWork = false;
  attempted = false;
  readonly signal: AbortSignal;

  constructor(
    readonly identity: ManagedExecution,
    readonly limits: LoopLimits,
    parent: AbortSignal,
    temporary: boolean,
    private readonly emit: (event: ConductorEvent) => void,
    private readonly write: (checkpoint: LoopCheckpoint, signal: AbortSignal) => Promise<boolean>,
  ) {
    const previous = identity.recovery;
    this.signal = AbortSignal.any([parent, this.deadline.signal]);
    this.elapsed = previous?.elapsedMs ?? 0;
    this.iteration = previous?.iteration ?? 0;
    this.stagnant = previous?.stagnant ?? 0;
    this.steering = [...(previous?.steering ?? [])];
    this.pending.push(...this.steering);
    this.question = previous?.question;
    this.waitForQuestionOnRecovery = Boolean(this.question);
    this.state = previous ? 'recovering' : 'created';
    this.durability = previous ? 'saved' : temporary ? 'live' : 'pending';
    for (const receipt of previous?.receipts ?? []) this.receipts.set(receipt.id, receipt);
    this.attempted = Boolean(previous);
    this.startClock();
    this.publish();
  }

  get activeMs() {
    return (
      this.elapsed + (this.started === undefined ? 0 : Math.floor(performance.now() - this.started))
    );
  }

  get saved() {
    return this.durability === 'saved';
  }

  heartbeat(snapshot: () => CheckpointState) {
    const timer = setInterval(() => {
      if (this.saved && this.started !== undefined && !this.signal.aborted)
        void this.save(snapshot()).catch((error: unknown) => this.deadline.abort(error));
    }, checkpointInterval);
    timer.unref();
    return () => clearInterval(timer);
  }

  private startClock() {
    if (this.started !== undefined) return;
    const remaining = this.limits.activeMs - this.elapsed;
    if (remaining <= 0) {
      this.deadline.abort(
        new DOMException('The execution reached its duration limit.', 'TimeoutError'),
      );
      return;
    }
    this.started = performance.now();
    this.timer = setTimeout(
      () =>
        this.deadline.abort(
          new DOMException('The execution reached its duration limit.', 'TimeoutError'),
        ),
      remaining,
    );
    this.timer.unref();
  }

  private stopClock() {
    this.elapsed = this.activeMs;
    this.started = undefined;
    clearTimeout(this.timer);
  }

  private publish() {
    const execution: ExecutionSnapshot = {
      executionId: this.identity.executionId,
      generation: this.identity.generation,
      state: this.state,
      durability: this.durability,
      iteration: this.iteration,
      ...(this.paused && this.state !== 'paused' && { pausing: true }),
      ...(this.question && { question: this.question }),
    };
    const encoded = JSON.stringify(execution);
    if (encoded === this.lastSnapshot) return;
    this.lastSnapshot = encoded;
    this.emit({ type: 'execution', execution });
  }

  control(command: LoopCommand) {
    if (
      command.executionId !== this.identity.executionId ||
      command.generation !== this.identity.generation ||
      this.signal.aborted ||
      executionTerminalStates.has(this.state)
    )
      return false;
    if (this.commands.has(command.commandId)) return 'duplicate' as const;
    if (this.commands.size >= 128)
      throw new ToolError('BUDGET_EXCEEDED', 'The execution reached its control limit.');
    switch (command.action) {
      case 'pause':
        this.paused = true;
        break;
      case 'resume':
        this.paused = false;
        break;
      case 'answer':
        if (this.question?.id !== command.questionId)
          throw new ToolError(
            'INVALID_REFERENCE',
            'This question is no longer waiting for an answer.',
          );
        this.acceptSteering(command.text);
        this.question = undefined;
        this.paused = false;
        break;
      case 'steer':
        this.acceptSteering(command.text);
        this.question = undefined;
        break;
    }
    this.commands.add(command.commandId);
    this.publish();
    this.wake?.();
    return 'applied' as const;
  }

  private acceptSteering(value: string) {
    if (this.steering.length >= 8 || Buffer.byteLength(this.steering.join('') + value) > 12_000)
      throw new ToolError('BUDGET_EXCEEDED', 'The execution reached its steering limit.');
    this.steering.push(value);
    this.pending.push(value);
  }

  get superseded() {
    return this.pending.length > 0;
  }

  admitDispatch() {
    this.signal.throwIfAborted();
    if (this.paused || this.superseded || this.question)
      throw new ToolError(
        'CANCELLED',
        'This operation did not start because the execution paused or received new instructions.',
      );
  }

  ask(text: string) {
    this.question = { id: randomUUID(), text };
  }

  async boundary(snapshot: () => CheckpointState) {
    const idleUntil = Date.now() + (this.durability === 'live' ? 300_000 : loopCheckpointLifetime);
    while (this.paused || this.question) {
      this.stopClock();
      this.waiting = true;
      this.state = this.paused ? 'paused' : 'waiting_for_user';
      this.publish();
      if (!this.waitForQuestionOnRecovery || !this.question) await this.save(snapshot());
      if (!this.paused && !this.question) break;
      const waiting = AbortSignal.any([
        this.signal,
        AbortSignal.timeout(Math.max(1, idleUntil - Date.now())),
      ]);
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiting.removeEventListener('abort', wake);
          this.wake = undefined;
          resolve();
        };
        this.wake = wake;
        if (waiting.aborted) wake();
        else waiting.addEventListener('abort', wake, { once: true });
      });
      this.signal.throwIfAborted();
      if (waiting.aborted)
        throw new ToolError('TIMEOUT', 'The execution stopped waiting for user input.');
    }
    this.waiting = false;
    this.waitForQuestionOnRecovery = false;
    this.startClock();
    this.signal.throwIfAborted();
    this.state = 'running';
    this.publish();
    if (this.pending.length) {
      this.stagnant = 0;
      await this.save(snapshot());
      return this.pending.splice(0);
    }
    return [];
  }

  round() {
    this.iteration++;
    this.publish();
  }

  tools(active: boolean) {
    this.toolPhase = active;
    this.state = active ? 'waiting_for_tool' : 'running';
    this.publish();
  }

  activity(step: ConductorActivity) {
    if (!this.waiting) {
      if (step.status === 'approval') this.approvals.add(step.stepId);
      else this.approvals.delete(step.stepId);
      this.state = this.approvals.size
        ? 'waiting_for_permission'
        : this.toolPhase
          ? 'waiting_for_tool'
          : 'running';
      this.publish();
    }
    if (!step.effect) return;
    const operation = this.receipts.get(step.stepId)?.operation ?? step.capability;
    const state = step.outcomeUnverified
      ? 'uncertain'
      : step.status === 'running' || step.status === 'processing'
        ? step.effect === 'read'
          ? undefined
          : 'pending'
        : step.status === 'completed' ||
            step.status === 'failed' ||
            step.status === 'uncertain' ||
            step.status === 'blocked'
          ? step.status
          : step.status === 'cancelled' && this.receipts.has(step.stepId)
            ? 'blocked'
            : undefined;
    if (state)
      this.receipts.set(step.stepId, {
        id: step.stepId,
        operation,
        state,
        ...(state === 'completed' &&
          step.evidence?.length && { evidenceIds: step.evidence.map(({ id }) => id) }),
      });
  }

  reserve(id: string, operation: string) {
    this.receipts.set(id, { id, operation, state: 'pending' });
  }

  save(snapshot: CheckpointState, signal = this.signal) {
    if (this.durability === 'live') return Promise.resolve();
    const budget: LoopBudget = snapshot.budget;
    const checkpoint: LoopCheckpoint = {
      executionId: this.identity.executionId,
      generation: this.identity.generation,
      userMessageId: this.identity.userMessageId,
      version: 1,
      revision: ++this.revision,
      state: this.state,
      elapsedMs: Math.min(
        this.limits.activeMs,
        this.activeMs + (this.started === undefined ? 0 : checkpointInterval),
      ),
      iteration: this.iteration,
      stagnant: this.stagnant,
      limits: this.limits,
      budget,
      privateContent: snapshot.privateContent,
      memoryContent: snapshot.memoryContent,
      pendingProviderWork: this.pendingProviderWork,
      spendingLimit: snapshot.spendingLimit,
      steering: [...this.steering],
      question: this.question,
      receipts: [...this.receipts.values()].slice(-48),
    };
    const work = this.saving.then(async () => {
      if (this.durability === 'live') return;
      const written = await this.write(checkpoint, signal);
      if (!written && this.durability === 'saved')
        throw new ToolError(
          'EXECUTION_FAILED',
          'The execution checkpoint could not be saved. Review its activity before resuming.',
        );
      this.durability = written ? 'saved' : 'live';
      this.publish();
    });
    this.saving = work.catch(() => undefined);
    return work;
  }

  finish(state: ExecutionSnapshot['state']) {
    this.stopClock();
    this.state = state;
    this.paused = false;
    this.question = undefined;
    this.publish();
  }

  close() {
    this.stopClock();
  }
}
