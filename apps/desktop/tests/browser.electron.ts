import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createProviderFixture } from '../../../tests/provider-fixture';
import type { ExecutionStep } from '@aria/shared';

const root = path.resolve(__dirname, '..');
const host = 'aria-fixture.example';
const ip = '93.184.216.34';
const url = `http://${host}/study`;

test('reads a public publisher and searches Brave through the built browser', async () => {
  test.skip(process.env.ARIA_RUN_PUBLIC_BROWSER_SMOKE !== '1', 'Requires reachable public sites.');
  const provider = await createProviderFixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-public-browser-'));
  let app: ElectronApplication | undefined;
  try {
    const env = {
      ...process.env,
      ARIA_TEST_DATA_DIR: directory,
      OPENAI_BASE_URL: provider.baseUrl,
      OPENAI_MODEL: 'fixture-model',
      OPENAI_API_KEY: 'test-only-key',
    };
    delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [root], env });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20_000 })
      .toMatchObject({ state: 'ready' });
    await page.evaluate(async () => {
      await window.aria!.importRegistryEnvironment();
      const { warning, ...policy } = await window.aria!.webSettings();
      if (warning) throw new Error('Could not load temporary web settings.');
      await window.aria!.saveWebSettings({ ...policy, aiBrowser: true });
    });
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()))
      .toMatchObject({ state: 'ready', configured: true });
    const ask = async (prompt: string, step: ExecutionStep) => {
      provider.queueOperations(prompt, { steps: [step] });
      let received: unknown;
      provider.onToolResult(prompt, (value) => {
        received = value;
        return undefined;
      });
      await page.getByRole('textbox', { name: 'Message Aria' }).fill(prompt);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect.poll(() => received, { timeout: 25_000 }).toBeDefined();
      return received;
    };
    const publisher = 'https://example.com/';
    const fetched = await ask(`Read ${publisher}`, {
      id: 'publisher', target: { kind: 'tool', tool: 'web_fetch', model: null },
      capability: 'web_fetch', instructions: 'Read the public publisher', summary: 'Read publisher',
      inputs: [], dependsOn: [], output: 'data', args: { url: publisher },
    });
    expect(fetched).toEqual([expect.objectContaining({
      status: 'completed',
      sources: [expect.objectContaining({ url: publisher, title: 'Example Domain' })],
    })]);
    await expect(page.locator('.from-assistant').last()).toHaveAttribute('data-status', 'completed');
    const searched = await ask('Search for the IANA example domains page', {
      id: 'search', target: { kind: 'tool', tool: 'web_search', model: null },
      capability: 'web-search', instructions: 'Search for IANA example domains', summary: 'Search the web',
      inputs: [], dependsOn: [], output: 'data', args: { query: 'IANA example domains' },
    });
    expect(searched).toEqual([expect.objectContaining({
      status: 'completed', data: expect.objectContaining({ status: 'results', results: expect.any(Array) }),
    })]);
  } finally {
    await app?.close();
    await provider.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function testTone() {
  const rate = 8_000;
  const samples = rate * 5;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(rate, 24);
  wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++)
    wave.writeInt16LE(
      Math.round(256 * Math.sin((index * 2 * Math.PI * 440) / rate)),
      44 + index * 2,
    );
  return wave;
}

