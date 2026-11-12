// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { UtilityProcess } from 'electron';
import type { ChatEvent, ChatRequest, ChatServiceStatus } from '@aria/shared';
import { readChatEvents } from '../electron/chat-protocol';
import { ChatService } from '../electron/chat-service';
import { ProviderConfigurationError, type ProviderStorage } from '../electron/provider-storage';

const request: ChatRequest = {
  requestId: 'request',
  conversationId: 'chat',
  assistantMessageId: 'assistant',
  messages: [{ role: 'user', content: 'Hello' }],
};
const envelope = {
  requestId: request.requestId,
  conversationId: request.conversationId,
  assistantMessageId: request.assistantMessageId,
};
it('decodes arbitrary byte boundaries, Unicode, CRLF frames, and heartbeats', async () => {
  const wire = `: heartbeat\r\n\r\ndata: ${JSON.stringify({ ...envelope, sequence: 1, type: 'delta', text: 'Hello 🌙\nWorld' })}\r\n\r\ndata: ${JSON.stringify({ ...envelope, sequence: 2, type: 'completed' })}\n\n`;
  const bytes = new TextEncoder().encode(wire);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readChatEvents(body)) events.push(event);
  expect(events).toEqual([
    { ...envelope, sequence: 1, type: 'delta', text: 'Hello 🌙\nWorld' },
    { ...envelope, sequence: 2, type: 'completed' },
  ]);
});
it('rejects malformed and incomplete stream frames', async () => {
  for (const wire of [
    'data: {bad}\n\n',
    'data: {"type":"delta"}\n\n',
    'data: {"unfinished":true}',
  ]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        controller.close();
      },
    });
    await expect(
      (async () => {
        for await (const event of readChatEvents(body)) void event;
      })(),
    ).rejects.toThrow();
  }
});

class Child extends EventEmitter {
  kill() {
    setImmediate(() => this.emit('exit', 0));
    return true;
  }
  postMessage() {
    this.kill();
  }
}
let server: http.Server;
let service: ChatService;
let children: Child[];
let events: ChatEvent[];
let states: ChatServiceStatus[];
let mode: 'normal' | 'slow' | 'wrong';
beforeEach(async () => {
  mode = 'normal';
  children = [];
  events = [];
  states = [];
  server = http.createServer(async (incoming, response) => {
    if (incoming.url === '/chat/capabilities') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ configured: true, model: 'test-model' }));
      return;
    }
    let body = '';
    for await (const chunk of incoming) body += String(chunk);
    const input = JSON.parse(body) as ChatRequest;
    expect(incoming.headers.authorization).toMatch(/^Bearer .+/);
    response.setHeader('Content-Type', 'text/event-stream');
    const current = {
      requestId: input.requestId,
      conversationId: mode === 'wrong' ? 'another-chat' : input.conversationId,
      assistantMessageId: input.assistantMessageId,
    };
    response.write(`data: ${JSON.stringify({ ...current, sequence: 1, type: 'started' })}\n\n`);
    response.write(
      `data: ${JSON.stringify({ ...current, sequence: 2, type: 'delta', text: 'Partial answer' })}\n\n`,
    );
    if (mode !== 'slow')
      response.end(`data: ${JSON.stringify({ ...current, sequence: 3, type: 'completed' })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const provider = {
    resolve: async () => ({
      apiKey: 'test-only-key',
      baseUrl: 'http://localhost/v1',
      model: 'test-model',
      systemPrompt: '',
    }),
  } as ProviderStorage;
  service = new ChatService(
    provider,
    (env) => {
      expect(env.OPENAI_API_KEY).toBe('test-only-key');
      const child = new Child();
      children.push(child);
      setImmediate(() => child.emit('message', { type: 'ready', port }));
      return child as unknown as UtilityProcess;
    },
    (event) => events.push(event),
    (state) => states.push(state),
  );
});
afterEach(async () => {
  await service?.close();
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
});
it('starts one managed service, streams once, and restarts without replaying messages', async () => {
  await Promise.all([service.start(), service.start()]);
  expect(children).toHaveLength(1);
  expect(service.getStatus()).toMatchObject({ state: 'ready', configured: true });
  service.submit(request);
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe('completed'));
  expect(events.filter((event) => event.type === 'delta')).toHaveLength(1);
  await service.restart();
  expect(children).toHaveLength(2);
  expect(events.filter((event) => event.type === 'delta')).toHaveLength(1);
});
it('cancels requests and rejects configuration changes during generation', async () => {
  mode = 'slow';
  await service.start();
  service.submit(request);
  await vi.waitFor(() => expect(events.some((event) => event.type === 'delta')).toBe(true));
  await expect(service.restart()).rejects.toThrow('Stop active responses');
  await service.cancel(request.requestId);
  expect(events.at(-1)?.type).toBe('stopped');
});
it('marks active responses interrupted after a service crash and supports explicit restart', async () => {
  mode = 'slow';
  await service.start();
  service.submit(request);
  await vi.waitFor(() => expect(events.some((event) => event.type === 'delta')).toBe(true));
  children[0].emit('exit', 1);
  await vi.waitFor(() =>
    expect(events.at(-1)).toMatchObject({ type: 'failed', interrupted: true }),
  );
  expect(states.at(-1)?.state).toBe('failed');
  await service.restart();
  expect(service.getStatus().state).toBe('ready');
});
it('never forwards stream events belonging to another conversation', async () => {
  mode = 'wrong';
  await service.start();
  service.submit(request);
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe('failed'));
  expect(events).toHaveLength(1);
  expect(events[0].conversationId).toBe('chat');
});

it('keeps the private API available for replacement-key discovery when a saved key cannot be unlocked', async () => {
  const port = (server.address() as { port: number }).port;
  const broken = {
    resolve: async () => {
      throw new ProviderConfigurationError('The saved API key could not be unlocked.');
    },
    get: async () => ({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'saved-model',
      models: { chat: 'saved-model', image: '', speech: '', transcription: '', live: '' },
      systemPrompt: '',
    }),
  } as unknown as ProviderStorage;
  const recovering = new ChatService(
    broken,
    (env) => {
      expect(env.OPENAI_API_KEY).toBe('');
      const child = new Child();
      setImmediate(() => child.emit('message', { type: 'ready', port }));
      return child as unknown as UtilityProcess;
    },
    () => undefined,
    () => undefined,
  );
  try {
    await recovering.start();
    expect(recovering.getStatus()).toMatchObject({
      state: 'ready',
      configured: false,
      error: expect.stringContaining('unlocked'),
    });
    expect((await recovering.http('chat/capabilities')).ok).toBe(true);
  } finally {
    await recovering.close();
  }
});
