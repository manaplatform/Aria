import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderFixture } from '../../../tests/provider-fixture';

test('records correlated managed chat events and exports sanitized diagnostics', async () => {
  const fixture = await createProviderFixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-diagnostics-e2e-'));
  const destination = path.join(directory, 'export.json');
  let app: ElectronApplication | undefined;
  try {
    const env = {
      ...process.env,
      ARIA_TEST_DATA_DIR: path.join(directory, 'profile'),
      OPENAI_API_KEY: 'test-only-key',
      OPENAI_MODEL: 'fixture-model',
      OPENAI_BASE_URL: fixture.baseUrl,
      ARIA_SYSTEM_PROMPT: '',
    };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
    app = await electron.launch({ args: [path.resolve(__dirname, '..')], env });
    const page = await app.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Message Aria', exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20_000 })
      .toMatchObject({ state: 'ready' });
    if (!(await page.evaluate(() => window.aria!.chatStatus())).configured)
      await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await expect
      .poll(() => page.evaluate(() => window.aria!.chatStatus()))
      .toMatchObject({ state: 'ready', configured: true });
    fixture.queueTool('private diagnostic test prompt', 'find_capabilities', {
      query: 'private search query',
    });
    fixture.finalReply('private diagnostic test prompt', 'The diagnostic fixture completed.');
    await page
      .getByRole('textbox', { name: 'Message Aria', exact: true })
      .fill('private diagnostic test prompt');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(1);
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.aria!.diagnosticQuery({ limit: 200 }))).events.map(
          (event) => event.event,
        ),
      )
      .toContain('model.completed');
    const events = (await page.evaluate(() => window.aria!.diagnosticQuery({ limit: 200 }))).events;
    const model = events.find((event) => event.event === 'model.completed')!;
    const chat = events.find((event) => event.event === 'chat.started')!;
    expect(model.context.requestId).toBe(chat.context.requestId);
    expect(model.context.executionId).toBe(chat.context.executionId);
    const tool = events.find((event) => event.event === 'tool.completed');
    expect(tool?.context.requestId).toBe(chat.context.requestId);
    expect(tool?.context.executionId).toBe(chat.context.executionId);
    expect(tool?.context.operationId).not.toBe(chat.context.operationId);
    expect(tool?.context.parentOperationId).toBe(chat.context.operationId);
    expect(JSON.stringify(events)).not.toContain('private search query');
    expect(JSON.stringify(events)).not.toContain('private diagnostic test prompt');
    expect(JSON.stringify(events)).not.toContain('test-only-key');
    const unauthorized = await app.evaluate(async ({ BrowserWindow }) => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
      });
      try {
        await other.loadURL('data:text/html,<title>Untrusted</title>');
        return await other.webContents.executeJavaScript(
          "require('electron').ipcRenderer.invoke('aria:diagnostic-status').then(() => false, () => true)",
        );
      } finally {
        other.destroy();
      }
    });
    expect(unauthorized).toBe(true);
    await app.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
    }, destination);
    expect(await page.evaluate(() => window.aria!.diagnosticExport({}))).toBe(true);
    const report = await fs.readFile(destination, 'utf8');
    expect(report).not.toContain('private diagnostic test prompt');
    expect(report).not.toContain('test-only-key');
    expect(report).not.toContain(chat.context.requestId!);
    expect(report).toContain('model.completed');
    expect(Object.keys(JSON.parse(report).timelines)).not.toHaveLength(0);
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: 'Developer & Diagnostics', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Developer & Diagnostics' })).toBeVisible();
  } finally {
    await app?.close();
    await fixture.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('keeps temporary-chat diagnostics out of persisted files', async () => {
  const fixture = await createProviderFixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-diagnostics-temp-'));
  let app: ElectronApplication | undefined;
  try {
    const env = {
      ...process.env,
      ARIA_TEST_DATA_DIR: directory,
      OPENAI_API_KEY: 'test-only-key',
      OPENAI_MODEL: 'fixture-model',
      OPENAI_BASE_URL: fixture.baseUrl,
      ARIA_SYSTEM_PROMPT: '',
    };
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
    app = await electron.launch({ args: [path.resolve(__dirname, '..')], env });
    const page = await app.firstWindow();
    await expect(page.getByRole('textbox', { name: 'Message Aria', exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20_000 })
      .toMatchObject({ state: 'ready' });
    if (!(await page.evaluate(() => window.aria!.chatStatus())).configured)
      await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await expect
      .poll(() => page.evaluate(() => window.aria!.chatStatus()))
      .toMatchObject({ state: 'ready', configured: true });
    await page.getByRole('button', { name: 'Start temporary chat' }).click();
    await expect(
      page.getByText('Temporary chat · session only · persistent memory off'),
    ).toBeVisible();
    await page
      .getByRole('textbox', { name: 'Message Aria', exact: true })
      .fill('private temporary diagnostic prompt');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(1);
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.aria!.diagnosticQuery({ limit: 200 }))).events.map(
          (event) => event.event,
        ),
      )
      .toContain('model.completed');
    const temporaryEvent = (
      await page.evaluate(() => window.aria!.diagnosticQuery({ limit: 200 }))
    ).events.find((event) => event.event === 'chat.started')!;
    expect(temporaryEvent.context.requestId).toBeTruthy();
    await app.close();
    app = undefined;
    const logs = path.join(directory, 'logs');
    const files = (await fs.readdir(logs)).filter((name) => name.endsWith('.jsonl'));
    const contents = (
      await Promise.all(files.map((name) => fs.readFile(path.join(logs, name), 'utf8')))
    ).join('\n');
    expect(contents).not.toContain(temporaryEvent.context.requestId!);
    expect(contents).not.toContain('private temporary diagnostic prompt');
  } finally {
    await app?.close();
    await fixture.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
