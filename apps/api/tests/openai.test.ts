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

const { OpenAIRuntime } = createRequire(import.meta.url)(
  '../dist/providers/openai-runtime.js',
) as typeof import('../src/providers/openai-runtime');
const { createHash, randomUUID } = createRequire(import.meta.url)(
  'node:crypto',
) as typeof import('node:crypto');

function runtime() {
  const primary = {
    id: 'fixture-model',
    connection: { baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-fixture-key' },
  } as ConstructorParameters<typeof OpenAIRuntime>[0];
  return new OpenAIRuntime(primary);
}

it('binds the hosted shell container, uses the approved network policy, and retrieves actual files', async () => {
  const calls: { url: string; method?: string; body?: BodyInit | null }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    const request = String(url);
    calls.push({ url: request, method: options?.method, body: options?.body });
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.endsWith('/containers')) return Response.json({ id: 'cntr_ABC' });
    if (request.endsWith('/files?limit=100'))
      return Response.json({ data: [{ id: 'cfile_ABC', path: '/mnt/data/outputs/report.txt' }] });
    if (request.endsWith('/content')) return new Response('verified data');
    throw new Error('Unexpected request in fixture');
  });
  const client = runtime();
  const signal = AbortSignal.timeout(1000);
  try {
    const id = await client.openHosted(
      [],
      ['example.com'],
      [{ skill_id: 'skill_ABC', version: '1' }],
      signal,
    );
    expect(JSON.parse(String(calls[0].body))).toMatchObject({
      expires_after: { anchor: 'last_active_at', minutes: 20 },
      network_policy: { type: 'allowlist', allowed_domains: ['example.com'] },
      skills: [{ type: 'skill_reference', skill_id: 'skill_ABC', version: '1' }],
    });
    expect(await client.artifact(id, 'report.txt', signal)).toMatchObject({
      name: 'report.txt',
      bytes: Buffer.from('verified data'),
    });
    await expect(client.artifact(randomUUID(), 'report.txt', signal)).rejects.toThrow(
      'unavailable',
    );
  } finally {
    await client.close();
  }
  expect(calls.at(-1)).toMatchObject({
    method: 'DELETE',
    url: 'https://api.openai.com/v1/containers/cntr_ABC',
  });
});

it('associates File Search attachments with a scoped version and discards unknown citations', async () => {
  const writes: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    if (typeof options?.body === 'string') writes.push(JSON.parse(options.body));
    if (String(url).endsWith('/vector_stores')) return Response.json({ id: 'vs_ABC' });
    if (String(url).endsWith('/vs_ABC/files')) return Response.json({ id: 'file_ABC' });
    if (String(url).endsWith('/vs_ABC/files/file_ABC'))
      return Response.json({ status: 'completed' });
    if (String(url).endsWith('/files') && options?.body instanceof FormData) {
      expect(options.body.get('purpose')).toBe('assistants');
      return Response.json({ id: 'file_ABC' });
    }
    throw new Error('Unexpected request in fixture');
  });
  const client = runtime();
  const bytes = Buffer.from('Termination requires thirty days of written notice.');
  const version = createHash('sha256').update(bytes).digest('hex');
  const file = { id: randomUUID(), name: 'terms.txt', mimeType: 'text/plain', bytes };
  try {
    await client.prepareSearch([{ file, version }], AbortSignal.timeout(1000));
    expect(writes[1]).toMatchObject({ file_id: 'file_ABC', attributes: { aria_version: version } });
    expect(
      client.evidence({
        queries: ['termination'],
        results: [
          { fileId: 'file_OUTSIDE_SCOPE', score: 0.99, text: 'unrelated document' },
          { fileId: 'file_ABC', score: 0.8, text: 'thirty days' },
        ],
      }),
    ).toEqual([expect.objectContaining({ fileId: file.id, excerpt: 'thirty days', version })]);
  } finally {
    await client.close();
  }
});

it('serializes the application-managed native shell call and its correlated result', async () => {
  const client = runtime();
  client.openLocal(randomUUID());
  const calls: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)));
    return new Response(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","created_at":1,"model":"fixture-model"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const call = 'call_from_responses';
  const result = new AiService().generate(
    [
      { role: 'user', content: 'Use the shell to run the approved command.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: call,
            toolName: 'aria_native_shell',
            input: {
              action: { commands: ['printf actual'], timeoutMs: 1000, maxOutputLength: 2048 },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: call,
            toolName: 'aria_native_shell',
            output: {
              type: 'json',
              value: {
                maxOutputLength: 2048,
                output: [{ stdout: 'actual', stderr: '', outcome: { type: 'exit', exitCode: 0 } }],
              },
            },
          },
        ],
      },
    ],
    AbortSignal.timeout(1000),
    {
      id: 'fixture-model',
      connection: { baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-fixture-key' },
    },
    'Verify the native continuation.',
    client.tools(),
    undefined,
    false,
    { fileSearch: false, toolLimit: 4 },
  );
  for await (const part of result.stream) if (part.type === 'error') throw part.error;
  expect(calls[0]).toMatchObject({
    max_tool_calls: 4,
    tools: expect.arrayContaining([{ type: 'shell', environment: { type: 'local' } }]),
    input: expect.arrayContaining([
      expect.objectContaining({
        type: 'shell_call',
        call_id: call,
        action: expect.objectContaining({ commands: ['printf actual'] }),
      }),
      expect.objectContaining({
        type: 'shell_call_output',
        call_id: call,
        max_output_length: 2048,
        output: [{ stdout: 'actual', stderr: '', outcome: { type: 'exit', exit_code: 0 } }],
      }),
    ]),
  });
});
