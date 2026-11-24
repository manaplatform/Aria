import { afterEach, expect, it, vi } from 'vitest';
import {
  defaultWebPolicy,
  normalizeWebDestination,
  publicAddress,
  publicWebUrl,
  resolvePublicAddress,
  type ExecutionStep,
} from '@aria/shared';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { BrowserPortClient } from '../src/web/browser-port.client';
const { ResearchRun } = createRequire(import.meta.url)(
  '../dist/web/web.service.js',
) as typeof import('../src/web/web.service');

afterEach(() => vi.restoreAllMocks());
const signal = AbortSignal.timeout(5000);
const target = {
  kind: 'tool',
  tool: 'web_search',
  model: null,
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

it('routes search and a subsequent HTTP read through the scoped native port', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      text: JSON.stringify({
        results: [
          { url: 'https://example.com/a', title: 'Example' },
          { url: 'https://example.com/a', title: 'Duplicate' },
        ],
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      url: 'https://example.com/a',
      title: 'Example',
      text: JSON.stringify({ url: 'https://example.com/a', status: 200, headers: {}, redirects: [],
        outcome: 'retrieved', text: 'Publisher evidence.' }),
    });
  const run = new ResearchRun(
    {
      requestId: randomUUID(),
      conversationId: 'test',
      messages: [{ role: 'user', content: 'Look up the term semaphore.' }],
    },
    { ...defaultWebPolicy, aiBrowser: true },
    { invoke } as unknown as BrowserPortClient,
  );
  const result = await run.invoke(
    'web_search',
    { query: 'semaphore' },
    searchStep('search'),
    signal,
  );
  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({ op: 'web_search', args: { query: 'semaphore' } }),
    signal,
  );
  expect(result.sources).toMatchObject([{ evidenceStatus: 'discovered', provenance: 'search', producerStepId: 'search' }]);
  const results = result.data?.results as { sourceId: string }[];
  expect(results).toEqual([
    { sourceId: expect.any(String), producerStepId: 'search', url: 'https://example.com/a', title: 'Example' },
  ]);
  const readStep: ExecutionStep = {
    ...searchStep('read'),
    capability: 'web_fetch',
    target: { kind: 'tool', tool: 'web_fetch', model: null },
  };
  await expect(
    run.invoke('web_fetch', { sourceId: results[0].sourceId }, readStep, signal),
  ).rejects.toThrow(/dependency/);
  const document = await run.invoke(
    'web_fetch',
    { sourceId: results[0].sourceId },
    { ...readStep, dependsOn: ['search'] },
    signal,
  );
  expect(invoke).toHaveBeenLastCalledWith(
    expect.objectContaining({ op: 'web_fetch', args: { url: 'https://example.com/a', method: 'GET' } }),
    signal,
  );
  expect(document.sources).toMatchObject([{ url: 'https://example.com/a', provenance: 'publisher' }]);
  expect(document.data?.preview).toBe('Publisher evidence.');
  expect(fetch).not.toHaveBeenCalled();
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
  expect(() => publicWebUrl('http://127.0.0.1/')).toThrow(/private/);
  expect(() => publicWebUrl('http://2130706433/')).toThrow(/private/);
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
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
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
  ).rejects.toMatchObject({ code: 'INVALID_REFERENCE', category: 'DESTINATION_UNVERIFIED' });
});

it('preserves structured browser error codes and messages from ResearchRun', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({
    ok: false,
    code: 'SEARCH_UNAVAILABLE',
    message: 'The search page was unavailable. Try the query in a Personal tab.',
  });
  const run = new ResearchRun(
    {
      requestId: randomUUID(),
      conversationId: 'test',
      messages: [{ role: 'user', content: 'Look up Aria.' }],
    },
    { ...defaultWebPolicy, aiBrowser: true },
    { invoke } as unknown as BrowserPortClient,
  );
  await expect(
    run.invoke('web_search', { query: 'Aria' }, searchStep('search'), signal),
  ).rejects.toMatchObject({
    code: 'EXECUTION_FAILED',
    category: 'SEARCH_UNAVAILABLE',
    message: 'The search page was unavailable. Try the query in a Personal tab.',
  });
});

