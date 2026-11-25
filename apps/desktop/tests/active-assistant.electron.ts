import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProviderFixture } from '../../../tests/provider-fixture';

const root = path.resolve(__dirname, '..');

test('supports default AI web search with snippets ("What is Mana-Agent?"), standing memory recall, and scoped workspace tools', async () => {
  test.setTimeout(90_000);
  const fixture = await createProviderFixture();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-active-assistant-'));
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-workspace-proj-'));
  await fs.writeFile(
    path.join(workspaceDir, 'README.md'),
    '# Mana Companion\n\nLocal repo README for testing.',
  );
  let app: ElectronApplication | undefined;
  try {
    const env = {
      ...process.env,
      ARIA_TEST_DATA_DIR: directory,
      OPENAI_BASE_URL: fixture.baseUrl,
      OPENAI_MODEL: 'fixture-model',
      OPENAI_API_KEY: 'test-only-key',
      ARIA_SYSTEM_PROMPT: '',
    };
    delete (env as NodeJS.ProcessEnv).VITE_DEV_SERVER_URL;
    delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [root], env });

    await app.evaluate(({ session }) => {
      const fromPartition = session.fromPartition.bind(session);
      session.fromPartition = (name, options) => {
        const profile = fromPartition(name, options);
        if (name.startsWith('aria-ai-')) {
          profile.protocol.handle('https', (request) => {
            const addr = new URL(request.url);
            if (addr.origin === 'https://search.brave.com' && addr.pathname === '/search') {
              return new Response(
                '<title>Search</title><main><div data-type="web"><div class="result-content">' +
                  '<a href="https://example.com/">Mana-Agent Docs</a>' +
                  '<p class="snippet-description">Mana-Agent is an autonomous agent runtime.</p>' +
                  '</div></div></main>',
                { headers: { 'Content-Type': 'text/html' } },
              );
            }
            if (addr.origin === 'https://example.com') {
              return new Response(
                '<title>Mana-Agent Docs</title><main><p>Mana-Agent builds autonomous workflows.</p></main>',
                { headers: { 'Content-Type': 'text/html' } },
              );
            }
            return profile.fetch(request, { bypassCustomProtocolHandlers: true });
          });
        }
        return profile;
      };
    });

    const page: Page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()), { timeout: 20_000 })
      .toMatchObject({ state: 'ready' });
    await page.evaluate(() => window.aria!.importRegistryEnvironment());
    await expect.poll(() => page.evaluate(() => window.aria!.chatStatus()))
      .toMatchObject({ state: 'ready', configured: true });

    // 1. Default web policy ships with aiBrowser enabled out of the box.
    expect(await page.evaluate(() => window.aria!.webSettings())).toMatchObject({
      enabled: true,
      aiBrowser: true,
    });

    // 2. "What is Mana-Agent?" discovers web_search + snippet on a fresh profile.
    const manaPrompt = 'What is Mana-Agent?';
    fixture.queueTool(manaPrompt, 'find_capabilities', { query: 'web search' });
    fixture.queueTool(manaPrompt, 'load_capabilities', { ids: ['web.web_search'] });
    fixture.queueTool(manaPrompt, 'web_web_search', { args: { query: 'Mana-Agent' } });
    const searchResults: unknown[] = [];
    fixture.onToolResult(manaPrompt, (value) => {
      searchResults.push(value);
      return undefined;
    });
    fixture.finalReply(
      manaPrompt,
      'Mana-Agent is an autonomous agent runtime. [Mana-Agent Docs](https://example.com/)',
    );
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(manaPrompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.from-assistant[data-status="completed"]').last()).toBeVisible({
      timeout: 20_000,
    });
    expect(JSON.stringify(searchResults)).toContain('Mana-Agent is an autonomous agent runtime.');

    // 3. Standing memory recall consent eliminates modal prompts on selective recall in a new chat.
    await page.evaluate(async () => {
      const { settings } = await window.aria!.memoryStatus();
      await window.aria!.saveMemorySettings({ ...settings, enabled: true }, true);
    });
    expect((await page.evaluate(() => window.aria!.memoryStatus())).settings.recallConsent).toBeDefined();

    // Save a user preference in Chat 1, then verify automatic selective recall in Chat 2 without dialog.
    const pref = 'Our internal project codename is Horizon-9.';
    fixture.queueTool(
      pref,
      'aria_reply_metadata',
      { candidates: [{ category: 'project', content: pref }] },
      'Noted Horizon-9.',
    );
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(pref);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.from-assistant[data-status="completed"]').last()).toBeVisible();
    // The memory worker indexes candidates in batches after the chat is saved.
    await expect.poll(
      () => page.evaluate(() => window.aria!.searchMemories({ query: 'Horizon-9' })),
      { timeout: 15_000 },
    ).toMatchObject({ records: [{ value: { content: pref } }] });

    // Ensure modal dialog would fail if triggered during automatic recall!
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => {
        throw new Error('Unexpected recall confirmation dialog');
      };
    });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const followUp = 'What is our Horizon-9 codename?';
    fixture.finalReply(followUp, 'Your project codename is Horizon-9.');
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(followUp);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.from-assistant[data-status="completed"]').last()).toBeVisible();
    const lastRequest = fixture.received.at(-1)?.body.messages ?? [];
    expect(JSON.stringify(lastRequest)).toContain(pref);

    // 4. Register scoped project folder via dialog.showOpenDialog -> chooseWorkspace() and test workspace.* + OperationApproval + path containment.
    await app.evaluate(({ dialog }, targetDir) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [targetDir] });
      const state = { calls: 0, response: 0 };
      (globalThis as unknown as { __workspaceApproval: typeof state }).__workspaceApproval = state;
      dialog.showMessageBox = async () => {
        state.calls += 1;
        return { response: state.response, checkboxChecked: false };
      };
    }, workspaceDir);

    const project = await page.evaluate(() => window.aria!.chooseWorkspace());
    expect(project).not.toBeNull();

    // 4a. Decline ("0") blocks workspace.read_file cleanly with PERMISSION_DENIED.
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const declinePrompt = 'Try reading README in our project when declined.';
    fixture.queueTool(declinePrompt, 'find_capabilities', { query: 'read workspace file' });
    fixture.queueTool(declinePrompt, 'load_capabilities', { ids: ['workspace.read_file'] });
    fixture.queueTool(declinePrompt, 'workspace_read_file', {
      projectId: project!.id,
      path: 'README.md',
    });
    const declinedOutcomes: unknown[] = [];
    fixture.onToolResult(declinePrompt, (value) => {
      declinedOutcomes.push(value);
      return undefined;
    });
    fixture.finalReply(declinePrompt, 'Access to README.md was declined.');
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(declinePrompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.from-assistant[data-status="failed"]').last()).toBeVisible({
      timeout: 15_000,
    });
    expect(JSON.stringify(declinedOutcomes)).toContain('PERMISSION_DENIED');

    // 4b. Allow for this execution ("2") prompts once across search_files + repeated read_file, while ../ traversal fails safely.
    await app.evaluate(() => {
      const state = (globalThis as unknown as { __workspaceApproval: { calls: number; response: number } }).__workspaceApproval;
      state.calls = 0;
      state.response = 2;
    });
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const allowPrompt = 'Inspect workspace repo, search README, read it twice, and reject escaping path.';
    fixture.queueTool(allowPrompt, 'find_capabilities', { query: 'workspace repo search read' });
    fixture.queueTool(allowPrompt, 'load_capabilities', {
      ids: ['workspace.repo_info', 'workspace.search_files', 'workspace.read_file'],
    });
    fixture.queueTool(allowPrompt, 'workspace_repo_info', { projectId: project!.id });
    fixture.queueTool(allowPrompt, 'workspace_search_files', { projectId: project!.id, query: 'Mana Companion' });
    fixture.queueTool(allowPrompt, 'workspace_read_file', { projectId: project!.id, path: 'README.md' });
    fixture.queueTool(allowPrompt, 'workspace_read_file', { projectId: project!.id, path: '../outside.txt' });
    const allowOutcomes: unknown[] = [];
    fixture.onToolResult(allowPrompt, (value) => {
      allowOutcomes.push(value);
      return undefined;
    });
    fixture.finalReply(allowPrompt, 'Mana Companion local repo verified.');
    await page.getByRole('textbox', { name: 'Message Aria' }).fill(allowPrompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.from-assistant[data-status="completed"]').last()).toBeVisible({
      timeout: 20_000,
    });
    const approvalCalls = await app.evaluate(
      () => (globalThis as unknown as { __workspaceApproval: { calls: number } }).__workspaceApproval.calls,
    );
    expect(approvalCalls).toBe(1);
    const serialized = JSON.stringify(allowOutcomes);
    expect(serialized).toContain('Local repo README for testing.');
    expect(serialized).toContain('PERMISSION_DENIED');
    expect(await page.locator('.from-assistant .markdown').last().innerText()).toContain(
      'Mana Companion local repo verified.',
    );
  } finally {
    await app?.close();
    await fixture.close();
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
