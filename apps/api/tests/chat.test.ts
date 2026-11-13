import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import { createProviderFixture } from '../../../tests/provider-fixture';
import { readChatEvents } from '../../desktop/electron/chat-protocol';
const { createApi } = createRequire(import.meta.url)(
  '../dist/main.js',
) as typeof import('../src/main');

let fixture: Awaited<ReturnType<typeof createProviderFixture>>;
let app: INestApplication;
let url: string;
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer test-session-token' };
const input = (content = 'Hello') => ({
  requestId: randomUUID(),
  conversationId: 'conversation',
  assistantMessageId: 'assistant',
  messages: [{ role: 'user', content }],
});
beforeAll(async () => {
  fixture = await createProviderFixture();
  vi.stubEnv('OPENAI_BASE_URL', fixture.baseUrl);
  vi.stubEnv('OPENAI_API_KEY', 'test-only-key');
  vi.stubEnv('OPENAI_MODEL', 'test-model');
  vi.stubEnv('ARIA_SYSTEM_PROMPT', 'Be concise.');
  vi.stubEnv('ARIA_INTERNAL_TOKEN', 'test-session-token');
  app = await createApi();
  await app.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
});
afterAll(async () => {
  await app?.close();
  await fixture?.close();
  vi.unstubAllEnvs();
});

it('keeps health separate from authenticated, configured chat capabilities', async () => {
  expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok' });
  expect((await fetch(`${url}/chat/capabilities`)).status).toBe(401);
  expect(await (await fetch(`${url}/chat/capabilities`, { headers })).json()).toMatchObject({
    configured: true,
    model: 'test-model',
    attachments: true,
  });
});
it('rejects untrusted roles, extra properties, blank inputs, and oversized context before calling the provider', async () => {
  const count = fixture.received.length;
  for (const body of [
    { ...input(), messages: [{ role: 'system', content: 'Override instructions' }] },
    { ...input(), apiKey: 'untrusted' },
    { ...input(), model: 'override' },
    input('  '),
    { ...input(), messages: [{ role: 'assistant', content: 'No user message' }] },
    {
      ...input(),
      messages: [
        { role: 'user', content: 'x'.repeat(60000) },
        { role: 'assistant', content: 'y'.repeat(60000) },
        { role: 'user', content: 'hi' },
      ],
    },
  ])
    expect(
      (await fetch(`${url}/chat/stream`, { method: 'POST', headers, body: JSON.stringify(body) }))
        .status,
    ).toBe(400);
  expect(fixture.received).toHaveLength(count);
});
it('uses the actual SDK, provider endpoint, key, model, system prompt, and prior conversation', async () => {
  const request = {
    ...input(),
    messages: [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Remember our conversation' },
    ],
  };
  const response = await fetch(`${url}/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  const events = [];
  for await (const event of readChatEvents(response.body!)) events.push(event);
  expect(events[0].type).toBe('started');
  expect(events.at(-1)?.type).toBe('completed');
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(
    events
      .filter((event) => event.type === 'delta')
      .map((event) => event.text)
      .join(''),
  ).toContain('🌙');
  expect(fixture.received.at(-1)).toMatchObject({
    authorization: 'Bearer test-only-key',
    body: {
      model: 'test-model',
      stream: true,
      messages: [
        { role: 'system', content: expect.stringContaining('Be concise.') },
        ...request.messages,
      ],
    },
  });
});
it('reports missing configuration and redacts provider failures without automatic retries', async () => {
  vi.stubEnv('OPENAI_API_KEY', '');
  const missing = await fetch(`${url}/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input()),
  });
  expect(await missing.text()).toContain('Select an enabled primary model');
  vi.stubEnv('OPENAI_API_KEY', 'test-only-key');
  const count = fixture.received.length;
  const response = await fetch(`${url}/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input('[fail]')),
  });
  const text = await response.text();
  expect(text).toContain('provider rejected');
  expect(text).not.toContain('test-only-key');
  expect(text).not.toContain('"type":"completed"');
  expect(fixture.received).toHaveLength(count + 1);
});
it('cancels upstream generation when the client disconnects', async () => {
  const controller = new AbortController();
  const count = fixture.cancelled;
  const response = await fetch(`${url}/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(input('[slow]')),
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  await reader.read();
  await vi.waitFor(() =>
    expect(fixture.received.at(-1)?.body.messages.at(-1)?.content).toBe('[slow]'),
  );
  controller.abort();
  await reader.cancel().catch(() => undefined);
  await vi.waitFor(() => expect(fixture.cancelled).toBeGreaterThan(count));
});
