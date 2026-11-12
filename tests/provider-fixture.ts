import http from 'node:http';

/** Test-only OpenAI-compatible server. Never imported by application builds. */
export async function createProviderFixture() {
  const received: {
    path: string;
    authorization?: string;
    body: { model: string; messages: { role: string; content: string }[]; stream: boolean };
  }[] = [];
  let cancelled = 0;
  let holdSlow = false;
  const server = http.createServer(async (request, response) => {
    let input = '';
    for await (const chunk of request) input += String(chunk);
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const body = JSON.parse(input) as (typeof received)[number]['body'];
    received.push({ path: request.url, authorization: request.headers.authorization, body });
    const prompt = body.messages.at(-1)?.content ?? '';
    if (prompt.includes('[fail]')) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message: 'Rejected test-only-key', type: 'invalid_api_key' } }),
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const answer = prompt.includes('[long]')
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    received,
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
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
