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

test('reads a public publisher and searches through the built browser', async () => {
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
        if (received === undefined) received = value;
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
  // Cold Electron and API startup can take half the default budget on hosted runners.
  test.setTimeout(90_000);
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
    } else if (request.url === '/robots.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain' })
        .end(`User-agent: *\nDisallow: /private\nSitemap: http://${host}/sitemap.xml\n`);
    } else if (request.url === '/sitemap.xml') {
      response.writeHead(200, { 'Content-Type': 'application/xml' })
        .end(`<urlset><url><loc>http://${host}/study</loc></url></urlset>`);
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
            '<a href="/next">Next page</a><button style="appearance:none;background:#1e82c8;position:absolute;left:100px;top:180px;width:180px;height:40px">Ready for input</button></main>' +
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
            if (profile.protocol.isProtocolHandled('https')) profile.protocol.unhandle('https');
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
                    Array.from({ length: 8 }, (_, index) =>
                      `<a href="https://search.brave.com/search?q=internal-${index}">Related search</a>`).join('') +
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
              (('host' in options && options.host === ip) ||
                ('hostname' in options && options.hostname === ip)) &&
              'headers' in options &&
              (options.headers as { host?: string }).host === host
            ) {
              Object.assign(options, { host: '127.0.0.1', hostname: '127.0.0.1', port });
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
      if (!Array.isArray(result) || !result[0]) return;
      if (!result[0].data) {
        resultSeen.push(`${result[0].id}: ${result[0].error ?? result[0].status}`);
        return;
      }
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
      if (step.id === 'web_fetch') searchResults.push(step.data?.preview ?? step.error ?? step.status);
    });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(lookup);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => searchResults)
      .toEqual([
        expect.stringContaining('user-provided destination'),
        url,
        expect.stringContaining('42 measurements'),
      ]);
    expect((await page.evaluate(() => window.aria!.browserState())).tabs).toHaveLength(
      state.tabs.length,
    );

    await app.evaluate(({ app }) => {
      const state = globalThis as typeof globalThis & { staticFetchViews: number };
      state.staticFetchViews = 0;
      app.on('web-contents-created', () => { state.staticFetchViews++; });
    });
    const directives = `Check robots and sitemap for http://${host}/ and probe http://${host}/redirect`;
    const staticResults: Record<string, unknown> = {};
    provider.queueOperations(directives, {
      steps: [{ ...tool('web_fetch', { url: `http://${host}/robots.txt` }), id: 'robots' }],
    });
    provider.onToolResult(directives, (result) => {
      if (!Array.isArray(result) || !result[0]) return;
      const [observed] = result;
      staticResults[observed.id] = observed.data ?? observed.problem;
      if (observed.id === 'robots' && observed.data?.links?.length) return {
        name: 'fixture_operations',
        input: { steps: [
          { ...tool('web_fetch', { sourceId: observed.data.links[0].sourceId }, ['robots']), id: 'sitemap' },
          { ...tool('web_fetch', { url: `http://${host}/redirect`, method: 'HEAD' }), id: 'redirect' },
        ] },
      };
      if (observed.id === 'sitemap') staticResults.redirect = result[1]?.problem;
    });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(directives);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => staticResults).toMatchObject({
      robots: { status: 200, preview: expect.stringContaining('Disallow: /private'),
        links: [{ href: `http://${host}/sitemap.xml`, sourceId: expect.any(String) }] },
      sitemap: { status: 200, links: [{ href: url, sourceId: expect.any(String) }] },
      redirect: { code: 'PERMISSION_DENIED', category: 'DESTINATION_BLOCKED' },
    });
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { staticFetchViews: number }).staticFetchViews))
      .toBe(0);

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
    const buttonPoint = { x: 110, y: 190 };
    let viewport: { width: number; height: number } | undefined;
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
        computerResults.failure = error ?? status;
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
      if (id === 'inspect') {
        const { width, height, screenshot } = data.observation;
        viewport = { width, height };
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
                    x: Math.round((buttonPoint.x * screenshot.width) / width),
                    y: Math.round((buttonPoint.y * screenshot.height) / height),
                  },
                ],
              }),
            ],
          },
        };
      }
      if (id === 'act') {
        computerResults.outcomes = data.outcomes;
        computerResults.elements = data.observation.state.elements;
      }
    });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(computerPrompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(() => computerResults.failure ?? computerResults.outcomes, { timeout: 20_000 })
      .toBeDefined();
    expect(computerResults).toMatchObject({
      outcomes: [{ index: 0, action: 'click', status: 'submitted' }],
      elements: expect.arrayContaining([
        expect.objectContaining({ label: 'Fixture received input' }),
      ]),
    });
    await expect(page.getByRole('region', { name: 'Computer Use' })).toBeVisible();
    const screenshot = provider.received
      .filter(({ body }) =>
        body.messages.some(({ role, content }) => role === 'user' && content === computerPrompt),
      )
      .map(({ body }) => body.messages.at(-1))
      .find((message) => message?.role === 'tool' && Array.isArray(message.content));
    const dataUrl = Array.isArray(screenshot?.content)
      ? screenshot.content.find((part) => part.type === 'image_url')?.image_url?.url
      : undefined;
    if (!viewport || typeof dataUrl !== 'string')
      throw new Error('The provider did not receive a browser screenshot.');
    const buttonPixel = await app.evaluate(
      ({ nativeImage }, { dataUrl, viewport, point }) => {
        const frame = nativeImage.createFromDataURL(dataUrl);
        const { width, height } = frame.getSize();
        const x = Math.round((point.x * width) / viewport.width);
        const y = Math.round((point.y * height) / viewport.height);
        const offset = (y * width + x) * 4;
        return [...frame.toBitmap().subarray(offset, offset + 4)];
      },
      { dataUrl, viewport, point: buttonPoint },
    );
    expect(buttonPixel).toEqual([200, 130, 30, 255]);
    expect(traffic).not.toContain('/unexpected-action');
    const controlHost = await app.evaluate(({ BaseWindow, BrowserWindow, WebContentsView }) => {
      const main = BrowserWindow.getAllWindows()[0];
      for (const window of BaseWindow.getAllWindows()) {
        if (window.id === main.id) continue;
        const tab = window.contentView.children.find((child) => child instanceof WebContentsView);
        if (tab instanceof WebContentsView) {
          return {
            id: window.id,
            contentsId: tab.webContents.id,
            visible: window.isVisible(),
            focusable: window.isFocusable(),
            throttled: tab.webContents.backgroundThrottling,
          };
        }
      }
      throw new Error('The managed tab has no rendering host.');
    });
    expect(controlHost).toMatchObject({ visible: false, focusable: false, throttled: true });
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Computer Use' })).toContainText(
      'You have control',
    );
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BaseWindow, BrowserWindow, WebContentsView }, { id, contentsId }) => {
            const main = BrowserWindow.getAllWindows()[0];
            return {
              hostClosed: BaseWindow.fromId(id) === null,
              tabAttached: main.contentView.children.some(
                (child) => child instanceof WebContentsView && child.webContents.id === contentsId,
              ),
            };
          },
          controlHost,
        ),
      )
      .toEqual({ hostClosed: true, tabAttached: true });
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

    // Verify web_search falls back to Bing and decodes /ck/a base64url links when Brave returns HTTP 429.
    await app.evaluate(
      ({ session }, { host }) => {
        const fromPartition = session.fromPartition.bind(session);
        session.fromPartition = (name, options) => {
          const profile = fromPartition(name, options);
          if (name.startsWith('aria-ai-')) {
            if (profile.protocol.isProtocolHandled('https')) profile.protocol.unhandle('https');
            profile.protocol.handle('https', (request) => {
              const address = new URL(request.url);
              if (address.origin === 'https://search.brave.com' && address.pathname === '/search') {
                return new Response('Too Many Requests', {
                  status: 429,
                  headers: { 'Content-Type': 'text/html' },
                });
              }
              if (address.origin === 'https://www.bing.com' && address.pathname === '/search') {
                const encoded = Buffer.from(`http://${host}/study`, 'utf8').toString('base64url');
                return new Response(
                  `<title>Bing Search</title><ol id="b_results"><li class="b_algo">` +
                    `<h2><a href="https://www.bing.com/ck/a?!&&u=a1${encoded}&ntb=1">Aria study via Bing</a></h2>` +
                    `<div class="b_caption"><p>Fallback snippet from Bing.<a class="b_algoReadMore">Read more</a></p></div>` +
                    `</li></ol>`,
                  { headers: { 'Content-Type': 'text/html' } },
                );
              }
              return profile.fetch(request, { bypassCustomProtocolHandlers: true });
            });
          }
          return profile;
        };
      },
      { host },
    );
    const fallbackPrompt = 'Search despite Brave 429';
    provider.queueOperations(fallbackPrompt, {
      steps: [tool('web_search', { query: 'semaphore fallback' })],
    });
    let fallbackResults: unknown;
    provider.onToolResult(fallbackPrompt, (result) => {
      if (!Array.isArray(result) || !result[0]) return;
      if (result[0].id === 'web_search') fallbackResults = result[0];
      return undefined;
    });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(fallbackPrompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => fallbackResults, { timeout: 20_000 }).toBeDefined();
    expect(fallbackResults).toMatchObject({
      status: 'completed',
      data: {
        status: 'results',
        results: [
          expect.objectContaining({
            url: `http://${host}/study`,
            title: 'Aria study via Bing',
            snippet: 'Fallback snippet from Bing.',
          }),
        ],
      },
    });
  } finally {
    await app?.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await provider.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('uses direct rendered evidence for Persian news and a site audit while assets stall', async () => {
  test.setTimeout(90_000);
  const provider = await createProviderFixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-browser-research-'));
  let app: ElectronApplication | undefined;
  try {
    const env = {
      ...process.env,
      ARIA_TEST_DATA_DIR: directory,
      OPENAI_MODEL: 'fixture-model',
      OPENAI_API_KEY: 'test-only-key',
      OPENAI_BASE_URL: provider.baseUrl,
    };
    delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [root], env });
    await app.evaluate(({ session }) => {
      const getPartition = session.fromPartition.bind(session);
      session.fromPartition = (name, options) => {
        const profile = getPartition(name, options);
        if (!name.startsWith('aria-ai-') || profile.protocol.isProtocolHandled('https')) return profile;
        profile.protocol.handle('https', (request) => {
          const { hostname, pathname } = new URL(request.url);
          const html = (text: string) => new Response(text, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
          if (hostname === 'zoomit.ir') {
            if (pathname === '/stall.png') return new Response(new ReadableStream({
              start(stream) { stream.enqueue(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])); },
            }), { headers: { 'Content-Type': 'image/png' } });
            if (pathname === '/') return html(
              '<html lang="fa" dir="rtl"><title>تازه‌ترین اخبار</title><main><h1>تازه‌ترین اخبار</h1>' +
              '<a href="/news/item">خبر آزمایشی</a><img src="/stall.png" alt=""></main></html>',
            );
            if (pathname === '/news/item') return html(
              '<html lang="fa" dir="rtl"><title>خبر آزمایشی</title>' +
              '<meta property="article:published_time" content="2026-11-21T08:00:00+03:30">' +
              '<meta property="article:modified_time" content="2026-11-22T14:30:00+03:30">' +
              '<article><h1>خبر آزمایشی</h1><time datetime="2026-11-21">۳۰ آبان</time></article>' +
              '<script>setTimeout(() => document.querySelector("article").append("گزارش تازه منتشر شد."), 80)</script></html>',
            );
          }
          if (hostname === 'manadev.net' && pathname === '/') return html(
            '<html lang="fa" dir="rtl"><title>ManaDev fixture</title>' +
            '<meta name="description" content="مستندات"><meta name="robots" content="noindex">' +
            '<link rel="canonical" href="/"><link rel="alternate" hreflang="en" href="/en">' +
            '<script type="application/ld+json">{"@type":"Organization"}</script>' +
            '<main><h1>ManaDev</h1><h3>Services</h3><img src="/one.png"><a href="/en">English</a></main></html>',
          );
          if (hostname === 'manadev.net' && pathname === '/never') return new Promise<Response>((resolve) => {
            request.signal.addEventListener('abort', () => resolve(new Response('', { status: 499 })), { once: true });
          });
          return new Response('', { status: 404 });
        });
        return profile;
      };
    });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20_000 })
      .toMatchObject({ state: 'ready' });
    await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()))
      .toMatchObject({ state: 'ready', configured: true });
    type BrowserTool = 'browser_open' | 'browser_get_page' | 'browser_extract' | 'browser_wait' | 'browser_close';
    const step = (id: string, tool: BrowserTool, args: Record<string, unknown>, dependsOn: string[] = []): ExecutionStep => ({
      id, target: { kind: 'tool', tool, model: null }, capability: tool, instructions: tool,
      summary: tool, inputs: [], dependsOn, args, output: 'data',
    });
    const run = (steps: ExecutionStep[]) => ({ name: 'fixture_operations', input: { steps } });
    const go = async (prompt: string) => {
      await page.getByRole('textbox', { name: 'Message Aria' }).fill(prompt);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    };
    const news = 'Check zoomit.ir and return the latest news.';
    const newsTools = ['browser_open', 'browser_get_page', 'browser_wait', 'browser_extract', 'browser_close']
      .map((tool) => `browser.${tool}`);
    const commands: string[] = [];
    let passedHome = 0;
    let publication: unknown;
    let publishedContent: unknown;
    let articleHref = '';
    provider.queueTool(news, 'find_capabilities', { query: '', ids: newsTools });
    provider.queueTool(news, 'load_capabilities', { ids: newsTools });
    provider.queueOperations(news, { steps: [step('home', 'browser_open', { url: 'zoomit.ir' })] });
    provider.onToolResult(news, (result) => {
      if (!Array.isArray(result)) return;
      const [first] = result;
      if (!first?.data) {
        if (first) commands.push(`${first.id}: ${first.error ?? first.status}`);
        return;
      }
      commands.push(first.id);
      const { tabId, documentId, links, metadata, text } = first.data;
      switch (first.id) {
        case 'home':
          expect(first.data.phase).toBe('partial');
          return run([step('links', 'browser_get_page', { tabId }, ['home'])]);
        case 'links':
          passedHome = Date.now();
          articleHref = links[0].href;
          return run([step('article', 'browser_open', { sourceId: links[0].sourceId }, ['links'])]);
        case 'article':
          return run([step('articleReady', 'browser_wait', { tabId, condition: 'visible_text', text: 'گزارش تازه' }, ['article'])]);
        case 'articleReady':
          return run([step('articlePage', 'browser_get_page', { tabId }, ['articleReady'])]);
        case 'articlePage':
          return run([step('date', 'browser_extract', { tabId, documentId, view: 'metadata' }, ['articlePage']),
            step('body', 'browser_extract', { tabId, documentId, view: 'content' }, ['articlePage'])]);
        case 'date':
          publication = metadata;
          publishedContent = result[1]?.data?.text;
          return run([step('close', 'browser_close', { tabId }, ['date'])]);
        case 'close':
          expect(first.data.phase).toBe('closed');
          provider.finalReply(news, 'خبر آزمایشی در ۳۰ آبان منتشر شد. [منبع](https://zoomit.ir/news/item)');
          break;
        default: expect(text).toBeUndefined();
      }
    });
    const sent = Date.now();
    await go(news);
    await expect(page.locator('.from-assistant').last()).toContainText('۳۰ آبان', { timeout: 15_000 });
    expect(passedHome - sent).toBeLessThan(2000);
    expect(articleHref).toBe('https://zoomit.ir/news/item');
    expect(publication).toMatchObject({
      language: 'fa', direction: 'rtl',
      published: ['2026-11-21T08:00:00+03:30'], modified: ['2026-11-22T14:30:00+03:30'],
    });
    expect(publishedContent).toContain('گزارش تازه منتشر شد.');
    expect(commands).toEqual(['home', 'links', 'article', 'articleReady', 'articlePage', 'date', 'close']);

    const audit = 'Analyze manadev.net for SEO.';
    let seoMetadata: unknown;
    let seoPerformance: unknown;
    provider.queueOperations(audit, { steps: [step('auditHome', 'browser_open', { url: 'manadev.net' })] });
    provider.onToolResult(audit, (result) => {
      if (!Array.isArray(result) || !result[0]?.data) return;
      const [{ id, data }] = result;
      if (id === 'auditHome') return run([step('auditPage', 'browser_get_page', { tabId: data.tabId }, [id])]);
      if (id === 'auditPage') return run([
        step('meta', 'browser_extract', { tabId: data.tabId, documentId: data.documentId, view: 'metadata' }, [id]),
        step('timing', 'browser_extract', { tabId: data.tabId, documentId: data.documentId, view: 'performance' }, [id]),
      ]);
      if (id === 'meta') {
        seoMetadata = data.metadata;
        seoPerformance = result[1]?.data?.performance;
        provider.finalReply(audit, 'Executive summary. The homepage declares noindex and one image lacks alt text. Search indexing was not measured.');
      }
    });
    await go(audit);
    await expect(page.locator('.from-assistant').last()).toContainText('The homepage declares noindex');
    expect(seoMetadata).toMatchObject({
      robots: 'noindex', canonical: 'https://manadev.net/', language: 'fa',
      headings: [{ level: 1, text: 'ManaDev' }, { level: 3, text: 'Services' }],
      images: { total: 1, missingAlt: 1 }, structuredTypes: ['Organization'],
      alternates: [{ language: 'en', href: 'https://manadev.net/en' }],
    });
    expect(seoPerformance).toMatchObject({ domContentLoadedMs: expect.any(Number), viewport: expect.any(Object) });

    const navigationTimeout = 'Try opening https://manadev.net/never';
    let timeout: unknown;
    provider.queueOperations(navigationTimeout, {
      steps: [step('timeout', 'browser_open', { url: 'https://manadev.net/never' })],
    });
    provider.onToolResult(navigationTimeout, (result) => {
      if (Array.isArray(result)) timeout = result[0];
      return undefined;
    });
    await go(navigationTimeout);
    await expect.poll(() => timeout, { timeout: 25_000 }).toMatchObject({
      status: 'failed', problem: { code: 'TIMEOUT', category: 'TIMEOUT' }, retry: { phase: 'timed_out' },
    });
    expect(await page.evaluate(async () => (await window.aria!.browserState()).tabs
      .some((tab) => tab.url.endsWith('/never')))).toBe(false);
    for (const turn of provider.received) {
      expect(turn.body.messages.filter((message) => message.role === 'tool')
        .every((message) => !JSON.stringify(message.content).includes('web_web_search'))).toBe(true);
    }
  } finally {
    await app?.close();
    await provider.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('grounds public research through an opt-in live desktop primary', async () => {
  test.skip(process.env.ARIA_RUN_PUBLIC_RESEARCH_EVAL !== '1', 'Requires an explicitly configured live primary.');
  test.setTimeout(1_000_000);
  if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)
    throw new Error('Set OPENAI_API_KEY and OPENAI_MODEL before running live desktop research.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-live-research-'));
  let app: ElectronApplication | undefined;
  try {
    const env = { ...process.env, ARIA_TEST_DATA_DIR: directory };
    delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [root], env });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 30_000 })
      .toMatchObject({ state: 'ready' });
    await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 30_000 })
      .toMatchObject({ state: 'ready', configured: true });
    const ask = async (prompt: string) => {
      await page.evaluate(() => {
        const target = window as typeof window & { researchEvents?: unknown[]; stopResearchEvents?: () => void };
        target.stopResearchEvents?.();
        target.researchEvents = [];
        target.stopResearchEvents = window.aria!.onChatEvent((event) => target.researchEvents?.push(event));
      });
      await page.getByRole('textbox', { name: 'Message Aria' }).fill(prompt);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.locator('.from-assistant').last()).toHaveAttribute('data-status', 'completed', { timeout: 310_000 });
      return page.evaluate(() => (window as typeof window & { researchEvents: import('@aria/shared').ChatEvent[] })
        .researchEvents.flatMap((event) => event.type === 'activity' && event.activity.status === 'completed' ? [event.activity] : []));
    };
    const project = await ask('What is Mana-Agent? Verify against GitHub and PyPI.');
    const projectSources = project.flatMap(({ sources }) => sources ?? []).map(({ url }) => url);
    expect(projectSources.some((url) => url.startsWith('https://github.com/manaplatform/mana-agent'))).toBe(true);
    expect(projectSources.some((url) => url.startsWith('https://pypi.org/project/mana-agent'))).toBe(true);
    for (const [domain, prompt] of [
      ['zoomit.ir', 'Check zoomit.ir and return the latest news.'],
      ['manadev.net', 'Analyze manadev.net for SEO.'],
    ]) {
      const steps = await ask(prompt);
      const observed = steps.flatMap(({ sources }) => sources ?? []).filter((source) =>
        ['inspected', 'partial'].includes(source.evidenceStatus ?? '') &&
        (source.domain === domain || source.domain?.endsWith('.' + domain)));
      expect(observed.length, prompt).toBeGreaterThan(0);
      expect(steps.some(({ target }) => target === 'browser.browser_extract' || target === 'web.web_fetch'), prompt).toBe(true);
    }
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
