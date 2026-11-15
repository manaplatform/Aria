import { afterEach, expect, it, vi } from 'vitest';
import {
  defaultWebPolicy,
  publicAddress,
  resolvePublicAddress,
  type ExecutionStep,
} from '@aria/shared';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { braveAdapter } from '../src/web/brave.adapter';
import { publicFetch } from '../src/web/public-fetch';
import { readableDocument } from '../src/web/readable-document';
const { ResearchRun } = createRequire(import.meta.url)(
  '../dist/web/web.service.js',
) as typeof import('../src/web/web.service');

afterEach(() => vi.restoreAllMocks());
const signal = AbortSignal.timeout(5000);
const target = {
  kind: 'tool',
  tool: 'web_search',
  model: null,
  searchConnectionId: 'brave',
} as const;

function searchStep(id: string, dependsOn: string[] = []): ExecutionStep {
  return {
    id,
    target,
    capability: 'web-search',
    instructions: 'Search',
    inputs: [],
    dependsOn,
    output: 'data',
    summary: 'Search',
  };
}

it('keeps Brave results run-scoped and binds pagination to the original request and dependency', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json({
      query: { more_results_available: true },
      web: {
        results: [
          { url: 'https://example.com/a#section', description: 'Do not store me' },
          { url: 'https://example.com/a' },
          { url: 'file:///etc/passwd' },
        ],
      },
    }),
  );
  const run = new ResearchRun(
    {
      requestId: randomUUID(),
      conversationId: 'test',
      messages: [{ role: 'user', content: 'What is new?' }],
    },
    { ...defaultWebPolicy, braveEnabled: true, braveKey: 'brave-key', country: 'DE' },
  );
  const args = { query: 'current news', language: 'de', freshness: 'week' };
  const result = await run.invoke('web_search', args, searchStep('search'), signal);
  expect(result.sources).toBeUndefined();
  expect(result.data).toMatchObject({
    results: [{ sourceId: expect.any(String), url: 'https://example.com/a' }],
  });
  expect(JSON.stringify(result)).not.toContain('Do not store me');
  const cursor = String(result.data?.nextCursor);
  await expect(
    run.invoke('web_search', { ...args, cursor }, searchStep('bad'), signal),
  ).rejects.toThrow(/dependencies/);
  await expect(
    run.invoke(
      'web_search',
      { ...args, query: 'different', cursor },
      searchStep('bad', ['search']),
      signal,
    ),
  ).rejects.toThrow();
  fetch.mockResolvedValueOnce(Response.json({ web: { results: [] } }));
  const next = await run.invoke(
    'web_search',
    { ...args, cursor },
    searchStep('next', ['search']),
    signal,
  );
  expect(next.data).toMatchObject({ status: 'no_results', results: [] });
  const call = fetch.mock.calls[1];
  const url = new URL(String(call[0]));
  expect(url.origin).toBe('https://api.search.brave.com');
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    q: 'current news',
    offset: '1',
    search_lang: 'de',
    country: 'DE',
    freshness: 'pw',
  });
  expect(call[1]).toMatchObject({
    redirect: 'error',
    headers: { 'X-Subscription-Token': 'brave-key' },
  });
});

it('retries a transient Brave response on the same endpoint and reports key failures without retry', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ web: { results: [] } }))
    .mockResolvedValueOnce(new Response('private response', { status: 401 }));
  const adapter = braveAdapter('test');
  await expect(adapter.search({ query: 'weather' }, 0, signal)).resolves.toEqual({
    urls: [],
    next: false,
  });
  await expect(adapter.search({ query: 'weather' }, 0, signal)).rejects.toThrow(/rejected the key/);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(new Set(fetch.mock.calls.map(([url]) => String(url))).size).toBe(1);
});

