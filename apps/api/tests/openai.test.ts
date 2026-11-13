import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const { AiService, providerError } = createRequire(import.meta.url)(
  '../dist/ai/ai.service.js',
) as typeof import('../src/ai/ai.service');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('uses the native Responses protocol for official OpenAI reasoning models', async () => {
  vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1');
  vi.stubEnv('OPENAI_API_KEY', 'test-only-key');
  vi.stubEnv('OPENAI_MODEL', 'gpt-6-luna');
  const events = [
    {
      type: 'response.created',
      response: { id: 'response-fixture', created_at: 1, model: 'gpt-6-luna' },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'message-fixture' },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'message-fixture',
      output_index: 0,
      delta: 'OK',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'message-fixture' },
    },
    { type: 'response.completed', response: {} },
  ];
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
  const result = new AiService().generate(
    [{ role: 'user', content: 'Reply OK' }],
    new AbortController().signal,
    {
      id: 'gpt-6-luna',
      connection: { baseUrl: 'https://api.openai.com/v1', apiKey: 'test-only-key' },
    },
    'Be concise.',
  );
  const parts = [];
  for await (const part of result.stream) parts.push(part);
  expect(
    parts
      .filter((part) => part.type === 'text-delta')
      .map((part) => part.text)
      .join(''),
  ).toBe('OK');
  expect(parts.some((part) => part.type === 'error')).toBe(false);
  expect(String(fetcher.mock.calls[0][0])).toBe('https://api.openai.com/v1/responses');
  const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
  expect(body).toMatchObject({
    model: 'gpt-6-luna',
    max_output_tokens: 4096,
    stream: true,
    store: false,
  });
  expect(body).not.toHaveProperty('max_tokens');
});

it('reports request compatibility and network failures without revealing provider response text', () => {
  expect(
    providerError({
      statusCode: 400,
      data: { error: { param: 'max_tokens', message: 'secret-key-in-response' } },
    }),
  ).toContain('HTTP 400; parameter: max_tokens');
  expect(
    providerError({
      statusCode: 400,
      data: { error: { param: 'secret-key-in-response', message: 'secret-key-in-response' } },
    }),
  ).not.toContain('secret-key-in-response');
  expect(providerError({ cause: { code: 'ENOTFOUND' } })).toContain('could not be resolved');
  expect(providerError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).toContain('timed out');
});
