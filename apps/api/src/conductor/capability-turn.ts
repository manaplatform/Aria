import { randomUUID } from 'node:crypto';
import { tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { programWireOutput } from './program-broker';
import {
  builtinSourceSkill,
  capabilityId,
  modelRefSchema,
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
  includeUnavailable: z.boolean().optional(),
  offset: z.number().int().min(0).max(2000).optional(),
  modelQuery: z.string().max(120).optional(),
  modelOffset: z.number().int().min(0).max(2400).optional(),
});
const resourcesInput = skillRefSchema.extend({
  resourceId: z.string().uuid(),
  offset: z.number().int().min(0).max(1_048_576).optional(),
});
const builtinInstructions = [
  'Identify the exact claims the user wants compared and the scope or time period that matters.',
  'When public research is appropriate, find independent sources and read the original publisher pages before citing them.',
  'For each claim, compare what the sources measured, when, and with which definitions. Note where differences are explained by scope and where the evidence conflicts.',
  'Summarize the strongest agreement, remaining uncertainty, and sources the user can verify.',
].join('\n');

function terms(value: string) {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function tokensFor(card: {
  id: string;
  namespace?: string;
  name: string;
  description: string;
  tags?: string[];
}) {
  return terms(
    `${card.id} ${card.namespace ?? ''} ${card.name} ${card.description} ${card.tags?.join(' ') ?? ''}`,
  );
}

function matchScore(words: Set<string>, tokens: Set<string>) {
  let score = 0;
  const list = [...tokens];
  for (const word of words) {
    if (tokens.has(word)) {
      score += 3;
      continue;
    }
    if (word.length >= 3 && list.some((token) => token.length >= 3 && (token.startsWith(word) || word.startsWith(token))))
      score += 1;
  }
  return score;
}

export class CapabilityTurn {
  private readonly loaded = new Map<string, ToolDescriptor>();
  private readonly discovered = new Set<string>();
  private readonly discoveredTools = new Map<string, ToolDescriptor>();
  private readonly selectedModels = new Map<string, Set<string>>();
  private readonly skills = new Set<string>();
  private readonly skillPages = new Map<string, NonNullable<Awaited<ReturnType<ToolRegistry['host']['request']>>>>();
  private readonly searches = new Map<string, {
    items: ({ id: string; name: string; available: boolean; reason?: string } | undefined)[];
    nextOffset?: number;
  }>();
  private delegateSnapshot?: ReturnType<ToolRegistry['delegates']>;
  progress = 0;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly context: ToolContext,
    private readonly request: ChatRequest,
    private readonly signal: AbortSignal,
    private readonly emit: (event: ConductorEvent) => void,
    private readonly protocol: ReturnType<typeof discoveryProtocol>,
    private readonly voiceSessionId?: string,
    private readonly discoveryProblem?: ToolError,
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
      ...(!this.discoveryProblem && { [this.protocol.name]: this.protocol.apiTool }),
    };
    if (this.discoveryProblem) return tools;
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
      'load_skill',
      'read_skill_resource',
      this.protocol.name,
    ].includes(name);
  }

  async control(
    name: string,
    raw: unknown,
    callId: string,
  ): Promise<{ value: object; error?: ToolError; unavailable?: boolean; availabilityOnly?: boolean }> {
    const stepId = randomUUID();
    const skill = name === 'load_skill' || name === 'read_skill_resource';
    const summary = skill
      ? name === 'load_skill'
        ? 'Loading a skill'
        : 'Reading a skill resource'
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
          ...(skill && status === 'completed' && this.context.privateContent && { privateContent: true }),
        },
      });
    activity('running');
    try {
      this.signal.throwIfAborted();
      this.context.budget.control();
      if (this.discoveryProblem) throw this.discoveryProblem;
      let value: object;
      let availabilityOnly = false;
      if (name === 'find_capabilities') {
        const query = findInput.parse(raw);
        const found = await this.find(query);
        if (query.ids?.length && !query.offset && !query.modelOffset &&
          !found.items.some((item) => item?.available) && found.nextOffset === undefined) {
          const message = found.items.flatMap((item) =>
            item?.available === false && item.reason ? [item.reason] : []).join(' ').slice(0, 400) ||
            this.registry.discoveryProblem(query.ids, this.context);
          const error = new ToolError('CAPABILITY_UNAVAILABLE', message);
          activity('failed', message);
          return { value: { ...found, error: { code: error.code, message } }, error, unavailable: true, availabilityOnly: true };
        }
        availabilityOnly = found.items.length > 0 && !found.items.some((item) => item?.available);
        const requestedName = query.query.trim().toLowerCase();
        availabilityOnly ||= found.items.some((item) => item?.available === false &&
          (item.name.toLowerCase() === requestedName || item.id.toLowerCase() === requestedName));
        value = found;
        resultSummary = 'Capability metadata returned';
      } else if (name === this.protocol.name) {
        const requested = this.protocol.selection(raw, callId);
        const loaded = await this.load(requested);
        resultSummary = `${loaded.length} definitions loaded`;
        value = this.protocol.result(loaded.map((descriptor) => this.definition(descriptor)));
        const skipped = requested.filter((id) => !this.loaded.has(this.registry.wireName(id)));
        if (skipped.length && this.protocol.resultFormat === 'text') value = {
          ...value, skipped: skipped.map((id) => ({ id, reason: this.registry.discoveryProblem([id], this.context) })),
        };
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
        throw new ToolError('CAPABILITY_UNAVAILABLE', 'This discovery operation is unavailable.');
      }
      activity('completed');
      return { value, availabilityOnly };
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
      return {
        value: { error: { code: error.code, message: error.message } },
        error,
        ...(error.code === 'CAPABILITY_UNAVAILABLE' && { unavailable: true }),
      };
    }
  }

  private async find(query: z.infer<typeof findInput>) {
    const key = JSON.stringify([
      query,
      this.registry.revision,
      this.registry.host.current.revision,
      this.context.privateContent,
      this.context.memoryPrivate,
    ]);
    const cached = this.searches.get(key);
    if (cached) return cached;
    const words = terms(query.query);
    const includeUnavailable = query.includeUnavailable !== false;
    const scored = [
      ...(query.kind === 'skills' ? [] : this.registry.cards(this.context, includeUnavailable)),
      ...(query.kind === 'tools'
        ? []
        : this.registry.host.current.skills
            .filter((skill) => skill.enabled)
            .map((skill) => ({ ...skill, namespace: 'skills', available: true as const }))),
    ]
      .filter(
        (card) =>
          (!query.namespace || card.namespace === query.namespace) &&
          (!query.ids || query.ids.includes(card.id)),
      )
      .map((card) => {
        const tokens = tokensFor(card);
        return { card, score: matchScore(words, tokens) };
      });
    const hasMatches = words.size > 0 && !query.ids?.length && scored.some(({ score }) => score > 0);
    const cards = scored
      .filter(({ card, score }) =>
        hasMatches
          ? score > 0
          : !words.size || Boolean(query.ids?.length) || score > 0 || card.available === true,
      )
      .sort(
        (first, second) =>
          (hasMatches
            ? second.score - first.score ||
              Number(second.card.available !== false) - Number(first.card.available !== false)
            : Number(second.card.available !== false) - Number(first.card.available !== false) ||
              second.score - first.score) ||
          first.card.id.localeCompare(second.card.id),
      );
    const pageSize = query.query.trim() ? 12 : 10;
    const offset = query.offset ?? 0;
    const page = cards.slice(offset, offset + pageSize);
    const items = await Promise.all(
      page.map(async ({ card }) => {
        const descriptor = this.registry.get(card.id);
        if (card.available === false) return card;
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
        if (isNew && (descriptor || card.namespace === 'skills')) this.progress++;
        return card;
      }),
    );
    const value = {
      items: items.filter(Boolean),
      ...(cards.length > offset + pageSize && { nextOffset: offset + pageSize }),
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
    const page = JSON.stringify([this.registry.host.current.revision, key, resourceId, offset]);
    const cached = this.skillPages.get(page);
    if (cached)
      return { skill, alreadyLoaded: true, resources: cached.resources, nextOffset: cached.nextOffset };
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
    this.skillPages.set(page, content);
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
