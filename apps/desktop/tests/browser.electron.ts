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

test('browses from ordinary chat through the managed private port and keeps private destinations out', async () => {
  const provider = await createProviderFixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-browser-electron-'));
  const traffic: string[] = [];
  const site = http.createServer((request, response) => {
    traffic.push(request.url || '');
    if (request.url === '/redirect') {
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
            '<a href="/next">Next page</a></main>' +
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
                address.searchParams.get('q') === 'semaphore definition'
              ) {
                return new Response(
                  '<title>Aria search fixture</title><main>' +
                    '<div data-type="ad"><div class="result-content"><a href="https://example.com/ad">Ad</a></div></div>' +
                    '<div data-type="web"><div class="result-content">' +
                    '<a href="http://' +
                    host +
                    '/study">Aria research fixture</a></div></div></main>',
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
  } finally {
    await app?.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await provider.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
