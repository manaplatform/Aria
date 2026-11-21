import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { ModelMessage } from 'ai';
const { AiService, providerError } = createRequire(import.meta.url)(
  '../dist/ai/ai.service.js',
) as typeof import('../src/ai/ai.service');
const { nativeComputerName, nativeComputerTools, computerScreenshot, readComputerCall } =
  createRequire(import.meta.url)(
    '../dist/providers/openai-computer.js',
  ) as typeof import('../src/providers/openai-computer');

it('preserves computer call identifiers and safety attestations in a stateless Responses continuation', async () => {
  const checks = [{ id: 'check_01', code: 'confirm', message: 'Review the synthetic action.' }];
  const item = {
    type: 'computer_call',
    id: 'cu_01',
    call_id: 'call_01',
    status: 'completed',
    pending_safety_checks: checks,
    actions: [{ type: 'click', button: 'left', x: 8, y: 9 }, { type: 'screenshot' }],
  };
  const stream = (events: object[]) =>
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  const created = {
    type: 'response.created',
    response: { id: 'resp_01', created_at: 1, model: 'fixture' },
  };
  const completed = { type: 'response.completed', response: {} };
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      stream([
        created,
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, status: 'in_progress' },
        },
        { type: 'response.output_item.done', output_index: 0, item },
        completed,
      ]),
    )
    .mockResolvedValueOnce(stream([created, completed]));
  const ai = new AiService();
  const signal = AbortSignal.timeout(2000);
  const target = {
    id: 'fixture',
    connection: { baseUrl: 'https://api.openai.com/v1', apiKey: 'fixture-key' },
  };
  const messages: ModelMessage[] = [{ role: 'user', content: 'Use the synthetic computer.' }];
  const initial = ai.generate(
    messages,
    signal,
    target,
    'Use the synthetic computer.',
    nativeComputerTools,
  );
  const calls = [];
  for await (const event of initial.stream) if (event.type === 'tool-call') calls.push(event);
  expect(calls).toHaveLength(1);
  const [call] = calls;
  expect(call).toMatchObject({
    toolName: nativeComputerName,
    toolCallId: 'call_01',
    providerMetadata: { openai: { itemId: 'cu_01' } },
  });
  expect(readComputerCall(call.input)?.actions.map(({ type }) => type)).toEqual([
    'click',
    'screenshot',
  ]);
  expect(readComputerCall({ ...(call.input as object), status: 'incomplete' })).toBeUndefined();
  const result = await initial.response;
  expect(result.id).toBe('resp_01');
  messages.push(...result.messages.filter(({ role }) => role === 'assistant'), {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolName: nativeComputerName,
        toolCallId: 'call_01',
        output: computerScreenshot(new Uint8Array([137, 80, 78, 71]), checks),
      },
    ],
  });
  const continued = ai.generate(
    messages,
    signal,
    target,
    'Summarize.',
    nativeComputerTools,
    undefined,
    true,
  );
  for await (const event of continued.stream) if (event.type === 'error') throw event.error;
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toMatchObject({
    store: false,
    input: expect.arrayContaining([
      expect.objectContaining({ type: 'computer_call', id: 'cu_01', call_id: 'call_01' }),
      expect.objectContaining({
        type: 'computer_call_output',
        call_id: 'call_01',
        acknowledged_safety_checks: checks,
        output: { type: 'computer_screenshot', image_url: 'data:image/png;base64,iVBORw==' },
      }),
    ]),
  });
});

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
const { ProvidersController } = createRequire(import.meta.url)(
  '../dist/providers/providers.controller.js',
) as typeof import('../src/providers/providers.controller');
const { ProvidersService } = createRequire(import.meta.url)(
  '../dist/providers/providers.service.js',
) as typeof import('../src/providers/providers.service');
const { ModelRegistry } = createRequire(import.meta.url)(
  '../dist/providers/model-registry.service.js',
) as typeof import('../src/providers/model-registry.service');
const { createHash, randomUUID } = createRequire(import.meta.url)(
  'node:crypto',
) as typeof import('node:crypto');

