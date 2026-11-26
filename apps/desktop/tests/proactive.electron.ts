import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  automationDraftSchema,
  defaultProactiveSettings,
  type ProactiveCommand,
} from '@aria/shared';
import { createProviderFixture } from '../../../tests/provider-fixture';

test('runs a reviewed automation through Conductor while the renderer is closed', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-proactive-electron-'));
  const fixtures = path.resolve(__dirname, '../../../tests/fixtures/proactive');
  const ca = path.join(fixtures, 'provider-fixture-cert.pem');
  const fixture = await createProviderFixture({
    tls: {
      key: await fs.readFile(path.join(fixtures, 'provider-fixture-key.pem')),
      cert: await fs.readFile(ca),
    },
    priced: true,
  });
  fixture.finalReply('', 'The reviewed background report is complete.');
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const executablePath = process.env.ARIA_TEST_PACKAGED_APP;
  const app = await electron.launch({
    ...(executablePath && { executablePath }),
    args: executablePath ? [] : [path.resolve(__dirname, '..')],
    env: {
      ...env,
      NODE_EXTRA_CA_CERTS: ca,
      ARIA_TEST_DATA_DIR: temporary,
      OPENAI_API_KEY: 'test-only-key',
      OPENAI_MODEL: 'fixture-model',
      OPENAI_BASE_URL: fixture.baseUrl,
      ARIA_SYSTEM_PROMPT: '',
    },
  });
  try {
    await app.evaluate(({ safeStorage }) => {
      safeStorage.isAsyncEncryptionAvailable = async () => true;
      safeStorage.encryptStringAsync = async (value) =>
        Buffer.from(Buffer.from(value).toString('base64'));
      safeStorage.decryptStringAsync = async (bytes) => ({
        result: Buffer.from(bytes.toString(), 'base64').toString(),
        shouldReEncrypt: false,
      });
    });
    const page = await app.firstWindow();
    await expect
      .poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20_000 })
      .toMatchObject({ state: 'ready' });
    if (!(await page.evaluate(() => window.aria!.chatStatus())).configured)
      await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await expect
      .poll(() => page.evaluate(() => window.aria!.chatStatus()))
      .toMatchObject({ configured: true });
    const send = (command: ProactiveCommand) =>
      page.evaluate((command) => window.aria!.proactive(command), command);
    await expect(page.getByRole('button', { name: 'Agenda', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Agenda', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Agenda', exact: true })).toBeVisible();
    const instruction = 'Create an automation to prepare a report when I run it.';
    fixture.queueOperations(instruction, {
      steps: [
        {
          id: 'proposal',
          target: { kind: 'tool', tool: 'automation.create', model: null },
          capability: 'tool',
          instructions: 'Propose an approved schedule.',
          inputs: [],
          dependsOn: [],
          args: {
            title: 'Manual report',
            instruction: 'Generated wording',
            action: 'Prepare a report.',
            trigger: { kind: 'manual' },
            scope: { publicSearch: false, publicOrigins: [], memory: false },
          },
        },
      ],
    });
    fixture.finalReply(instruction, 'Review the proposal in Automations.');
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Aria', exact: true }).fill(instruction);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    try {
      await expect(page.locator('.from-assistant[data-status="completed"]')).toHaveCount(1, {
        timeout: 10_000,
      });
    } catch (error) {
      await test
        .info()
        .attach('visible-state', {
          contentType: 'text/plain',
          body: await page.locator('body').innerText(),
        });
      await test.info().attach('fixture-tool-sequence', {
        contentType: 'application/json',
        body: JSON.stringify(
          fixture.received.map(({ body }) => body.messages.filter(({ role }) => role !== 'system')),
          null,
          2,
        ),
      });
      throw error;
    }
    await page.getByRole('button', { name: 'Automations', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible();
    await expect(page.locator('.proactive-card').getByText(instruction, { exact: true })).toBeVisible();
    const proposal = await send({ action: 'snapshot' });
    expect(proposal.kind === 'snapshot' && proposal.value.automations).toEqual([]);
    await page.getByRole('button', { name: 'Authorize automation', exact: true }).click();
    await expect(page.getByRole('link', { name: /Manual report/ })).toBeVisible();
    const draft = automationDraftSchema.parse({
      title: 'Fixture background report',
      instruction: 'Prepare a background report.',
      action: 'Summarize the fixture responsibility.',
      trigger: { kind: 'once', at: new Date(Date.now() + 6500).toISOString(), zone: 'UTC' },
      scope: { publicSearch: false, publicOrigins: [], memory: false },
      maxAttempts: 1,
    });
    expect(
      await send({
        action: 'settings',
        commandId: randomUUID(),
        revision: 1,
        value: { ...defaultProactiveSettings, background: true },
      }),
    ).toMatchObject({ kind: 'accepted' });
    const automation = await send({
      action: 'automation_create',
      commandId: randomUUID(),
      automation: draft,
    });
    expect(automation).toMatchObject({ kind: 'accepted' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.windows().length).toBe(0);
    const completed = () =>
      app.evaluate(({ app }) => {
        const { DatabaseSync } = process.getBuiltinModule('node:sqlite')!;
        const path = process.getBuiltinModule('node:path')!;
        const db = new DatabaseSync(path.join(app.getPath('userData'), 'runtime.sqlite'), {
          readOnly: true,
        });
        try {
          return (
            db
              .prepare('SELECT state,reason FROM proactive_jobs ORDER BY created DESC LIMIT 1')
              .get() ?? null
          );
        } finally {
          db.close();
        }
      });
    await expect
      .poll(
        async () => {
          const row = await completed();
          return row?.state === 'failed' || row?.state === 'blocked' ? row : row?.state;
        },
        { timeout: 15_000 },
      )
      .toBe('completed');
    const background = fixture.received.find(({ body }) =>
      body.messages.some(
        (entry) => entry.role === 'system' && entry.content.includes('scheduled Aria system event'),
      ),
    );
    expect(background?.body.messages.filter(({ role }) => role === 'user')).toEqual([]);
    expect(background?.body.model).toBe('fixture-model');
  } finally {
    await app.close().catch(() => undefined);
    await fixture.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