test('browses from ordinary chat through the managed private port and keeps private destinations out', async () => {
  const provider = await createProviderFixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-browser-electron-'));
  const traffic: string[] = [];
  const site = http.createServer((request, response) => {
    traffic.push(request.url || '');
    if (request.url === '/music') {
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          '<title>Instrumental fixture</title><audio controls autoplay src="/tone.wav"></audio>',
        );
    } else if (request.url === '/tone.wav') {
      const wave = testTone();
      response
        .writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wave.length })
        .end(wave);
    } else if (request.url === '/redirect') {
      response.writeHead(302, { Location: 'http://127.0.0.1/' }).end();
    } else if (request.url === '/next') {
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<title>Next page</title><p>Another page</p>');
    } else {
      response
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          '<title>Aria research fixture</title><main><h1>Research evidence</h1>' +
            '<p>The sample contains 42 measurements.</p><p hidden>secret-hidden-value</p>' +
            '<a href="/next">Next page</a><button style="position:absolute;left:100px;top:180px;width:180px;height:40px">Ready for input</button></main>' +
            '<script>document.querySelector("button").onclick=()=>{document.querySelector("button").textContent="Fixture received input";fetch("/unexpected-action").catch(()=>{})}</script>' +
            `<img src="http://127.0.0.1:${port}/private-canary" alt="">`,
        );
    }
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const port = (site.address() as { port: number }).port;
  let app: ElectronApplication | undefined;
  try {
    const env = {
      ...process.env,
      ARIA_TEST_DATA_DIR: directory,
      OPENAI_MODEL: 'fixture-model',
      OPENAI_API_KEY: 'test-only-key',
      OPENAI_BASE_URL: provider.baseUrl,
      ARIA_SYSTEM_PROMPT: '',
    };
    delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [root], env });
    // Route just one public fixture hostname after normal validation. The app has no fixture bypass.
    await app.evaluate(
      ({ session }, { host, ip, port }) => {
        const fromPartition = session.fromPartition.bind(session);
        session.fromPartition = (name, options) => {
          const profile = fromPartition(name, options);
          if (name.startsWith('aria-ai-')) {
            profile.protocol.handle('https', (request) => {
              const address = new URL(request.url);
              if (
                address.origin === 'https://search.brave.com' &&
                address.pathname === '/search' &&
                ['semaphore definition', 'public instrumental audio'].includes(
                  address.searchParams.get('q') ?? '',
                )
              ) {
                const path =
                  address.searchParams.get('q') === 'public instrumental audio' ? 'music' : 'study';
                return new Response(
                  '<title>Aria search fixture</title><main>' +
                    '<div data-type="ad"><div class="result-content"><a href="https://example.com/ad">Ad</a></div></div>' +
                    '<div data-type="web"><div class="result-content">' +
                    '<a href="http://' +
                    host +
                    `/${path}">Aria research fixture</a></div></div></main>`,
                  { headers: { 'Content-Type': 'text/html' } },
                );
              }
              return profile.fetch(request, { bypassCustomProtocolHandlers: true });
            });
          }
          return profile;
        };
        const dns = process.getBuiltinModule('node:dns/promises');
        const http = process.getBuiltinModule('node:http');
        if (!dns || !http) throw new Error('Node modules are unavailable.');
        const lookup = dns.lookup;
        const request = http.request;
        Object.assign(dns, {
          lookup: (name: string, options: { all?: boolean }) =>
            name === host ? Promise.resolve([{ address: ip, family: 4 }]) : lookup(name, options),
        });
        Object.assign(http, {
          request: (...args: Parameters<typeof request>) => {
            const options = args[0] as unknown;
            if (
              options &&
              typeof options === 'object' &&
              'host' in options &&
              options.host === ip &&
              'headers' in options &&
              (options.headers as { host?: string }).host === host
            ) {
              Object.assign(options, { host: '127.0.0.1', port });
            }
            return Reflect.apply(request, http, args);
          },
        });
      },
      { host, ip, port },
    );

    const page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20_000 })
      .toMatchObject({ state: 'ready' });
    await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await page.evaluate(async () => {
      const settings = await window.aria!.webSettings();
      const { warning, ...policy } = settings;
      if (warning) throw new Error('Expected fresh web settings.');
      await window.aria!.saveWebSettings({
        ...policy,
        aiBrowser: true,
        history: true,
        restoreTabs: true,
      });
    });
    await expect
      .poll(() => page.evaluate(() => window.aria!.chatStatus()))
      .toMatchObject({ state: 'ready', configured: true });
    const prompt = `Open and read ${url}`;
    const step = (
      id: string,
      op: 'browser_open' | 'browser_get_page' | 'browser_extract',
      args: Record<string, unknown>,
      dependsOn: string[] = [],
    ): ExecutionStep => ({
      id,
      target: { kind: 'tool', tool: op, model: null },
      capability: op,
      instructions: op,
      summary: op,
      inputs: [],
      args,
      dependsOn,
      output: 'data',
    });
    const resultSeen: string[] = [];
    provider.queueOperations(prompt, { steps: [step('open', 'browser_open', { url })] });
    provider.onToolResult(prompt, (result) => {
      if (!Array.isArray(result) || !result[0]?.data) return;
      const { id, data } = result[0];
      resultSeen.push(id);
      if (id === 'open')
        return {
          name: 'fixture_operations',
          input: { steps: [step('observe', 'browser_get_page', { tabId: data.tabId }, [id])] },
        };
      if (id === 'observe')
        return {
          name: 'fixture_operations',
          input: {
            steps: [
              step(
                'extract',
                'browser_extract',
                { tabId: data.tabId, documentId: data.documentId },
                [id],
              ),
            ],
          },
        };
    });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => [...resultSeen], { timeout: 20_000 })
      .toEqual(['open', 'observe', 'extract']);
    const sources = page.getByRole('navigation', { name: 'Research sources' });
    await expect(
      sources.getByRole('button', { name: 'Aria research fixture', exact: true }),
    ).toBeVisible();
    expect(provider.received.at(-1)?.body.messages.at(-1)?.content).toContain('42 measurements');
    expect(provider.received.at(-1)?.body.messages.at(-1)?.content).not.toContain(
      'secret-hidden-value',
    );
    expect(traffic).toContain('/study');
    await sources.getByRole('button', { name: 'Aria research fixture', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Address or search' })).toHaveValue(url);
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow, WebContentsView }) => {
          const main = BrowserWindow.getAllWindows()[0];
          const child = main.contentView.children.find(
            (view) => view instanceof WebContentsView && view.webContents !== main.webContents,
          );
          return child?.getBounds().height ?? 0;
        }),
      )
      .toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message Aria' })).toBeHidden();
    await page.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message Aria' })).toBeVisible();

    const remote = await app.evaluate(({ BrowserWindow, WebContentsView }) => {
      const main = BrowserWindow.getAllWindows()[0];
      const child = main.contentView.children.find(
        (view) => view instanceof WebContentsView && view.webContents !== main.webContents,
      );
      if (!(child instanceof WebContentsView))
        throw new Error('The personal page view is missing.');
      return child.webContents.executeJavaScript(`
        window.getSelection().selectAllChildren(document.querySelector('p'));
        ({ bridge: typeof window.aria, node: typeof process })
      `);
    });
    expect(remote).toEqual({ bridge: 'undefined', node: 'undefined' });
    await page.getByRole('button', { name: 'Share selection', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Share with Aria' })).toContainText(
      '42 measurements',
    );
    await page.getByRole('button', { name: 'Add to draft', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message Aria' })).toHaveValue(
      'Website selection:\n> The sample contains 42 measurements.',
    );

    await expect(page.getByRole('dialog', { name: 'Share with Aria' })).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Message Aria' })).toBeFocused();
    const address = page.getByRole('textbox', { name: 'Address or search' });
    await address.fill(`http://${host}/redirect`);
    await address.press('Enter');
    await expect(page.locator('.browser-status[role="alert"]')).toBeVisible();
    expect(traffic).toContain('/redirect');
    expect(traffic).not.toContain('/private-canary');
    const state = await page.evaluate(() => window.aria!.browserState());
    expect(state.history.some(({ url }) => url.includes('127.0.0.1'))).toBe(false);
    expect(state.history.some((entry) => entry.url === url)).toBe(true);

    const lookup = 'Look up what semaphore means.';
    const tool = (
      tool: 'web_search' | 'web_fetch',
      args: Record<string, unknown>,
      dependsOn: string[] = [],
    ): ExecutionStep => ({
      id: tool,
      capability: tool === 'web_search' ? 'web-search' : tool,
      target: { kind: 'tool', tool, model: null },
      args,
      dependsOn,
      inputs: [],
      instructions: tool,
      summary: tool,
      output: 'data',
    });
    const searchResults: string[] = [];
    provider.queueOperations(lookup, {
      steps: [step('guess', 'browser_open', { url: 'https://example.com/guessed' })],
    });
    provider.onToolResult(lookup, (result) => {
      if (!Array.isArray(result)) return;
      const step = result[0];
      if (step.id === 'guess' && step.status === 'failed') {
        searchResults.push(step.error);
        return {
          name: 'fixture_operations',
          input: { steps: [tool('web_search', { query: 'semaphore definition' })] },
        };
      }
      if (
        step.id === 'web_search' &&
        step.status === 'completed' &&
        step.data.results?.length === 1
      ) {
        searchResults.push(step.data.results[0].url);
        return {
          name: 'fixture_operations',
          input: {
            steps: [tool('web_fetch', { sourceId: step.data.results[0].sourceId }, ['web_search'])],
          },
        };
      }
      if (step.id === 'web_fetch' && step.status === 'completed')
        searchResults.push(step.data.preview);
    });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(lookup);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => searchResults)
      .toEqual([
        expect.stringContaining('web_search with a query first'),
        url,
        expect.stringContaining('42 measurements'),
      ]);
    expect((await page.evaluate(() => window.aria!.browserState())).tabs).toHaveLength(
      state.tabs.length,
    );

    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
    const computerPrompt = `Use the computer to interact with ${url}`;
    expect(
      await page.evaluate(() => window.aria!.setNativeRuntime('computer-image', true)),
    ).toContain('computer-image');
    const computer = (id: string, operation: string, args: Record<string, unknown>) => ({
      ...step(id, 'browser_open', args),
      capability: operation,
      target: { kind: 'tool' as const, tool: operation, model: null },
    });
    await app.evaluate(({ dialog }) => {
      const show = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = ((...args: Parameters<typeof show>) => {
        if (
          args.some(
            (part) => 'message' in part && part.message === 'Allow this computer action once?',
          )
        )
          return Promise.resolve({ response: 1, checkboxChecked: false });
        return show(...args);
      }) as typeof show;
    });
    const computerResults: Record<string, unknown> = {};
    const computerTools = [
      'browser.browser_open',
      'computer.open',
      'computer.observe',
      'computer.act',
    ];
    provider.queueTool(computerPrompt, 'find_capabilities', {
      ids: computerTools,
      kind: 'tools',
      query: '',
    });
    provider.queueTool(computerPrompt, 'load_capabilities', { ids: computerTools });
    provider.queueOperations(computerPrompt, { steps: [step('open', 'browser_open', { url })] });
    provider.onToolResult(computerPrompt, (result) => {
      if (!Array.isArray(result) || !result[0]) return;
      const { id, data, status, error } = result[0];
      computerResults.last = id;
      if (status !== 'completed') {
        computerResults.failure = error;
        return;
      }
      if (id === 'open')
        return {
          name: 'fixture_operations',
          input: {
            steps: [
              computer('start', 'computer.open', {
                environment: 'managed-browser',
                mode: 'aria',
                tabId: data.tabId,
              }),
            ],
          },
        };
      if (id === 'start')
        return {
          name: 'fixture_operations',
          input: {
            steps: [
              computer('inspect', 'computer.observe', {
                sessionId: data.sessionId,
                format: 'image',
              }),
            ],
          },
        };
      if (id === 'inspect')
        return {
          name: 'fixture_operations',
          input: {
            steps: [
              computer('act', 'computer.act', {
                sessionId: data.observation.sessionId,
                observationId: data.observation.id,
                actions: [
                  {
                    type: 'click',
                    button: 'left',
                    x: Math.round(
                      (165 * data.observation.screenshot.width) / data.observation.width,
                    ),
                    y: Math.round(
                      (198 * data.observation.screenshot.height) / data.observation.height,
                    ),
                  },
                ],
              }),
            ],
          },
        };
      if (id === 'act') {
        computerResults.outcomes = data.outcomes;
        computerResults.elements = data.observation.state.elements;
      }
    });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(computerPrompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => computerResults, { timeout: 20_000 })
      .toMatchObject({
        outcomes: [{ index: 0, action: 'click', status: 'submitted' }],
        elements: expect.arrayContaining([
          expect.objectContaining({ label: 'Fixture received input' }),
        ]),
      });
    await expect(page.getByRole('region', { name: 'Computer Use' })).toBeVisible();
    expect(
      provider.received.some(({ body }) =>
        body.messages.some(
          ({ role, content }) =>
            role === 'tool' &&
            Array.isArray(content) &&
            content.some((part) => part.type === 'image_url'),
        ),
      ),
    ).toBe(true);
    expect(traffic).not.toContain('/unexpected-action');
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Computer Use' })).toContainText(
      'You have control',
    );
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Computer Use' })).toBeHidden();

    const playbackPrompt = 'play music';
    const playbackTools = ['web.web_search', 'browser.browser_open', 'browser.browser_media'];
    provider.queueTool(playbackPrompt, 'find_capabilities', {
      ids: playbackTools,
      kind: 'tools',
      query: '',
    });
    provider.queueTool(playbackPrompt, 'load_capabilities', { ids: playbackTools });
    provider.queueOperations(playbackPrompt, {
      steps: [tool('web_search', { query: 'public instrumental audio' })],
    });
    let playbackResult: unknown;
    provider.onToolResult(playbackPrompt, (result) => {
      if (!Array.isArray(result) || !result[0]) return;
      const { id, data, status, error } = result[0];
      if (status !== 'completed') {
        playbackResult = error;
        return;
      }
      if (id === 'web_search')
        return {
          name: 'fixture_operations',
          input: {
            steps: [
              step('open-music', 'browser_open', { sourceId: data.results[0].sourceId }, [id]),
            ],
          },
        };
      if (id === 'open-music')
        return {
          name: 'fixture_operations',
          input: {
            steps: [
              {
                ...step('play', 'browser_open', { tabId: data.tabId, action: 'play' }, [id]),
                capability: 'browser_media',
                target: { kind: 'tool', model: null, tool: 'browser_media' },
              },
            ],
          },
        };
      playbackResult = data.status;
    });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(playbackPrompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => playbackResult).toBe('playing');
    const stopPlayback = page.getByRole('button', { name: 'Stop browser playback' });
    await expect(stopPlayback).toBeVisible();
    expect(traffic).toContain('/tone.wav');
    await stopPlayback.click();
    await expect(stopPlayback).toBeHidden();
    expect(
      await app.evaluate(
        ({ webContents }, target) =>
          webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === target)
            ?.isAudioMuted(),
        `http://${host}/music`,
      ),
    ).toBe(true);
  } finally {
    await app?.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await provider.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
