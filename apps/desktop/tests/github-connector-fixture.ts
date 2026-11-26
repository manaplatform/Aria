import { expect } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import type { GithubConfig } from '../electron/connectors/github/config';

export const fixtureGithub = { clientId: 'Iv1.fixture', slug: 'fixture-app' };
const userCode = 'AR1A-2026';
const deviceCode = 'd'.repeat(40);
const access = 'ghu_fake_desktop_access_secret';
const refresh = 'ghr_fake_desktop_refresh_secret';
const rotatedAccess = 'ghu_fake_desktop_rotated_access';
const rotatedRefresh = 'ghr_fake_desktop_rotated_refresh';
export const githubFixtureSecrets = [userCode, deviceCode, access, refresh, rotatedAccess, rotatedRefresh];

type FixtureState = { opened: number; refreshes: number; publicSearches: number; authorized: boolean; allowVerification: boolean };
type FixtureGlobal = typeof globalThis & { ariaGithubFixture: FixtureState };

export async function installGithubFixture(app: ElectronApplication, identity: GithubConfig,
  { mockStorage = false, restart = false, hasInstallation = true } = {}) {
  await app.evaluate(({ dialog, safeStorage, shell }, fixture) => {
    const actualFetch = globalThis.fetch;
    const state = { opened: 0, refreshes: 0, publicSearches: 0, authorized: false, allowVerification: fixture.restart };
    (globalThis as FixtureGlobal).ariaGithubFixture = state;
    let validAccess = fixture.restart ? undefined : fixture.access;
    if (fixture.mockStorage) {
      safeStorage.isAsyncEncryptionAvailable = async () => true;
      safeStorage.encryptStringAsync = async (value) => Buffer.from(Buffer.from(value).toString('base64'));
      safeStorage.decryptStringAsync = async (bytes) => ({ result: Buffer.from(bytes.toString(), 'base64').toString(), shouldReEncrypt: false });
      safeStorage.getSelectedStorageBackend = () => 'gnome_libsecret';
    }
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    shell.openExternal = async (destination) => {
      if (destination !== 'https://github.com/login/device') throw new Error('Unexpected sign-in URL');
      state.opened++;
    };
    const pair = (access_token: string, refresh_token: string) => Response.json({
      access_token, refresh_token, expires_in: 28800, refresh_token_expires_in: 15897600, token_type: 'bearer',
    });
    globalThis.fetch = async (value, options) => {
      const url = new URL(String(value));
      if (url.origin === 'https://github.com') {
        const form = new URLSearchParams(String(options?.body));
        if (options?.method !== 'POST' || options.redirect !== 'error' || options.credentials !== 'omit' ||
            form.get('client_id') !== fixture.identity.clientId || form.has('client_secret'))
          throw new Error('Invalid Device Flow request');
        if (url.pathname === '/login/device/code' && !fixture.restart) {
          if (form.get('scope') !== 'offline_access') throw new Error('Missing offline access');
          return Response.json({ device_code: fixture.deviceCode, user_code: fixture.userCode,
            verification_uri: 'https://github.com/login/device', interval: 1, expires_in: 900 });
        }
        if (url.pathname === '/login/oauth/access_token') {
          if (fixture.restart && form.get('grant_type') === 'refresh_token') {
            const previous = form.get('refresh_token');
            if (previous !== fixture.refresh && previous !== fixture.rotatedRefresh) throw new Error('Invalid refresh token');
            state.refreshes++;
            const wasRotated = previous === fixture.rotatedRefresh;
            validAccess = wasRotated ? fixture.access : fixture.rotatedAccess;
            return pair(validAccess, wasRotated ? fixture.refresh : fixture.rotatedRefresh);
          }
          if (!fixture.restart && form.get('device_code') === fixture.deviceCode &&
              form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
            if (!state.opened || !state.authorized) return Response.json({ error: 'authorization_pending' });
            return pair(fixture.access, fixture.refresh);
          }
        }
        throw new Error('Unexpected GitHub authorization request');
      }
      if (url.origin === 'https://api.github.com') {
        if (!validAccess || new Headers(options?.headers).get('authorization') !== 'Bearer ' + validAccess)
          return Response.json({}, { status: 401 });
        if (url.pathname === '/user') {
          while (!state.allowVerification) {
            options?.signal?.throwIfAborted();
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return Response.json({ id: 1, login: 'fixture-user' });
        }
        if (url.pathname === '/user/installations') return Response.json({ installations: fixture.hasInstallation ? [
          { id: 10, app_slug: fixture.identity.slug, permissions: { metadata: 'read', contents: 'write' } },
        ] : [] });
        if (url.pathname === '/search/repositories') {
          if (url.searchParams.get('q') !== '"mana-agent" in:name,description is:public') throw new Error('Unexpected search scope');
          state.publicSearches++;
          return Response.json({ incomplete_results: false, items: [{
            full_name: 'manaplatform/mana-agent', private: false, description: 'Public search fixture.',
            language: 'Python', stargazers_count: 12,
          }] });
        }
        const publicRepo = '/repos/manaplatform/mana-agent';
        const publicCommit = 'b'.repeat(40);
        if (url.pathname === publicRepo) return Response.json({ id: 42, full_name: 'manaplatform/mana-agent',
          default_branch: 'main', private: false, visibility: 'public' });
        if (url.pathname === publicRepo + '/branches/main') return Response.json({ name: 'main', commit: { sha: publicCommit } });
        if (url.pathname.startsWith(publicRepo + '/')) {
          if (url.searchParams.get('ref') !== publicCommit) throw new Error('Expected a pinned public GitHub read');
          if (url.pathname === publicRepo + '/contents') return Response.json([{ path: 'src', type: 'dir' }]);
          const readme = url.pathname === publicRepo + '/readme';
          if (readme || url.pathname === publicRepo + '/contents/src/agent.py') {
            return Response.json({ type: 'file', encoding: 'base64', path: readme ? 'README.md' : 'src/agent.py',
              content: Buffer.from(readme ? '# Mana-Agent\nAn AI assistant with local agent state.' : 'def run_agent():\n    return dispatch_task()').toString('base64') });
          }
        }
        if (url.pathname === '/user/installations/10/repositories') return Response.json({ repositories: [
          { id: 20, full_name: 'example/connector-fixture', private: true, default_branch: 'main', permissions: { push: true } },
        ] });
        if (url.pathname === '/repos/example/connector-fixture') return Response.json({ id: 20 });
        if (url.pathname === '/repos/example/connector-fixture/contents/README.md')
          return Response.json({ type: 'file', path: 'README.md', encoding: 'base64',
            content: Buffer.from('Deterministic GitHub content. ' + validAccess).toString('base64') });
        return Response.json({}, { status: 404 });
      }
      return actualFetch(value, options);
    };
  }, { identity, mockStorage, restart, hasInstallation, deviceCode, userCode, access, refresh, rotatedAccess, rotatedRefresh });
}

export async function githubFixturePublicSearchCount(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as FixtureGlobal).ariaGithubFixture.publicSearches);
}

