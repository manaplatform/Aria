import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  conductorLimits,
  type ArtifactReference,
  type ConductorActivity,
  type ConductorEvent,
  type ExecutionStep,
} from '@aria/shared';
import { providerError } from '../ai/ai.service';
import {
  officialConnection,
  type ModelRegistry,
  type ResolvedModel,
} from '../providers/model-registry.service';
import { RunError, type RunAssets, type RunAttachment } from './run-assets';
import { modelOutputs, toolOutputs, type StepValue, type ToolRegistry } from './tool-registry';

type Registry = Awaited<ReturnType<ModelRegistry['resolve']>>;
type Outcome = StepValue & {
  status: 'completed' | 'failed' | 'blocked' | 'cancelled';
  error?: string;
  artifact?: ArtifactReference;
};
type Planned = {
  step: ExecutionStep;
  model?: ResolvedModel;
  attachmentDerived: boolean;
  startedAt?: number;
};
type Capability = ExecutionStep['capability'];

export class ExecutionEngine {
  private readonly planned = new Map<string, Planned>();
  private readonly results = new Map<string, Outcome>();
  private readonly dispatched = new Set<string>();
  private readonly failedCapabilities = new Set<Capability>();
  private searches = 0;
  private receivedAttachmentContent = false;
  billableChildStarted = false;
  unavailable = false;
  rejection?: string;

  constructor(
    private readonly id: string,
    private readonly registry: Registry,
    private readonly attachments: Map<string, RunAttachment>,
    private readonly assets: RunAssets,
    private readonly tools: ToolRegistry,
    private readonly emit: (event: ConductorEvent) => void,
    private readonly signal: AbortSignal,
  ) {}

  private eligible(model: ResolvedModel, capability: Capability, hosted = false) {
    return (
      model.delegate &&
      model.capabilities.some((value) => value === capability) &&
      (!hosted || (model.connection.webSearch && officialConnection(model.connection.baseUrl)))
    );
  }

  canRun(capability: Capability) {
    if (capability === 'create-file') return true;
    if (capability === 'read-file')
      return [...this.attachments.values()].some((file) => file.mimeType === 'text/plain');
    return [...this.registry.models.values()].some((model) =>
      this.eligible(model, capability, capability === 'web-search'),
    );
  }

  descriptors() {
    const models = [...this.registry.models.values()].filter((model) => model.delegate);
    return models.flatMap((model) => {
      const capabilities = model.capabilities.filter(
        (capability) =>
          Object.hasOwn(modelOutputs, capability) ||
          (capability === 'web-search' && this.eligible(model, capability, true)),
      );
      return capabilities.length
        ? [
            {
              name: model.id,
              connection: model.connection.name,
              operations: capabilities.map((capability) => ({
                capability,
                output:
                  capability === 'web-search'
                    ? toolOutputs.web_search.output
                    : modelOutputs[capability as keyof typeof modelOutputs],
                target:
                  capability === 'web-search'
                    ? { kind: 'tool', tool: 'web_search', model: model.ref }
                    : { kind: 'model', model: model.ref },
              })),
              contextTokens: model.contextTokens,
              inputCost: model.inputCost,
              outputCost: model.outputCost,
              attachmentTransfer:
                model.connection.id === this.registry.primary.connection.id ||
                this.registry.config.crossConnectionAttachments,
            },
          ]
        : [];
    });
  }

  get requiresSettings() {
    return this.failedCapabilities.size > 0;
  }

  private rejectTarget(capability: Capability) {
    // Validation has not dispatched anything. Let the primary correct its choice
    // when another authorized operation exists; invocation failures stay blocked.
    if (this.canRun(capability))
      throw new RunError(
        `The requested target does not provide ${capability}. No operation started. Choose a listed ${capability} operation and copy its exact target and output.`,
      );
    this.failedCapabilities.add(capability);
    throw new RunError(
      'The selected model is unavailable for this capability. Check AI Models in Settings.',
    );
  }

  get failed() {
    return (
      this.unavailable ||
      Boolean(this.rejection) ||
      this.failedCapabilities.size > 0 ||
      [...this.results.values()].some((result) => result.status !== 'completed')
    );
  }

  get succeeded() {
    return [...this.results.values()].some((result) => result.status === 'completed');
  }

  private activity(item: Planned, status: ConductorActivity['status'], outcome?: Outcome) {
    const at = Date.now();
    this.emit({
      type: 'activity',
      activity: {
        stepId: item.step.id,
        capability: item.step.capability,
        summary: item.step.summary,
        target: item.model
          ? `${item.model.connection.name} / ${item.model.id}`
          : item.step.target.kind === 'tool'
            ? item.step.target.tool
            : '',
        status,
        at,
        durationMs: outcome && item.startedAt ? at - item.startedAt : undefined,
        error: outcome?.error,
        resultId: outcome?.artifact?.id,
        sources: outcome?.sources,
      },
    });
  }

