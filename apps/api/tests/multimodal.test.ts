import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import { emptyRegistryPolicy, type RuntimeRegistry, type ExecutionStep } from '@aria/shared';
import WebSocket from 'ws';
import {
  createProviderFixture,
  fixtureConnectionId,
  fixtureRef,
} from '../../../tests/provider-fixture';
import { readChatEvents } from '../../desktop/electron/chat-protocol';

const require = createRequire(import.meta.url);
const { createApi } = require('../dist/main.js') as typeof import('../src/main');
const { ModelRegistry } =
  require('../dist/providers/model-registry.service.js') as typeof import('../src/providers/model-registry.service');
let fixture: Awaited<ReturnType<typeof createProviderFixture>>;
let app: INestApplication;
let registry: InstanceType<typeof ModelRegistry>;
let url: string;
const token = 'Bearer multimodal-session';
const headers = { Authorization: token };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
const models = [
  'fixture-model',
  'test-model',
  'gpt-image-2.6-flare',
  'tts-1',
  'gpt-realtime-2.1-mini',
  'gpt-transcribe',
  'gpt-live-1',
];
const secondId = '10000000-0000-4000-8000-000000000002';

function config(): RuntimeRegistry {
  return {
    ...emptyRegistryPolicy,
    revision: 'fixture-configuration',
    primary: fixtureRef('fixture-model'),
    live: { model: fixtureRef('gpt-live-1'), voice: 'marin' },
    connections: [
      {
        id: fixtureConnectionId,
        name: 'Fixture',
        baseUrl: fixture.baseUrl,
        apiKey: 'test-only-key',
        webSearch: false,
        verified: [],
        models: models.map((id) => ({ id, enabled: true, delegate: true, declared: [] })),
      },
    ],
  };
}

beforeAll(async () => {
  fixture = await createProviderFixture();
  vi.stubEnv('ARIA_INTERNAL_TOKEN', 'multimodal-session');
  app = await createApi();
  registry = app.get(ModelRegistry);
  await app.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
beforeEach(() => registry.install(config()));
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await app?.close();
  await fixture?.close();
  vi.unstubAllEnvs();
});

function discovery(apiKey: string, provider = 'openai') {
  return fetch(`${url}/providers/models`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ provider, baseUrl: fixture.baseUrl, apiKey }),
  });
}
it('discovers account IDs, exact capability metadata, and unknown models without exposing credentials', async () => {
  expect((await fetch(`${url}/providers/models`, { method: 'POST' })).status).toBe(401);
  expect((await discovery('key', 'unsupported')).status).toBe(400);
  const models = await (await discovery('draft-key')).json();
  expect(models).toContainEqual(
    expect.objectContaining({
      id: 'gpt-image-2.6-flare',
      capabilities: ['image', 'image-edit'],
      source: 'provider',
    }),
  );
  expect(models).toContainEqual({ id: 'unknown-model', capabilities: [], source: 'unknown' });
  expect(JSON.stringify(models)).not.toContain('draft-key');
  const failure = await discovery('rejected-key');
  expect(failure.status).toBe(502);
  expect(await failure.text()).not.toContain('secret-');
});
it('verifies a discovered compatible model by streaming a forced synthetic tool call', async () => {
  const response = await fetch(`${url}/providers/verify`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      provider: 'openai',
      baseUrl: fixture.baseUrl,
      apiKey: 'key',
      model: 'unknown-model',
    }),
  });
  expect(await response.json()).toEqual({ verified: true });
  expect(fixture.received.at(-1)?.body.tool_choice).toMatchObject({
    function: { name: 'verify_connection' },
  });
});

