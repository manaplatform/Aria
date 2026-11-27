import { createHash } from 'node:crypto';
import {
  defaultMemorySettings,
  containsSecret,
  communicationCandidatesSchema,
  communicationDimension,
  memoryCandidates,
  memoryOperations,
  type ChatConversation,
  type ChatMessage,
  type ChatEvent,
  type CapabilityHostRequest,
  type MemoryContextHint,
  type MemoryInput,
  type MemoryRecord,
  type MemorySearch,
  type MemorySettings,
  type MemoryScope,
  type MemorySource,
  type MemoryJobSource,
  type MemoryStatus,
  type RuntimeRegistry,
  type RuntimeResult,
} from '@aria/shared';
import { RuntimeError } from '../runtime/store';
import { embeddingRevision, type LocalEmbeddings } from '../runtime/embeddings';
import { RemoteEmbeddings } from '../runtime/remote-embeddings';
import { MemoryClient } from './client';
import type { MemoryAccess, MemoryIntake } from './store';

type Request = Extract<CapabilityHostRequest, { type: 'runtime' }>;
type Disposition = 'recall' | 'write' | 'transfer';
interface ManagedTurn {
  conversation: ChatConversation;
  user: ChatMessage;
  requestId: string;
  assistantId: string;
  epoch: number;
  started: number;
  learning: boolean;
  recalled?: boolean;
  consent?: Promise<boolean>;
  references?: Set<string>;
}
type EmbeddingBackend = {
  identity: string;
  remote?: RemoteEmbeddings;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
};

const blocked = () =>
  new RuntimeError('PERMISSION_DENIED', 'Memory is unavailable for this turn or scope.');
const simplified = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const maxOutbox = 192;

