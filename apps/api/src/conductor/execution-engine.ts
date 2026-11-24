import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  conductorLimits,
  type ArtifactReference,
  type ChatRequest,
  type ConductorActivity,
  type ConductorEvent,
  type ExecutionStep,
  type LoopBudget,
  type LoopCheckpoint,
  type ToolEffect,
  type ToolProblem,
  type BrowserPhase,
} from '@aria/shared';
import { providerError } from '../ai/ai.service';
import type { ResolvedModel } from '../providers/model-registry.service';
import { ToolError } from './capability-host';
import { RunError, type RunAssets } from './run-assets';
import {
  type StepValue,
  type ToolContext,
  type ToolDescriptor,
  type ToolRegistry,
} from './tool-registry';

export type Outcome = StepValue & {
  id: string;
  status: 'completed' | 'failed' | 'blocked' | 'cancelled';
  problem?: ToolProblem;
  artifact?: ArtifactReference;
  retry?: { eligible: boolean; afterMs?: number; phase?: BrowserPhase | string };
};

export type Invocation = {
  descriptor: ToolDescriptor;
  callId: string;
  input: unknown;
  program?: { id: string; backend: 'managed' | 'openai-responses'; revision: string; signal: AbortSignal };
};
export type BatchInvocation = { id: string; after: string[]; invocation?: Invocation };
type ReadAttempt = {
  id: string;
  count: number;
  retryable: boolean;
  retryAt?: number;
  ordinal: number;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function formatSchemaError(prefix: string, error: z.ZodError) {
  const detail = error.issues
    .slice(0, 2)
    .map((issue) => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`)
    .join('; ')
    .slice(0, 220);
  return detail ? `${prefix} (${detail}).` : `${prefix}.`;
}

const transientResultKeys = new Set([
  'stepId', 'attemptId', 'callId', 'sourceId', 'resultId', 'resultRef', 'observationId', 'retrievedAt',
  'documentId', 'elementId', 'producerStepId', 'tabId', 'timestamp', 'durationMs', 'startedAt', 'finishedAt',
]);

function stableResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !transientResultKeys.has(key))
    .map(([key, item]) => [key, stableResult(item)]));
}

export class ExecutionEngine {
  private readonly results = new Map<string, Outcome>();
  private readonly corrected = new Set<string>();
  private readonly effectFailed = new Set<string>();
  private readonly recoverable = new Map<string, { toolId: string; effect: ToolEffect }>();
  private readonly restricted = new Set<string>();
  private readonly dispatched = new Set<string>();
  private readonly uncertainCapabilities = new Set<string>();
  private readonly counters = { searches: 0, fetches: 0, screenshots: 0, navigations: 0, inspections: 0 };
  private validationFailures = 0;
  directToolCalls = 0;
  programChildCalls = 0;
  billableChildStarted = false;
  partial = false;
  progress = 0;
  private readonly evidence = new Set<string>();
  private readonly readAttempts = new Map<string, ReadAttempt>();
  private readonly unverified = new Map<string, { target: string; ordinal: number }>();
  private readonly observations = new Map<string, { target: string; ordinal: number }>();
  private readonly verificationUpdates = new Map<string, () => void>();
  private ordinal = 0;

  constructor(
    private readonly request: ChatRequest,
    readonly context: ToolContext,
    private readonly assets: RunAssets,
    private readonly tools: ToolRegistry,
    private readonly emit: (event: ConductorEvent) => void,
    private readonly signal: AbortSignal,
    private readonly voiceSessionId?: string,
    prior?: LoopBudget,
    receipts?: readonly LoopCheckpoint['receipts'][number][],
  ) {
    if (!prior) return;
    this.directToolCalls = prior.directToolCalls;
    this.programChildCalls = prior.programChildCalls;
    this.counters.searches = prior.searches;
    this.counters.fetches = prior.fetches;
    this.counters.screenshots = prior.screenshots;
    this.counters.navigations = prior.navigations ?? 0;
    this.counters.inspections = prior.inspections ?? 0;
    this.validationFailures = prior.validationFailures ?? 0;
    for (const receipt of receipts ?? []) {
      if (receipt.state === 'failed' && receipt.fingerprint && receipt.attemptCount)
        this.readAttempts.set(receipt.fingerprint, { id: receipt.id, count: receipt.attemptCount,
          retryable: receipt.retryEligible === true, retryAt: receipt.retryAt, ordinal: 0 });
      else if (receipt.state === 'completed' && receipt.fingerprint)
        this.readAttempts.delete(receipt.fingerprint);
    }
  }

  snapshot() {
    return {
      directToolCalls: this.directToolCalls, programChildCalls: this.programChildCalls,
      validationFailures: this.validationFailures, ...this.counters,
    };
  }

  remainingWeb() {
    return Object.fromEntries(Object.keys(this.counters).map((key) => {
      const resource = key as keyof typeof this.counters;
      return [resource, Math.max(0, this.context.research.policy[resource] - this.counters[resource])];
    }));
  }

  get needsVerification() { return this.unverified.size > 0; }

  verify(steps: string[], resolutions: { stepId: string; evidenceStepId: string }[]) {
    if (steps.some((id) => this.results.get(id)?.status !== 'completed')) return false;
    for (const { stepId, evidenceStepId } of resolutions) {
      const effect = this.unverified.get(stepId);
      const observation = this.observations.get(evidenceStepId);
      if (!effect || !observation || effect.target !== observation.target || effect.ordinal >= observation.ordinal) return false;
    }
    for (const { stepId } of resolutions) {
      this.unverified.delete(stepId);
      this.verificationUpdates.get(stepId)?.();
      this.verificationUpdates.delete(stepId);
    }
    return true;
  }

  get failed() {
    return [...this.results.values()].some(
      (result) => result.status !== 'completed' && !this.corrected.has(result.id),
    );
  }

  get hasUnrecoveredEffectFailure() {
    return [...this.results.values()].some(
      (result) =>
        result.status !== 'completed' &&
        !this.corrected.has(result.id) &&
        this.effectFailed.has(result.id),
    );
  }

  get succeeded() {
    return [...this.results.values()].some((result) => result.status === 'completed');
  }

  reserveProgram() {
    this.context.budget.step();
  }

  async reserveNative(requestNumber: number) {
    const scope = {
      requestId: this.request.requestId,
      conversationId: this.request.conversationId,
      assistantMessageId: this.request.assistantMessageId,
      revision: this.tools.host.current.revision,
      voiceSessionId: this.voiceSessionId,
      fingerprint: createHash('sha256')
        .update(canonical(['provider.native', this.context.registry.primary.ref, requestNumber]))
        .digest('hex'),
    };
    await this.tools.host.request({
      ...scope,
      type: 'reserve',
      operation: { id: 'provider.native', stepId: randomUUID(), callId: String(requestNumber) },
    }, this.signal);
    this.billableChildStarted = true;
    return async (state: 'completed' | 'uncertain') => {
      if (!this.signal.aborted)
        await this.tools.host.request({ ...scope, type: 'receipt', state }, this.signal);
    };
  }

  async execute(
    invocations: Invocation[],
    delegates: () => ReturnType<ToolRegistry['delegates']>,
    discovered: (id: string, ref: string) => boolean,
  ) {
    const outcomes: Outcome[] = [];
    for (let index = 0; index < invocations.length;) {
      const batch = [invocations[index++]];
      // Reads may run together. A read that exposes private content takes effect
      // before any later outbound invocation is authorized.
      if (this.canRunConcurrently(batch[0])) {
        while (
          batch.length < (this.context.execution?.concurrency ?? conductorLimits.parallel) &&
          index < invocations.length &&
          this.canRunConcurrently(invocations[index])
        )
          batch.push(invocations[index++]);
      }
      outcomes.push(
        ...(await Promise.all(batch.map((item) => this.run(item, delegates, discovered)))),
      );
    }
    return outcomes;
  }

  async executeBatch(
    batch: BatchInvocation[],
    delegates: () => ReturnType<ToolRegistry['delegates']>,
    discovered: (id: string, ref: string) => boolean,
  ) {
    const ids = new Set(batch.map(({ id }) => id));
    if (ids.size !== batch.length || batch.some(({ after }) =>
      new Set(after).size !== after.length || after.some((id) => !ids.has(id))))
      throw new ToolError('INVALID_ARGUMENT', 'Use unique batch IDs and dependencies from the same batch.');
    const waves: BatchInvocation[][] = [];
    const remaining = new Set(batch);
    const ordered = new Set<string>();
    while (remaining.size) {
      const ready = [...remaining].filter(({ after }) => after.every((id) => ordered.has(id)));
      if (!ready.length) throw new ToolError('INVALID_ARGUMENT', 'The batch has a dependency cycle.');
      waves.push(ready);
      for (const item of ready) {
        remaining.delete(item);
        ordered.add(item.id);
      }
    }
    const outcomes = new Map<string, Outcome>();
    const reject = (item: BatchInvocation, code: ToolProblem['code'], message: string) => {
      const result: Outcome = { id: randomUUID(), status: 'blocked', problem: { code, message } };
      outcomes.set(item.id, result);
      this.results.set(result.id, result);
    };
    for (const wave of waves) {
      const pending = [];
      for (const item of wave) {
        if (item.after.some((id) => outcomes.get(id)?.status !== 'completed')) {
          reject(item, 'INVALID_REFERENCE', 'A prerequisite did not complete.');
        } else if (!item.invocation) {
          reject(item, 'CAPABILITY_UNAVAILABLE', 'Load an eligible direct tool before using it in a batch.');
        } else {
          pending.push({ id: item.id, invocation: item.invocation });
        }
      }
      const results = await this.execute(pending.map(({ invocation }) => invocation), delegates, discovered);
      pending.forEach(({ id }, index) => outcomes.set(id, results[index]));
    }
    return batch.map(({ id }) => ({ id, outcome: outcomes.get(id)! }));
  }

  private canRunConcurrently({ descriptor }: Invocation) {
    return (
      (descriptor.parallelDelegate === true && !this.context.privateContent) ||
      (descriptor.effect === 'read' && descriptor.parallelRead === true)
    );
  }

  private async run(
    invocation: Invocation,
    delegates: () => ReturnType<ToolRegistry['delegates']>,
    discovered: (id: string, ref: string) => boolean,
  ): Promise<Outcome> {
    const { descriptor, callId, program } = invocation;
    const parent = program ? AbortSignal.any([this.signal, program.signal]) : this.signal;
    const id = randomUUID();
    const start = Date.now();
    let model: ResolvedModel | undefined;
    let phase: BrowserPhase | string | undefined;
    let operationTarget: string | undefined;
    let sourceId: string | undefined;
    let fingerprint: string | undefined;
    let dependencyState: LoopCheckpoint['receipts'][number]['dependencyState'];
    let networkStarted = false;
    const activity = (status: ConductorActivity['status'], outcome?: Outcome, verified = false) =>
      this.emit({
        type: 'activity',
        activity: {
          stepId: id,
          callId,
          parentStepId: program?.id,
          programStatus: outcome?.programStatus,
          programResultSaved: outcome?.programResultSaved,
          capability: descriptor.capability,
          effect: descriptor.effect,
          target: model ? `${model.connection.name} / ${model.id}`.slice(0, 310) : descriptor.id,
          summary: descriptor.name,
          inputSummary: descriptor.permission,
          status,
          at: Date.now(),
          durationMs: outcome ? Date.now() - start : undefined,
          operationTarget,
          phase,
          failureCategory: outcome?.problem?.category ?? outcome?.problem?.code,
          retryEligible: outcome?.retry?.eligible,
          error: outcome?.problem?.message,
          ...(outcome && this.unverified.has(id) && { outcomeUnverified: true }),
          resultSummary:
            outcome?.status === 'completed'
              ? verified ? 'Outcome verified by a subsequent observation'
                : outcome.artifact
                ? 'Artifact created'
                : this.unverified.has(id)
                  ? 'Action sent. Outcome awaits verification.'
                : outcome.sources?.length
                  ? `${outcome.sources.length} verified source references`
                  : 'Result received'
              : undefined,
          resultId: outcome?.artifact?.id,
          sources: outcome?.sources,
          evidence: outcome?.evidence,
          executionDetails: outcome?.executionDetails,
          privateContent: outcome?.privateContent,
        },
      });
    let result: Outcome;
    let reserved = false;
    let launched = false;
    let lease: Awaited<ReturnType<ToolRegistry['scheduler']['acquire']>> | undefined;
    let operation: Promise<StepValue> | undefined;
    let readKey: string | undefined;
    let previousAttempt: ReadAttempt | undefined;
    let retryDelay: number | undefined;
    let budgetKey: ToolDescriptor['budget'] | undefined;
    let admittedFingerprint: string | undefined;
    let settleArtifact: ReturnType<ToolContext['budget']['artifact']> | undefined;
    let reservation: { fingerprint: string; revision: string } | undefined;
    const scope = {
      requestId: this.request.requestId,
      conversationId: this.request.conversationId,
      assistantMessageId: this.request.assistantMessageId,
      voiceSessionId: this.voiceSessionId,
    };
    try {
      parent.throwIfAborted();
      this.context.execution?.admit();
      if (!program) this.reserveProgram();
      if (!program && !descriptor.modes.includes('direct'))
        throw new ToolError('CALLER_MISMATCH', 'This tool is only available inside an authorized program.');
      if (!this.tools.allowed(descriptor, this.context)) {
        if (descriptor.dependency === 'browser' && this.context.privateContent)
          throw new ToolError(
            'PERMISSION_DENIED',
            'Web tools cannot receive private skill or attachment contents.',
          );
        throw new ToolError(
          'CAPABILITY_UNAVAILABLE',
          'The selected tool is unavailable for this turn.',
        );
      }
      if (this.uncertainCapabilities.has(descriptor.capability) || this.context.execution?.blocked.has(descriptor.id))
        throw new ToolError(
          'OUTCOME_UNCERTAIN',
          'That capability already failed after dispatch. Reconcile the earlier operation before trying again.',
        );
      if (Buffer.byteLength(JSON.stringify(invocation.input ?? null)) > 48_000)
        throw new ToolError('INVALID_ARGUMENT', 'The tool input exceeds its size limit.');
      const preparedInput = descriptor.prepareInput
        ? descriptor.prepareInput(invocation.input)
        : invocation.input;
      const input = descriptor.input.safeParse(preparedInput);
      if (!input.success)
        throw new ToolError(
          'INVALID_ARGUMENT',
          formatSchemaError('The arguments do not match the loaded tool schema', input.error),
          'SCHEMA_VALIDATION',
        );
      if (program && (program.revision !== this.tools.host.current.revision ||
        !this.tools.allowedForProgram(descriptor, this.context, program.backend, input.data)))
        throw new ToolError('PERMISSION_DENIED', 'The program cannot invoke this tool with these arguments.');
      const step: ExecutionStep = {
        id,
        target: { kind: 'tool', tool: descriptor.id, model: null },
        capability: descriptor.capability,
        output: descriptor.output,
        instructions: descriptor.name,
        summary: descriptor.name,
        inputs: [],
        dependsOn: [],
        ...descriptor.normalize?.(input.data),
      };
      if (
        new Set(step.dependsOn).size !== step.dependsOn.length ||
        step.dependsOn.some((dependency) => this.results.get(dependency)?.status !== 'completed')
      ) {
        dependencyState = 'invalid';
        throw new ToolError(
          'INVALID_ARGUMENT',
          'Reference only successful execution IDs from this turn.',
          'INVALID_DEPENDENCY',
        );
      }
      dependencyState = step.dependsOn.length ? 'ready' : 'none';
      const originalArgs = step.args;
      if (typeof originalArgs?.sourceId === 'string') sourceId = originalArgs.sourceId;
      const dispatchInput = descriptor.preflight?.(step, this.context);
      if (typeof dispatchInput?.url === 'string') operationTarget = new URL(dispatchInput.url).hostname.slice(0, 253);
      if (step.target.kind === 'model') {
        const available = await delegates();
        model = available.models.get(step.target.model);
        if (
          !discovered(descriptor.id, step.target.model) ||
          !model?.delegate ||
          !descriptor.requiredModelCapabilities.every((capability) =>
            model!.capabilities.some((value) => value === capability),
          )
        ) {
          throw new ToolError(
            'CAPABILITY_UNAVAILABLE',
            'The selected model is unavailable for this capability. No operation started.',
          );
        }
      }
      let restricted = step.dependsOn.some((dependency) => this.restricted.has(dependency));
      const text: string[] = [];
      const files: NonNullable<StepValue['file']>[] = [];
      for (const input of step.inputs) {
        if (input.kind === 'text') text.push(input.text);
        else if (input.kind === 'attachment') {
          const file = this.context.attachments.get(input.id);
          if (!file)
            throw new ToolError(
              'PERMISSION_DENIED',
              'A step refers to an attachment outside this turn.',
            );
          files.push(file);
          restricted = true;
        } else {
          if (!step.dependsOn.includes(input.stepId))
            throw new ToolError(
              'INVALID_ARGUMENT',
              'Add referenced results to the step dependencies.',
            );
          const value = this.results.get(input.stepId)!;
          if (value.text) text.push(value.text);
          if (value.file) files.push(value.file);
        }
      }
      if (
        model &&
        (restricted || this.context.privateContent) &&
        model.connection.id !== this.context.registry.primary.connection.id &&
        !this.context.registry.config.crossConnectionAttachments
      )
        throw new ToolError(
          'PERMISSION_DENIED',
          'Settings restrict attachment transfer to this connection.',
        );
      if (descriptor.dependency === 'browser' && restricted)
        throw new ToolError('PERMISSION_DENIED', 'Web tools cannot receive attachment contents.');
      if (text.reduce((size, part) => size + part.length, 0) > 32_000)
        throw new ToolError('INVALID_ARGUMENT', 'The supplied text exceeds the step input limit.');
      fingerprint = createHash('sha256')
        .update(
          canonical([descriptor.id, step.target, dispatchInput ?? step.args ?? (descriptor.normalize ? step.instructions : input.data), step.inputs]),
        )
        .digest('hex');
      const researchRetry = Boolean(descriptor.preflight && descriptor.effect !== 'consequential' &&
        (descriptor.effect === 'read' || descriptor.budget === 'navigations'));
      const verifiedReadRetry =
        researchRetry || (descriptor.effect === 'read' &&
        descriptor.program?.retry === 'verified-read' &&
        Boolean(this.context.execution));
      const retryOf = descriptor.preflight && typeof input.data === 'object' && input.data
        ? Reflect.get(input.data, 'retryOf') : undefined;
      if (verifiedReadRetry) {
        previousAttempt = this.readAttempts.get(fingerprint);
        const observation = typeof dispatchInput?.tabId === 'string' &&
          [...this.observations.values()].some(({ target, ordinal }) =>
            target === dispatchInput.tabId && ordinal > (previousAttempt?.ordinal ?? -1));
        const windowElapsed = previousAttempt?.retryAt !== undefined && Date.now() >= previousAttempt.retryAt;
        if (retryOf && retryOf !== previousAttempt?.id)
          throw new ToolError('INVALID_REFERENCE', 'retryOf must reference the latest attempt of this same operation.', 'RETRY_REFERENCE_INVALID');
        if (
          previousAttempt &&
          (!previousAttempt.retryable || previousAttempt.count > (this.context.execution?.readRetries ?? 2) ||
            (researchRetry && (!retryOf || (!observation && !windowElapsed))))
        )
          if (!(researchRetry && descriptor.repeatable && this.results.get(previousAttempt.id)?.status === 'completed' && !retryOf))
            throw new ToolError('DUPLICATE_DISPATCH', 'This operation already ran. For a retry, use the returned attempt ID after a fresh observation or the reported retry window.', 'UNCHANGED_ATTEMPT');
      } else if (!descriptor.repeatable && this.dispatched.has(fingerprint))
        throw new ToolError('DUPLICATE_DISPATCH', 'This operation already ran.');
      else if (retryOf)
        throw new ToolError('INVALID_ARGUMENT', 'This operation does not support retryOf.', 'RETRY_UNSUPPORTED');
      if (descriptor.budget) {
        const limit = this.context.research.policy[descriptor.budget];
        if (this.counters[descriptor.budget] >= limit)
          throw new ToolError(
            'BUDGET_EXCEEDED',
            `The turn reached its ${descriptor.budget} limit (${limit}).`,
          );
        this.counters[descriptor.budget]++;
        budgetKey = descriptor.budget;
      }
      if (verifiedReadRetry) {
        this.readAttempts.set(fingerprint, {
          id,
          count: (previousAttempt?.count ?? 0) + 1,
          retryable: false,
          ordinal: this.ordinal,
        });
        readKey = fingerprint;
      }
      this.dispatched.add(fingerprint);
      admittedFingerprint = fingerprint;
      activity('queued');
      const timeout = AbortSignal.timeout(Math.min(descriptor.timeoutMs, this.context.execution?.toolMs ?? Infinity));
      const signal = AbortSignal.any([parent, timeout]);
      if (descriptor.id !== 'programs.run') {
        const resource = step.args?.sessionId ?? step.args?.tabId ??
          (step.args?.args as Record<string, unknown> | undefined)?.tabId;
        const locks = typeof resource === 'string'
          ? [`resource/${resource}`]
          : descriptor.effect === 'local' || (program && !descriptor.program?.parallel)
            ? [`${this.request.conversationId}/state`]
            : [];
        lease = await this.tools.scheduler.acquire({
          turn: this.request.requestId,
          provider: model?.connection.id,
          tool: descriptor.id,
          toolLimit: descriptor.program?.parallel ? 3 : 4,
          limit: Math.min(this.context.execution?.concurrency ?? conductorLimits.parallel,
            program ? this.tools.host.current.programming?.parallel ?? conductorLimits.parallel : Infinity),
          locks,
          signal,
        });
      }
      const authorize = () => {
        signal.throwIfAborted();
        this.context.execution?.admit();
        if (!this.tools.allowed(descriptor, this.context) ||
          (program && (program.revision !== this.tools.host.current.revision ||
            !this.tools.allowedForProgram(descriptor, this.context, program.backend, input.data))) ||
          (model && this.context.privateContent &&
            model.connection.id !== this.context.registry.primary.connection.id &&
            !this.context.registry.config.crossConnectionAttachments))
          throw new ToolError('PERMISSION_DENIED', 'The operation was revoked before dispatch.');
      };
      authorize();
      if (this.context.execution && descriptor.effect !== 'read') {
        await this.context.execution.beforeEffect(id, descriptor.id);
        authorize();
      }
      if (descriptor.artifacts) settleArtifact = this.context.budget.artifact();
      if (descriptor.effect === 'billable' || this.context.execution && descriptor.effect === 'consequential' && !descriptor.repeatable) {
        const revision = this.tools.host.current.revision;
        await this.tools.host.request(
          {
            ...scope,
            type: 'reserve',
            revision,
            fingerprint,
            operation: { id: descriptor.id, stepId: id, callId },
          },
          signal,
        );
        reservation = { fingerprint, revision };
        reserved = true;
        this.billableChildStarted ||= descriptor.effect === 'billable';
      }
      authorize();
      activity('running');
      launched = true;
      if (program) this.programChildCalls++;
      else if (descriptor.id !== 'programs.run') this.directToolCalls++;
      if (descriptor.effect === 'consequential') this.billableChildStarted = true;
      let raw;
      try {
        operation = Promise.resolve(descriptor.execute(input.data, {
            step,
            callId,
            model,
            inputs: { text, files },
            context: this.context,
            signal,
            approval: () => activity('approval'),
            browserProgress: (progress) => {
              if (signal.aborted) return;
              if (progress === 'approval') activity('approval');
              else if (progress === 'network') networkStarted = true;
              else {
                phase = progress;
                activity('running');
              }
            },
            programId: program?.id,
          }));
        raw = await waitForTool(operation, signal);
      } catch (error) {
        if (timeout.aborted)
          throw new ToolError(
            reserved || descriptor.effect === 'consequential' ? 'OUTCOME_UNCERTAIN' : 'TIMEOUT',
            reserved
              ? 'The provider timed out after dispatch. The outcome is uncertain.'
              : 'The tool timed out.',
          );
        throw error;
      }
      activity('processing');
      const value = descriptor.outputSchema.safeParse(raw);
      if (!value.success)
        throw new ToolError('INVALID_TOOL_OUTPUT', 'The tool returned an unexpected result.');
      if (
        (['image', 'file', 'audio'].includes(descriptor.output) &&
          !value.data.file &&
          !value.data.managedArtifact) ||
        (descriptor.output === 'sources' && !value.data.sources?.length) ||
        (descriptor.output === 'text' && typeof value.data.text !== 'string')
      )
        throw new ToolError('EXECUTION_FAILED', 'The tool returned no usable result.');
      const { managedArtifact, privateContent, commandProblem, ...resultValue } = value.data;
      if (value.data.programStatus === 'partial') this.partial = true;
      const hosted =
        descriptor.id === 'artifacts.publish' &&
        this.context.native?.active.shell?.kind === 'hosted'
          ? this.context.native.active.shell
          : undefined;
      const fileArtifact =
        value.data.file && this.assets.put(this.request.requestId, value.data.file);
      const artifact =
        managedArtifact ??
        (fileArtifact && {
          ...fileArtifact,
          executionId: id,
          ...(hosted && { hostedExecution: { stepId: id, sessionId: hosted.id } }),
        });
      if (settleArtifact) {
        const settle = settleArtifact;
        settleArtifact = undefined;
        settle(artifact);
      } else if (artifact) this.context.budget.artifact()(artifact);
      if (artifact) this.emit({ type: 'artifact', artifact });
      if (restricted || privateContent || descriptor.capability === 'browser_screenshot') {
        this.restricted.add(id);
        if (value.data.text || privateContent) this.context.privateContent = true;
      }
      result = {
        id,
        ...resultValue,
        privateContent: privateContent || restricted,
        text: value.data.text?.slice(0, conductorLimits.resultCharacters),
        status: commandProblem || ['failed', 'uncertain'].includes(value.data.programStatus ?? '')
          ? 'failed' : value.data.programStatus === 'cancelled' ? 'cancelled' : 'completed',
        problem: commandProblem ?? (value.data.programStatus === 'uncertain'
          ? { code: 'OUTCOME_UNCERTAIN', message: 'Some program operations have uncertain outcomes.' }
          : undefined),
        artifact,
      };
      const evidence = createHash('sha256')
        .update(
          canonical(
            result.evidence?.length
              ? [
                  descriptor.id,
                  result.evidence.map(({ chunkId, version }) => [chunkId, version]).sort(),
                ]
              : [
                  descriptor.id, result.text, stableResult(result.data),
                  result.sources?.map(({ url, title }) => [url, title]),
                  fileArtifact?.sha256,
                  value.data.computerImage && createHash('sha256').update(value.data.computerImage.bytes).digest('hex'),
                  managedArtifact?.id,
                ],
          ),
        )
        .digest('hex');
      if (result.status === 'completed' && !this.evidence.has(evidence)) {
        this.evidence.add(evidence);
        this.progress++;
      }
      const target = result.data?.tabId ?? result.data?.sessionId ?? step.args?.sessionId;
      if (typeof result.data?.phase === 'string') phase = result.data.phase.slice(0, 40);
      if (!operationTarget && typeof result.data?.url === 'string') {
        try { operationTarget = new URL(result.data.url).hostname.slice(0, 253); } catch { /* No public target. */ }
      }
      if (typeof target === 'string' && result.status === 'completed') {
        const status = result.data?.status;
        const computerOutcomes = z.array(z.object({ status: z.string() })).safeParse(result.data?.outcomes);
        if (status === 'dispatched_outcome_unverified' || status === 'action_dispatched' ||
            computerOutcomes.data?.some(({ status }) => status === 'submitted')) {
          this.unverified.set(id, { target, ordinal: ++this.ordinal });
          this.verificationUpdates.set(id, () => activity('completed', result, true));
        } else if (['browser.browser_get_page', 'browser.browser_extract', 'browser.browser_wait', 'computer.observe'].includes(descriptor.id)) {
          this.observations.set(id, { target, ordinal: ++this.ordinal });
        }
      }
      if (
        commandProblem?.code === 'EXECUTION_FAILED' &&
        (descriptor.effect === 'read' || !this.context.execution)
      )
        this.recoverable.set(id, { toolId: descriptor.id, effect: descriptor.effect });
      for (const [failedId, entry] of this.recoverable) {
        if (
          !commandProblem &&
          (entry.toolId === descriptor.id ||
            (entry.effect === 'read' &&
              (descriptor.effect === 'read' || descriptor.budget === 'navigations')))
        ) {
          this.corrected.add(failedId);
          this.recoverable.delete(failedId);
        }
      }
    } catch (error) {
      const stopped = parent.aborted;
      const code = stopped
        ? launched && (reserved || descriptor.effect === 'consequential' ||
          descriptor.program?.retry === 'never') ? 'OUTCOME_UNCERTAIN' : 'CANCELLED'
        : error instanceof ToolError
          ? error.code
          : launched && (reserved || descriptor.effect === 'consequential') && !(error instanceof RunError)
            ? 'OUTCOME_UNCERTAIN'
            : 'EXECUTION_FAILED';
      const message = stopped
        ? code === 'OUTCOME_UNCERTAIN' ? 'The operation stopped after dispatch and needs reconciliation.' : 'The operation stopped.'
        : error instanceof RunError
          ? error.message
          : providerError(error);
      if (error instanceof ToolError) {
        phase = error.phase ?? phase;
        retryDelay = error.retryAfterMs;
        if (error.category === 'MISSING_DEPENDENCY') dependencyState = 'invalid';
      }
      if (!launched && ['INVALID_ARGUMENT', 'INVALID_REFERENCE'].includes(code)) this.validationFailures++;
      const recoverableRead = descriptor.effect === 'read' ||
        (descriptor.preflight && descriptor.budget === 'navigations' && code !== 'OUTCOME_UNCERTAIN');
      if (!recoverableRead && code !== 'CANCELLED') this.effectFailed.add(id);
      if (
        (!launched && (code === 'INVALID_ARGUMENT' || code === 'INVALID_REFERENCE' || code === 'CAPABILITY_UNAVAILABLE')) ||
        (recoverableRead && !['CANCELLED', 'OUTCOME_UNCERTAIN'].includes(code))
      )
        this.recoverable.set(id, { toolId: descriptor.id, effect: recoverableRead ? 'read' : descriptor.effect });
      if (!launched && code === 'CANCELLED' && this.context.execution) this.corrected.add(id);
      result = {
        id,
        status: code === 'CANCELLED' ? 'cancelled' : code === 'DUPLICATE_DISPATCH' ? 'blocked' : 'failed',
        problem: { code, message: message.slice(0, 400),
          category: error instanceof ToolError ? error.category : undefined },
      };
    } finally {
      settleArtifact?.();
      const held = lease;
      if (held) {
        if (operation) {
          const timer = setTimeout(held.fence, 2000);
          timer.unref();
          const settle = () => {
            clearTimeout(timer);
            held.release();
          };
          void operation.then(settle, settle);
        } else held.release();
      }
    }
    if (reservation && !parent.aborted) {
      await this.tools.host.request({
        ...scope, ...reservation, type: 'receipt',
        state: !launched && this.context.execution ? 'not_started' : result.problem?.code === 'OUTCOME_UNCERTAIN' ? 'uncertain' :
          result.status === 'completed' ? 'completed' : 'failed',
      }, AbortSignal.any([parent, AbortSignal.timeout(2000)])).catch(() => undefined);
    }
    const networkBudget = budgetKey === 'searches' || budgetKey === 'fetches' || budgetKey === 'navigations';
    if (budgetKey && (!launched ||
      (networkBudget && !networkStarted && result.status !== 'completed' && result.problem?.category !== 'IPC_TIMEOUT')))
      this.counters[budgetKey] = Math.max(0, this.counters[budgetKey] - 1);
    if (!launched && result.problem?.code === 'CANCELLED') {
      if (admittedFingerprint) this.dispatched.delete(admittedFingerprint);
      if (readKey) {
        if (previousAttempt) this.readAttempts.set(readKey, previousAttempt);
        else this.readAttempts.delete(readKey);
        readKey = undefined;
      }
    }
    if (result.problem?.code === 'OUTCOME_UNCERTAIN')
      this.uncertainCapabilities.add(descriptor.capability);
    if (readKey) {
      const attempt = this.readAttempts.get(readKey)!;
      const research = Boolean(descriptor.preflight);
      attempt.retryable = Boolean(launched && (research
        ? retryDelay !== undefined || result.problem?.category === 'STALE_PAGE'
        : result.problem?.code === 'TIMEOUT' || result.problem?.code === 'EXECUTION_FAILED'));
      if (attempt.retryable && retryDelay !== undefined) attempt.retryAt = Date.now() + retryDelay;
      if (research && result.problem) result.retry = {
        eligible: attempt.retryable && attempt.count <= (this.context.execution?.readRetries ?? 2),
        afterMs: retryDelay,
        phase,
      };
    }
    this.results.set(id, result);
    activity(result.problem?.code === 'OUTCOME_UNCERTAIN' ? 'uncertain' : result.status, result);
    if (descriptor.preflight) this.context.execution?.observeAttempt?.({
      id, operation: descriptor.id,
      state: result.problem?.code === 'OUTCOME_UNCERTAIN' ? 'uncertain' :
        result.status === 'cancelled' ? 'blocked' : result.status,
      durationMs: Date.now() - start,
      fingerprint, sourceId, dependencyState, phase,
      failureCategory: result.problem?.category ?? result.problem?.code,
      retryEligible: result.retry?.eligible,
      ...(readKey && {
        attemptCount: this.readAttempts.get(readKey)?.count,
        retryAt: this.readAttempts.get(readKey)?.retryAt,
      }),
    });
    return result;
  }
}

async function waitForTool<T>(operation: T | Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener('abort', cancel, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