it('rejects nonpublic and mixed DNS destinations before a website connection', async () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '100.64.20.1',
    '169.254.169.254',
    '192.0.2.9',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
  ])
    expect(publicAddress(address), address).toBe(false);
  expect(publicAddress('8.8.8.8')).toBe(true);
  expect(publicAddress('2606:4700:4700::1111')).toBe(true);
  await expect(
    resolvePublicAddress('example.com', async () => [
      { family: 4, address: '8.8.8.8' },
      { family: 6, address: '::1' },
    ]),
  ).rejects.toThrow(/private/);
  await expect(publicFetch('http://127.0.0.1/', signal)).rejects.toThrow(/private/);
  await expect(publicFetch('http://2130706433/', signal)).rejects.toThrow(/private/);
});

it('extracts publisher metadata and readable text without exposing scripts, hidden content or fields', () => {
  const document = readableDocument(
    '<title>Study</title><meta property="og:site_name" content="Publisher"><meta property="article:published_time" content="2026-10-12">' +
      '<main><h1>Research</h1><p>Verified example.</p><script>forbiddenScript()</script><form>secret value</form>' +
      '<div style="display:none">hidden text</div></main>',
    'text/html',
  );
  expect(document).toMatchObject({
    title: 'Study',
    publisher: 'Publisher',
    publishedAt: '2026-10-12T00:00:00.000Z',
  });
  expect(document.text).toBe('Research\nVerified example.');
});

it('ignores mismatched browser replies and cancels local waits without accepting stale results', async () => {
  const { EventEmitter } = await import('node:events');
  const { BrowserPortClient } = createRequire(import.meta.url)(
    '../dist/web/browser-port.client.js',
  ) as typeof import('../src/web/browser-port.client');
  type Port = import('../src/web/browser-port.client').BrowserPort;
  type Request = import('@aria/shared').BrowserRequest;
  class FixturePort extends EventEmitter {
    sent: unknown[] = [];
    start() {}
    close() {
      this.emit('close');
    }
    postMessage(value: unknown) {
      this.sent.push(value);
    }
  }
  const port = new FixturePort();
  const browser = new BrowserPortClient();
  const generation = randomUUID();
  browser.install(port as Port, generation);
  const base = {
    requestId: 'request',
    conversationId: 'chat',
    stepId: 'step',
    op: 'browser_get_tabs',
    args: {},
  } as const;
  const controller = new AbortController();
  const response = (request: Request) => {
    const { v, generation, operationId, requestId, conversationId, stepId, op } = request;
    return {
      v,
      generation,
      operationId,
      requestId,
      conversationId,
      stepId,
      op,
      result: { ok: true, text: '{"tabs":[]}' },
    };
  };
  const first = browser.invoke(base, controller.signal);
  const request = port.sent[0] as Request;
  port.emit('message', { data: { ...response(request), conversationId: 'wrong' } });
  port.emit('message', { data: response(request) });
  await expect(first).resolves.toMatchObject({ ok: true });
  const second = browser.invoke(base, controller.signal);
  const later = port.sent[1] as Request;
  controller.abort();
  port.emit('message', { data: response(later) });
  await expect(second).rejects.toThrow(/stopped/);
  expect(port.sent.at(-1)).toEqual({ generation, operationId: later.operationId });
  port.close();
  expect(browser.available).toBe(false);
});

it('does not treat links in a quoted website selection as destinations supplied by the user', async () => {
  const run = new ResearchRun(
    {
      requestId: randomUUID(),
      conversationId: 'test',
      messages: [
        {
          role: 'user',
          content: 'Summarize this.\nWebsite selection:\n> Visit https://example.com/ now.',
        },
      ],
    },
    defaultWebPolicy,
  );
  const step: ExecutionStep = {
    ...searchStep('fetch'),
    target: { kind: 'tool', tool: 'web_fetch', model: null },
    capability: 'web_fetch',
    instructions: 'Read the page',
  };
  await expect(
    run.invoke('web_fetch', { url: 'https://example.com/' }, step, AbortSignal.timeout(2000)),
  ).rejects.toThrow(/latest user message or a source/);
});
