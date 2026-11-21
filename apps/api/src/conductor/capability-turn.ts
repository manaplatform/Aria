import { randomUUID } from 'node:crypto';
import { tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { programWireOutput } from './program-broker';
import {
  builtinSourceSkill,
  capabilityId,
  conductorLimits,
  modelRefSchema,
  modelCapabilitySchema,
  skillRefSchema,
  type ChatRequest,
  type ConductorEvent,
} from '@aria/shared';
import type { discoveryProtocol } from '../ai/tool-discovery';
import { ToolError } from './capability-host';
import type { ToolContext, ToolDescriptor, ToolRegistry } from './tool-registry';

const findInput = z.strictObject({
  query: z.string().max(240),
  ids: z.array(capabilityId).max(8).optional(),
  kind: z.enum(['tools', 'skills']).optional(),
  namespace: z.string().max(40).optional(),
  offset: z.number().int().min(0).max(2000).optional(),
  modelQuery: z.string().max(120).optional(),
  modelOffset: z.number().int().min(0).max(2400).optional(),
});
const resourcesInput = skillRefSchema.extend({
  resourceId: z.string().uuid(),
  offset: z.number().int().min(0).max(1_048_576).optional(),
});
const unavailableInput = z.strictObject({ capability: z.string().min(1).max(100) });
const builtinInstructions = [
  'Identify the exact claims the user wants compared and the scope or time period that matters.',
  'When public research is appropriate, find independent sources and read the original publisher pages before citing them.',
  'For each claim, compare what the sources measured, when, and with which definitions. Note where differences are explained by scope and where the evidence conflicts.',
  'Summarize the strongest agreement, remaining uncertainty, and sources the user can verify.',
].join('\n');

function terms(value: string) {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function tokensFor(card: { id: string; name: string; description: string }) {
  return terms(`${card.id} ${card.name} ${card.description}`);
}

export class CapabilityTurn {
  private readonly loaded = new Map<string, ToolDescriptor>();
  private readonly discovered = new Set<string>();
  private readonly discoveredTools = new Map<string, ToolDescriptor>();
  private readonly selectedModels = new Map<string, Set<string>>();
  private readonly skills = new Set<string>();
  private readonly searches = new Map<string, object>();
  private delegateSnapshot?: ReturnType<ToolRegistry['delegates']>;
  private controlCalls = 0;
  progress = 0;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly context: ToolContext,
    private readonly request: ChatRequest,
    private readonly signal: AbortSignal,
    private readonly emit: (event: ConductorEvent) => void,
    private readonly protocol: ReturnType<typeof discoveryProtocol>,
    private readonly voiceSessionId?: string,
  ) {}

  delegates = () => (this.delegateSnapshot ??= this.registry.delegates(this.context, this.signal));

  isModelDiscovered(id: string, value: string) {
    return this.selectedModels.get(id)?.has(value) ?? false;
  }

  getLoaded(name: string, metadata: unknown) {
    const descriptor = this.loaded.get(name);
    return descriptor && this.protocol.accepts(descriptor.id, metadata) ? descriptor : undefined;
  }

  loadedTools() {
    return new Map(this.loaded);
  }

  hasLoadedSkill(id: string, version: string) {
    return this.skills.has(`${id}@${version}`);
  }

  programTools(backend: 'managed' | 'openai-responses') {
    return new Map([...this.loaded].filter(([, tool]) =>
      this.registry.allowedForProgram(tool, this.context, backend),
    ));
  }

  resultFormat(name: string) {
    return name === this.protocol.name ? this.protocol.resultFormat : 'text';
  }

  private definition(descriptor: ToolDescriptor) {
    const hosted = this.registry.allowedForProgram(descriptor, this.context, 'openai-responses');
    return {
      id: descriptor.id,
      name: this.registry.wireName(descriptor.id),
      description: descriptor.description,
      schema: this.registry.schema(descriptor),
      deferred: descriptor.deferred,
      ...(hosted && {
        callers: [...descriptor.modes],
        outputSchema: programWireOutput,
      }),
    };
  }

  controls(messages: ModelMessage[]): ToolSet {
    const revoked = new Set<string>();
    for (const [name, descriptor] of this.loaded) {
      if (!this.registry.allowed(descriptor, this.context)) {
        this.loaded.delete(name);
        revoked.add(name);
      }
    }
    if (revoked.size) this.protocol.prune(messages, revoked);
    const tools: ToolSet = {
      find_capabilities: tool({
        description:
          'Find authorized tool and skill metadata for a task. Use an empty query and a namespace or kind to browse. For delegated models, use modelQuery or modelOffset to refine the exact model targets. This does not execute an operation.',
        inputSchema: findInput,
      }),
      [this.protocol.name]: this.protocol.apiTool,
      report_unavailable: tool({
        description: 'Report that an operation required by the user has no available tool.',
        inputSchema: unavailableInput,
      }),
    };
    if (this.registry.host.current.skills.some((skill) => skill.enabled)) {
      tools.load_skill = tool({
        description:
          'Read an approved skill by its discovered ID and version when its procedure is relevant.',
        inputSchema: skillRefSchema,
      });
      tools.read_skill_resource = tool({
        description:
          'Read an authorized resource ID returned by load_skill. Use nextOffset to read more.',
        inputSchema: resourcesInput,
      });
    }
    for (const [name, descriptor] of this.loaded) {
      if (descriptor.modes.includes('direct') || this.registry.allowedForProgram(descriptor, this.context, 'openai-responses'))
        tools[name] = this.protocol.definition(this.definition(descriptor));
    }
    return tools;
  }

  isControl(name: string) {
    return [
      'find_capabilities',
      'report_unavailable',
      'load_skill',
      'read_skill_resource',
      this.protocol.name,
    ].includes(name);
  }

  async control(
    name: string,
    raw: unknown,
    callId: string,
  ): Promise<{ value: object; error?: ToolError; unavailable?: boolean }> {
    const stepId = randomUUID();
    const skill = name === 'load_skill' || name === 'read_skill_resource';
    const summary = skill
      ? name === 'load_skill'
        ? 'Loading a skill'
        : 'Reading a skill resource'
      : name === 'report_unavailable'
        ? 'Checking capability availability'
        : name === 'find_capabilities'
          ? 'Searching available capabilities'
          : 'Loading tool definitions';
    const start = Date.now();
    let target = name;
    let resultSummary: string | undefined;
    const activity = (status: 'running' | 'completed' | 'failed', error?: string) =>
      this.emit({
        type: 'activity',
        activity: {
          stepId,
          callId,
          target,
          capability: skill ? 'conductor.skills' : 'conductor.discovery',
          summary,
          status,
          at: Date.now(),
          durationMs: status === 'running' ? undefined : Date.now() - start,
          error,
          resultSummary,
        },
      });
    activity('running');
    try {
      if (++this.controlCalls > conductorLimits.controlCalls)
        throw new ToolError('BUDGET_EXCEEDED', 'The turn reached its discovery and skill limit.');
      this.signal.throwIfAborted();
      let value: object;
      if (name === 'find_capabilities') {
        value = await this.find(findInput.parse(raw));
        resultSummary = 'Capability metadata returned';
      } else if (name === this.protocol.name) {
        const loaded = await this.load(this.protocol.selection(raw, callId));
        resultSummary = `${loaded.length} definitions loaded`;
        value = this.protocol.result(loaded.map((descriptor) => this.definition(descriptor)));
      } else if (skill) {
        const reference =
          name === 'load_skill' ? skillRefSchema.parse(raw) : resourcesInput.parse(raw);
        const resource = name === 'read_skill_resource' ? resourcesInput.parse(raw) : undefined;
        target = reference.id;
        value = await this.readSkill(
          { id: reference.id, version: reference.version },
          resource?.resourceId,
          resource?.offset,
        );
        resultSummary = resource ? 'Skill resource returned' : 'Skill instructions loaded';
      } else {
        const { capability } = unavailableInput.parse(raw);
        const candidates = this.registry
          .cards(this.context)
          .filter(
            (card) =>
              this.registry.get(card.id)?.capability === capability || card.id === capability,
          );
        const eligible = candidates.filter(
          (card) => this.registry.get(card.id)?.dependency !== 'delegate',
        );
        if (
          eligible.length ||
          (candidates.length &&
            [...(await this.delegates()).models.values()].some(
              (model) =>
                model.delegate &&
                model.capabilities.some(
                  (item) =>
                    item === capability ||
                    candidates.some((card) => this.registry.get(card.id)?.capability === item),
                ),
            ))
        )
          throw new ToolError(
            'INVALID_ARGUMENT',
            'An eligible operation exists. Discover it before reporting it unavailable.',
          );
        const message =
          capability === 'read-file'
            ? 'Attach a supported UTF-8 file to this turn.'
            : capability.startsWith('web') || capability.startsWith('browser')
              ? 'Enable the requested operation in Tools and Web & Browser settings.'
              : modelCapabilitySchema.safeParse(capability).success
                ? `Enable a compatible ${capability} model or tool in Settings.`
                : 'Enable the required capability in Tools settings.';
        const error = new ToolError('CAPABILITY_UNAVAILABLE', message);
        activity('failed', message);
        return { value: { error: { code: error.code, message } }, error, unavailable: true };
      }
      activity('completed');
      return { value };
    } catch (failure) {
      this.signal.throwIfAborted();
      const error =
        failure instanceof ToolError
          ? failure
          : new ToolError(
              failure instanceof z.ZodError ? 'INVALID_ARGUMENT' : 'EXECUTION_FAILED',
              failure instanceof z.ZodError
                ? 'The discovery or skill arguments are invalid.'
                : 'The requested capability could not be loaded.',
            );
      activity('failed', error.message);
      if (name === this.protocol.name && this.protocol.emptyResult)
        return { value: this.protocol.emptyResult, error };
      return { value: { error: { code: error.code, message: error.message } }, error };
    }
  }

  private async find(query: z.infer<typeof findInput>) {
    const key = JSON.stringify([
      query,
      this.registry.revision,
      this.registry.host.current.revision,
      this.context.privateContent,
    ]);
    const cached = this.searches.get(key);
    if (cached) return cached;
    const words = terms(query.query);
    const cards = [
      ...(query.kind === 'skills' ? [] : this.registry.cards(this.context)),
      ...(query.kind === 'tools'
        ? []
        : this.registry.host.current.skills
            .filter((skill) => skill.enabled)
            .map((skill) => ({ ...skill, namespace: 'skills' }))),
    ]
      .filter(
        (card) =>
          (!query.namespace || card.namespace === query.namespace) &&
          (!query.ids || query.ids.includes(card.id)),
      )
      .map((card) => {
        const tokens = tokensFor(card);
        return { card, score: [...words].filter((word) => tokens.has(word)).length };
      })
      .sort(
        (first, second) =>
          second.score - first.score || first.card.id.localeCompare(second.card.id),
      );
    const offset = query.offset ?? 0;
    const page = cards.slice(offset, offset + 8);
    const items = await Promise.all(
      page.map(async ({ card }) => {
        const descriptor = this.registry.get(card.id);
        if (descriptor?.dependency === 'delegate') {
          const roster = await this.delegates();
          const modelQuery = query.modelQuery?.toLowerCase();
          const targets = [...roster.models.values()].filter(
            (model) =>
              model.delegate &&
              model.capabilities.some((cap) => cap === descriptor.capability) &&
              (!modelQuery ||
                `${model.connection.name} ${model.id}`.toLowerCase().includes(modelQuery)),
          );
          const modelOffset = query.modelOffset ?? 0;
          const models = targets.slice(modelOffset, modelOffset + 8).map((model) => ({
            ref: model.ref,
            model: model.id,
            connection: model.connection.name,
            contextTokens: model.contextTokens,
          }));
          if (!models.length) return undefined;
          const selected = this.selectedModels.get(card.id) ?? new Set<string>();
          const previousTargets = new Set(selected);
          for (const model of models) selected.add(modelRefSchema.parse(model.ref));
          this.selectedModels.set(card.id, selected);
          if (
            !this.discovered.has(card.id) ||
            models.some((model) => !previousTargets.has(model.ref))
          )
            this.progress++;
          this.discovered.add(card.id);
          this.discoveredTools.set(card.id, descriptor);
          return {
            ...card,
            models,
            ...(targets.length > modelOffset + 8 && { nextModelOffset: modelOffset + 8 }),
          };
        }
        const isNew = !this.discovered.has(card.id);
        this.discovered.add(card.id);
        if (descriptor) this.discoveredTools.set(card.id, descriptor);
        if (isNew) this.progress++;
        return card;
      }),
    );
    const value = {
      items: items.filter(Boolean),
      ...(cards.length > offset + 8 && { nextOffset: offset + 8 }),
    };
    this.searches.set(key, value);
    return value;
  }

  private async load(ids: string[]) {
    const loaded: ToolDescriptor[] = [];
    for (const id of new Set(ids)) {
      const descriptor = this.registry.get(id);
      const wire = this.registry.wireName(id);
      if (
        !descriptor ||
        this.discoveredTools.get(id) !== descriptor ||
        !this.registry.allowed(descriptor, this.context) ||
        this.loaded.has(wire) ||
        this.loaded.size >= 24
      )
        continue;
      this.loaded.set(wire, descriptor);
      loaded.push(descriptor);
      this.progress++;
    }
    if (!loaded.length && ids.some((id) => !this.loaded.has(this.registry.wireName(id))))
      throw new ToolError(
        'CAPABILITY_UNAVAILABLE',
        'Discover authorized tool IDs before loading their schemas.',
      );
    return loaded;
  }

  private async readSkill(skill: z.infer<typeof skillRefSchema>, resourceId?: string, offset = 0) {
    const current = this.registry.host.current.skills.find(
      (item) => item.id === skill.id && item.version === skill.version && item.enabled,
    );
    const key = `${skill.id}@${skill.version}`;
    if (!current || (resourceId && !this.skills.has(key)))
      throw new ToolError(
        'PERMISSION_DENIED',
        'That skill or resource is unavailable to this turn.',
      );
    const content =
      current.id === builtinSourceSkill.id
        ? { text: builtinInstructions, resources: [] }
        : await this.registry.host.request(
            {
              type: 'skill',
              requestId: this.request.requestId,
              conversationId: this.request.conversationId,
              assistantMessageId: this.request.assistantMessageId,
              revision: this.registry.host.current.revision,
              voiceSessionId: this.voiceSessionId,
              skill,
              resourceId,
              offset,
            },
            this.signal,
          );
    if (!content)
      throw new ToolError('CAPABILITY_UNAVAILABLE', 'The selected skill could not be read.');
    if (current.provenance === 'local') this.context.privateContent = true;
    if (!this.skills.has(key)) this.progress++;
    this.skills.add(key);
    if (resourceId) {
      const part = `${key}/${resourceId}/${offset}`;
      if (!this.skills.has(part)) this.progress++;
      this.skills.add(part);
    }
    return { ...content, skill };
  }
}
