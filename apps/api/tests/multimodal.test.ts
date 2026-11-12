import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import WebSocket from 'ws';
import { createProviderFixture } from '../../../tests/provider-fixture';
const { createApi } = createRequire(import.meta.url)(
  '../dist/main.js',
) as typeof import('../src/main');
let fixture: Awaited<ReturnType<typeof createProviderFixture>>;
let app: INestApplication;
let url: string;
const token = 'Bearer multimodal-session';
const headers = { Authorization: token };
beforeAll(async () => {
  fixture = await createProviderFixture();
  vi.stubEnv('OPENAI_BASE_URL', fixture.baseUrl);
  vi.stubEnv('OPENAI_API_KEY', 'test-only-key');
  vi.stubEnv('OPENAI_MODEL', '');
  vi.stubEnv('ARIA_INTERNAL_TOKEN', 'multimodal-session');
  app = await createApi();
  await app.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
afterAll(async () => {
  await app?.close();
  await fixture?.close();
  vi.unstubAllEnvs();
});
const discovery = (body: object) =>
  fetch(`${url}/providers/models`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
it('discovers models using draft credentials before a Chat model is configured and validates the provider', async () => {
  expect((await fetch(`${url}/providers/models`, { method: 'POST' })).status).toBe(401);
  expect(
    (await discovery({ provider: 'anthropic', baseUrl: fixture.baseUrl, apiKey: 'test-only-key' }))
      .status,
  ).toBe(400);
  const response = await discovery({
    provider: 'openai',
    baseUrl: fixture.baseUrl,
    apiKey: 'draft-key',
  });
  expect(response.ok).toBe(true);
  const models = await response.json();
  expect(models).toContainEqual({ id: 'gpt-image-2.6-flare', modes: ['image'] });
  expect(models).toContainEqual({ id: 'gpt-live-1', modes: ['live'] });
  expect(models).toContainEqual({ id: 'fixture-model', modes: [] });
  expect(JSON.stringify(models)).not.toContain('draft-key');
});
it('reports catalog auth failures without returning provider error text', async () => {
  const response = await discovery({
    provider: 'openai',
    baseUrl: fixture.baseUrl,
    apiKey: 'rejected-key',
  });
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain('secret-');
});
async function generate(
  mode: string,
  model: string,
  prompt = '',
  file?: { bytes: Buffer; mime: string; name: string },
) {
  const body = new FormData();
  body.set('mode', mode);
  body.set('model', model);
  body.set('prompt', prompt);
  if (mode === 'speech') body.set('voice', model === 'tts-1' ? 'alloy' : 'marin');
  if (file)
    body.append('files', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
  return fetch(`${url}/media/generate`, { method: 'POST', headers, body });
}
it('generates and edits actual inline PNG files through the configured endpoint', async () => {
  const response = await generate('image', 'gpt-image-2.6-flare', 'A mountain');
  expect(response.headers.get('content-type')).toContain('image/png');
  expect(Buffer.from(await response.arrayBuffer())).toEqual(fixture.png);
  const edited = await generate('image', 'gpt-image-2.6-flare', 'Add snow', {
    bytes: fixture.png,
    mime: 'image/png',
    name: 'reference.png',
  });
  expect(edited.ok).toBe(true);
  await edited.arrayBuffer();
  expect(fixture.mediaReceived.at(-1)?.path).toBe('/v1/images/edits');
  expect(fixture.mediaReceived.at(-1)?.body).toContain('name="image[]"');
  expect(fixture.mediaReceived.at(-1)?.authorization).toBe('Bearer test-only-key');
});
it('generates Speech API and Realtime WAV audio without requiring a text Chat default', async () => {
  const speech = await generate('speech', 'tts-1', 'Read this exactly.');
  expect(speech.ok).toBe(true);
  expect(Buffer.from(await speech.arrayBuffer())).toEqual(fixture.wav);
  const realtime = await generate('speech', 'gpt-realtime-2.1-mini', 'Hello.');
  expect(realtime.ok).toBe(true);
  expect(Buffer.from(await realtime.arrayBuffer()).toString('ascii', 0, 4)).toBe('RIFF');
  expect(fixture.voiceReceived.some((event) => event.type === 'response.create')).toBe(true);
});
it('transcribes uploaded audio and rejects missing inputs, unknown models, and malformed media requests', async () => {
  const response = await generate('transcription', 'gpt-transcribe', '', {
    bytes: fixture.wav,
    mime: 'audio/wav',
    name: 'recording.wav',
  });
  expect(await response.json()).toEqual({ text: 'A transcript from the uploaded audio.' });
  expect((await generate('transcription', 'gpt-transcribe')).status).toBe(400);
  const count = fixture.mediaReceived.length;
  expect((await generate('image', 'not-returned-by-provider', 'hello')).status).toBe(400);
  expect(fixture.mediaReceived).toHaveLength(count);
  const bad = await generate('image', 'gpt-image-2.6-flare', '[fail]');
  expect(bad.status).toBe(502);
  expect(JSON.stringify(await bad.json())).not.toContain('secret-response-text');
});
it('authenticates GPT-Live and relays transcripts, audio, delegation, mute, and graceful close', async () => {
  const ws = new WebSocket(url.replace('http:', 'ws:') + '/voice', { headers });
  const events: Record<string, unknown>[] = [];
  ws.on('message', (data) => events.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send(
    JSON.stringify({
      type: 'start',
      model: 'gpt-live-1',
      chatModel: 'gpt-6-luna',
      voice: 'marin',
      messages: [{ role: 'user', content: 'Earlier context' }],
    }),
  );
  await vi.waitFor(() => expect(events.some((event) => event.type === 'ready')).toBe(true));
  ws.send(JSON.stringify({ type: 'audio', audio: Buffer.alloc(960).toString('base64') }));
  await vi.waitFor(() => expect(events.some((event) => event.type === 'audio')).toBe(true));
  expect(events).toContainEqual({
    type: 'transcript',
    role: 'user',
    text: 'Hello from my microphone.',
    startMs: 0,
    endMs: 300,
  });
  ws.send(JSON.stringify({ type: 'mute', muted: true }));
  await vi.waitFor(() =>
    expect(fixture.voiceReceived.some((event) => event.type === 'session.input_audio.mute')).toBe(
      true,
    ),
  );
  const start = fixture.voiceReceived.find((event) => event.type === 'session.start') as {
    session: { store: boolean; delegation: { responses: { model: string } } };
  };
  expect(start.session.store).toBe(false);
  expect(start.session.delegation.responses.model).toBe('gpt-6-luna');
  ws.send(JSON.stringify({ type: 'end' }));
  await vi.waitFor(() => expect(events.some((event) => event.type === 'ended')).toBe(true));
  ws.close();
  const unauthorized = new WebSocket(url.replace('http:', 'ws:') + '/voice');
  await new Promise<void>((resolve) => unauthorized.on('error', () => resolve()));
  unauthorized.terminate();
});
