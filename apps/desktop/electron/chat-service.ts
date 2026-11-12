import { randomUUID } from 'node:crypto';
import type { UtilityProcess } from 'electron';
import {
  conductorLimits,
  emptyRegistryPolicy,
  type ArtifactReference,
  type ChatEvent,
  type ChatRequest,
  type ChatServiceStatus,
  type MediaAsset,
  type RuntimeRegistry,
} from '@aria/shared';
import { z } from 'zod';
import WebSocket from 'ws';
import { chatRequestSchema, readChatEvents } from './chat-protocol';
import { ProviderConfigurationError, type ProviderStorage } from './provider-storage';
import type { MediaStorage } from './media-storage';

interface ActiveRequest {
  request: ChatRequest;
  controller: AbortController;
  stopped: boolean;
  sequence: number;
  length: number;
  done: Promise<void>;
  emit: (event: ChatEvent) => void;
}
export class ChatService {
  private child?: UtilityProcess;
  private url = '';
  private token = '';
  private generation = 0;
  private starting?: Promise<void>;
  private requests = new Map<string, ActiveRequest>();
  private status: ChatServiceStatus = { state: 'starting', configured: false, model: '' };
  constructor(
    private readonly provider: ProviderStorage,
    private readonly launch: (env: NodeJS.ProcessEnv) => UtilityProcess,
    private readonly emitEvent: (event: ChatEvent) => void,
    private readonly emitStatus: (status: ChatServiceStatus) => void,
    private readonly assets?: MediaStorage,
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
  assertIdle(): void {
    if (this.requests.size)
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
      if (generation !== this.generation) return;
      this.token = randomUUID() + randomUUID();
      const env = { ...process.env };
      for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL', 'ARIA_SYSTEM_PROMPT'])
        delete env[key];
      const child = this.launch({ ...env, ARIA_MANAGED: '1', ARIA_INTERNAL_TOKEN: this.token });
      this.child = child;
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
            child.postMessage({ registry });
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
      child.once('exit', () => {
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
          ...(configurationError ? { configured: false, error: configurationError } : {}),
        });
    } catch (error) {
      if (generation === this.generation) {
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
  private begin(input: ChatRequest, emit = this.emitEvent): ActiveRequest {
    const request = chatRequestSchema.parse(input);
    if (this.status.state !== 'ready' || !this.status.configured || !this.url)
      throw new Error('Configure your provider in Settings before sending a message.');
    if (request.expectedRevision && this.status.revision !== request.expectedRevision)
      throw new Error('The AI Models configuration changed. Send again to use current settings.');
    if (this.requests.size >= conductorLimits.turns)
      throw new Error('Aria is handling too many turns. Stop a response or try again shortly.');
    if (
      this.requests.has(request.requestId) ||
      [...this.requests.values()].some(
        (item) => item.request.conversationId === request.conversationId,
      )
    )
      throw new Error('This conversation already has a response in progress.');
    const active: ActiveRequest = {
      request,
      controller: new AbortController(),
      stopped: false,
      sequence: 0,
      length: 0,
      done: Promise.resolve(),
      emit,
    };
    this.requests.set(request.requestId, active);
    active.done = this.consume(active);
    return active;
  }
  submit(input: ChatRequest): void {
    this.begin(input);
  }
  private async consume(active: ActiveRequest): Promise<void> {
    const { request, controller } = active;
    let terminal = false;
    let failure = 'The response was interrupted. Check the connection and send it again.';
    const artifacts = new Map<string, string>();
    try {
      if (request.attachmentIds?.length) await this.stage(request, controller.signal);
      const response = await this.http('chat/stream', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(request),
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
          event.assistantMessageId !== request.assistantMessageId
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
          const asset = await this.importArtifact(
            request.requestId,
            event.artifact,
            controller.signal,
          );
          if (active.stopped) break;
          artifacts.set(event.artifact.id, asset.id);
          active.emit({
            type: 'asset',
            asset,
            requestId: event.requestId,
            conversationId: event.conversationId,
            assistantMessageId: event.assistantMessageId,
            sequence: event.sequence,
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
      void this.releaseAssets(request.requestId);
    }
  }
  async cancel(requestId: string): Promise<void> {
    const active = this.requests.get(requestId);
    if (!active) return;
    active.stopped = true;
    active.controller.abort();
    await active.done;
  }
  async cancelAll(): Promise<void> {
    await Promise.all([...this.requests.keys()].map((id) => this.cancel(id)));
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
    const asset = await this.assets.put(Buffer.concat(chunks), artifact.name, mime);
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
    this.child?.kill();
    this.child = undefined;
    this.url = '';
    await this.start();
  }
  async close(): Promise<void> {
    ++this.generation;
    await this.cancelAll();
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
