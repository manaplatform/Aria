import { createHash, randomUUID } from 'node:crypto';
import type { UtilityProcess } from 'electron';
import {
  conductorLimits,
  diagnosticEventSchema,
  type DiagnosticEvent,
  type DiagnosticConfig,
  proactiveRequestSchema,
  proactiveRunEnvelope,
  type ProactiveRequest,
  emptyRegistryPolicy,
  type ArtifactReference,
  type BrowserRequest,
  type RuntimeWeb,
  type ChatEvent,
  type ChatRequest,
  type ChatServiceStatus,
  type MediaAsset,
  type RuntimeRegistry,
  type CapabilityHostRequest,
  type ToolPolicy,
  type LoopCommand,
} from '@aria/shared';
import { z } from 'zod';
import WebSocket from 'ws';
import { managedChatRequestSchema, readChatEvents } from './chat-protocol';
import { ProviderConfigurationError, type ProviderStorage } from './provider-storage';
import type { MediaStorage } from './media-storage';

import type { BrowserBridgeSession } from './browser/bridge';

interface BrowserIntegration {
  runtime(): Promise<RuntimeWeb>;
  revision(): string;
  open(authorize: (request: BrowserRequest) => AbortSignal | undefined): BrowserBridgeSession;
}

interface CapabilityIntegration {
  policy(registry: RuntimeRegistry): ToolPolicy;
  artifact?(id: string, conversation: string, request: string): Promise<MediaAsset>;
  adoptArtifact?(
    asset: MediaAsset,
    conversation: string,
    request: string,
    execution: { stepId: string; sessionId?: string },
    signal: AbortSignal,
  ): Promise<void>;
  release?(request: string): void;
  cancelExecution?(request: string): void;
  availableAssets?(conversation: string): MediaAsset[];
  open(
    revision: string,
    authorize: (request: CapabilityHostRequest) => AbortSignal | undefined,
  ): Pick<BrowserBridgeSession, 'port' | 'close'>;
}

