import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderFixture } from '../../../tests/provider-fixture';

test('connects GitHub through Settings and discovers a scoped read in normal chat', async () => {
  const packaged = process.env.ARIA_TEST_PACKAGED_APP;
  test.skip(Boolean(packaged) && process.env.ARIA_TEST_PACKAGED_CONNECTOR !== '1',
    'The packaged fixture needs a package configured with the test-only GitHub App client ID and slug.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-connect-electron-'));
  const fixture = await createProviderFixture();
  const prompt = 'Read the README for example/connector-fixture';
  fixture.queueOperations(prompt, { steps: [{
    id: 'read', target: { kind: 'tool', tool: 'github.read_file', model: null }, capability: 'github.read_file',
    instructions: 'Read the requested file', args: { repository: 'example/connector-fixture', path: 'README.md' },
    inputs: [], dependsOn: [],
  }] });
  fixture.onToolResult(prompt, (result) => {
    const [envelope] = result as { data?: { content?: string; verified?: boolean } }[];
    if (envelope?.data?.verified && envelope.data.content?.includes('Deterministic GitHub content.'))
      fixture.finalReply(prompt, 'Verified GitHub README.');
    return undefined;
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const app = await electron.launch({
    ...(packaged && { executablePath: packaged }),
    args: packaged ? [] : [path.resolve(__dirname, '..')],
    env: {
      ...env, ARIA_TEST_DATA_DIR: directory,
      OPENAI_API_KEY: 'test-only-key', OPENAI_MODEL: 'fixture-model', OPENAI_BASE_URL: fixture.baseUrl,
      ARIA_CONNECT_GITHUB_CLIENT_ID: 'Iv1_fixture',
      ARIA_CONNECT_GITHUB_APP_SLUG: 'fixture-app',
    },
  });
  try {
    await app.evaluate(({ dialog, safeStorage, shell }) => {
      const actualFetch = globalThis.fetch;
      let opened = 0;
      const deviceSecret = 'd'.repeat(40);
      const access = 'ghu_fake_desktop_access_secret';
      safeStorage.isAsyncEncryptionAvailable = async () => true;
      safeStorage.encryptStringAsync = async (value) => Buffer.from(Buffer.from(value).toString('base64'));
      safeStorage.decryptStringAsync = async (bytes) => ({ result: Buffer.from(bytes.toString(), 'base64').toString(), shouldReEncrypt: false });
      safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
      shell.openExternal = async (destination) => {
        if (destination !== 'https://github.com/login/device') throw new Error('Unexpected sign-in URL');
        opened++;
      };
      globalThis.fetch = async (value, options) => {
        const url = new URL(String(value));
        if (url.origin === 'https://github.com') {
          const form = new URLSearchParams(String(options?.body));
          if (options?.method !== 'POST' || options?.redirect !== 'error' ||
              form.get('client_id') !== 'Iv1_fixture' || form.has('client_secret'))
            throw new Error('Invalid Device Flow request');
          if (url.pathname === '/login/device/code') {
            if (form.get('scope') !== 'offline_access') throw new Error('Missing offline access');
            return Response.json({ device_code: deviceSecret, user_code: 'AR1A-2026',
              verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 });
          }
          if (url.pathname !== '/login/oauth/access_token' || form.get('device_code') !== deviceSecret ||
              form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code')
            throw new Error('Invalid device poll');
          if (opened < 2) return Response.json({ error: 'authorization_pending' });
          return Response.json({ access_token: access, refresh_token: 'ghr_fake_desktop_refresh_secret',
            expires_in: 28800, refresh_token_expires_in: 1500000, token_type: 'bearer' });
        }
        if (url.origin === 'https://api.github.com') {
          if (new Headers(options?.headers).get('authorization') !== 'Bearer ' + access)
            return Response.json({}, { status: 401 });
          if (url.pathname === '/user') return Response.json({ id: 1, login: 'fixture-user' });
          if (url.pathname === '/user/installations') return Response.json({ installations: [
            { id: 10, app_slug: 'fixture-app', permissions: { metadata: 'read', contents: 'write' } },
          ] });
          if (url.pathname === '/user/installations/10/repositories') return Response.json({ repositories: [
            { id: 20, full_name: 'example/connector-fixture', private: true, default_branch: 'main', permissions: { push: true } },
          ] });
          if (url.pathname === '/repos/example/connector-fixture') return Response.json({ id: 20 });
          if (url.pathname === '/repos/example/connector-fixture/contents/README.md')
            return Response.json({ type: 'file', path: 'README.md', encoding: 'base64',
              content: Buffer.from('Deterministic GitHub content. ' + access).toString('base64') });
          return Response.json({}, { status: 404 });
        }
        return actualFetch(value, options);
      };
    });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20000 }).toMatchObject({ state: 'ready' });
    if (!(await page.evaluate(() => window.aria!.chatStatus())).configured)
      await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus())).toMatchObject({ configured: true });
    await page.evaluate(() => { location.hash = '/settings/connectors'; });
    await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    const verification = page.getByRole('region', { name: 'GitHub device verification' });
    await expect(verification.getByText('AR1A-2026', { exact: true })).toBeVisible();
    await expect(verification).toContainText('Never authorize a code someone else sent you.');
    const pending = await page.evaluate(() => window.aria!.connectors({ action: 'status' }));
    expect(Object.keys(pending.attempt?.verification ?? {}).sort()).toEqual(['expiresAt', 'userCode']);
    await verification.getByRole('button', { name: 'Open GitHub' }).click();
    await expect(verification).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'fixture-user', exact: true })).toBeVisible({ timeout: 10000 });
    await page.getByRole('checkbox', { name: /example\/connector-fixture/ }).check();
    await page.getByRole('button', { name: 'Review repository access' }).click();
    await expect.poll(() => page.evaluate(() => window.aria!.connectors({ action: 'status' })))
      .toMatchObject({ accounts: [{ state: 'connected', policy: 'read_only', selected: [20] }] });
    await page.evaluate(() => { location.hash = '/chat'; });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(prompt);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.from-assistant .markdown').last()).toContainText('Verified GitHub README.');
    const requests = JSON.stringify(fixture.received);
    for (const secret of ['ghu_fake_desktop_access_secret', 'ghr_fake_desktop_refresh_secret', 'd'.repeat(40), 'AR1A-2026'])
      expect(requests).not.toContain(secret);
    await expect(page.getByText('ghu_fake_desktop_access_secret', { exact: false })).toHaveCount(0);
  } finally {
    await app.close();
    await fixture.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('authorizes the live development GitHub App through the system browser', async () => {
  test.skip(process.env.ARIA_RUN_LIVE_GITHUB_CONNECT !== '1', 'Opt in with an installed development GitHub App.');
  test.setTimeout(940_000);
  const filename = process.env.ARIA_TEST_PACKAGED_APP;
  const repository = process.env.ARIA_TEST_GITHUB_REPOSITORY;
  if (!repository) throw new Error('Set ARIA_TEST_GITHUB_REPOSITORY to an authorized development repository.');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-connect-live-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const app = await electron.launch({
    ...(filename && { executablePath: filename }),
    args: filename ? [] : [path.resolve(__dirname, '..')],
    env: { ...env, ARIA_TEST_DATA_DIR: directory },
  });
  try {
    const page = await app.firstWindow();
    await page.evaluate(() => { location.hash = '/settings/connectors'; });
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.aria!.connectors({ action: 'status' }));
      return state.accounts.some((account) => account.repositories.some((item) => item.name === repository));
    }, { timeout: 920_000 }).toBe(true);
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.aria!.connectors({ action: 'status' }));
      return state.error;
    }).toBeNull();
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