type Attachment = { id: string; name: string; mimeType: string; bytes: Buffer };
const file = (name: string, mimeType: string, bytes: Buffer): Attachment => ({
  id: randomUUID(),
  name,
  mimeType,
  bytes,
});
function step(
  id: string,
  model: string,
  capability: ExecutionStep['capability'],
  output: ExecutionStep['output'],
  overrides: Partial<ExecutionStep> = {},
): ExecutionStep {
  return {
    id,
    target: { kind: 'model', model: fixtureRef(model) },
    capability,
    output,
    instructions: 'Complete this part of the request.',
    inputs: [],
    dependsOn: [],
    summary: 'Use the compatible operation',
    ...overrides,
  };
}
async function submit(
  content: string,
  steps?: ExecutionStep[],
  attachments: Attachment[] = [],
  signal?: AbortSignal,
) {
  const requestId = randomUUID();
  if (attachments.length) {
    const form = new FormData();
    for (const attachment of attachments)
      form.append(
        'files',
        new Blob([new Uint8Array(attachment.bytes)], { type: attachment.mimeType }),
        attachment.id,
      );
    form.set(
      'metadata',
      JSON.stringify(attachments.map(({ bytes, ...item }) => ({ ...item, size: bytes.length }))),
    );
    expect(
      (await fetch(`${url}/chat/${requestId}/attachments`, { method: 'POST', headers, body: form }))
        .status,
    ).toBe(201);
  }
  if (steps) fixture.queueTool(content, 'execute_steps', { steps }, 'Preparing your request.');
  const response = await fetch(`${url}/chat/stream`, {
    method: 'POST',
    headers: jsonHeaders,
    signal,
    body: JSON.stringify({
      requestId,
      conversationId: 'chat',
      assistantMessageId: 'assistant',
      messages: [{ role: 'user', content }],
      attachmentIds: attachments.map((attachment) => attachment.id),
    }),
  });
  return { requestId, response };
}
async function read(content: string, steps?: ExecutionStep[], attachments?: Attachment[]) {
  const { requestId, response } = await submit(content, steps, attachments);
  const events = [];
  for await (const event of readChatEvents(response.body!)) events.push(event);
  const assets = events.flatMap((event) => (event.type === 'artifact' ? [event.artifact] : []));
  const bytes = await Promise.all(
    assets.map(async (asset) =>
      Buffer.from(
        await (
          await fetch(`${url}/chat/${requestId}/artifacts/${asset.id}`, { headers })
        ).arrayBuffer(),
      ),
    ),
  );
  const text = events
    .filter((event) => event.type === 'delta')
    .map((event) => event.text)
    .join('');
  await fetch(`${url}/chat/${requestId}/assets`, { method: 'DELETE', headers });
  return { events, assets, bytes, text };
}
it('uses the same primary for semantic routing and synthesis and reuses image generation and editing', async () => {
  const count = fixture.received.length;
  const generation = await read('Show a foggy harbor at dawn', [
    step('image', 'gpt-image-2.6-flare', 'image', 'image'),
  ]);
  expect(generation.events.map((event) => event.type)).toContain('reset');
  expect(generation.events.at(-1)?.type).toBe('completed');
  expect(generation.bytes).toEqual([fixture.png]);
  expect(fixture.received.slice(count).map((call) => call.body.model)).toEqual([
    'fixture-model',
    'fixture-model',
  ]);

  const reference = file('reference.png', 'image/png', fixture.png);
  const edit = await read(
    'Make the lights warmer',
    [
      step('edit', 'gpt-image-2.6-flare', 'image-edit', 'image', {
        inputs: [{ kind: 'attachment', id: reference.id }],
      }),
    ],
    [reference],
  );
  expect(edit.bytes).toEqual([fixture.png]);
  expect(fixture.mediaReceived.at(-1)).toMatchObject({
    path: '/v1/images/edits',
    authorization: 'Bearer test-only-key',
  });
  expect(fixture.mediaReceived.at(-1)?.body).toContain('name="image[]"');
});
it('runs dependent transcription, speech, and downloadable text through authorized result references', async () => {
  const recording = file('recording.wav', 'audio/wav', fixture.wav);
  const result = await read(
    'Transcribe this and make a reading and a text file',
    [
      step('transcript', 'gpt-transcribe', 'transcription', 'text', {
        inputs: [{ kind: 'attachment', id: recording.id }],
      }),
      step('audio', 'tts-1', 'speech', 'audio', {
        dependsOn: ['transcript'],
        inputs: [{ kind: 'result', stepId: 'transcript' }],
      }),
      step('file', '', 'create-file', 'file', {
        target: { kind: 'tool', tool: 'create_text_artifact', model: null },
        instructions: 'transcript.txt',
        dependsOn: ['transcript'],
        inputs: [{ kind: 'result', stepId: 'transcript' }],
      }),
    ],
    [recording],
  );
  expect(result.events.at(-1)?.type).toBe('completed');
  expect(result.assets.map((asset) => asset.mimeType)).toEqual(
    expect.arrayContaining(['text/plain', 'audio/wav']),
  );
  expect(result.bytes).toContainEqual(fixture.wav);
  expect(result.bytes).toContainEqual(Buffer.from('A transcript from the uploaded audio.'));
  expect(fixture.mediaReceived.slice(-2).map((call) => call.path)).toEqual([
    '/v1/audio/transcriptions',
    '/v1/audio/speech',
  ]);
});
it('supports Realtime speech and vision using adapter metadata', async () => {
  const attachment = file('picture.png', 'image/png', fixture.png);
  const result = await read(
    'Describe the picture and read your description out loud',
    [
      step('vision', 'test-model', 'vision', 'text', {
        inputs: [{ kind: 'attachment', id: attachment.id }],
      }),
      step('spoken', 'gpt-realtime-2.1-mini', 'speech', 'audio', {
        dependsOn: ['vision'],
        inputs: [{ kind: 'result', stepId: 'vision' }],
      }),
    ],
    [attachment],
  );
  expect(result.events.at(-1)?.type).toBe('completed');
  expect(result.bytes[0].subarray(0, 4).toString()).toBe('RIFF');
  expect(
    [...fixture.received].reverse().find((call) => call.body.model === 'test-model')?.body.tools,
  ).toBeUndefined();
  expect(fixture.voiceReceived.some((event) => event.type === 'response.create')).toBe(true);
});
it('rejects a disabled target, a cycle, and a fabricated attachment before dispatch', async () => {
  const snapshot = config();
  snapshot.connections[0].models.find((model) => model.id === 'gpt-image-2.6-flare')!.enabled =
    false;
  registry.install(snapshot);
  const count = fixture.mediaReceived.length;
  const disabled = await read('Draw the first scene', [
    step('image', 'gpt-image-2.6-flare', 'image', 'image'),
  ]);
  expect(disabled.text).toContain('unavailable for this capability');
  const cyclic = await read('Handle these tasks', [
    step('a', 'test-model', 'chat', 'text', { dependsOn: ['b'] }),
    step('b', 'test-model', 'chat', 'text', { dependsOn: ['a'] }),
  ]);
  expect(cyclic.text).toContain('cyclic dependency');
  const fabricated = await read('Analyze that file', [
    step('vision', 'test-model', 'vision', 'text', {
      inputs: [{ kind: 'attachment', id: randomUUID() }],
    }),
  ]);
  expect(fabricated.text).toContain('outside this turn');
  expect(fixture.mediaReceived).toHaveLength(count);
});
it('dispatches parallel steps, aborts both on disconnect, and never substitutes a failed image model', async () => {
  const controller = new AbortController();
  const count = fixture.mediaReceived.length;
  const cancelled = fixture.cancelled;
  const { response } = await submit(
    'Make a diptych',
    [
      step('one', 'gpt-image-2.6-flare', 'image', 'image', { instructions: '[slow] left panel' }),
      step('two', 'gpt-image-2.6-flare', 'image', 'image', { instructions: '[slow] right panel' }),
    ],
    [],
    controller.signal,
  );
  await vi.waitFor(() => expect(fixture.mediaReceived).toHaveLength(count + 2));
  controller.abort();
  await response.body?.cancel().catch(() => undefined);
  await vi.waitFor(() => expect(fixture.cancelled).toBeGreaterThanOrEqual(cancelled + 2));
  const result = await read('Produce a detailed image', [
    step('image', 'gpt-image-2.6-flare', 'image', 'image', {
      instructions: '[fail] Test error redaction.',
    }),
  ]);
  expect(result.events.at(-1)).toMatchObject({
    type: 'failed',
    run: { billableChildStarted: true },
  });
  expect(JSON.stringify(result.events)).not.toContain('secret-response-text');
  expect(fixture.mediaReceived).toHaveLength(count + 3);
});
it('deduplicates equivalent operations and reports a missing capability without dispatch', async () => {
  const count = fixture.mediaReceived.length;
  const deduplicated = await read('Produce one image', [
    step('first', 'gpt-image-2.6-flare', 'image', 'image'),
    step('duplicate', 'gpt-image-2.6-flare', 'image', 'image'),
  ]);
  expect(deduplicated.events.at(-1)).toMatchObject({ type: 'completed', partial: true });
  expect(deduplicated.assets).toHaveLength(1);
  expect(fixture.mediaReceived).toHaveLength(count + 1);

  const snapshot = config();
  snapshot.connections[0].models.find((model) => model.id === 'gpt-image-2.6-flare')!.enabled =
    false;
  registry.install(snapshot);
  fixture.queueTool('Show a city', 'report_unavailable', { capability: 'image' });
  const unavailable = await read('Show a city');
  expect(unavailable.events.at(-1)).toMatchObject({ type: 'failed', settingsHelp: true });
  expect(unavailable.text).toContain('Enable a compatible image');
  expect(fixture.mediaReceived).toHaveLength(count + 1);
});
it('blocks a model-requested replacement after a failed provider operation', async () => {
  const snapshot = config();
  snapshot.crossConnection = true;
  snapshot.connections.push({
    ...snapshot.connections[0],
    id: secondId,
    name: 'Second',
    apiKey: 'second-key',
  });
  registry.install(snapshot);
  const prompt = 'Design a coastal illustration';
  fixture.continueWithTool(prompt, 'execute_steps', {
    steps: [
      step('replacement', 'gpt-image-2.6-flare', 'image', 'image', {
        target: { kind: 'model', model: `${secondId}:gpt-image-2.6-flare` },
      }),
    ],
  });
  const count = fixture.mediaReceived.length;
  const result = await read(prompt, [
    step('original', 'gpt-image-2.6-flare', 'image', 'image', {
      instructions: '[fail] illustration',
    }),
  ]);
  expect(result.events.at(-1)).toMatchObject({ type: 'failed' });
  expect(result.text).toContain('That capability already failed');
  expect(fixture.mediaReceived).toHaveLength(count + 1);
});
it('reads a native text attachment and prevents its contents from crossing connections in a later step', async () => {
  const snapshot = config();
  snapshot.crossConnection = true;
  snapshot.connections.push({
    ...snapshot.connections[0],
    id: secondId,
    name: 'Second',
    apiKey: 'second-key',
  });
  registry.install(snapshot);
  const prompt = 'Read the note and consider the next action';
  const attachment = file('notes.txt', 'text/plain', Buffer.from('Private attachment contents'));
  fixture.continueWithTool(prompt, 'execute_steps', {
    steps: [
      step('share', 'test-model', 'chat', 'text', {
        target: { kind: 'model', model: `${secondId}:test-model` },
        instructions: 'Summarize Private attachment contents.',
      }),
    ],
  });
  const count = fixture.received.length;
  const result = await read(
    prompt,
    [
      step('read', '', 'read-file', 'text', {
        target: { kind: 'tool', tool: 'read_attachment', model: null },
        inputs: [{ kind: 'attachment', id: attachment.id }],
      }),
    ],
    [attachment],
  );
  expect(result.text).toContain('restrict attachment transfer');
  expect(
    fixture.received
      .slice(count)
      .every((request) => request.authorization === 'Bearer test-only-key'),
  ).toBe(true);
  expect(fixture.received.slice(count)[1]?.body.messages.at(-1)?.content).toContain(
    'Private attachment contents',
  );
});

