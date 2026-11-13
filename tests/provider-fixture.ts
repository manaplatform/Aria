import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export const fixtureConnectionId = '10000000-0000-4000-8000-000000000001';
export const fixtureRef = (id: string) => `${fixtureConnectionId}:${id}`;
export const fixtureDescriptors: Record<string, Record<string, unknown>> = {
  'test-model': { capabilities: ['chat', 'tools', 'vision'] },
  'fixture-model': { capabilities: ['chat', 'tools', 'vision'] },
  'gpt-6-luna': { capabilities: ['chat', 'tools', 'vision'] },
  'gpt-image-2.6-flare': { capabilities: ['image', 'image-edit'], transport: 'inline-png' },
  'tts-1': { capabilities: ['speech'], voices: ['alloy'], transport: 'speech-api' },
  'gpt-realtime-2.1-mini': { capabilities: ['speech'], voices: ['marin'], transport: 'realtime' },
  'gpt-transcribe': { capabilities: ['transcription'] },
  'gpt-live-1': { capabilities: ['live'], voices: ['marin'] },
  'unknown-model': {},
};

/** Test-only OpenAI-compatible server. Never imported by application builds. */
export async function createProviderFixture() {
  const received: {
    path: string;
    authorization?: string;
    body: {
      model: string;
      messages: { role: string; content: string }[];
      stream: boolean;
      tools?: unknown[];
      tool_choice?: unknown;
    };
  }[] = [];
  const mediaReceived: { path: string; body: string; authorization?: string }[] = [];
  const voiceReceived: Record<string, unknown>[] = [];
  let models = Object.keys(fixtureDescriptors);
  const toolReplies = new Map<string, { name: string; input: unknown; provisional?: string }[]>();
  const continuedReplies = new Map<string, { name: string; input: unknown }>();
  let livePrompt = 'Hello from my microphone.';
  let catalogStatus = 200;
  let cancelled = 0;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const pcm = Buffer.alloc(4800);
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  let holdSlow = false;
  const server = http.createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += String(chunk);
    if (request.headers.authorization === 'Bearer rejected-key') {
      response
        .writeHead(401, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'secret-rejected-key' } }));
      return;
    }
    if (request.url === '/v1/models') {
      response.writeHead(catalogStatus, { 'Content-Type': 'application/json' }).end(
        JSON.stringify(
          catalogStatus === 200
            ? {
                object: 'list',
                data: models.map((id) => ({
                  id,
                  object: 'model',
                  owned_by: 'fixture',
                  ...fixtureDescriptors[id],
                })),
              }
            : { error: { message: 'secret-catalog-error' } },
        ),
      );
      return;
    }
    if (
      [
        '/v1/images/generations',
        '/v1/images/edits',
        '/v1/audio/speech',
        '/v1/audio/transcriptions',
      ].includes(request.url || '')
    ) {
      mediaReceived.push({
        path: request.url!,
        body: input,
        authorization: request.headers.authorization,
      });
      if (input.includes('[fail]')) {
        response
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'secret-response-text' } }));
        return;
      }
      const finish = () => {
        if (request.url === '/v1/audio/speech')
          response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav);
        else
          response
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(
              JSON.stringify(
                request.url === '/v1/audio/transcriptions'
                  ? { text: 'A transcript from the uploaded audio.' }
                  : { data: [{ b64_json: png.toString('base64') }] },
              ),
            );
      };
      if (input.includes('[slow]')) {
        const timeout = setTimeout(finish, 5000);
        response.on('close', () => {
          clearTimeout(timeout);
          if (!response.writableEnded) cancelled++;
        });
      } else finish();
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(input) as (typeof received)[number]['body'];
    received.push({ path: request.url, authorization: request.headers.authorization, body });
    const last = body.messages.at(-1);
    const prompt =
      typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    const configuredTool =
      body.tool_choice &&
      typeof body.tool_choice === 'object' &&
      'function' in body.tool_choice &&
      (body.tool_choice.function as { name: string }).name === 'verify_connection';
    const userPrompt =
      [...body.messages].reverse().find((item) => item.role === 'user')?.content ?? '';
    const continuation = last?.role === 'tool' && continuedReplies.get(userPrompt);
    if (continuation) continuedReplies.delete(userPrompt);
    const script = configuredTool
      ? { name: 'verify_connection', input: { ok: true } }
      : body.tools?.length
        ? continuation || toolReplies.get(prompt)?.shift()
        : undefined;
    if (script) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const [delta, finish_reason] of [
        [
          { role: 'assistant', content: 'provisional' in script ? script.provisional || '' : '' },
          null,
        ],
        [
          {
            tool_calls: [
              {
                index: 0,
                id: 'tool-fixture-1',
                type: 'function',
                function: { name: script.name, arguments: JSON.stringify(script.input) },
              },
            ],
          },
          null,
        ],
        [{}, 'tool_calls'],
      ])
        response.write(
          `data: ${JSON.stringify({
            id: 'fixture-tool',
            object: 'chat.completion.chunk',
            created: 1,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (prompt.includes('[fail]')) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Rejected test-only-key', type: 'invalid_api_key' } }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const answer =
      last?.role === 'tool'
        ? `Result: ${prompt}`
        : prompt.includes('[long]')
          ? Array.from(
              { length: 55 },
              (_, index) =>
                `Paragraph ${index + 1}. A useful explanation with enough detail to exercise the reading position.\n\n`,
            ).join('')
          : `Hello from the test provider, 🌙.\n\nHere is a **streamed response** to “${prompt}”.\n\n| Idea | Next step |\n| --- | --- |\n| A little clarity | Start a conversation |\n\n\`\`\`typescript\nconst greeting = 'Hello, Aria';\n\`\`\``;
    const chunks = answer.match(/[\s\S]{1,18}/gu) ?? [];
    let index = 0;
    const send = (delta: unknown, finish: string | null = null) =>
      response.write(
        `data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    send({ role: 'assistant', content: '' });
    const timer = setInterval(
      () => {
        if (prompt.includes('[drop]') && index === 2) {
          response.destroy();
          return;
        }
        if (index < chunks.length) send({ content: chunks[index++] });
        else if (!prompt.includes('[slow]') || !holdSlow) {
          clearInterval(timer);
          send({}, 'stop');
          response.end('data: [DONE]\n\n');
        }
      },
      prompt.includes('[slow]') ? 70 : 3,
    );
    response.on('close', () => {
      clearInterval(timer);
      if (!response.writableEnded) cancelled++;
    });
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    if (
      !request.headers.authorization?.startsWith('Bearer ') ||
      request.headers.authorization === 'Bearer rejected-key' ||
      !request.url?.startsWith('/v1/')
    ) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const send = (item: object) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(item));
      };
      let spoke = false;
      ws.on('message', (raw) => {
        const event = JSON.parse(raw.toString());
        voiceReceived.push(event);
        if (event.type === 'session.start') {
          send({ type: 'session.started', session: { id: 'fixture-live' } });
        } else if (event.type === 'session.input_audio.append' && !spoke) {
          spoke = true;
          send({
            type: 'session.input_transcript.delta',
            delta: livePrompt,
            start_ms: 0,
            end_ms: 300,
          });
          send({
            type: 'session.output_transcript.delta',
            delta: 'Hello from GPT-Live.',
            start_ms: 300,
            end_ms: 500,
          });
          send({ type: 'session.output_audio.delta', delta: pcm.toString('base64') });
          const delegation = {
            type: 'session.delegation.created',
            offset_ms: 300,
            delegation: { id: 'fixture-delegation', target: 'client' },
          };
          send(delegation);
          send(delegation);
        } else if (event.type === 'session.close') {
          send({ type: 'session.closed', usage: {} });
          ws.close();
        } else if (event.type === 'session.update') send({ type: 'session.updated', session: {} });
        else if (event.type === 'response.create') {
          send({ type: 'response.output_audio.delta', delta: pcm.toString('base64') });
          send({ type: 'response.done', response: { status: 'completed' } });
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    received,
    mediaReceived,
    voiceReceived,
    png,
    wav,
    queueTool: (prompt: string, name: string, input: unknown, provisional?: string) =>
      toolReplies.set(prompt, [...(toolReplies.get(prompt) ?? []), { name, input, provisional }]),
    continueWithTool: (prompt: string, name: string, input: unknown) =>
      continuedReplies.set(prompt, { name, input }),
    setLivePrompt: (value: string) => {
      livePrompt = value;
    },
    setModels: (value: string[]) => {
      models = value;
    },
    setCatalogStatus: (value: number) => {
      catalogStatus = value;
    },
    holdSlow: () => {
      holdSlow = true;
    },
    releaseSlow: () => {
      holdSlow = false;
    },
    get cancelled() {
      return cancelled;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        sockets.clients.forEach((socket) => socket.terminate());
        sockets.close();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
