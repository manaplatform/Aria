import { test, expect } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderFixture } from '../../../tests/provider-fixture';
import providers from '../electron/connectors/providers.json';
import {
  connectGithubFixture, fixtureGithub, githubFixturePublicSearchCount, githubFixtureSecrets, installGithubFixture, openConnectors,
  verifyGithubFixtureAfterRestart,
} from './github-connector-fixture';

function launchEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  delete env.ARIA_DEV_GITHUB_CLIENT_ID;
  delete env.ARIA_DEV_GITHUB_APP_SLUG;
  return env;
}

test('uses the bundled GitHub default without a connector environment', async () => {
  const executablePath = process.env.ARIA_TEST_PACKAGED_APP;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-connect-default-'));
  const app = await electron.launch({
    ...(executablePath && { executablePath }),
    args: executablePath ? [] : [path.resolve(__dirname, '..')],
    env: { ...launchEnvironment(), ARIA_TEST_DATA_DIR: directory },
  });
  try {
    const page = await app.firstWindow();
    await openConnectors(page);
    const connect = page.getByRole('button', { name: 'Connect', exact: true });
    if (providers.github) await expect(connect).toBeEnabled();
    else {
      await expect(connect).toBeDisabled();
      await expect(page.getByText('This build is missing a valid GitHub App registration.', { exact: false })).toBeVisible();
    }
  } finally {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('connects GitHub through Settings and discovers a scoped read in normal chat', async () => {
  const packaged = process.env.ARIA_TEST_PACKAGED_APP;
  test.skip(Boolean(packaged) && !providers.github, 'The official App identity is pending. The packaged unavailable state is tested separately.');
  const identity = providers.github ?? fixtureGithub;
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
  const launch = () => electron.launch({
    ...(packaged && { executablePath: packaged }),
    args: packaged ? [] : [path.resolve(__dirname, '..')],
    env: {
      ...launchEnvironment(), ARIA_TEST_DATA_DIR: directory,
      OPENAI_API_KEY: 'test-only-key', OPENAI_MODEL: 'fixture-model', OPENAI_BASE_URL: fixture.baseUrl,
      ...(providers.github ? {} : {
        ARIA_DEV_GITHUB_CLIENT_ID: identity.clientId, ARIA_DEV_GITHUB_APP_SLUG: identity.slug,
      }),
    },
  });
  let app = await launch();
  try {
    await installGithubFixture(app, identity, { mockStorage: true });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20000 }).toMatchObject({ state: 'ready' });
    if (!(await page.evaluate(() => window.aria!.chatStatus())).configured)
      await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus())).toMatchObject({ configured: true });
    await connectGithubFixture(app, page);
    await page.evaluate(() => { location.hash = '/chat'; });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(prompt);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.from-assistant .markdown').last()).toContainText('Verified GitHub README.');
    const requests = JSON.stringify(fixture.received);
    for (const secret of githubFixtureSecrets) {
      expect(requests).not.toContain(secret);
      await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
    }
    await app.close();
    app = await launch();
    await installGithubFixture(app, identity, { mockStorage: true, restart: true });
    await verifyGithubFixtureAfterRestart(app, await app.firstWindow());
  } finally {
    await app.close();
    await fixture.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('explains a public GitHub repository from its README and source without app installations or browser access', async () => {
  const executablePath = process.env.ARIA_TEST_PACKAGED_APP;
  test.skip(Boolean(executablePath) && !providers.github, 'Packaged authorization requires the bundled GitHub identity.');
  const identity = providers.github ?? fixtureGithub;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-github-public-search-'));
  const fixture = await createProviderFixture();
  const prompt = 'Check GitHub for mana-agent. What is it and what does its code do?';
  const repo = 'manaplatform/mana-agent';
  const ids = ['github.search_public_repositories', 'github.get_public_readme', 'github.list_public_files', 'github.read_public_file'];
  fixture.queueTool(prompt, 'find_capabilities', { query: 'public GitHub repository', namespace: 'github', includeUnavailable: true });
  fixture.onToolResult(prompt, (result) => {
    const payload = result as { items?: { id: string; available: boolean }[]; loaded?: unknown;
      data?: { results?: { name: string }[]; path?: string; text?: string; entries?: { path: string }[] };
      sources?: { url: string; evidenceStatus: string }[] };
    if (payload.items && payload.items.filter((item) => item.available && ids.includes(item.id)).length === ids.length &&
        !payload.items.some((item) => !ids.includes(item.id) && item.available))
      return { name: 'load_capabilities', input: { ids } };
    if (payload.loaded) return { name: 'github_search_public_repositories', input: { query: 'mana-agent' } };
    if (payload.data?.results?.[0]?.name === repo && payload.sources?.some((source) =>
      source.url === `https://github.com/${repo}` && source.evidenceStatus === 'metadata'))
      return { name: 'github_get_public_readme', input: { repository: repo } };
    if (payload.data?.path === 'README.md' && payload.data.text?.includes('An AI assistant'))
      return { name: 'github_list_public_files', input: { repository: repo } };
    if (payload.data?.entries?.some((entry) => entry.path === 'src'))
      return { name: 'github_read_public_file', input: { repository: repo, path: 'src/agent.py' } };
    if (payload.data?.path === 'src/agent.py' && payload.data.text?.includes('return dispatch_task()') &&
        payload.sources?.some((source) => source.evidenceStatus === 'inspected' &&
          source.url === `https://github.com/${repo}/blob/${'b'.repeat(40)}/src/agent.py`))
      fixture.finalReply(prompt, 'Mana-Agent is an AI assistant. Its runner calls dispatch_task().');
    return undefined;
  });
  const app = await electron.launch({
    ...(executablePath && { executablePath }),
    args: executablePath ? [] : [path.resolve(__dirname, '..')],
    env: {
      ...launchEnvironment(), ARIA_TEST_DATA_DIR: directory,
      OPENAI_API_KEY: 'test-only-key', OPENAI_MODEL: 'fixture-model', OPENAI_BASE_URL: fixture.baseUrl,
      ...(providers.github ? {} : { ARIA_DEV_GITHUB_CLIENT_ID: identity.clientId, ARIA_DEV_GITHUB_APP_SLUG: identity.slug }),
    },
  });
  try {
    await installGithubFixture(app, identity, { mockStorage: true, hasInstallation: false });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20000 }).toMatchObject({ state: 'ready' });
    if (!(await page.evaluate(() => window.aria!.chatStatus())).configured)
      await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await page.evaluate(async () => {
      const policy = await window.aria!.webSettings();
      delete policy.warning;
      await window.aria!.saveWebSettings({ ...policy, aiBrowser: false, fetches: 1 });
    });
    await connectGithubFixture(app, page, { reviewRepositories: false });
    expect(await page.evaluate(() => window.aria!.connectors({ action: 'status' })))
      .toMatchObject({ accounts: [{ state: 'needs_repositories', repositories: [], selected: [] }] });
    await page.evaluate(() => { location.hash = '/chat'; });
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(prompt);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.from-assistant .markdown').last()).toContainText('Its runner calls dispatch_task().');
    expect(await githubFixturePublicSearchCount(app)).toBe(1);
    for (const secret of githubFixtureSecrets) expect(JSON.stringify(fixture.received)).not.toContain(secret);
  } finally {
    await app.close();
    await fixture.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('authorizes the live GitHub App through the system browser', async () => {
  test.skip(process.env.ARIA_RUN_LIVE_GITHUB_CONNECT !== '1', 'Opt in with an installed GitHub App and a disposable repository.');
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
    await openConnectors(page);
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
