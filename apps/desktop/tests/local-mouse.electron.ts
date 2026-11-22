import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ComputerAction } from '@aria/shared';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

test('delivers native mouse gestures to a synthetic desktop window', async () => {
  test.skip(
    process.env.ARIA_TEST_LOCAL_MOUSE !== '1' ||
      (process.platform !== 'darwin' && process.platform !== 'win32'),
    'Requires an interactive test desktop with native mouse and screen permissions granted.',
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'aria-native-mouse-'));
  const root = path.resolve(__dirname, '..');
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, ARIA_TEST_DATA_DIR: directory },
  });
  try {
    const seen = await app.evaluate(
      async ({ BrowserWindow, screen }, { root, directory, id }) => {
        const load = process.getBuiltinModule('node:module')!.createRequire(`${root}/package.json`);
        const { LocalComputer } = load(
          `${root}/dist-electron/runtime/local-computer.js`,
        ) as typeof import('../electron/runtime/local-computer');
        const { RuntimeStore } = load(
          `${root}/dist-electron/runtime/store.js`,
        ) as typeof import('../electron/runtime/store');
        const store = new RuntimeStore(directory);
        const driver = new LocalComputer(store, () => 'fixture');
        const display = screen.getPrimaryDisplay();
        const view = new BrowserWindow({
          x: display.workArea.x + 50,
          y: display.workArea.y + 50,
          width: Math.min(700, display.workArea.width - 100),
          height: Math.min(500, display.workArea.height - 100),
          alwaysOnTop: true,
          frame: false,
          show: false,
        });
        try {
          await view.loadURL(
            'data:text/html;charset=utf-8,' +
              encodeURIComponent(`
          <title>Aria native mouse fixture</title>
          <style>html { height: 100%; background: #fff } body { min-height: 95vh }</style>
          <p>Aria native mouse fixture</p>
          <script>
            const seen = [];
            for (const kind of ['mousedown', 'mouseup', 'mousemove', 'dblclick', 'wheel', 'contextmenu', 'auxclick']) {
              addEventListener(kind, event => {
                if (event.cancelable) event.preventDefault();
                seen.push([kind, event.button, event.buttons, event.deltaX, event.deltaY]);
              }, { passive: false });
            }
          </script>`),
          );
          view.show();
          view.focus();
          const signal = AbortSignal.timeout(15_000);
          await driver.prepareScreen(
            '',
            { id: display.id, label: 'Test display' },
            signal,
            'fixture',
          );
          const access = await driver.access(signal);
          if (access.state !== 'ready') throw new Error(`Native fixture access is ${access.state}`);
          await driver.open('fixture', id, { environment: 'local-desktop', mode: 'aria' }, signal);
          const { observation } = await driver.observe('fixture', id, id, true, signal);
          const frame = observation.screenshot!;
          const bounds = view.getContentBounds();
          const point = (fraction: number) => ({
            x: Math.floor(
              ((bounds.x - display.bounds.x + bounds.width * fraction) * frame.width) /
                display.bounds.width,
            ),
            y: Math.floor(
              ((bounds.y - display.bounds.y + bounds.height / 2) * frame.height) /
                display.bounds.height,
            ),
          });
          const start = point(0.3);
          const end = point(0.7);
          const actions: ComputerAction[] = [
            { type: 'move', ...start },
            { type: 'click', button: 'left', ...start },
            { type: 'click', button: 'right', ...start },
            { type: 'click', button: 'middle', ...start },
            { type: 'double_click', ...start },
            { type: 'drag', path: [start, point(0.5), end] },
            { type: 'scroll', ...end, scrollX: 100, scrollY: 100 },
          ];
          for (const action of actions) {
            if (action.type === 'wait' || action.type === 'screenshot')
              throw new Error('Use mouse actions.');
            if (!view.isFocused()) throw new Error('The synthetic test window lost focus.');
            await driver.input('fixture', id, id, observation, action, signal);
            await view.webContents.executeJavaScript(
              'new Promise(resolve => requestAnimationFrame(resolve))',
            );
          }
          return (await view.webContents.executeJavaScript('seen')) as (string | number | null)[][];
        } finally {
          driver.reset();
          if (!view.isDestroyed()) view.destroy();
          store.close();
        }
      },
      { root, directory: path.join(directory, 'mouse-fixture'), id: randomUUID() },
    );

    for (const button of [0, 1, 2])
      expect(seen.some(([kind, value]) => kind === 'mousedown' && value === button)).toBe(true);
    expect(seen.some(([kind]) => kind === 'dblclick')).toBe(true);
    expect(seen.some(([kind, , held]) => kind === 'mousemove' && held === 1)).toBe(true);
    expect(seen.some(([kind, , held]) => kind === 'mouseup' && held === 0)).toBe(true);
    expect(seen.some(([kind, , , x]) => kind === 'wheel' && Number(x) !== 0)).toBe(true);
    expect(seen.some(([kind, , , , y]) => kind === 'wheel' && Number(y) !== 0)).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
