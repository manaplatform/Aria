import { createHash, randomUUID } from 'node:crypto';
import {
  conductorLimits,
  type ArtifactReference,
  type ChatRequest,
  type ConductorActivity,
  type ConductorEvent,
  type ExecutionStep,
  type ToolProblem,
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
};

export type Invocation = {
  descriptor: ToolDescriptor;
  callId: string;
  input: unknown;
  program?: { id: string; backend: 'managed' | 'openai-responses'; revision: string; signal: AbortSignal };
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

const transientResultKeys = new Set([
  'stepId', 'callId', 'sourceId', 'resultId', 'resultRef', 'observationId', 'retrievedAt',
  'documentId', 'elementId', 'timestamp', 'durationMs', 'startedAt', 'finishedAt',
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
  private readonly recoverable = new Map<string, string>();
  private readonly restricted = new Set<string>();
  private readonly dispatched = new Set<string>();
  private readonly uncertainCapabilities = new Set<string>();
  private readonly counters = { searches: 0, fetches: 0, screenshots: 0 };
  directToolCalls = 0;
  programChildCalls = 0;
  billableChildStarted = false;
  partial = false;
  progress = 0;
  private readonly evidence = new Set<string>();

  constructor(
    private readonly request: ChatRequest,
    readonly context: ToolContext,
    private readonly assets: RunAssets,
    private readonly tools: ToolRegistry,
    private readonly emit: (event: ConductorEvent) => void,
    private readonly signal: AbortSignal,
    private readonly voiceSessionId?: string,
  ) {}

  get failed() {
    return [...this.results.values()].some(
      (result) => result.status !== 'completed' && !this.corrected.has(result.id),
    );
  }

  get succeeded() {
    return [...this.results.values()].some((result) => result.status === 'completed');
  }

  reserveProgram() {
    this.context.budget.step();
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
          batch.length < conductorLimits.parallel &&
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

  private canRunConcurrently({ descriptor }: Invocation) {
    return (
      descriptor.effect === 'billable' ||
      (descriptor.effect === 'read' && descriptor.dependency === 'browser')
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
    const activity = (status: ConductorActivity['status'], outcome?: Outcome) =>
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
          error: outcome?.problem?.message,
          resultSummary:
            outcome?.status === 'completed'
              ? outcome.artifact
                ? 'Artifact created'
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
    let reservation: { fingerprint: string; revision: string } | undefined;
    const scope = {
      requestId: this.request.requestId,
      conversationId: this.request.conversationId,
      assistantMessageId: this.request.assistantMessageId,
      voiceSessionId: this.voiceSessionId,
    };
    try {
      parent.throwIfAborted();
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
      if (this.uncertainCapabilities.has(descriptor.capability))
        throw new ToolError(
          'OUTCOME_UNCERTAIN',
          'That capability already failed after dispatch. Reconcile the earlier operation before trying again.',
        );
      if (Buffer.byteLength(JSON.stringify(invocation.input ?? null)) > 48_000)
        throw new ToolError('INVALID_ARGUMENT', 'The tool input exceeds its size limit.');
      const input = descriptor.input.safeParse(invocation.input);
      if (!input.success)
        throw new ToolError(
          'INVALID_ARGUMENT',
          'The arguments do not match the loaded tool schema.',
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
      )
        throw new ToolError(
          'INVALID_ARGUMENT',
          'Reference only successful execution IDs from this turn.',
        );
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
      const fingerprint = createHash('sha256')
        .update(
          canonical([descriptor.id, step.target, step.args ?? (descriptor.normalize ? step.instructions : input.data), step.inputs]),
        )
        .digest('hex');
      if (!descriptor.repeatable && this.dispatched.has(fingerprint))
        throw new ToolError('DUPLICATE_DISPATCH', 'This operation already ran.');
      if (
        descriptor.budget &&
        ++this.counters[descriptor.budget] > this.context.research.policy[descriptor.budget]
      )
        throw new ToolError('BUDGET_EXCEEDED', `The turn reached its ${descriptor.budget} limit.`);
      this.dispatched.add(fingerprint);
      activity('queued');
      const timeout = AbortSignal.timeout(descriptor.timeoutMs);
      const signal = AbortSignal.any([parent, timeout]);
      if (descriptor.id !== 'programs.run') {
        const resource = step.args?.sessionId ?? step.args?.tabId ??
          (step.args?.args as Record<string, unknown> | undefined)?.tabId;
        const locks = typeof resource === 'string'
          ? [`${this.request.conversationId}/${resource}`]
          : descriptor.effect === 'local' || (program && !descriptor.program?.parallel)
            ? [`${this.request.conversationId}/state`]
            : [];
        lease = await this.tools.scheduler.acquire({
          turn: this.request.requestId,
          provider: model?.connection.id,
          tool: descriptor.id,
          toolLimit: descriptor.program?.parallel ? 3 : 4,
          limit: this.tools.host.current.programming?.backend !== 'off'
            ? this.tools.host.current.programming?.parallel ?? conductorLimits.parallel
            : conductorLimits.parallel,
          locks,
          signal,
        });
      }
      const authorize = () => {
        signal.throwIfAborted();
        if (!this.tools.allowed(descriptor, this.context) ||
          (program && (program.revision !== this.tools.host.current.revision ||
            !this.tools.allowedForProgram(descriptor, this.context, program.backend, input.data))) ||
          (model && this.context.privateContent &&
            model.connection.id !== this.context.registry.primary.connection.id &&
            !this.context.registry.config.crossConnectionAttachments))
          throw new ToolError('PERMISSION_DENIED', 'The operation was revoked before dispatch.');
      };
      authorize();
      if (descriptor.effect === 'billable') {
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
        this.billableChildStarted = reserved = true;
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
      if (commandProblem?.code === 'EXECUTION_FAILED') this.recoverable.set(id, descriptor.id);
      for (const [failedId, toolId] of this.recoverable) {
        if (!commandProblem && toolId === descriptor.id) {
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
          : reserved && !(error instanceof RunError)
            ? 'OUTCOME_UNCERTAIN'
            : 'EXECUTION_FAILED';
      const message = stopped
        ? code === 'OUTCOME_UNCERTAIN' ? 'The operation stopped after dispatch and needs reconciliation.' : 'The operation stopped.'
        : error instanceof RunError
          ? error.message
          : providerError(error);
      if (!launched && (code === 'INVALID_ARGUMENT' || code === 'CAPABILITY_UNAVAILABLE'))
        this.recoverable.set(id, descriptor.id);
      result = {
        id,
        status: code === 'CANCELLED' ? 'cancelled' : code === 'DUPLICATE_DISPATCH' ? 'blocked' : 'failed',
        problem: { code, message: message.slice(0, 400) },
      };
    } finally {
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
        state: result.problem?.code === 'OUTCOME_UNCERTAIN' ? 'uncertain' :
          result.status === 'completed' ? 'completed' : 'failed',
      }, AbortSignal.any([parent, AbortSignal.timeout(2000)])).catch(() => undefined);
    }
    if (result.problem?.code === 'OUTCOME_UNCERTAIN')
      this.uncertainCapabilities.add(descriptor.capability);
    this.results.set(id, result);
    activity(result.problem?.code === 'OUTCOME_UNCERTAIN' ? 'uncertain' : result.status, result);
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