const primary = {
  id: 'fixture-model',
  connection: { baseUrl: 'https://api.openai.com/v1', apiKey: 'synthetic-fixture-key' },
} as ConstructorParameters<typeof OpenAIRuntime>[0];

function runtime() {
  return new OpenAIRuntime(primary);
}

it('verifies managed Shell with a required native tool call and a correlated synthetic result', async () => {
  const requests: Record<string, unknown>[] = [];
  const stream = (events: object[]) =>
    new Response(
      [
        { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: primary.id } },
        ...events,
        { type: 'response.completed', response: {} },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    requests.push(request);
    const send = (type: string, item: object) => ({ type, output_index: 0, item });
    if (requests.length === 1) {
      const command = JSON.stringify(request.input).match(/printf '[^']+'/u)?.[0];
      const call = {
        id: 'shell_1',
        type: 'shell_call',
        call_id: 'call_1',
        action: { commands: [command] },
      };
      return stream([
        send('response.output_item.added', { ...call, status: 'in_progress' }),
        send('response.output_item.done', { ...call, status: 'completed' }),
      ]);
    }
    const result = request.input.find(({ type }: { type: string }) => type === 'shell_call_output');
    const item = { type: 'message', id: 'msg_1' };
    return stream([
      send('response.output_item.added', item),
      { type: 'response.output_text.delta', output_index: 0, item_id: item.id, delta: result.output[0].stdout },
      send('response.output_item.done', item),
    ]);
  });
  const providers = new ProvidersService();
  const models = new ModelRegistry(providers);
  vi.spyOn(models, 'resolve').mockResolvedValue({
    primary,
    models: new Map(),
    config: models.configuration(),
  });
  const controller = new ProvidersController(providers, new AiService(), models);
  await expect(controller.verifyNativeRuntime({ feature: 'local-shell' })).resolves.toEqual({
    feature: 'local-shell', verified: true,
  });
  expect(requests[0]).toMatchObject({
    tool_choice: 'required',
    tools: [{ type: 'shell', environment: { type: 'local' } }],
  });
  expect(requests[1]).toMatchObject({
    tool_choice: 'none',
    input: expect.arrayContaining([
      expect.objectContaining({ type: 'shell_call', id: 'shell_1', call_id: 'call_1' }),
      expect.objectContaining({ type: 'shell_call_output', call_id: 'call_1' }),
    ]),
  });
});

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
  const deleted: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (options?.method === 'DELETE') {
      deleted.push(new URL(String(url)).pathname);
      return new Response(null, { status: 204 });
    }
    if (typeof options?.body === 'string') writes.push(JSON.parse(options.body));
    if (String(url).endsWith('/vector_stores')) return Response.json({ id: 'vs_ABC' });
    if (String(url).endsWith('/vs_ABC/files')) return Response.json({ id: 'file-ABC' });
    if (String(url).endsWith('/vs_ABC/files/file-ABC'))
      return Response.json({ status: 'completed' });
    if (String(url).endsWith('/files') && options?.body instanceof FormData) {
      expect(options.body.get('purpose')).toBe('assistants');
      return Response.json({ id: 'file-ABC' });
    }
    throw new Error('Unexpected request in fixture');
  });
  const client = runtime();
  const bytes = Buffer.from('Termination requires thirty days of written notice.');
  const version = createHash('sha256').update(bytes).digest('hex');
  const file = { id: randomUUID(), name: 'terms.txt', mimeType: 'text/plain', bytes };
  try {
    await client.prepareSearch([{ file, version }], AbortSignal.timeout(1000));
    expect(writes[1]).toMatchObject({ file_id: 'file-ABC', attributes: { aria_version: version } });
    expect(
      client.evidence({
        queries: ['termination'],
        results: [
          { fileId: 'file_OUTSIDE_SCOPE', score: 0.99, text: 'unrelated document' },
          { fileId: 'file-ABC', score: 0.8, text: 'thirty days' },
        ],
      }),
    ).toEqual([expect.objectContaining({ fileId: file.id, excerpt: 'thirty days', version })]);
  } finally {
    await client.close();
  }
  expect(deleted).toEqual(['/v1/vector_stores/vs_ABC', '/v1/files/file-ABC']);
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
