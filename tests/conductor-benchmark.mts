import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createProviderFixture } from './provider-fixture.ts';

// Run against a compiled API from the checkout being measured.
const require = createRequire(import.meta.url);
const fixture = await createProviderFixture();
Object.assign(process.env, {
  OPENAI_BASE_URL: fixture.baseUrl,
  OPENAI_API_KEY: 'test-only-key',
  OPENAI_MODEL: 'test-model',
  ARIA_INTERNAL_TOKEN: 'test-only-token',
  ARIA_MANAGED: '0',
  ARIA_TOOL_DISCOVERY: 'aria',
});
const start = performance.now();
const app = await require('../apps/api/dist/main.js').createApi();
app.useLogger(false);

try {
  await app.listen(0, '127.0.0.1');
  const startupMs = performance.now() - start;
  const url = `${await app.getUrl()}/chat/stream`;
  async function run(discovery: boolean) {
    const requestId = randomUUID();
    const content = discovery ? `Fixture capability lookup ${requestId}` : 'What color is the Moon?';
    if (discovery) fixture.queueTool(content, 'find_capabilities', { query: 'artifact' });
    const before = fixture.received.length;
    const begin = performance.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-only-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId, conversationId: 'fixture-chat', assistantMessageId: requestId,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!response.ok || !response.body) throw new Error(`Chat returned ${response.status}.`);
    let firstToken: number | undefined;
    let firstActivity: number | undefined;
    let completed = false;
    let buffer = '';
    for await (const fragment of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += fragment;
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === 'delta') firstToken ??= performance.now() - begin;
        if (event.type === 'activity') firstActivity ??= performance.now() - begin;
        if (event.type === 'completed') completed = true;
        if (event.type === 'failed') throw new Error(event.error);
      }
    }
    if (!completed) throw new Error('Chat did not finish.');
    const requests = fixture.received.slice(before);
    return {
      total: performance.now() - begin,
      firstToken,
      firstActivity,
      requests: requests.length,
      wireBytes: requests.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.body)), 0),
    };
  }

  const cold = await run(false);
  for (let index = 0; index < 3; index++) {
    await run(false);
    await run(true);
  }
  const before = process.resourceUsage();
  const ordinary: Awaited<ReturnType<typeof run>>[] = [];
  const discovery: typeof ordinary = [];
  for (let index = 0; index < 20; index++) {
    ordinary.push(await run(false));
    discovery.push(await run(true));
  }
  const after = process.resourceUsage();
  function summary(items: typeof ordinary) {
    return Object.fromEntries(Object.keys(items[0]).flatMap((name) => {
      const values = items.map((item) => item[name as keyof typeof item])
        .filter((value): value is number => value !== undefined).sort((a, b) => a - b);
      if (!values.length) return [];
      return [[name, {
        p50: Number(values[Math.ceil(values.length * 0.5) - 1].toFixed(2)),
        p95: Number(values[Math.ceil(values.length * 0.95) - 1].toFixed(2)),
      }]];
    }));
  }
  console.log(JSON.stringify({
    startupMs, cold, samplesPerScenario: ordinary.length,
    ordinary: summary(ordinary), discovery: summary(discovery),
    cpuMs: (after.userCPUTime + after.systemCPUTime - before.userCPUTime - before.systemCPUTime) / 1000,
    rssBytes: process.memoryUsage().rss,
  }, null, 2));
} finally {
  await app.close();
  await fixture.close();
}