export async function openConnectors(page: Page) {
  const navigation = page.getByRole('navigation', { name: 'Settings categories' });
  if (!await navigation.isVisible()) await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await navigation.getByRole('button', { name: 'Connectors', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connectors', exact: true })).toBeVisible();
}

export async function connectGithubFixture(app: ElectronApplication, page: Page, { reviewRepositories = true } = {}) {
  await openConnectors(page);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const verification = page.getByRole('region', { name: 'GitHub device verification' });
  await expect(verification.getByText(userCode, { exact: true })).toBeVisible();
  await expect(verification).toContainText('Never authorize a code someone else sent you.');
  const pending = await page.evaluate(() => window.aria!.connectors({ action: 'status' }));
  expect(pending.attempt?.phase).toBe('waiting');
  expect(Object.keys(pending.attempt?.phase === 'waiting' ? pending.attempt.verification : {}).sort()).toEqual(['expiresAt', 'userCode']);
  await app.evaluate(() => { (globalThis as FixtureGlobal).ariaGithubFixture.authorized = true; });
  await expect(page.getByRole('status').filter({ hasText: 'Verifying GitHub account' })).toBeVisible({ timeout: 10000 });
  await expect(verification).toHaveCount(0);
  const verifying = await page.evaluate(() => window.aria!.connectors({ action: 'status' }));
  expect(verifying.attempt).toEqual({ id: pending.attempt?.id, phase: 'verifying' });
  await app.evaluate(() => { (globalThis as FixtureGlobal).ariaGithubFixture.allowVerification = true; });
  await expect(page.getByRole('heading', { name: 'fixture-user', exact: true })).toBeVisible({ timeout: 10000 });
  expect(await app.evaluate(() => (globalThis as FixtureGlobal).ariaGithubFixture.opened)).toBe(1);
  if (!reviewRepositories) return;
  await page.getByRole('checkbox', { name: /example\/connector-fixture/ }).check();
  await page.getByRole('button', { name: 'Review repository access' }).click();
  await expect.poll(() => page.evaluate(() => window.aria!.connectors({ action: 'status' })))
    .toMatchObject({ accounts: [{ state: 'connected', policy: 'read_only', selected: [20] }] });
}

export async function verifyGithubFixtureAfterRestart(app: ElectronApplication, page: Page) {
  await openConnectors(page);
  await expect.poll(() => page.evaluate(() => window.aria!.connectors({ action: 'status' })))
    .toMatchObject({ accounts: [{ state: 'connected', policy: 'read_only', selected: [20] }] });
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as FixtureGlobal).ariaGithubFixture.refreshes)).toBe(1);
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  expect(await page.evaluate(() => window.aria!.connectors({ action: 'status' }))).toMatchObject({
    error: null, accounts: [{ state: 'connected', selected: [20] }],
  });
}
