import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JSONSchema7 } from 'ai';
import {
  artifactReferenceSchema,
  evidenceSchema,
  programFrameSchema,
  programJson,
  programLimits,
  programStatus,
  programValueSchema,
  sourceSchema,
  toolProblemSchema,
  type ConductorEvent,
  type ProgramRequest,
  type ProgramSettings,
  type ProgramValue,
  type ToolProblem,
} from '@aria/shared';
import { ToolError } from './capability-host';
import type { ExecutionEngine, Outcome } from './execution-engine';
import type { StepValue, ToolDescriptor, ToolRegistry } from './tool-registry';

type Backend = Exclude<ProgramSettings['backend'], 'off'>;
type Status = z.infer<typeof programStatus>;
type Json = ReturnType<typeof programJson>;

export const programChildOutput = z.strictObject({
  status: z.enum(['completed', 'failed', 'blocked', 'cancelled']),
  id: z.string().uuid().optional(),
  text: z.string().optional(),
  data: z.json().optional(),
  dataOmitted: z.boolean().optional(),
  resultRef: z.string().uuid().optional(),
  sources: z.array(sourceSchema).optional(),
  evidence: z.array(evidenceSchema).optional(),
  artifact: artifactReferenceSchema.optional(),
  problem: toolProblemSchema.optional(),
});
export const programWireOutput = z.toJSONSchema(programChildOutput, {
  target: 'draft-7',
  // The Responses API relies on the application to validate object keys.
  override: ({ jsonSchema }) => { delete jsonSchema.propertyNames; },
}) as JSONSchema7;
type ChildOutput = z.infer<typeof programChildOutput>;
type Receipt = {
  tool: string;
  fingerprint: string;
  value: Promise<ChildOutput>;
};

