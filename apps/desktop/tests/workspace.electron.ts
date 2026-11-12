import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const desktopRoot = path.resolve(__dirname, '..');
let app: ElectronApplication;
let page: Page;
let temporary: string;
let project: string;
const errors: string[] = [];
async function launch(development = false) {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.ARIA_TEST_DATA_DIR = path.join(temporary, 'data');
  delete env.ELECTRON_RUN_AS_NODE;
  if (development) env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:5174';
  app = await electron.launch({ args: [desktopRoot], env });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  // CI displays can clamp the native window below the desktop layout breakpoint.
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.getByRole('navigation', { name: 'Chat navigation' })).toBeVisible();
}
async function openLegacy() {
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'Open legacy workspace', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
}
test.beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aria-electron-'));
  project = path.join(temporary, 'my-project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'hello.ts'), 'export const hello = "Aria";\n');
  errors.length = 0;
  await launch();
  await openLegacy();
});
test.afterEach(async () => {
  await app.close();
  await fs.rm(temporary, { recursive: true, force: true });
});
test('built desktop routes, local project work, persistence, and security', async () => {
  await expect(page.getByText('Good work starts')).toBeVisible();
  await fs.mkdir(path.join(desktopRoot, '.artifacts/screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(desktopRoot, '.artifacts/screenshots/home.png') });
  expect(await page.evaluate(() => typeof (window as Window & { require?: unknown }).require)).toBe(
    'undefined',
  );
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, project);
  await page.getByRole('button', { name: 'Open a project', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Aria' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Message Aria' }).fill('A persistent local draft');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'New task', exact: true }).last().click();
  await page
    .getByRole('textbox', { name: 'Title', exact: true })
    .fill('Build a reliable workspace');
  await page.getByRole('button', { name: 'Save task', exact: true }).click();
  await expect(page.getByRole('button', { name: /Build a reliable workspace/ })).toBeVisible();
  await page.getByRole('button', { name: 'Create plan', exact: true }).last().click();
  await page.getByRole('button', { name: 'Add step', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'New plan step', exact: true })
    .fill('Review the desktop UI');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Complete Review the desktop UI' }).last().click();
  await page.getByRole('link', { name: 'Knowledge', exact: true }).click();
  await page.getByRole('button', { name: 'hello.ts', exact: true }).click();
  await expect(page.getByText('export const hello = "Aria";')).toBeVisible();
  await page.getByRole('button', { name: 'Copy file content', exact: true }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    'export const hello = "Aria";\n',
  );
  expect(
    await page.evaluate(async () => {
      try {
        await window.aria!.readFile('unregistered', '../private');
        return 'unsafe';
      } catch {
        return 'blocked';
      }
    }),
  ).toBe('blocked');
  for (const route of ['Home', 'Agents', 'Terminal', 'History', 'Settings']) {
    await page.getByRole('link', { name: route, exact: true }).click();
    await expect(page.getByRole('main')).toBeVisible();
  }
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Reset layout', exact: true })).toHaveCSS(
    'background-color',
    'rgb(243, 243, 248)',
  );
  await page.screenshot({
    path: path.join(desktopRoot, '.artifacts/screenshots/settings-light.png'),
  });
  await page.getByRole('link', { name: 'Workspace', exact: true }).click();
  // Close immediately after a keystroke to exercise the close-time persistence flush.
  await page.getByRole('textbox', { name: 'Message Aria' }).fill('Saved on close');
  await app.close();
  await launch();
  await openLegacy();
  await page.getByRole('link', { name: 'Workspace', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Aria' })).toHaveValue('Saved on close');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(errors).toEqual([]);
});
test('sample workflow, keyboard search, approvals, responsive panels, and screenshots', async () => {
  await page.getByRole('button', { name: 'Explore sample', exact: true }).click();
  await expect(page.getByText('Simulated content · no real operations')).toBeVisible();
  await expect(page.getByText('Orchestrator (Aria)', { exact: true })).toBeVisible();
  await expect(page.getByRole('log', { name: 'Terminal output' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message Aria' }).fill('Explain the workflow');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Sample response', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Plan title', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Execute', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Execution activity', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page
    .getByRole('button', { name: 'Approve Open pull request', exact: true })
    .first()
    .click();
  await page.getByRole('button', { name: 'Approve sample request', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByText('approved', { exact: true }).first()).toBeVisible();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k');
  await expect(page.getByRole('dialog', { name: 'Search Aria' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search commands' }).fill('Terminal');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Terminal', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page
    .getByRole('button', { name: 'Dismiss notification' })
    .click()
    .catch(() => undefined);
  await page.locator('.conversation-scroll').evaluate((element) => element.scrollTo({ top: 0 }));
  const resize = page.getByRole('separator', { name: 'Resize orchestration panel', exact: true });
  await resize.focus();
  const before = await resize.getAttribute('aria-valuenow');
  await page.keyboard.press('ArrowLeft');
  await expect(resize).not.toHaveAttribute('aria-valuenow', before!);
  await resize.dblclick();
  const panelHeading = page.getByRole('button', { name: /^Task Board/ });
  await panelHeading.click();
  await expect(panelHeading).toHaveAttribute('aria-expanded', 'false');
  await panelHeading.click();
  await fs.mkdir(path.join(desktopRoot, '.artifacts/screenshots'), { recursive: true });
  for (const [width, height] of [
    [1600, 1000],
    [1440, 960],
    [1280, 900],
    [1024, 800],
    [720, 520],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole('textbox', { name: 'Message Aria' })).toBeVisible();
    await expect(page.getByText('Simulated content · no real operations')).toBeVisible({
      visible: width >= 1100,
    });
    await expect(
      page.getByRole('complementary', { name: 'Orchestration', exact: true }),
    ).toBeVisible({ visible: width >= 1100 });
    await page.locator('.conversation-scroll').evaluate((element) => element.scrollTo({ top: 0 }));
    await page.screenshot({
      path: path.join(desktopRoot, `.artifacts/screenshots/workspace-${width}.png`),
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    if (width < 1100) {
      await expect(
        page.getByRole('dialog', { name: 'Orchestration', exact: true }),
      ).not.toBeVisible();
    }
  }
  await page.getByRole('button', { name: 'Show orchestration panel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Orchestration', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Orchestration', exact: true })).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('development Electron startup with nonce-protected Vite refresh', async () => {
  await app.close();
  await launch(true);
  await openLegacy();
  await expect(page.getByText('Good work starts')).toBeVisible();
  await page.getByRole('button', { name: 'Explore sample', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Message Aria' })).toBeVisible();
  expect(await page.evaluate(() => typeof window.aria?.platform)).toBe('string');
  expect(errors).toEqual([]);
});
