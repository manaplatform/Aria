import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

const endpoint = process.env.ARIA_TEST_DOCKER_ENDPOINT;
const image = process.env.ARIA_TEST_COMPUTER_IMAGE;

test('runs real graphical input inside an offline Aria Docker desktop', async () => {
  test.skip(
    !endpoint || !image,
    'Requires the reviewed graphical image and an authorized Docker test host.',
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'aria-virtual-computer-'));
  const root = path.resolve(__dirname, '..');
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, ARIA_TEST_DATA_DIR: directory },
  });
  try {
    const result = await app.evaluate(
      async ({ app }, { endpoint, image, root, id }) => {
        const load = process.getBuiltinModule('node:module')!.createRequire(`${root}/package.json`);
        const { VirtualComputer } = load(
          `${root}/dist-electron/runtime/virtual-computer.js`,
        ) as typeof import('../electron/runtime/virtual-computer');
        const driver = new VirtualComputer(
          () => ({ engineSocket: endpoint, desktopImage: image, commandMs: 10000 }),
          app.getPath('userData'),
        );
        const signal = AbortSignal.timeout(35000);
        await driver.verify(signal);
        await driver.open(
          'fixture',
          id,
          { environment: 'virtual-desktop', mode: 'aria', application: 'mousepad' },
          signal,
        );
        try {
          let capture = await driver.observe('fixture', id, id, true, signal);
          for (
            let index = 0;
            index < 12 && !capture.observation.title?.toLowerCase().includes('mousepad');
            index++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            capture = await driver.observe('fixture', id, id, true, signal);
          }
          const before = capture.bytes;
          await driver.input(
            'fixture',
            id,
            id,
            capture.observation,
            { type: 'type', text: 'Aria graphical test' },
            signal,
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
          const after = await driver.observe('fixture', id, id, true, signal);
          return {
            title: capture.observation.title,
            width: after.observation.screenshot?.width,
            changed:
              !!before && !!after.bytes && !Buffer.from(before).equals(Buffer.from(after.bytes)),
          };
        } finally {
          await driver.close('fixture', id, id);
        }
      },
      { endpoint: endpoint!, image: image!, root, id: randomUUID() },
    );
    expect(result.title).toMatch(/mousepad/i);
    expect(result).toMatchObject({ width: 1024, changed: true });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