function writeDetails(value: MemoryInput, scope?: MemoryScope) {
  const entities = value.entities?.map(({ name, kind, qualifier, aliases }) =>
    [name, kind, qualifier, aliases?.join(', ')].filter(Boolean).join(' · '),
  );
  return [
    value.content,
    scope && `Scope: ${scope.kind === 'profile' ? scope.kind : `${scope.kind} (${scope.id})`}`,
    `Category: ${value.category}`,
    value.factKey && `Fact key: ${value.factKey}`,
    value.taskState && `Task state: ${value.taskState}`,
    value.dependsOn?.length && `Task dependencies: ${value.dependsOn.join(', ')}`,
    value.expiresAt && `Expires: ${new Date(value.expiresAt).toISOString()}`,
    entities?.length && `Entities: ${entities.join(' / ')}`,
    value.relationships?.length &&
      `Relationships: ${value.relationships
        .map(({ from, to, relation }) => `${from + 1} → ${relation} → ${to + 1}`)
        .join(' / ')}`,
    value.importance !== undefined && `Importance: ${value.importance}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export class DesktopMemory {
  readonly client: MemoryClient;
  settings = defaultMemorySettings;
  private epoch = 0;
  private generation = 0;
  cutoff = 0;
  private ready = false;
  private processing = false;
  private configuring = false;
  private nextRetry = 0;
  private accepting = true;
  private readonly turns = new Map<string, ManagedTurn>();
  private readonly exposed = new Map<string, { conversation: string; ids: string[] }>();
  private revocations = new AbortController();
  private readonly completed = new Map<string, MemoryIntake>();
  private readonly queryVectors = new Map<string, number[]>();
  private readonly timer: NodeJS.Timeout;
  private embeddingsInFlight = 0;
  private embeddingRequests = 0;
  private embeddingMs = 0;
  private extractionBatches = 0;
  private extractionMs = 0;
  private embeddingHealth?: MemoryStatus['embedding'];
  private verifiedRemote?: string;

  constructor(
    directory: string,
    private readonly localEmbeddings: LocalEmbeddings,
    private readonly registry: () => Promise<RuntimeRegistry>,
    private readonly approve: (
      kind: Disposition,
      title: string,
      detail: string,
      signal: AbortSignal,
    ) => Promise<boolean>,
    private readonly cancel: (request: string) => void,
    private readonly conversations: (id: string) => ChatConversation | undefined,
    private readonly context: (id: string) => unknown,
    private readonly projectTasks: (project: string) => unknown[],
    private readonly clearContext: () => void,
    private readonly purgeOutbox: () => Promise<void>,
    private readonly providerIdentity: () => string | undefined = () => undefined,
    diagnostic?: (event: string, detail?: { method?: string; durationMs?: number }) => void,
    private readonly learning = () => true,
  ) {
    this.client = new MemoryClient(directory, diagnostic);
    this.timer = setInterval(() => void this.tick(), 4000);
    this.timer.unref();
  }

  async start() {
    await this.reload().catch(() => undefined);
  }

  private async reload() {
    const status = await this.client.call('status');
    this.ready = true;
    this.settings = status.settings;
    if (this.epoch && status.epoch !== this.epoch) this.invalidate();
    this.epoch = status.epoch;
    this.cutoff = status.cutoff;
    return status;
  }

  private invalidate(except?: string) {
    this.generation++;
    this.revocations.abort();
    this.revocations = new AbortController();
    this.exposed.clear();
    this.clearContext();
    this.queryVectors.clear();
    this.completed.clear();
    for (const [request, turn] of this.turns)
      if (request !== except && turn.recalled) this.cancel(request);
  }

  hasStandingRecallConsent() {
    const key = this.providerIdentity();
    return Boolean(
      this.settings.enabled &&
      key &&
      this.settings.recallConsent?.providerKey === key,
    );
  }

  async selectiveContext(
    conversation: ChatConversation,
    query: string,
    assistantId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<MemoryContextHint[]> {
    if (
      !this.ready ||
      !this.settings.enabled ||
      conversation.temporary ||
      !this.hasStandingRecallConsent() ||
      !query.trim() ||
      containsSecret(query)
    )
      return [];
    try {
      const deadline = signal
        ? AbortSignal.any([signal, this.revocations.signal, AbortSignal.timeout(150)])
        : AbortSignal.any([this.revocations.signal, AbortSignal.timeout(150)]);
      const access: MemoryAccess = {
        conversationId: conversation.id,
        projectId: conversation.projectId,
        communication: this.learning(),
      };
      const result = await Promise.race([
        this.client.call('search', access, { query: query.slice(0, 300), limit: 4 }),
        new Promise<never>((_, reject) => {
          const abort = () => reject(deadline.reason);
          if (deadline.aborted) abort();
          else deadline.addEventListener('abort', abort, { once: true });
        }),
      ]);
      const hints: MemoryContextHint[] = [];
      let total = 0;
      const turn = this.turns.get(requestId);
      for (const record of result.records) {
        if (containsSecret(record.value.content)) continue;
        const content = record.value.content.slice(0, 240);
        if (total + content.length > 1000) break;
        total += content.length;
        hints.push({
          id: record.id,
          scope: record.scope.kind,
          category: record.value.category,
          content,
          confirmation: record.confirmation,
          communication: communicationDimension(record.value.factKey),
          observedAt: record.observedAt,
        });
        if (turn && turn.assistantId === assistantId) {
          turn.references ??= new Set();
          if (turn.references.size < 24) turn.references.add(record.id);
        }
      }
      if (hints.length && turn && turn.assistantId === assistantId) turn.recalled = true;
      return hints;
    } catch {
      return [];
    }
  }

  admit(conversation: ChatConversation, user: ChatMessage, assistant: ChatMessage) {
    const enabled =
      this.ready &&
      this.accepting &&
      !this.configuring &&
      this.settings.enabled &&
      !conversation.temporary;
    const suggestions = this.settings.suggestions;
    if (enabled) {
      this.turns.set(assistant.requestId, {
        conversation,
        user,
        requestId: assistant.requestId,
        assistantId: assistant.id,
        epoch: this.epoch,
        started: Date.now() + 1,
        learning: this.learning(),
      });
    }
    return { enabled, suggestions, ...(conversation.temporary && { temporary: true }) };
  }

  event(event: ChatEvent) {
    if (event.type !== 'completed' && event.type !== 'stopped' && event.type !== 'failed') return;
    const turn = this.turns.get(event.requestId);
    this.turns.delete(event.requestId);
    const references = [...(turn?.references ?? [])].slice(0, 24);
    if (turn && event.type === 'completed' && references.length) {
      this.exposed.set(event.assistantMessageId, {
        conversation: event.conversationId,
        ids: references,
      });
      if (this.exposed.size > 128) this.exposed.delete(this.exposed.keys().next().value!);
    }
    if (
      !turn ||
      event.type !== 'completed' ||
      (!event.memoryCandidates?.length && !event.communicationCandidates?.length) ||
      event.partial ||
      turn.epoch !== this.epoch ||
      event.conversationId !== turn.conversation.id ||
      event.assistantMessageId !== turn.assistantId
    )
      return references;
    const parsed = memoryCandidates.safeParse(event.memoryCandidates ?? []);
    if (!parsed.success) return references;
    const user = simplified(turn.user.content);
    const proposed = communicationCandidatesSchema.safeParse(event.communicationCandidates ?? []);
    const communication = turn.learning && this.learning() && proposed.success
      ? proposed.data.filter(({ quote }) => turn.user.content.includes(quote) && !containsSecret(quote))
      : [];
    // Automatic proposals are extractive and bound to the newest saved user turn.
    const candidates = parsed.data.filter((item) => {
      const quote = simplified(item.content);
      return (
        quote.length >= 12 &&
        user.includes(quote) &&
        !containsSecret(JSON.stringify(item)) &&
        !item.factKey?.startsWith('aria.communication.') &&
        !communication.some(({ quote: source }) => quote.includes(simplified(source))) &&
        (!item.factKey || user.toLowerCase().includes(simplified(item.factKey).toLowerCase())) &&
        !item.dependsOn?.length &&
        !item.relationships?.length &&
        (item.entities ?? []).every(
          ({ name, id, aliases, qualifier }) =>
            !id &&
            [name, ...(aliases ?? []), ...(qualifier ? [qualifier] : [])].every((value) =>
              user.toLowerCase().includes(simplified(value).toLowerCase()),
            ),
        )
      );
    });
    if ((!candidates.length && !communication.length) || this.completed.size >= maxOutbox) return references;
    this.completed.set(event.assistantMessageId, {
      id: fingerprint(
        JSON.stringify([event.conversationId, turn.user.id, event.assistantMessageId]),
      ),
      epoch: turn.epoch,
      scope: turn.conversation.projectId
        ? { kind: 'project', id: turn.conversation.projectId }
        : { kind: 'profile' },
      observedAt: Date.parse(turn.user.createdAt) || turn.started,
      source: { conversationId: turn.conversation.id, messageId: turn.user.id },
      candidates,
      ...(communication.length && { communication }),
    });
    return references;
  }

  canInspect(conversation: string, record: string, assistant?: string) {
    return assistant
      ? this.exposed.get(assistant)?.conversation === conversation &&
          this.exposed.get(assistant)?.ids.includes(record)
      : [...this.exposed.values()].some(
          ({ conversation: owner, ids }) => owner === conversation && ids.includes(record),
        );
  }

  outbox(previous: MemoryIntake[], messages: ChatMessage[], conversations: ChatConversation[]) {
    if (!this.settings.enabled || (!this.completed.size && !previous.length)) return [];
    const saved = new Map(messages.map((item) => [item.id, item]));
    const available = new Map(conversations.map((item) => [item.id, item]));
    const pending = previous.filter(
      (event) =>
        this.settings.enabled &&
        event.epoch === this.epoch &&
        available.has(event.source.conversationId) &&
        saved.has(event.source.messageId),
    );
    for (const [id, event] of this.completed) {
      if (pending.length >= maxOutbox) break;
      const reply = saved.get(id);
      const owner = available.get(event.source.conversationId);
      if (
        reply?.status === 'completed' &&
        !reply.partial &&
        reply.conversationId === event.source.conversationId &&
        owner &&
        !owner.temporary &&
        saved.has(event.source.messageId)
      )
        pending.push(event);
    }
    return [...new Map(pending.map((event) => [event.id, event])).values()];
  }

  async communicationPreferences() {
    const result = await this.client.call('communicationPreferences');
    return { ...result, proposals: result.proposals.filter(({ source }) => Boolean(this.conversations(source.conversationId))) };
  }

  async reviewCommunicationPreference(id: string, accept: boolean) {
    const { proposals } = await this.communicationPreferences();
    if (!proposals.some((proposal) => proposal.id === id) || (accept && (!this.settings.enabled || !this.learning())))
      throw new Error('This communication preference is unavailable.');
    await this.client.call('reviewCommunicationPreference', id, accept, this.epoch);
  }

  async ingest(events: MemoryIntake[]) {
    if (!events.length) return [];
    const admitted = this.learning() ? events : events.map((event) => ({ ...event, communication: undefined }));
    const accepted = await this.client.call('enqueue', admitted);
    for (const [id, event] of this.completed)
      if (accepted.includes(event.id)) this.completed.delete(id);
    return accepted;
  }

  private async tick() {
    if (
      this.processing ||
      !this.accepting ||
      this.configuring ||
      (!this.ready && Date.now() < this.nextRetry) ||
      (this.ready && !this.settings.enabled)
    )
      return;
    this.processing = true;
    try {
      if (!this.ready) await this.reload();
      if (this.settings.enabled) {
        const start = performance.now();
        if (await this.client.call('process')) {
          this.extractionBatches++;
          this.extractionMs += performance.now() - start;
        }
        await this.client.call('maintain');
        const options = this.settings.embedding;
        if (
          options.mode === 'local' &&
          !this.embeddingsInFlight &&
          (await this.localEmbeddings.available())
        ) {
          const generation = this.generation;
          const backend = await this.backend();
          if (generation === this.generation)
            await this.index(backend, { management: true }, {}, AbortSignal.timeout(5000));
        }
      }
      await this.reload();
    } catch {
      this.nextRetry = Date.now() + 15_000;
      await this.reload().catch(() => {
        this.ready = false;
      });
    } finally {
      this.processing = false;
    }
  }

  async diagnosticSnapshot() {
    const storage = await this.client.call('diagnostics');
    return {
      ...storage,
      embeddingRequests: this.embeddingRequests,
      embeddingMs: this.embeddingMs,
      extractionBatches: this.extractionBatches,
      extractionMs: this.extractionMs,
    };
  }

  async status(): Promise<MemoryStatus> {
    try {
      const status = await this.reload();
      let embedding: MemoryStatus['embedding'] = 'lexical';
      if (status.settings.embedding.mode === 'local')
        embedding =
          this.embeddingHealth ??
          ((await this.localEmbeddings.available()) ? 'ready' : 'unavailable');
      if (status.settings.embedding.mode === 'remote') {
        try {
          await this.backend();
          embedding = this.embeddingHealth ?? 'approval-required';
        } catch {
          embedding = 'unavailable';
        }
      }
      return {
        settings: status.settings,
        state: 'ready',
        embedding,
        records: status.records,
        pending: status.pending,
        failures: status.failures,
      };
    } catch {
      this.ready = false;
      return {
        settings: this.settings,
        state: 'unavailable',
        embedding: 'unavailable',
        records: 0,
        pending: 0,
        failures: 0,
      };
    }
  }

  async saveSettings(settings: MemorySettings) {
    if (this.configuring) throw new Error('Wait for Memory settings to finish saving.');
    this.configuring = true;
    try {
      const normalized: MemorySettings = settings.enabled
        ? settings
        : { ...settings, recallConsent: undefined };
      if (
        normalized.embedding.mode === 'remote' &&
        JSON.stringify(normalized.embedding) !== JSON.stringify(this.settings.embedding)
      ) {
        const remote = RemoteEmbeddings.resolve(await this.registry(), normalized.embedding);
        await this.verifyRemote(remote, AbortSignal.timeout(6000));
      }
      this.invalidate();
      this.embeddingHealth = undefined;
      const saved = await this.client.call('saveSettings', normalized);
      this.settings = saved.settings;
      this.epoch = saved.epoch;
      this.cutoff = saved.cutoff;
      this.ready = true;
      await this.purgeOutbox();
      return this.status();
    } finally {
      this.configuring = false;
    }
  }

  private async verifyRemote(backend: RemoteEmbeddings, signal: AbortSignal) {
    if (this.verifiedRemote === backend.revision) return;
    await backend.embed(['Synthetic Aria memory embedding verification.'], signal);
    signal.throwIfAborted();
    this.verifiedRemote = backend.revision;
  }

  private async backend(): Promise<EmbeddingBackend> {
    const settings = this.settings.embedding;
    if (settings.mode === 'local' && (await this.localEmbeddings.available()))
      return {
        identity: embeddingRevision,
        embed: (texts, signal) => this.localEmbeddings.embed(texts, signal),
      };
    if (settings.mode === 'remote') {
      const registry = await this.registry();
      if (registry.spendingLimitUsdMicros !== undefined)
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'Memory embeddings have no verified rate for this spending cap.',
        );
      const remote = RemoteEmbeddings.resolve(registry, settings);
      return {
        identity: remote.revision,
        remote,
        embed: (texts, signal) => remote.embed(texts, signal),
      };
    }
    throw new RuntimeError(
      'CAPABILITY_UNAVAILABLE',
      'Choose an available Memory embedding backend or request lexical search.',
    );
  }

  private async embed(backend: EmbeddingBackend, texts: string[], signal: AbortSignal) {
    const start = performance.now();
    this.embeddingRequests++;
    try {
      return await backend.embed(texts, signal);
    } finally {
      this.embeddingMs += performance.now() - start;
    }
  }

  private async index(
    backend: EmbeddingBackend,
    access: MemoryAccess,
    query: MemorySearch,
    signal: AbortSignal,
  ) {
    const generation = this.generation;
    if (this.embeddingsInFlight >= 2)
      throw new RuntimeError('BUDGET_EXCEEDED', 'Memory embeddings are busy.');
    this.embeddingsInFlight++;
    try {
      const batch = await this.client.call('embeddingBatch', access, query, backend.identity, 8);
      if (!batch.length) return 0;
      signal.throwIfAborted();
      if (generation !== this.generation) throw blocked();
      const vectors = await this.embed(
        backend,
        batch.map(({ content }) => content),
        signal,
      );
      signal.throwIfAborted();
      if (generation !== this.generation) throw blocked();
      await this.client.call(
        'saveVectors',
        backend.identity,
        this.epoch,
        batch.map(({ checksum }, index) => ({ checksum, embedding: vectors[index] })),
      );
      return batch.length;
    } finally {
      this.embeddingsInFlight--;
    }
  }

  async search(
    query: MemorySearch,
    access: MemoryAccess = { management: true },
    signal = AbortSignal.timeout(8000),
  ) {
    if (query.from !== undefined && query.to !== undefined && query.from > query.to)
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'The start of the date range must precede its end.',
      );
    if (query.match !== 'hybrid' && query.match !== 'semantic')
      return this.client.call('search', access, query);
    if (!query.query)
      throw new RuntimeError('INVALID_ARGUMENT', 'Semantic memory search requires query text.');
    const generation = this.generation;
    signal = AbortSignal.any([signal, this.revocations.signal]);
    const backend = await this.backend();
    try {
      if (backend.remote) {
        await this.verifyRemote(backend.remote, signal);
        if (
          containsSecret(query.query) ||
          !(await this.approve(
            'transfer',
            'Send memory text to the embedding provider?',
            `Allow Aria to send this search query and up to eight eligible memory snippets to ${backend.remote.origin} for this search.`,
            signal,
          ))
        )
          throw new RuntimeError('PERMISSION_DENIED', 'Memory embedding transfer was declined.');
      }
      signal.throwIfAborted();
      if (generation !== this.generation) throw blocked();
      const key = fingerprint(JSON.stringify([generation, backend.identity, access, query.query]));
      let vector = this.queryVectors.get(key);
      if (!vector) {
        [vector] = await this.embed(backend, [query.query], signal);
        signal.throwIfAborted();
        if (generation !== this.generation) throw blocked();
        this.queryVectors.set(key, vector);
        if (this.queryVectors.size > 48)
          this.queryVectors.delete(this.queryVectors.keys().next().value!);
      }
      const identity = backend.remote ? `${backend.identity}:${vector.length}` : backend.identity;
      const indexed = await this.index({ ...backend, identity }, access, query, signal);
      const dense = await this.client.call('dense', access, query, identity, vector, 7000);
      signal.throwIfAborted();
      if (generation !== this.generation) throw blocked();
      this.embeddingHealth = indexed === 8 ? 'indexing' : 'ready';
      return this.client.call('search', access, query, dense);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('The semantic memory scan exceeded'))
        throw new RuntimeError('BUDGET_EXCEEDED', error.message);
      if (
        !signal.aborted &&
        generation === this.generation &&
        !(error instanceof RuntimeError && error.code === 'PERMISSION_DENIED')
      )
        this.embeddingHealth = 'unavailable';
      throw error;
    }
  }

  private available(turn: ManagedTurn, generation: number, signal: AbortSignal) {
    signal.throwIfAborted();
    const current = this.conversations(turn.conversation.id);
    if (
      !current ||
      current.temporary ||
      current.projectId !== turn.conversation.projectId ||
      !this.ready ||
      this.configuring ||
      generation !== this.generation ||
      !this.settings.enabled ||
      turn.epoch !== this.epoch
    )
      throw blocked();
  }

  async proactiveRecall(operation: 'memory.search' | 'memory.read', input: unknown, signal: AbortSignal): Promise<RuntimeResult> {
    const generation = this.generation;
    signal = AbortSignal.any([signal, this.revocations.signal]);
    if (!this.hasStandingRecallConsent() || !this.ready) throw blocked();
    let records: MemoryRecord[];
    if (operation === 'memory.search') {
      const query = memoryOperations[operation].parse(input);
      records = (await this.search({ ...query, match: 'terms', scope: 'profile', historical: false }, {}, signal)).records.slice(0, 5);
    } else {
      const { id } = memoryOperations[operation].parse(input);
      const record = await this.client.call('read', id, {}, false);
      records = record ? [record] : [];
    }
    signal.throwIfAborted();
    if (generation !== this.generation || !this.hasStandingRecallConsent()) throw blocked();
    return { data: { records: records.map(({ id, revision, value, observedAt, confirmation }) => ({
      id, revision, content: value.content.slice(0, 520), category: value.category, observedAt, confirmation,
    })) }, privateContent: records.length > 0 };
  }

  async dispatch(request: Request, signal: AbortSignal): Promise<RuntimeResult> {
    const turn = this.turns.get(request.requestId);
    signal = AbortSignal.any([signal, this.revocations.signal]);
    if (
      !turn ||
      request.programId ||
      turn.assistantId !== request.assistantMessageId ||
      turn.conversation.id !== request.conversationId
    )
      throw blocked();
    const generation = this.generation;
    this.available(turn, generation, signal);
    const access = {
      conversationId: request.conversationId,
      projectId: turn.conversation.projectId,
      communication: turn.learning && this.learning(),
    };
    const source = { conversationId: request.conversationId, messageId: turn.user.id };
    let data: Record<string, unknown>;
    switch (request.operation) {
      case 'memory.get_context': {
        memoryOperations[request.operation].parse(request.input);
        return {
          data: {
            context: this.context(request.conversationId),
            now: Date.now(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
          privateContent: true,
        };
      }
      case 'memory.remember': {
        const input = memoryOperations[request.operation].parse(request.input);
        if (input.value.factKey?.startsWith('aria.communication.')) throw blocked();
        if (input.value.category === 'project' && !access.projectId) throw blocked();
        const kind = input.scope ?? (access.projectId ? 'project' : 'profile');
        const scope: MemoryScope =
          kind === 'conversation'
            ? { kind, id: access.conversationId }
            : kind === 'project' && access.projectId
              ? { kind, id: access.projectId }
              : { kind: 'profile' };
        if (
          kind !== scope.kind ||
          (access.projectId && kind === 'profile' && input.value.category !== 'preference')
        )
          throw blocked();
        await this.confirmWrite(
          'Remember this information?',
          writeDetails(input.value, scope),
          turn,
          generation,
          signal,
        );
        const record = await this.client.call('remember', scope, input.value, source, turn.epoch);
        return {
          data: { saved: { id: record.id, revision: record.revision } },
          privateContent: true,
        };
      }
      case 'memory.update': {
        const { id, revision, value } = memoryOperations[request.operation].parse(request.input);
        await this.confirmWrite(
          'Correct this memory?',
          writeDetails(value),
          turn,
          generation,
          signal,
        );
        const record = await this.edit({ id, revision, value }, access, source, turn);
        return {
          data: { saved: { id: record.id, revision: record.revision } },
          privateContent: true,
        };
      }
      case 'memory.forget': {
        const { id, revision } = memoryOperations[request.operation].parse(request.input);
        const record = await this.client.call('read', id, access, true);
        if (!record || record.revision !== revision) throw blocked();
        await this.confirmWrite(
          'Forget this memory?',
          record.value.content,
          turn,
          generation,
          signal,
        );
        await this.forget({ id, revision }, access, turn);
        return { data: { deleted: id }, privateContent: true };
      }
      default: {
        turn.recalled = true;
        if (this.hasStandingRecallConsent()) {
          this.available(turn, generation, signal);
          break;
        }
        turn.consent ??= this.approve(
          'recall',
          'Use saved memories in this reply?',
          `Allow relevant memory snippets to be sent to ${new URL(request.primary.endpoint).origin} using ${request.primary.model} for this reply.`,
          signal,
        );
        if (!(await turn.consent)) throw blocked();
        this.available(turn, generation, signal);
      }
    }
    switch (request.operation) {
      case 'memory.read': {
        const { id, historical } = memoryOperations[request.operation].parse(request.input);
        data = { record: (await this.client.call('read', id, access, historical)) ?? null };
        break;
      }
      case 'memory.search':
        data = {
          ...(await this.search(
            memoryOperations[request.operation].parse(request.input),
            access,
            signal,
          )),
        };
        break;
      case 'memory.get_project_context':
        if (!access.projectId) throw blocked();
        data = {
          ...(await this.search(
            { ...memoryOperations[request.operation].parse(request.input), scope: 'project' },
            access,
            signal,
          )),
        };
        break;
      case 'memory.get_pending_tasks':
        data = {
          ...(await this.search(
            {
              ...memoryOperations[request.operation].parse(request.input),
              category: 'task',
              pending: true,
            },
            access,
            signal,
          )),
        };
        if (access.projectId) data.projectTasks = this.projectTasks(access.projectId);
        break;
      case 'memory.get_timeline':
        data = {
          ...(await this.search(
            { ...memoryOperations[request.operation].parse(request.input), historical: true },
            access,
            signal,
          )),
        };
        break;
      case 'memory.resolve_entity': {
        const { name, kind } = memoryOperations[request.operation].parse(request.input);
        data = await this.client.call('resolve', access, name, kind);
        break;
      }
      default:
        throw blocked();
    }
    this.available(turn, generation, signal);
    const records = (data.records ?? (data.record ? [data.record] : [])) as MemoryRecord[];
    const hasEntities = Array.isArray(data.matches) && data.matches.length > 0;
    const hasTasks = Array.isArray(data.projectTasks) && data.projectTasks.length > 0;
    turn.references ??= new Set();
    for (const record of records) if (turn.references.size < 24) turn.references.add(record.id);
    if (data.records)
      data.records = records.map((record) => ({
        id: record.id,
        revision: record.revision,
        scope: record.scope,
        ...(record.value.factKey?.startsWith('aria.communication.') && { communicationPreference: communicationDimension(record.value.factKey) }),
        category: record.value.category,
        content: record.value.content.slice(0, 520),
        taskState: record.value.taskState,
        state: record.state,
        observedAt: record.observedAt,
        confirmation: record.confirmation,
        confidence: record.confidence,
        sources: record.sources.slice(-3),
      }));
    return { data, privateContent: records.length > 0 || hasEntities || hasTasks };
  }

  private async confirmWrite(
    title: string,
    value: string,
    turn: ManagedTurn,
    generation: number,
    signal: AbortSignal,
  ) {
    if (containsSecret(value))
      throw new RuntimeError('INVALID_ARGUMENT', 'Memory cannot contain authentication secrets.');
    if (!(await this.approve('write', title, value, signal))) throw blocked();
    this.available(turn, generation, signal);
  }

  async rememberJob(source: MemoryJobSource, text: string, observedAt: number, authorize: () => boolean) {
    const content = text.trim();
    if (!this.ready || !this.settings.enabled) throw new Error('Enable persistent memory to save a verified finding.');
    if (!content || content.length > 1400 || containsSecret(content))
      throw new Error('Choose a finding of up to 1,400 characters without authentication secrets.');
    const signal = AbortSignal.any([this.revocations.signal, AbortSignal.timeout(65_000)]);
    const epoch = this.epoch;
    if (!await this.approve('write', 'Save this verified finding?', content, signal) || !authorize())
      throw new Error('The memory save was declined or its source changed.');
    signal.throwIfAborted();
    return this.client.call('remember', { kind: 'profile' }, { content, category: 'episode' }, source, epoch, observedAt);
  }

  async rememberSource(
    conversation: ChatConversation,
    message: ChatMessage,
    category: MemoryRecord['value']['category'],
  ) {
    if (!this.ready || !this.settings.enabled || conversation.temporary)
      throw new Error('Enable persistent memory to save a message.');
    const content = message.content.trim();
    if (!content || content.length > 1400 || containsSecret(content))
      throw new Error('Choose a message of up to 1,400 characters without authentication secrets.');
    const scope: MemoryScope = conversation.projectId
      ? { kind: 'project', id: conversation.projectId }
      : { kind: 'profile' };
    const signal = AbortSignal.any([this.revocations.signal, AbortSignal.timeout(65000)]);
    const epoch = this.epoch;
    if (
      !(await this.approve(
        'write',
        'Save this message as a memory?',
        `${content}\n\nScope: ${scope.kind} · ${category}`,
        signal,
      )) ||
      this.conversations(conversation.id)?.projectId !== conversation.projectId
    )
      throw new Error('The memory save was declined or the conversation changed.');
    signal.throwIfAborted();
    return this.client.call(
      'remember',
      scope,
      {
        category,
        content,
        ...(category === 'task' && { taskState: 'pending' as const }),
      },
      { conversationId: conversation.id, messageId: message.id },
      epoch,
      Date.parse(message.createdAt),
    );
  }

  async edit(
    input: Pick<MemoryRecord, 'id' | 'revision' | 'value'>,
    access: MemoryAccess = { management: true },
    source?: MemorySource,
    turn?: ManagedTurn,
  ) {
    const result = await this.client.call(
      'edit',
      input.id,
      input.revision,
      input.value,
      access,
      source,
      turn?.epoch,
    );
    const state = await this.client.call('status');
    this.epoch = state.epoch;
    this.cutoff = state.cutoff;
    this.invalidate(turn?.requestId);
    await this.purgeOutbox();
    return result;
  }

  async forget(
    input: Pick<MemoryRecord, 'id' | 'revision'>,
    access: MemoryAccess = { management: true },
    turn?: ManagedTurn,
  ) {
    await this.client.call('forget', input.id, input.revision, access, turn?.epoch);
    const state = await this.client.call('status');
    this.epoch = state.epoch;
    this.cutoff = state.cutoff;
    this.invalidate(turn?.requestId);
    await this.purgeOutbox();
  }

  async clear(filter: { category?: MemoryRecord['value']['category']; projectId?: string }) {
    const count = await this.client.call('clear', filter);
    await this.reload();
    await this.purgeOutbox();
    return count;
  }

  async removeConversation(conversationId: string) {
    if (!this.settings.enabled && !this.ready) return;
    await this.client.call('removeConversation', conversationId);
    await this.reload();
  }

  async close() {
    this.accepting = false;
    clearInterval(this.timer);
    await this.client.close();
  }
}