it('recognizes user URLs from earlier messages, steered updates, bare domains, and balanced parens while reporting missing dependency IDs', async () => {
  const invoke = vi.fn().mockResolvedValue({
    ok: true,
    url: 'https://en.wikipedia.org/wiki/Semaphore_(programming)',
    title: 'Semaphore',
    text: JSON.stringify({ url: 'https://en.wikipedia.org/wiki/Semaphore_(programming)',
      status: 200, headers: {}, redirects: [], outcome: 'retrieved', text: 'Evidence text.' }),
  });
  const run = new ResearchRun(
    {
      requestId: randomUUID(),
      conversationId: 'test',
      messages: [
        { role: 'user', content: 'Start with https://en.wikipedia.org/wiki/Semaphore_(programming)' },
        { role: 'assistant', content: 'Let me know what to open.' },
        { role: 'user', content: 'Now check docs.example.com/guide and open Wikipedia.' },
      ],
    },
    { ...defaultWebPolicy, aiBrowser: true },
    { invoke } as unknown as BrowserPortClient,
  );
  run.observeUserMessage('Also inspect https://steered.example/notes:');
  const fetchStep: ExecutionStep = {
    ...searchStep('fetch'),
    target: { kind: 'tool', tool: 'web_fetch', model: null },
    capability: 'web_fetch',
  };
  await expect(
    run.invoke('web_fetch', { url: 'https://en.wikipedia.org/wiki/Semaphore_(programming)' }, fetchStep, signal),
  ).resolves.toMatchObject({ data: { preview: 'Evidence text.' } });
  expect(
    run.destination({ url: 'https://docs.example.com/guide' }, []),
  ).toBe('https://docs.example.com/guide');
  expect(
    run.destination({ url: 'https://steered.example/notes' }, []),
  ).toBe('https://steered.example/notes');
  run.observeSources(
    [{ id: '11111111-1111-4111-8111-111111111111', url: 'https://result.example/page', title: 'Page' }],
    'search-step-1',
  );
  expect(() =>
    run.destination({ sourceId: '11111111-1111-4111-8111-111111111111' }, []),
  ).toThrow(/dependsOn: \["search-step-1"\]/);
});

it('scopes opaque sources to their execution and authorizes only exact URLs and standard site documents', () => {
  const context = {
    conversationId: 'test',
    messages: [{ role: 'user' as const, content: 'Open zoomit.ir and https://manadev.net/#/about' }],
  };
  const first = new ResearchRun({ ...context, requestId: randomUUID() }, defaultWebPolicy);
  const next = new ResearchRun({ ...context, requestId: randomUUID() }, defaultWebPolicy);
  const sourceId = randomUUID();
  first.observeSources([{ id: sourceId, url: 'https://example.com/research', title: 'Evidence' }], 'producer');
  expect(first.destination({ sourceId }, ['producer'])).toBe('https://example.com/research');
  expect(() => first.destination({ sourceId }, ['wrong-producer'])).toThrow(/producer/);
  expect(() => next.destination({ sourceId }, ['producer'])).toThrow(/current execution/);
  expect(next.destination({ url: 'zoomit.ir' }, [])).toBe('https://zoomit.ir/');
  expect(next.destination({ url: 'https://manadev.net/#/about' }, [])).toBe('https://manadev.net/#/about');
  expect(next.destination({ url: 'https://zoomit.ir/robots.txt' }, [], true)).toBe('https://zoomit.ir/robots.txt');
  expect(() => next.destination({ url: 'https://zoomit.ir/robots.txt?other=1' }, [], true)).toThrow();
  expect(() => next.destination({ url: 'https://zoomit.ir/other' }, [], true)).toThrow();
  for (const invalid of ['user@example.com', 'example.com:9000', 'example.com\\private', '127.1', 'file:///tmp/a'])
    expect(() => normalizeWebDestination(invalid), invalid).toThrow();
});