interface ActiveRequest {
  request: ChatRequest;
  proactive?: ProactiveRequest;
  controller: AbortController;
  stopped: boolean;
  privateRuntimeContent?: boolean;
  sequence: number;
  length: number;
  done: Promise<void>;
  emit: (event: ChatEvent) => void;
}
export class ChatService {
  onDiagnostic?: (event: DiagnosticEvent, temporary: boolean) => void;
  private diagnosticConfig?: DiagnosticConfig;
  configureDiagnostics(config: DiagnosticConfig) {
    this.diagnosticConfig = config;
    try { this.child?.postMessage({ type: 'diagnostic-config', config }); } catch { /* Service may be restarting. */ }
  }
  private child?: UtilityProcess;
  private browserSession?: BrowserBridgeSession;
  private capabilitySession?: Pick<BrowserBridgeSession, 'port' | 'close'>;
  private url = '';
  private token = '';
  private generation = 0;
  private readonly newlyPublished = new Map<string, number>();
  private runtimePrimary?: { connectionId: string; model: string; endpoint: string };
  private runtimeProviderKey?: string;
  private starting?: Promise<void>;
  private requests = new Map<string, ActiveRequest>();
  private status: ChatServiceStatus = { state: 'starting', configured: false, model: '' };
  constructor(
    private readonly provider: ProviderStorage,
    private readonly launch: (env: NodeJS.ProcessEnv) => UtilityProcess,
    private readonly emitEvent: (event: ChatEvent) => void,
    private readonly emitStatus: (status: ChatServiceStatus) => void,
    private readonly assets?: MediaStorage,
    private readonly browser?: BrowserIntegration,
    private readonly capabilities?: CapabilityIntegration,
  ) {}
  getStatus(): ChatServiceStatus {
    return { ...this.status };
  }
  private setStatus(status: ChatServiceStatus) {
    this.status = status;
    this.emitStatus(this.getStatus());
  }
  assertConversationIdle(conversationId: string): void {
    if ([...this.requests.values()].some((r) => r.request.conversationId === conversationId))
      throw new Error('This conversation already has a response in progress.');
  }
  assertExecutionCapacity(conversationId: string): void {
    if (this.requests.size >= conductorLimits.turns)
      throw new Error('Aria is handling too many turns. Stop a response or try again shortly.');
    this.assertConversationIdle(conversationId);
  }
  assertIdle(foregroundOnly = false): void {
    if ([...this.requests.values()].some((request) => !foregroundOnly || !request.proactive))
      throw new Error('Stop active responses before changing the connection.');
  }
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.boot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async boot(): Promise<void> {
    const generation = ++this.generation;
    this.setStatus({ state: 'starting', configured: false, model: '' });
    try {
      let registry: RuntimeRegistry;
      let configurationError: string | undefined;
      try {
        registry = await this.provider.resolve();
      } catch (error) {
        if (!(error instanceof ProviderConfigurationError)) throw error;
        registry = { ...emptyRegistryPolicy, revision: '', connections: [] };
        configurationError = error.message;
      }
      const runtimeConnection = registry.connections.find((item) =>
        registry.primary?.startsWith(`${item.id}:`),
      );
      this.runtimePrimary =
        runtimeConnection && registry.primary
          ? {
              connectionId: runtimeConnection.id,
              model: registry.primary.slice(runtimeConnection.id.length + 1),
              endpoint: runtimeConnection.baseUrl,
            }
          : undefined;
      this.runtimeProviderKey =
        runtimeConnection && this.runtimePrimary
          ? createHash('sha256')
              .update(JSON.stringify([this.runtimePrimary, runtimeConnection.apiKey]))
              .digest('hex')
          : undefined;
      const registryRevision = registry.revision;
      const web = await this.browser?.runtime();
      const tools = this.capabilities?.policy(registry);
      if (this.browser || tools)
        registry = {
          ...registry,
          revision: createHash('sha256')
            .update(JSON.stringify([registry.revision, this.browser?.revision(), tools?.revision]))
            .digest('hex'),
        };
      if (generation !== this.generation) return;
      this.token = randomUUID() + randomUUID();
      const env = { ...process.env };
      for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL', 'ARIA_SYSTEM_PROMPT'])
        delete env[key];
      const child = this.launch({ ...env, ARIA_MANAGED: '1', ARIA_INTERNAL_TOKEN: this.token });
      this.child = child;
      child.on('message', (message: unknown) => {
        if (generation !== this.generation || !message || typeof message !== 'object' ||
            !('type' in message) || message.type !== 'diagnostic' || !('entry' in message)) return;
        const parsed = diagnosticEventSchema.safeParse(message.entry);
        if (!parsed.success) return;
        const context = parsed.data.context;
        const turn = context.requestId && this.requests.get(context.requestId);
        if (!turn || turn.request.conversationId !== context.conversationId ||
            turn.request.execution?.executionId !== context.executionId ||
            turn.request.execution?.generation !== context.generation) return;
        this.onDiagnostic?.(parsed.data, turn.request.memory?.temporary === true);
      });
      const native = this.browser?.open((request) => {
        const turn = this.requests.get(request.requestId);
        if (
          generation === this.generation &&
          !turn?.stopped &&
          turn?.request.programPrivateHistory !== true &&
          turn?.request.conversationId === request.conversationId
        )
          return turn.controller.signal;
        return undefined;
      });
      this.browserSession = native;
      const capabilityPort =
        tools &&
        this.capabilities?.open(tools.revision, (request) => {
          if (generation !== this.generation) return;
          return this.activeTurn(request);
        });
      this.capabilitySession = capabilityPort;
      const transfer = [native?.port, capabilityPort?.port].filter((port) => port !== undefined);
      let sentConfiguration = false;
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Startup timed out.'));
        }, 15000);
        const ready = (message: unknown) => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            message.type === 'configure'
          ) {
            if (sentConfiguration) return;
            sentConfiguration = true;
            child.postMessage(
              {
                registry,
                ...(web && { web }),
                ...(tools && { tools }),
                browserGeneration: native?.generation,
              },
              transfer,
            );
            return;
          }
          const parsed = z
            .object({ type: z.literal('ready'), port: z.number().int().min(1).max(65535) })
            .safeParse(message);
          if (parsed.success) {
            cleanup();
            resolve(parsed.data.port);
          }
        };
        const exit = () => {
          cleanup();
          reject(new Error('Service exited during startup.'));
        };
        const cleanup = () => {
          clearTimeout(timer);
          child.removeListener('message', ready);
          child.removeListener('exit', exit);
        };
        child.on('message', ready);
        child.once('exit', exit);
      });
      if (generation !== this.generation) {
        child.kill();
        return;
      }
      this.url = `http://127.0.0.1:${port}`;
      if (this.diagnosticConfig) this.configureDiagnostics(this.diagnosticConfig);
      child.once('exit', () => {
        native?.close();
        capabilityPort?.close();
        if (generation !== this.generation) return;
        ++this.generation;
        this.child = undefined;
        this.url = '';
        this.requests.forEach((request) => request.controller.abort());
        this.setStatus({
          state: 'failed',
          configured: false,
          model: this.status.model,
          error: 'The chat service stopped. Restart it in Settings, then retry your response.',
        });
      });
      const response = await fetch(`${this.url}/chat/capabilities`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Service did not become ready.');
      const capabilities = z
        .object({
          configured: z.boolean(),
          model: z.string(),
          revision: z.string().optional(),
          voiceReady: z.boolean().optional(),
        })
        .parse(await response.json());
      if (generation === this.generation)
        this.setStatus({
          state: 'ready',
          ...capabilities,
          registryRevision,
          ...(configurationError ? { configured: false, error: configurationError } : {}),
        });
    } catch (error) {
      if (generation === this.generation) {
        this.browserSession?.close();
        this.capabilitySession?.close();
        this.child?.kill();
        this.url = '';
        this.setStatus({
          state: 'failed',
          configured: false,
          model: '',
          error:
            error instanceof ProviderConfigurationError
              ? error.message
              : 'The chat service could not start. Check your provider settings and restart the connection.',
        });
      }
    }
  }
  private headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` };
  }
  async http(route: string, init: RequestInit = {}): Promise<Response> {
    if (!this.url || this.status.state !== 'ready')
      throw new Error('Restart the service in Settings before trying again.');
    const response = await fetch(`${this.url}/${route}`, {
      ...init,
      redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, ...init.headers },
    });
    if (!response.ok) {
      let message = 'The request failed. Check the connection settings and try again.';
      try {
        const value = await response.json();
        if (typeof value.message === 'string' && value.message.length <= 2000)
          message = value.message;
      } catch {
        /* Never surface raw response bodies. */
      }
      throw new Error(message);
    }
    return response;
  }
  voiceSocket(): WebSocket {
    if (!this.url || this.status.state !== 'ready')
      throw new Error('Restart the service before starting voice.');
    return new WebSocket(`${this.url.replace('http:', 'ws:')}/voice`, {
      headers: { Authorization: `Bearer ${this.token}` },
      maxPayload: 300000,
      handshakeTimeout: 15000,
    });
  }
  private begin(input: ChatRequest, emit = this.emitEvent, proactive?: ProactiveRequest, signal?: AbortSignal): ActiveRequest {
    const request = proactive ? input : managedChatRequestSchema.parse(input);
    signal?.throwIfAborted();
    if (this.status.state !== 'ready' || !this.status.configured || !this.url)
      throw new Error('Configure your provider in Settings before sending a message.');
    if (request.expectedRevision && this.status.revision !== request.expectedRevision)
      throw new Error('The AI Models configuration changed. Send again to use current settings.');
    this.assertExecutionCapacity(request.conversationId);
    if (proactive && this.requests.size >= conductorLimits.turns - 1)
      throw new Error('The foreground turn reservation is in use.');
    if (this.requests.has(request.requestId))
      throw new Error('This conversation already has a response in progress.');
    const active: ActiveRequest = {
      request,
      proactive,
      controller: new AbortController(),
      stopped: false,
      sequence: 0,
      length: 0,
      done: Promise.resolve(),
      emit,
    };
    this.requests.set(request.requestId, active);
    const abort = () => active.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    active.done = this.consume(active).finally(() => signal?.removeEventListener('abort', abort));
    return active;
  }
  activeTurn(request: { requestId: string; conversationId: string; assistantMessageId?: string }) {
    const turn = this.requests.get(request.requestId);
    if (
      !turn ||
      turn.stopped ||
      turn.request.conversationId !== request.conversationId ||
      (request.assistantMessageId && turn.request.assistantMessageId !== request.assistantMessageId)
    )
      return;
    return turn.controller.signal;
  }
  executionIdentity() {
    return this.runtimeProviderKey;
  }
  runtimeIdentity() {
    if (this.runtimePrimary && this.runtimeProviderKey)
      return { ...this.runtimePrimary, key: this.runtimeProviderKey };
  }
  authorizeRuntime(request: Extract<CapabilityHostRequest, { type: 'runtime' }>) {
    const primary = this.runtimePrimary;
    if (
      !primary ||
      request.primary.connectionId !== primary.connectionId ||
      request.primary.model !== primary.model ||
      new URL(request.primary.endpoint).href.replace(/\/$/, '') !==
        new URL(primary.endpoint).href.replace(/\/$/, '')
    )
      return;
    return this.activeTurn(request);
  }
  assistantForTurn(requestId: string) {
    return this.requests.get(requestId)?.request.assistantMessageId;
  }
  executionForTurn(requestId: string) {
    const turn = this.requests.get(requestId);
    return turn?.stopped ? undefined : turn?.request.execution;
  }
  proactiveForTurn(id: string) { return this.requests.get(id)?.proactive; }
  temporaryForTurn(id: string) { return this.requests.get(id)?.request.memory?.temporary === true; }
  privateContextForTurn(id: string) {
    const turn = this.requests.get(id);
    return !turn || turn.privateRuntimeContent === true || turn.request.programPrivateHistory === true || turn.request.memory?.privateHistory === true;
  }
  markPrivateRuntimeContent(id: string) {
    const turn = this.requests.get(id);
    if (turn) turn.privateRuntimeContent = true;
  }

  async runProactive(input: ProactiveRequest, signal: AbortSignal, emit: (event: ChatEvent) => void) {
    const run = proactiveRequestSchema.parse(input);
    await this.begin(proactiveRunEnvelope(run), emit, run, signal).done;
  }

  async control(command: LoopCommand) {
    const turn = this.requests.get(command.requestId);
    if (!turn || !this.activeTurn(command) || command.executionId !== turn.request.execution?.executionId ||
        command.generation !== turn.request.execution.generation)
      throw new Error('This execution is no longer active.');
    const response = await this.http(`chat/${encodeURIComponent(command.requestId)}/control`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(command), signal: AbortSignal.timeout(5000),
    });
    return z.strictObject({ accepted: z.literal(true), applied: z.boolean() }).parse(await response.json()).applied;
  }
  submit(input: ChatRequest): void {
    this.begin(input);
  }
  recentlyPublished(id: string) {
    const now = Date.now();
    for (const [asset, expires] of this.newlyPublished) {
      if (expires <= now) this.newlyPublished.delete(asset);
    }
    return this.newlyPublished.has(id);
  }

  private async consume(active: ActiveRequest): Promise<void> {
    const { request, controller } = active;
    let terminal = false;
    let failure = 'The response was interrupted. Check the connection and send it again.';
    const artifacts = new Map<string, string>();
    try {
      if (request.attachmentIds?.length) await this.stage(request, controller.signal);
      const response = await this.http(active.proactive ? 'internal/proactive/stream' : 'chat/stream', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(active.proactive ?? {
          ...request,
          availableAssets: this.capabilities
            ?.availableAssets?.(request.conversationId)
            ?.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
        }),
        signal: controller.signal,
      });
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.startsWith('text/event-stream')
      )
        throw new Error('Chat request failed.');
      for await (const event of readChatEvents(response.body)) {
        if (
          event.requestId !== request.requestId ||
          event.conversationId !== request.conversationId ||
          event.assistantMessageId !== request.assistantMessageId ||
          event.executionId !== request.execution?.executionId ||
          event.generation !== request.execution?.generation
        )
          throw new Error('Mismatched stream.');
        if (event.sequence <= active.sequence) continue;
        if (event.sequence !== active.sequence + 1)
          throw new Error('Stream sequence was interrupted.');
        active.sequence = event.sequence;
        if (event.type === 'delta') {
          active.length += event.text.length;
          if (active.length > 100000) throw new Error('Response exceeded the local message limit.');
        }
        if (event.type === 'reset') active.length = 0;
        if (active.stopped) break;
        if (event.type === 'artifact') {
          const asset =
            event.artifact.storage === 'desktop'
              ? await this.capabilities?.artifact?.(
                  event.artifact.id,
                  request.conversationId,
                  request.requestId,
                )
              : await this.importArtifact(request.requestId, event.artifact, controller.signal);
          if (
            !asset ||
            asset.name !== event.artifact.name ||
            asset.mimeType !== event.artifact.mimeType ||
            asset.size !== event.artifact.size
          )
            throw new Error('The artifact does not match its verified storage record.');
          if (active.stopped) break;
          if (event.artifact.storage !== 'desktop' && event.artifact.executionId)
            await this.capabilities?.adoptArtifact?.(
              asset,
              request.conversationId,
              request.requestId,
              {
                stepId: event.artifact.executionId,
                sessionId: event.artifact.hostedExecution?.sessionId,
              },
              controller.signal,
            );
          if (active.stopped) break;
          if (!active.proactive) {
            this.recentlyPublished(asset.id);
            if (this.newlyPublished.size >= 128) {
              const oldest = this.newlyPublished.keys().next().value;
              if (oldest) this.newlyPublished.delete(oldest);
            }
            this.newlyPublished.set(asset.id, Date.now() + 30_000);
          }
          artifacts.set(event.artifact.id, asset.id);
          active.emit({
            type: 'asset',
            asset:
              event.artifact.storage === 'desktop' || event.artifact.executionId
                ? { ...asset, managed: true }
                : asset,
            requestId: event.requestId,
            conversationId: event.conversationId,
            assistantMessageId: event.assistantMessageId,
            sequence: event.sequence,
            executionId: event.executionId,
            generation: event.generation,
          });
        } else if (event.type === 'activity' && event.activity.resultId) {
          active.emit({
            ...event,
            activity: { ...event.activity, resultId: artifacts.get(event.activity.resultId) },
          });
        } else active.emit(event);
        if (['completed', 'failed', 'stopped'].includes(event.type)) {
          terminal = true;
          break;
        }
      }
    } catch (error) {
      if (error instanceof Error && !controller.signal.aborted)
        failure = error.message.slice(0, 2000);
    } finally {
      if (!terminal)
        active.emit({
          requestId: request.requestId,
          conversationId: request.conversationId,
          assistantMessageId: request.assistantMessageId,
          sequence: active.sequence + 1,
          executionId: request.execution?.executionId,
          generation: request.execution?.generation,
          ...(active.stopped
            ? { type: 'stopped' as const }
            : {
                type: 'failed' as const,
                error: failure,
                interrupted: true,
              }),
        });
      controller.abort();
      this.requests.delete(request.requestId);
      this.capabilities?.release?.(request.requestId);
      void this.releaseAssets(request.requestId);
    }
  }
  async cancel(requestId: string): Promise<void> {
    const active = this.requests.get(requestId);
    if (!active) return;
    active.stopped = true;
    try {
      this.capabilities?.cancelExecution?.(requestId);
    } finally {
      active.controller.abort();
      await active.done;
    }
  }
  async cancelAll(): Promise<void> {
    await Promise.all([...this.requests.keys()].map((id) => this.cancel(id)));
  }
  async interruptAll(foregroundOnly = false): Promise<void> {
    const active = [...this.requests.values()].filter((request) => !foregroundOnly || !request.proactive);
    active.forEach(({ controller }) => controller.abort());
    await Promise.all(active.map(({ done }) => done));
  }
  async interruptProactive(): Promise<void> {
    const active = [...this.requests.values()].filter((request) => request.proactive);
    active.forEach(({ controller }) => controller.abort());
    await Promise.all(active.map(({ done }) => done));
  }

  private async stage(request: ChatRequest, signal: AbortSignal) {
    if (!this.assets) throw new Error('Local attachments are unavailable.');
    const form = new FormData();
    const metadata: MediaAsset[] = [];
    for (const id of request.attachmentIds ?? []) {
      signal.throwIfAborted();
      const { asset, bytes } = await this.assets.get(id);
      metadata.push(asset);
      form.append('files', new Blob([new Uint8Array(bytes)], { type: asset.mimeType }), id);
    }
    form.set('metadata', JSON.stringify(metadata));
    const response = await this.http(`chat/${encodeURIComponent(request.requestId)}/attachments`, {
      method: 'POST',
      body: form,
      signal,
    });
    await response.body?.cancel();
  }

  async importArtifact(requestId: string, artifact: ArtifactReference, signal?: AbortSignal) {
    if (!this.assets) throw new Error('Local artifact storage is unavailable.');
    const response = await this.http(
      `chat/${encodeURIComponent(requestId)}/artifacts/${artifact.id}`,
      { signal },
    );
    const mime = response.headers.get('content-type')?.split(';')[0];
    if (!response.body || mime !== artifact.mimeType) {
      await response.body?.cancel();
      throw new Error('Aria received an unexpected artifact format.');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > artifact.size || bytes > conductorLimits.artifactBytes)
          throw new Error('Aria received an oversized artifact.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    signal?.throwIfAborted();
    if (bytes !== artifact.size) throw new Error('The artifact download was incomplete.');
    const content = Buffer.concat(chunks);
    if (artifact.sha256 && createHash('sha256').update(content).digest('hex') !== artifact.sha256)
      throw new Error('The artifact failed its integrity check.');
    const asset = await this.assets.put(content, artifact.name, mime);
    if (signal?.aborted) {
      await this.assets.remove(asset.id);
      signal.throwIfAborted();
    }
    return asset;
  }

  async releaseAssets(requestId: string) {
    await this.http(`chat/${encodeURIComponent(requestId)}/assets`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    })
      .then((response) => response.body?.cancel())
      .catch(() => undefined);
  }

  async restart(): Promise<void> {
    this.assertIdle();
    if (this.starting) await this.starting;
    ++this.generation;
    this.browserSession?.close();
    this.capabilitySession?.close();
    this.child?.kill();
    this.child = undefined;
    this.url = '';
    await this.start();
  }
  async close(): Promise<void> {
    ++this.generation;
    await this.interruptAll();
    this.browserSession?.close();
    this.capabilitySession?.close();
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage('shutdown');
    });
  }
}