function canonical(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

function failure(code: ToolProblem['code'], message: string) {
  return { status: 'failed', problem: { code, message } } as const;
}

function problem(error: unknown): ToolProblem {
  if (error instanceof ToolError) return { code: error.code, message: error.message };
  return { code: 'EXECUTION_FAILED', message: 'The program stopped without an accepted result.' };
}

function typeOf(value: Json) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

export class ProgramBroker {
  private readonly values = new Map<string, { json: string; private: boolean; program: string }>();
  private retainedBytes = 0;
  constructor(
    private readonly engine: ExecutionEngine,
    private readonly registry: ToolRegistry,
    private readonly emit: (event: ConductorEvent) => void,
    private readonly parent: AbortSignal,
  ) {}

  async open(
    id: string,
    backend: Backend,
    bindings: ReadonlyMap<string, ToolDescriptor>,
    signal = this.parent,
  ) {
    const settings = this.registry.host.current.programming;
    if (settings?.backend !== backend)
      throw new ToolError(
        'CAPABILITY_UNAVAILABLE',
        'Select and verify this program backend in Tools settings.',
      );
    if (
      bindings.size > 24 ||
      new Set([...bindings.values()].map((entry) => entry.program?.scope)).size > 1
    )
      throw new ToolError(
        'PERMISSION_DENIED',
        'Use separate program scopes for public and private data.',
      );
    const program = new ProgramExecution(
      id,
      backend,
      bindings,
      settings,
      this.engine,
      this.registry,
      this.emit,
      signal,
      (data, restricted) => this.retain(id, data, restricted),
    );
    await program.open();
    return program;
  }

  private retain(program: string, data: unknown, restricted: boolean) {
    try {
      const remaining = programLimits.intermediate - this.retainedBytes;
      const bytes = JSON.stringify(programJson(data, remaining));
      this.retainedBytes += Buffer.byteLength(bytes);
      const id = randomUUID();
      this.values.set(id, { json: bytes, private: restricted, program });
      return id;
    } catch {
      return undefined;
    }
  }

  read(resultId: string, offset: number, program?: string): StepValue {
    const value = this.values.get(resultId);
    if (!value || (program && program !== value.program) || offset >= value.json.length)
      throw new ToolError(
        'INVALID_REFERENCE',
        'The program result reference or offset is unavailable in this scope.',
      );
    const end = Math.min(offset + 6000, value.json.length);
    return {
      data: {
        resultId,
        content: value.json.slice(offset, end),
        ...(end < value.json.length && { nextOffset: end }),
      },
      privateContent: value.private,
    };
  }

  async managed(
    input: ProgramRequest,
    id: string,
    loaded: ReadonlyMap<string, ToolDescriptor>,
    parent: AbortSignal,
  ): Promise<StepValue> {
    const bindings = new Map<string, ToolDescriptor>();
    const handles: Record<string, string> = {};
    for (const id of new Set(input.tools)) {
      const tool = loaded.get(this.registry.wireName(id));
      if (tool?.id !== id || !this.registry.allowedForProgram(tool, this.engine.context, 'managed'))
        throw new ToolError(
          'PERMISSION_DENIED',
          'Discover and load each eligible tool before starting the program.',
        );
      const handle = randomUUID();
      handles[id] = handle;
      bindings.set(handle, tool);
    }
    const program = await this.open(id, 'managed', bindings, parent);
    const reader = randomUUID();
    handles['programs.read_result'] = reader;
    const active = new Map<number, Promise<void>>();
    const replies: { id: number; value: ChildOutput }[] = [];
    let result: unknown;
    let error: ToolProblem | undefined;
    try {
      await program.command('program.start', {
        ...(input.skillSource ? { skillSource: input.skillSource } : { code: input.code }),
        bindings: handles,
        toolCalls: program.settings.toolCalls,
        milliseconds: Math.max(1, program.deadline - Date.now()),
      });
      while (result === undefined) {
        program.signal.throwIfAborted();
        const batch = replies.splice(0, 1);
        const round = await program.command('program.exchange', {
          replies: batch,
          wait: batch.length ? 0 : 150,
        });
        const frames = z.array(programFrameSchema).max(13).safeParse(round.data?.frames);
        if (!frames.success)
          throw new ToolError('INVALID_PROGRAM', 'The isolated runner returned an invalid frame.');
        for (const frame of frames.data) {
          if (frame.type === 'failure')
            throw new ToolError(frame.code, 'The isolated JavaScript program could not finish.');
          if (frame.type === 'result') {
            if (active.size)
              throw new ToolError(
                'INVALID_PROGRAM',
                'Await all invoked tools before returning the program result.',
              );
            result = frame.value;
            break;
          }
          const child = (
            frame.handle === reader
              ? Promise.resolve(this.readFromProgram(program.id, frame.input))
              : program.invoke(String(frame.id), frame.handle, frame.input)
          )
            .then((value) => {
              replies.push({ id: frame.id, value });
            })
            .finally(() => {
              active.delete(frame.id);
            });
          active.set(frame.id, child);
        }
      }
    } catch (caught) {
      error =
        program.signal.aborted && !parent.aborted
          ? { code: 'TIMEOUT', message: 'The program reached its execution deadline.' }
          : problem(caught);
    } finally {
      program.stopChildren();
      await Promise.allSettled(active.values());
      if (!parent.aborted) await program.command('program.stop', {}, parent).catch(() => undefined);
    }
    const final = await program.finish(result, error, input, parent.aborted);
    const { data: _data, ...summary } = final;
    return {
      data: final,
      programStatus: final.status,
      programResultSaved: final.saved,
      privateContent: program.privateContent,
      executionDetails: JSON.stringify(summary, null, 2).slice(0, 12_000),
    };
  }

  private readFromProgram(programId: string, raw: unknown): ChildOutput {
    try {
      this.engine.reserveProgram();
      const { resultId, offset } = resultReadSchema.parse(raw);
      const value = this.read(resultId, offset, programId);
      return programChildOutput.parse({ status: 'completed', data: value.data });
    } catch (error) {
      const issue = problem(error);
      return failure(issue.code, issue.message);
    }
  }
}

const resultReadSchema = z.strictObject({
  resultId: z.string().uuid(),
  offset: z.number().int().min(0).max(programLimits.intermediate),
});

export class ProgramExecution {
  private readonly started = Date.now();
  readonly deadline: number;
  private readonly children = new AbortController();
  readonly signal: AbortSignal;
  private readonly resolved = new Map<string, ChildOutput>();
  private readonly calls = new Map<string, Receipt>();
  private attempted = 0;
  private bytes = 0;
  private uncertain = false;
  private closed = false;
  private readonly revision: string;
  private readonly rejected: ChildOutput[] = [];

  constructor(
    readonly id: string,
    readonly backend: Backend,
    private readonly bindings: ReadonlyMap<string, ToolDescriptor>,
    readonly settings: ProgramSettings,
    private readonly engine: ExecutionEngine,
    private readonly registry: ToolRegistry,
    private readonly emit: (event: ConductorEvent) => void,
    private readonly parent: AbortSignal,
    private readonly retain: (data: unknown, restricted: boolean) => string | undefined,
  ) {
    this.revision = registry.host.current.revision;
    this.deadline = this.started + settings.milliseconds;
    this.signal = AbortSignal.any([
      parent,
      this.children.signal,
      AbortSignal.timeout(settings.milliseconds),
    ]);
  }

  get privateContent() {
    return [...this.bindings.values()].some(
      (descriptor) => descriptor.program?.scope === 'private',
    );
  }

  async open() {
    await this.journal({ action: 'open', backend: this.backend, deadline: this.deadline });
    this.activity('running');
  }

  stopChildren() {
    this.children.abort();
  }

  async command(
    operation: 'program.start' | 'program.exchange' | 'program.stop' | 'program.journal',
    input: Record<string, unknown>,
    signal = this.signal,
  ) {
    const {
      runtime,
      registry: { primary },
    } = this.engine.context;
    if (!runtime)
      throw new ToolError('CAPABILITY_UNAVAILABLE', 'Programs require managed desktop chat.');
    return this.registry.host.runtime(
      {
        ...runtime,
        type: 'runtime',
        operation,
        revision: this.revision,
        stepId: this.id,
        callId: this.id,
        input,
        primary: {
          connectionId: primary.connection.id,
          model: primary.id,
          endpoint: primary.connection.baseUrl,
        },
      },
      signal,
    );
  }

  private journal(input: Record<string, unknown>, signal = this.signal) {
    return this.command('program.journal', input, signal);
  }

  async invoke(callId: string, binding: string, input: unknown): Promise<ChildOutput> {
    const descriptor = this.bindings.get(binding);
    const reject = (code: ToolProblem['code'], message: string) => {
      const result = failure(code, message);
      if (this.rejected.length < this.settings.toolCalls) this.rejected.push(result);
      return result;
    };
    if (++this.attempted > this.settings.toolCalls)
      return reject('BUDGET_EXCEEDED', 'This program reached its tool call limit.');
    try {
      this.engine.reserveProgram();
    } catch {
      return reject('BUDGET_EXCEEDED', 'The parent turn has no remaining tool calls.');
    }
    if (
      !descriptor ||
      this.closed ||
      this.signal.aborted ||
      this.revision !== this.registry.host.current.revision ||
      !this.registry.allowedForProgram(descriptor, this.engine.context, this.backend)
    )
      return reject('PERMISSION_DENIED', 'The tool is outside the active program scope.');
    let value: Json;
    try {
      value = programJson(input, programLimits.frame - 1000);
    } catch {
      return reject('INVALID_ARGUMENT', 'The arguments exceed the program JSON limits.');
    }
    const parsed = descriptor.input.safeParse(value);
    if (!parsed.success)
      return reject('INVALID_ARGUMENT', 'The arguments do not match the tool schema.');
    if (
      !this.registry.allowedForProgram(descriptor, this.engine.context, this.backend, parsed.data)
    )
      return reject('PERMISSION_DENIED', 'These arguments are outside program authorization.');
    const fingerprint = createHash('sha256')
      .update(canonical([descriptor.id, descriptor.version, value]))
      .digest('hex');
    const prior = this.calls.get(callId);
    if (prior) {
      return prior.fingerprint === fingerprint
        ? prior.value
        : reject('CALLER_MISMATCH', 'The program reused a call ID with different arguments.');
    }
    const operation = this.dispatch(descriptor, callId, fingerprint, value);
    this.calls.set(callId, { tool: descriptor.id, fingerprint, value: operation });
    return operation;
  }

  private async dispatch(
    descriptor: ToolDescriptor,
    callId: string,
    fingerprint: string,
    input: Json,
  ) {
    let value: ChildOutput;
    let journaled = false;
    try {
      await this.journal({
        action: 'reserve',
        callId,
        tool: descriptor.id,
        version: descriptor.version,
        fingerprint,
        mutable: descriptor.program?.retry === 'never',
      });
      journaled = true;
      const [outcome] = await this.engine.execute(
        [
          {
            descriptor,
            callId,
            input,
            program: {
              id: this.id,
              backend: this.backend,
              revision: this.revision,
              signal: this.signal,
            },
          },
        ],
        async () => this.engine.context.registry,
        () => false,
      );
      value = this.project(outcome);
      await this.journal(
        {
          action: 'receipt',
          callId,
          stepId: outcome.id,
          state: outcome.problem?.code === 'OUTCOME_UNCERTAIN' ? 'uncertain' : outcome.status,
        },
        this.parent,
      );
      this.uncertain ||= outcome.problem?.code === 'OUTCOME_UNCERTAIN';
    } catch (error) {
      this.uncertain ||= journaled;
      const issue = problem(error);
      value = failure(issue.code, issue.message);
    }
    this.resolved.set(callId, value);
    return value;
  }

  private project(outcome: Outcome): ChildOutput {
    const { id, status, text, evidence, sources, artifact, problem: issue, data } = outcome;
    const value: ChildOutput = {
      id,
      status,
      text: text?.slice(0, 6000),
      evidence,
      sources,
      artifact,
      problem: issue,
    };
    if (data) {
      try {
        const remaining = Math.min(12_000, programLimits.intermediate - this.bytes);
        value.data = programJson(data, remaining);
        this.bytes += Buffer.byteLength(JSON.stringify(value.data));
      } catch {
        value.dataOmitted = true;
        value.resultRef = this.retain(data, this.privateContent || outcome.privateContent === true);
      }
    }
    return programChildOutput.parse(value);
  }

  async finish(raw: unknown, issue?: ToolProblem, input?: ProgramRequest, cancelled = false) {
    this.closed = true;
    await Promise.allSettled([...this.calls.values()].map((call) => call.value));
    let value: ProgramValue | undefined;
    const availableEvidence = new Set(
      [...this.resolved.values()].flatMap((child) =>
        [...(child.evidence ?? []), ...(child.sources ?? [])].map(({ id }) => id),
      ),
    );
    const availableArtifacts = new Set(
      [...this.resolved.values()].map((child) => child.artifact?.id),
    );
    if (!issue) {
      try {
        value = programValueSchema.parse(programJson(raw, programLimits.result));
        if (
          input &&
          (value.objective !== input.objective ||
            (input.dataContract.length &&
              (typeOf(value.data) !== 'object' ||
                !input.dataContract.every(
                  ({ key, type }) =>
                    Object.hasOwn(value!.data as object, key) &&
                    typeOf((value!.data as Record<string, Json>)[key]) === type,
                ))))
        )
          throw new ToolError(
            'INVALID_PROGRAM',
            'The program result does not satisfy its declared data contract.',
          );
        if (
          value.evidence.some((id) => !availableEvidence.has(id)) ||
          value.artifacts.some((id) => !availableArtifacts.has(id))
        )
          throw new ToolError(
            'INVALID_REFERENCE',
            'The program returned a reference outside its verified results.',
          );
      } catch (error) {
        value = undefined;
        issue =
          error instanceof ToolError
            ? problem(error)
            : {
                code: 'INVALID_PROGRAM',
                message: 'The program returned an invalid structured result.',
              };
      }
    }
    const completed: { id?: string; tool?: string }[] = [];
    const failed: { id?: string; tool?: string; problem?: ToolProblem }[] = this.rejected.map(
      ({ problem }) => ({ problem }),
    );
    for (const [id, child] of this.resolved) {
      const item = { id: child.id, tool: this.calls.get(id)?.tool };
      if (child.status === 'completed') completed.push(item);
      else failed.push({ ...item, problem: child.problem });
    }
    const partial = Boolean(
      issue ||
      failed.length ||
      value?.missing.length ||
      value?.checks.some(({ passed }) => !passed),
    );
    let status: Status = this.uncertain
      ? 'uncertain'
      : cancelled
        ? 'cancelled'
        : partial
          ? completed.length
            ? 'partial'
            : 'failed'
          : 'complete';
    const result = {
      status,
      objective: value?.objective ?? input?.objective,
      data: value?.data,
      checks: value?.checks ?? [],
      missing: value?.missing ?? [],
      // Keep verified evidence available even when untrusted result assembly fails.
      evidence: [...availableEvidence]
        .filter((id): id is string => typeof id === 'string')
        .slice(0, 24),
      artifacts: [...availableArtifacts].filter((id): id is string => !!id).slice(0, 8),
      completed,
      failed,
      problem: issue,
      warnings: value?.warnings ?? [],
      usage: {
        childCalls: this.attempted,
        intermediateBytes: this.bytes,
        durationMs: Date.now() - this.started,
      },
    };
    let saved = false;
    if (!this.parent.aborted) {
      try {
        const serialized = JSON.stringify(result);
        const receipt = await this.journal({
          action: 'finish', state: status,
          ...(value && Buffer.byteLength(serialized) <= 24_000 && { result: serialized }),
        }, this.parent);
        saved = receipt.data?.saved === true;
      } catch {
        result.status = status = 'uncertain';
        result.problem = {
          code: 'OUTCOME_UNCERTAIN',
          message: 'The program journal could not confirm completion.',
        };
      }
    }
    this.activity(
      status === 'complete' || status === 'partial'
        ? 'completed'
        : status === 'cancelled'
          ? 'cancelled'
          : 'failed',
      status,
      saved,
    );
    return { ...result, saved };
  }

  private activity(status: 'running' | 'completed' | 'cancelled' | 'failed', result?: Status, saved?: boolean) {
    this.emit({
      type: 'activity',
      activity: {
        stepId: this.id,
        capability: 'programs.run',
        target: this.backend === 'managed' ? 'Aria isolated JavaScript' : 'OpenAI Responses',
        summary: 'Coordinate tool operations',
        status,
        programStatus: result,
        programResultSaved: saved,
        at: Date.now(),
        durationMs: result ? Date.now() - this.started : undefined,
        resultSummary: result ? `${this.attempted} child calls · ${result}` : undefined,
      },
    });
  }
}