it('isolates duplicate provider model IDs by connection and enforces cross-connection attachment policy', async () => {
  const snapshot = config();
  snapshot.crossConnection = true;
  snapshot.connections.push({
    ...snapshot.connections[0],
    id: secondId,
    name: 'Second',
    apiKey: 'second-key',
  });
  registry.install(snapshot);
  const delegate = { kind: 'model' as const, model: `${secondId}:test-model` };
  await read('Get a second opinion', [
    step('other', 'test-model', 'chat', 'text', { target: delegate }),
  ]);
  expect(
    [...fixture.received].reverse().find((call) => call.body.model === 'test-model')?.authorization,
  ).toBe('Bearer second-key');
  const attachment = file('picture.png', 'image/png', fixture.png);
  const result = await read(
    'Describe this on the other connection',
    [
      step('vision', 'test-model', 'vision', 'text', {
        target: delegate,
        inputs: [{ kind: 'attachment', id: attachment.id }],
      }),
    ],
    [attachment],
  );
  expect(result.text).toContain('restrict attachment transfer');
  const call = [...fixture.received].reverse().find((call) => call.body.model === 'test-model');
  expect(call?.body.messages).toHaveLength(2);
});
it('searches with the explicitly chosen OpenAI model and feeds sourced results into image generation', async () => {
  const snapshot = config();
  snapshot.crossConnection = true;
  snapshot.connections.push({
    id: secondId,
    name: 'OpenAI research',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'search-key',
    verified: [],
    webSearch: true,
    models: [{ id: 'gpt-6-luna', enabled: true, delegate: true, declared: [] }],
  });
  registry.install(snapshot);
  const nativeFetch = globalThis.fetch;
  const source = 'https://example.com/study';
  const search = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    if (String(input) === 'https://api.openai.com/v1/models')
      return Response.json({ data: [{ id: 'gpt-6-luna' }] });
    if (String(input) === 'https://api.openai.com/v1/responses') {
      expect(JSON.parse(String(options?.body))).toMatchObject({
        model: 'gpt-6-luna',
        max_tool_calls: 3,
        tools: [expect.objectContaining({ type: 'web_search' })],
      });
      return Response.json({
        id: 'response',
        output: [
          {
            type: 'web_search_call',
            id: 'search',
            status: 'completed',
            action: { type: 'search', query: 'electric cars' },
          },
          {
            type: 'message',
            role: 'assistant',
            id: 'answer',
            content: [
              {
                type: 'output_text',
                text: 'Verified comparison data',
                annotations: [
                  {
                    type: 'url_citation',
                    start_index: 0,
                    end_index: 24,
                    title: 'Study',
                    url: source,
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    return nativeFetch(input, options);
  });
  const result = await read('Compare electric cars and create an infographic', [
    step('research', '', 'web-search', 'sources', {
      target: { kind: 'tool', tool: 'web_search', model: `${secondId}:gpt-6-luna` },
      instructions: 'Compare electric cars.',
    }),
    step('graphic', 'gpt-image-2.6-flare', 'image', 'image', {
      dependsOn: ['research'],
      inputs: [{ kind: 'result', stepId: 'research' }],
    }),
  ]);
  expect(
    search.mock.calls.filter(([input]) => String(input) === 'https://api.openai.com/v1/responses'),
  ).toHaveLength(1);
  expect(result.events).toContainEqual(
    expect.objectContaining({
      type: 'activity',
      activity: expect.objectContaining({
        stepId: 'research',
        sources: [{ url: source, title: 'Study' }],
      }),
    }),
  );
  expect(fixture.mediaReceived.at(-1)?.body).toContain('Verified comparison data');
  expect(result.bytes).toEqual([fixture.png]);
});
it('routes client-delegated GPT-Live requests once through the same primary and returns the spoken result', async () => {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/voice', { headers });
  const events: Record<string, unknown>[] = [];
  const count = fixture.received.length;
  ws.on('message', (data) => events.push(JSON.parse(data.toString())));
  try {
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        sessionId: 'live',
        conversationId: 'voice',
        assistantMessageId: 'assistant',
        messages: [{ role: 'user', content: 'Earlier context' }],
      }),
    );
    await vi.waitFor(() => expect(events.some((event) => event.type === 'ready')).toBe(true));
    ws.send(JSON.stringify({ type: 'audio', audio: Buffer.alloc(960).toString('base64') }));
    await vi.waitFor(() =>
      expect(
        [...fixture.voiceReceived]
          .reverse()
          .find((event) => event.type === 'session.commentary.append'),
      ).toMatchObject({
        delegation_id: 'fixture-delegation',
        content: expect.stringContaining('test provider'),
      }),
    );
    expect(fixture.received.slice(count)).toHaveLength(1);
    expect(fixture.received.at(-1)?.body).toMatchObject({
      model: 'fixture-model',
      messages: expect.arrayContaining([{ role: 'user', content: 'Hello from my microphone.' }]),
    });
    expect(
      [...fixture.voiceReceived].reverse().find((event) => event.type === 'session.start'),
    ).toMatchObject({ session: { store: false, delegation: { type: 'client' } } });
    ws.send(JSON.stringify({ type: 'mute', muted: true }));
    await vi.waitFor(() =>
      expect(fixture.voiceReceived.some((event) => event.type === 'session.input_audio.mute')).toBe(
        true,
      ),
    );
    ws.send(JSON.stringify({ type: 'end' }));
    await vi.waitFor(() => expect(events.some((event) => event.type === 'ended')).toBe(true));
  } finally {
    ws.terminate();
  }
  const unauthorized = new WebSocket(url.replace('http:', 'ws:') + '/voice');
  await new Promise<void>((resolve) => unauthorized.on('error', () => resolve()));
  unauthorized.terminate();
});