  private validate(steps: ExecutionStep[]) {
    if (steps.length + this.planned.size > conductorLimits.steps)
      throw new RunError('The turn reached its execution step limit.');
    const batch = new Map(steps.map((step) => [step.id, step]));
    if (batch.size !== steps.length || steps.some((step) => this.planned.has(step.id)))
      throw new RunError('Each execution step must have a unique ID.');
    const searchCount = steps.filter((step) => step.capability === 'web-search').length;
    if (this.searches + searchCount > conductorLimits.searches)
      throw new RunError('The turn reached its search limit.');
    const checked = new Map<string, Planned>();
    const visiting = new Set<string>();
    const resolve = (id: string): Planned => {
      const prior = checked.get(id) ?? this.planned.get(id);
      if (prior) return prior;
      const step = batch.get(id);
      if (!step || visiting.has(id))
        throw new RunError('A step has a missing or cyclic dependency.');
      visiting.add(id);
      if (new Set(step.dependsOn).size !== step.dependsOn.length)
        throw new RunError('A step has duplicate dependencies.');
      const dependencies = step.dependsOn.map(resolve);
      if (this.failedCapabilities.has(step.capability))
        throw new RunError(
          'That capability already failed in this turn. Explain the result to the user.',
        );
      const model = step.target.model ? this.registry.models.get(step.target.model) : undefined;
      if (step.target.kind === 'model') {
        if (!model || !this.eligible(model, step.capability)) this.rejectTarget(step.capability);
        if (modelOutputs[step.capability as keyof typeof modelOutputs] !== step.output)
          throw new RunError('The selected output does not match the capability.');
      } else {
        const tool = toolOutputs[step.target.tool];
        if (tool.capability !== step.capability || tool.output !== step.output)
          throw new RunError('The selected tool does not provide this capability or output.');
        if (
          step.target.tool === 'web_search' &&
          (!model || !this.eligible(model, step.capability, true))
        ) {
          this.rejectTarget(step.capability);
        }
        if (step.target.tool !== 'web_search' && step.target.model !== null)
          throw new RunError('This local tool does not use a backing model.');
      }
      const attachmentDerived =
        dependencies.some((item) => item.attachmentDerived) ||
        step.inputs.some((input) => input.kind === 'attachment');
      if (
        model &&
        (attachmentDerived || this.receivedAttachmentContent) &&
        model.connection.id !== this.registry.primary.connection.id &&
        !this.registry.config.crossConnectionAttachments
      )
        throw new RunError('Settings restrict attachment transfer to this connection.');
      for (const input of step.inputs) {
        if (input.kind === 'attachment' && !this.attachments.has(input.id))
          throw new RunError('A step refers to an attachment outside this turn.');
        if (input.kind === 'result' && !step.dependsOn.includes(input.stepId))
          throw new RunError('Add referenced results to the step dependencies.');
      }
      const item = { step, model, attachmentDerived };
      checked.set(id, item);
      visiting.delete(id);
      return item;
    };
    return { items: steps.map((step) => resolve(step.id)), searchCount };
  }

  async execute(steps: ExecutionStep[]) {
    let validated: ReturnType<ExecutionEngine['validate']>;
    try {
      validated = this.validate(steps);
      this.rejection = undefined;
    } catch (error) {
      this.rejection =
        error instanceof RunError ? error.message : 'The execution request was rejected.';
      throw error;
    }
    const { items, searchCount } = validated;
    this.searches += searchCount;
    for (const item of items) {
      this.planned.set(item.step.id, item);
      this.activity(item, 'queued');
    }
    const pending = new Map(items.map((item) => [item.step.id, item]));
    while (pending.size) {
      const ready = [...pending.values()]
        .filter((item) => item.step.dependsOn.every((dependency) => this.results.has(dependency)))
        .slice(0, conductorLimits.parallel);
      if (!ready.length) throw new RunError('Execution dependencies could not be resolved.');
      await Promise.all(
        ready.map(async (item) => {
          pending.delete(item.step.id);
          const result = await this.runStep(item);
          this.results.set(item.step.id, result);
          this.activity(item, result.status, result);
        }),
      );
    }
    if (items.some((item) => item.attachmentDerived && this.results.get(item.step.id)?.text))
      this.receivedAttachmentContent = true;
    return items.map(({ step }) => {
      const result = this.results.get(step.id)!;
      return {
        id: step.id,
        status: result.status,
        error: result.error,
        text: result.text,
        artifact: result.artifact,
        sources: result.sources,
      };
    });
  }

  private async runStep(item: Planned): Promise<Outcome> {
    const { step, model } = item;
    if (this.signal.aborted) return { status: 'cancelled' };
    if (step.dependsOn.some((id) => this.results.get(id)?.status !== 'completed'))
      return { status: 'blocked', error: 'A prerequisite did not complete.' };
    const files = [];
    const text = [];
    for (const input of step.inputs) {
      if (input.kind === 'text') text.push(input.text);
      else if (input.kind === 'attachment') files.push(this.attachments.get(input.id)!);
      else {
        const result = this.results.get(input.stepId)!;
        if (result.file) files.push(result.file);
        if (result.text) text.push(result.text);
      }
    }
    if (text.reduce((sum, item) => sum + item.length, 0) > 32_000)
      return { status: 'failed', error: 'The supplied text exceeds the step input limit.' };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([step.target, step.capability, step.instructions, step.inputs]))
      .digest('hex');
    if (this.dispatched.has(fingerprint))
      return { status: 'blocked', error: 'This operation already ran.' };
    this.dispatched.add(fingerprint);
    item.startedAt = Date.now();
    this.activity(item, 'running');
    if (model) this.billableChildStarted = true;
    try {
      const value = await this.tools.invoke(step, { files, text }, this.signal, model);
      this.signal.throwIfAborted();
      if (step.output === 'sources' && (!value.text?.trim() || !value.sources?.length))
        throw new RunError('Web search returned no usable sourced results.');
      const artifact = value.file && this.assets.put(this.id, value.file);
      if (artifact) this.emit({ type: 'artifact', artifact });
      return {
        ...value,
        text: value.text?.slice(0, conductorLimits.resultCharacters),
        status: 'completed',
        artifact,
      };
    } catch (error) {
      if (this.signal.aborted) return { status: 'cancelled' };
      this.failedCapabilities.add(step.capability);
      const message =
        error instanceof RunError || error instanceof HttpException
          ? error.message
          : providerError(error);
      return { status: 'failed', error: message.slice(0, 400) };
    }
  }
}
