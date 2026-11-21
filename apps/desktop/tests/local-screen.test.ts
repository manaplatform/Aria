import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { CapabilityHostRequest } from '@aria/shared';
import { ComputerRuntime } from '../electron/runtime/computer';
import { LocalComputer } from '../electron/runtime/local-computer';
import { RuntimeStore } from '../electron/runtime/store';

const { openPath, capture, frame } = vi.hoisted(() => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const thumbnail = {
    isEmpty: () => false,
    toPNG: () => bytes,
    getSize: () => ({ width: 8, height: 6 }),
  };
  return {
    frame: bytes,
    openPath: vi.fn(async (_path: string) => ''),
    capture: vi.fn(async () => [{ display_id: '12', thumbnail }]),
  };
});
vi.mock('electron', () => ({
  app: { getPath: () => '/home/fixture' },
  shell: { openPath },
  screen: { getAllDisplays: () => [{ id: 12, size: { width: 800, height: 600 }, scaleFactor: 1 }] },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  desktopCapturer: { getSources: capture },
}));

it('shares only the approved display and requests separate permission to open its file manager', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aria-local-screen-'));
  const store = new RuntimeStore(directory);
  const driver = new LocalComputer();
  const approve = vi.fn(async (_title: string, _detail: string) => false);
  const runtime = new ComputerRuntime(
    store,
    [driver],
    () => 'fixture',
    (owner) => owner === 'chat',
    approve,
    () => undefined,
    { read: vi.fn(), adopt: vi.fn(), script: vi.fn() },
  );
  const signal = AbortSignal.timeout(5000);
  const primary = {
    connectionId: randomUUID(),
    endpoint: 'https://api.openai.com/v1',
    model: 'fixture',
  };
  const dispatch = (
    operation: Extract<CapabilityHostRequest, { type: 'runtime' }>['operation'],
    input: Record<string, unknown>,
    conversationId = 'chat',
  ) =>
    runtime.dispatch(
      {
        id: randomUUID(),
        requestId: 'request',
        conversationId,
        assistantMessageId: 'turn',
        revision: 'fixture',
        type: 'runtime',
        stepId: randomUUID(),
        callId: randomUUID(),
        primary,
        operation,
        input,
      },
      signal,
    );

  try {
    expect(driver.ready()).toBe(false);
    await expect(
      driver.prepareScreen('chat', { id: 99, label: 'Other display' }, signal),
    ).rejects.toThrow('could not be captured');
    await driver.prepareScreen('chat', { id: 12, label: 'Display 1' }, signal);
    await expect(dispatch('computer.inspect', {}, 'other')).resolves.toMatchObject({
      data: {
        environments: expect.arrayContaining([
          { environment: 'local-desktop', available: false, actions: [] },
        ]),
      },
    });
    const opened = await dispatch('computer.open', { environment: 'local-desktop', mode: 'aria' });
    expect(opened.data?.actions).toEqual(['screenshot', 'open_file_manager']);
    const sessionId = String(opened.data?.sessionId);
    const observed = await dispatch('computer.observe', { sessionId, format: 'structured' });
    const observationId = (observed.data?.observation as { id: string }).id;
    await expect(
      dispatch('computer.act', {
        sessionId,
        observationId,
        actions: [{ type: 'click', x: 2, y: 2, button: 'left' }],
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const launch = () =>
      dispatch('computer.act', {
        sessionId,
        observationId,
        actions: [{ type: 'open_file_manager' }],
      });
    await expect(launch()).resolves.toMatchObject({
      data: {
        outcomes: [{ index: 0, action: 'open_file_manager', status: 'declined' }],
      },
    });
    expect(openPath).not.toHaveBeenCalled();
    const refreshed = await dispatch('computer.observe', { sessionId, format: 'structured' });
    approve.mockResolvedValueOnce(true);
    await expect(
      dispatch('computer.act', {
        sessionId,
        observationId: (refreshed.data?.observation as { id: string }).id,
        actions: [{ type: 'open_file_manager' }],
      }),
    ).resolves.toMatchObject({
      data: {
        outcomes: [{ index: 0, action: 'open_file_manager', status: 'submitted' }],
      },
    });
    expect(openPath).toHaveBeenCalledExactlyOnceWith('/home/fixture');
    await expect(
      dispatch('computer.observe', { sessionId, format: 'image' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await runtime.preview('chat', sessionId)).toBeUndefined();
    approve.mockResolvedValueOnce(true);
    await expect(
      dispatch('computer.observe', { sessionId, format: 'image' }),
    ).resolves.toMatchObject({
      computerImage: {
        bytes: new Uint8Array(frame),
        observation: { screenshot: { width: 8, height: 6 } },
      },
    });
    driver.disconnectDisplay(12);
    expect(await runtime.preview('chat', sessionId)).toBeUndefined();
    await expect(
      dispatch('computer.observe', { sessionId, format: 'structured' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  } finally {
    await runtime.shutdown();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
