import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderFixture } from '../../../tests/provider-fixture';

const root = path.resolve(__dirname, '..');
const screenshots = path.join(root, '.artifacts/screenshots');
let fixture: Awaited<ReturnType<typeof createProviderFixture>>;
let app: ElectronApplication;
let page: Page;
let temporary: string;
let errors: string[];
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
async function launch(
  configured = true,
  development = false,
  expectedConfiguration = configured,
  fakeMicrophone = false,
) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARIA_TEST_DATA_DIR = temporary;
  env.OPENAI_API_KEY = configured ? 'test-only-key' : '';
  env.OPENAI_MODEL = configured ? 'fixture-model' : '';
  env.OPENAI_BASE_URL = configured ? fixture.baseUrl : '';
  env.ARIA_SYSTEM_PROMPT = '';
  if (development) env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:5174';
  else delete env.VITE_DEV_SERVER_URL;
  app = await electron.launch({
    args: [
      ...(fakeMicrophone
        ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
        : []),
      root,
    ],
    env,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await expect(page.getByRole('navigation', { name: 'Chat navigation' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20000 })
    .toMatchObject({ state: 'ready', configured: expectedConfiguration });
}
async function screenshot(name: string) {
  await fs.mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, name), animations: 'disabled' });
}
async function send(content: string) {
  await page.getByRole('textbox', { name: 'Message Aria' }).fill(content);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
test.beforeAll(async () => {
  fixture = await createProviderFixture();
});
test.afterAll(async () => {
  await fixture?.close();
});
test.beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-chat-electron-'));
  errors = [];
  fixture.holdSlow();
});
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus && page && !page.isClosed()) {
    await test.info().attach('visible-state', {
      body: await page.locator('body').innerText(),
      contentType: 'text/plain',
    });
    await test.info().attach('chat-status', {
      body: JSON.stringify(await page.evaluate(() => window.aria!.chatStatus())),
      contentType: 'application/json',
    });
    await test
      .info()
      .attach('screenshot', { body: await page.screenshot(), contentType: 'image/png' });
  }
  await app?.close();
  await fs.rm(temporary, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

test('opens directly into chat without a project and restores appearance, sidebar preference, and welcome draft', async () => {
  await launch(false);
  await expect(page.getByRole('heading', { name: 'How can I help you today?' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message Aria' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.getByRole('tab', { name: 'Execute', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open a project', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => typeof (window as Window & { require?: unknown }).require)).toBe(
    'undefined',
  );
  await screenshot('chat-welcome.png');
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await screenshot('chat-settings-light.png');
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message Aria' })
    .fill('A draft saved without choosing a folder');
  await app.close();
  await launch(false);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.chat-sidebar')).toHaveClass(/compact/);
  await expect(page.getByRole('textbox', { name: 'Message Aria' })).toHaveValue(
    'A draft saved without choosing a folder',
  );
  expect(
    JSON.parse(await fs.readFile(path.join(temporary, 'aria-v3.json'), 'utf8')).workspaces,
  ).toEqual([]);
});
test('streams through the managed NestJS API, renders Markdown, manages conversations, and stops background replies', async () => {
  await launch();
  await send('Help me think');
  await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(1);
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
    "const greeting = 'Hello, Aria';",
  );
  await page.getByRole('button', { name: 'Copy response', exact: true }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain(
    'Hello from the test provider',
  );
  await page.getByRole('button', { name: 'Options for Help me think', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Conversation name').fill('A thoughtful conversation');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page
    .getByRole('button', { name: 'Options for A thoughtful conversation', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Pin conversation', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Pinned', exact: true })).toBeVisible();
  await screenshot('chat-conversation.png');
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const cancellations = fixture.cancelled;
  await send('[slow] another question');
  await expect(page.locator('.from-assistant .markdown')).toContainText('Hello');
  await page.getByRole('button', { name: 'A thoughtful conversation', exact: true }).click();
  await expect(page.locator('.from-user')).toContainText('Help me think');
  await page.getByRole('button', { name: '[slow] another question', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await expect(page.locator('.from-assistant[data-status="stopped"]')).toHaveCount(1);
  await expect.poll(() => fixture.cancelled).toBeGreaterThan(cancellations);
  fixture.releaseSlow();
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(1);
  await expect(page.locator('.from-user')).toHaveCount(1);
  await page
    .getByRole('searchbox', { name: 'Search conversations', exact: true })
    .fill('test provider');
  await expect(
    page.getByRole('button', { name: 'A thoughtful conversation', exact: true }),
  ).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search conversations', exact: true }).clear();
  await page
    .getByRole('button', { name: 'Options for [slow] another question', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'How can I help you today?' })).toBeVisible();
  await page.getByRole('button', { name: 'A thoughtful conversation', exact: true }).click();
  await app.close();
  await launch();
  await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'A thoughtful conversation', exact: true }),
  ).toBeVisible();
});
test('shows real provider errors, supports explicit retry, and tests the connection without creating a chat', async () => {
  await launch();
  await send('[fail] check provider error');
  await expect(page.getByRole('alert')).toContainText('provider rejected');
  await expect(page.getByRole('button', { name: 'Retry response', exact: true })).toBeEnabled();
  await expect(page.locator('.from-assistant .markdown')).toHaveCount(0);
  await screenshot('chat-error.png');
  const count = fixture.received.length;
  await page.getByRole('button', { name: 'Retry response', exact: true }).click();
  await expect(page.locator('.from-assistant[data-status="failed"]')).toHaveCount(1);
  expect(fixture.received).toHaveLength(count + 1);
  await expect(page.locator('.from-user')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(page.getByText('Your provider responded successfully.')).toBeVisible();
  await expect(page.getByText('Connection tested', { exact: true })).toBeVisible();
  expect(JSON.stringify(await page.evaluate(() => window.aria!.providerSettings()))).not.toContain(
    'test-only-key',
  );
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.locator('.conversation-item')).toHaveCount(1);
});
test('recovers from service crashes, preserves drafts, and supports narrow windows and keyboard navigation', async () => {
  await launch();
  await send('[slow] survive an interruption');
  await expect(page.locator('.from-assistant .markdown')).toContainText('Hello');
  await page.getByRole('textbox', { name: 'Message Aria' }).fill('Keep my next question');
  await app.evaluate(({ app: application }) => {
    const child = application.getAppMetrics().find((process) => process.name === 'Aria Chat API');
    if (!child) throw new Error('Managed chat process was not found.');
    process.kill(child.pid, 'SIGKILL');
  });
  await expect(page.locator('.from-assistant[data-status="interrupted"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Restart chat service', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.aria!.chatStatus()))
    .toMatchObject({ state: 'ready', configured: true });
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Aria' })).toHaveValue(
    'Keep my next question',
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(720, 600),
  );
  await expect(page.getByRole('button', { name: 'Open sidebar', exact: true })).toBeVisible();
  await page.keyboard.press(`${modifier}+k`);
  await expect(page.getByRole('dialog', { name: 'Conversations', exact: true })).toBeVisible();
  await expect(
    page.getByRole('searchbox', { name: 'Search conversations', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Conversations', exact: true })).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await screenshot('chat-narrow.png');
  await app.close();
  await launch();
  await expect(page.getByRole('textbox', { name: 'Message Aria' })).toHaveValue(
    'Keep my next question',
  );
  await expect(page.locator('.from-assistant[data-status="interrupted"]')).toHaveCount(1);
});
test('development renderer uses the same managed backend and safe preload', async () => {
  await launch(true, true);
  await send('Hello from development');
  await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(1);
  expect(await page.evaluate(() => typeof window.aria?.submitChat)).toBe('function');
});
test('configures a provider in Settings using native encrypted storage and restores it on relaunch', async () => {
  await launch(false);
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  const settings = await page.evaluate(() => window.aria!.providerSettings());
  if (!settings.encryptionAvailable) {
    await expect(page.getByLabel('API key', { exact: true })).toBeDisabled();
    await expect(page.getByText(/System encryption is unavailable/)).toBeVisible();
    return;
  }
  await page.getByLabel('Provider endpoint', { exact: true }).fill(fixture.baseUrl);
  await page.getByLabel('API key', { exact: true }).fill('test-only-key');
  await page.getByRole('button', { name: 'Load models', exact: true }).click();
  await expect(page.getByLabel('Chat model', { exact: true })).toBeEnabled();
  await page.getByLabel('Chat model', { exact: true }).selectOption('fixture-model');
  await page.getByLabel('Image model', { exact: true }).selectOption('gpt-image-2.6-flare');
  await page.getByLabel('Speech model', { exact: true }).selectOption('gpt-realtime-2.1-mini');
  await page.getByLabel('Transcribe model', { exact: true }).selectOption('gpt-transcribe');
  await page.getByLabel('Live Voice model', { exact: true }).selectOption('gpt-live-1');
  await page.getByLabel('System instructions', { exact: true }).fill('Give useful answers.');
  await page.getByRole('button', { name: 'Save & reconnect', exact: true }).click();
  await expect(page.getByText('Model settings saved.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  const saved = await fs.readFile(path.join(temporary, 'provider.json'), 'utf8');
  expect(saved).not.toContain('test-only-key');
  expect(JSON.parse(saved).encryptedKey).toBeTruthy();
  expect(JSON.parse(saved).models).toEqual({
    chat: 'fixture-model',
    image: 'gpt-image-2.6-flare',
    speech: 'gpt-realtime-2.1-mini',
    transcription: 'gpt-transcribe',
    live: 'gpt-live-1',
  });
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click();
  await send('Use my saved provider');
  await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(1);
  expect(fixture.received.at(-1)?.body.messages[0]).toEqual({
    role: 'system',
    content: 'Give useful answers.',
  });
  await app.close();
  await launch(false, false, true);
  await send('The saved key still works');
  await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(2);
});

test('creates images, edits references, transcribes audio, exports speech, and restores media history', async () => {
  await launch();
  await page.getByLabel('Creation mode', { exact: true }).selectOption('image');
  await page.getByLabel('Image model', { exact: true }).selectOption('gpt-image-2.6-flare');
  await send('A calm mountain');
  const image = page.locator('.from-assistant img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
  const exportPath = path.join(temporary, 'exported-image.png');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exportPath);
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect
    .poll(async () => {
      try {
        return (await fs.readFile(exportPath)).equals(fixture.png);
      } catch {
        return false;
      }
    })
    .toBe(true);
  await page.getByRole('button', { name: 'Use image', exact: true }).click();
  await send('Add a little snow');
  await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(2);
  expect(fixture.mediaReceived.at(-1)?.path).toBe('/v1/images/edits');
  await page.getByLabel('Creation mode', { exact: true }).selectOption('transcription');
  await page.getByLabel('Transcribe model', { exact: true }).selectOption('gpt-transcribe');
  const recordingPath = path.join(temporary, 'recording.wav');
  await fs.writeFile(recordingPath, fixture.wav);
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, recordingPath);
  await page.getByRole('button', { name: 'Audio file', exact: true }).click();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.from-assistant').last()).toContainText(
    'A transcript from the uploaded audio.',
  );
  await page.getByLabel('Creation mode', { exact: true }).selectOption('speech');
  await page.getByLabel('Speech model', { exact: true }).selectOption('tts-1');
  await expect(page.getByLabel('Speech voice', { exact: true })).toHaveValue('alloy');
  await send('A little clarity.');
  await expect(page.locator('.from-assistant audio')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.from-assistant audio').evaluate((node: HTMLAudioElement) => node.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await page.getByLabel('Speech model', { exact: true }).selectOption('gpt-realtime-2.1-mini');
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(4);
  expect(fixture.mediaReceived.at(-1)?.path).toBe('/v1/audio/speech');
  expect(fixture.mediaReceived.at(-1)?.body).toContain('"model":"tts-1"');
  await app.close();
  await launch();
  await expect(page.locator('.from-assistant img')).toHaveCount(2);
  await expect(page.locator('.from-assistant audio')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const saved = JSON.parse(await fs.readFile(path.join(temporary, 'aria-v3.json'), 'utf8'));
  expect(saved.version).toBe(3);
  expect(JSON.stringify(saved)).not.toContain('base64');
});

test('cancels media generation and preserves the original model for explicit retry', async () => {
  await launch();
  await page.getByLabel('Creation mode', { exact: true }).selectOption('image');
  await page.getByLabel('Image model', { exact: true }).selectOption('gpt-image-2.6-flare');
  const cancelled = fixture.cancelled;
  await send('[slow] mountain');
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await expect(page.locator('.from-assistant[data-status="stopped"]')).toHaveCount(1);
  await expect.poll(() => fixture.cancelled).toBeGreaterThan(cancelled);
  await send('[fail] image request');
  await expect(page.locator('.from-assistant[data-status="failed"]')).toHaveCount(1);
  await expect(page.getByRole('alert')).not.toContainText('secret-response-text');
  await page.getByRole('button', { name: 'Retry response', exact: true }).click();
  await expect(page.locator('.from-assistant[data-status="failed"]')).toHaveCount(1);
});

test('uses a synthetic microphone for GPT-Live, saves captions and assistant audio, and releases the microphone on end', async () => {
  await launch(true, false, true, true);
  await page.getByText('Live voice options', { exact: true }).click();
  await page.getByLabel('Live Voice model', { exact: true }).selectOption('gpt-live-1');
  await page.getByLabel('Voice backend model', { exact: true }).selectOption('gpt-6-luna');
  await page.getByRole('button', { name: 'Start live voice conversation', exact: true }).click();
  await expect(page.getByText('Hello from my microphone.', { exact: true })).toBeVisible();
  await expect(page.locator('.from-assistant .markdown')).toContainText('Hello from GPT-Live.');
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unmute microphone', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'End voice conversation', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Start live voice conversation', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.from-assistant audio')).toBeVisible();
  await expect
    .poll(() =>
      page.locator('.from-assistant audio').evaluate((node: HTMLAudioElement) => node.readyState),
    )
    .toBeGreaterThanOrEqual(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await app.close();
  await launch();
  await expect(page.locator('.from-assistant .markdown')).toContainText('Hello from GPT-Live.');
  const saved = JSON.parse(await fs.readFile(path.join(temporary, 'aria-v3.json'), 'utf8'));
  expect(
    saved.chat.messages.find((message: { role: string }) => message.role === 'user').assets,
  ).toBeUndefined();
  expect(
    saved.chat.messages.find((message: { role: string }) => message.role === 'assistant').assets[0]
      .name,
  ).toBe('aria-live-replies.wav');
});
