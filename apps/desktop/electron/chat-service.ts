import { randomUUID } from 'node:crypto';
import type { UtilityProcess } from 'electron';
import type { ChatEvent, ChatRequest, ChatServiceStatus } from '@aria/shared';
import { z } from 'zod';
import { chatRequestSchema, readChatEvents } from './chat-protocol';
import { ProviderConfigurationError, type ProviderStorage } from './provider-storage';

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
  ) {}
  getStatus(): ChatServiceStatus {
    return { ...this.status };
  }
  private setStatus(status: ChatServiceStatus) {
    this.status = status;
    this.emitStatus(this.getStatus());
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
      const provider = await this.provider.resolve();
      if (generation !== this.generation) return;
      this.token = randomUUID() + randomUUID();
      const child = this.launch({
        ...process.env,
        ARIA_MANAGED: '1',
        ARIA_INTERNAL_TOKEN: this.token,
        OPENAI_BASE_URL: provider.baseUrl,
        OPENAI_MODEL: provider.model,
        OPENAI_API_KEY: provider.apiKey,
        ARIA_SYSTEM_PROMPT: provider.systemPrompt,
      });
      this.child = child;
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Startup timed out.'));
        }, 15000);
        const ready = (message: unknown) => {
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
          model: provider.model,
          error: 'The chat service stopped. Restart it in Settings, then retry your response.',
        });
      });
      const response = await fetch(`${this.url}/chat/capabilities`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Service did not become ready.');
      const capabilities = z
        .object({ configured: z.boolean(), model: z.string() })
        .parse(await response.json());
      if (generation === this.generation) this.setStatus({ state: 'ready', ...capabilities });
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
  private begin(input: ChatRequest, emit = this.emitEvent): ActiveRequest {
    const request = chatRequestSchema.parse(input);
    if (this.status.state !== 'ready' || !this.status.configured || !this.url)
      throw new Error('Configure your provider in Settings before sending a message.');
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
    try {
      const response = await fetch(`${this.url}/chat/stream`, {
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
        if (active.stopped) break;
        active.emit(event);
        if (['completed', 'failed', 'stopped'].includes(event.type)) {
          terminal = true;
          break;
        }
      }
    } catch {
      /* Keep the partial response and send one terminal event below. */
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
                error: 'The response was interrupted. Check your connection and retry.',
                interrupted: true,
              }),
        });
      controller.abort();
      this.requests.delete(request.requestId);
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
  async testProvider(): Promise<void> {
    this.assertIdle();
    let result: ChatEvent | undefined;
    const requestId = randomUUID();
    const active = this.begin(
      {
        requestId,
        conversationId: `test-${requestId}`,
        assistantMessageId: randomUUID(),
        messages: [{ role: 'user', content: 'Reply with OK.' }],
      },
      (event) => {
        result = event;
      },
    );
    const timeout = setTimeout(() => {
      void this.cancel(requestId);
    }, 15000);
    try {
      await active.done;
    } finally {
      clearTimeout(timeout);
    }
    if (result?.type !== 'completed')
      throw new Error(
        result?.type === 'failed' ? result.error : 'The provider test did not complete.',
      );
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
