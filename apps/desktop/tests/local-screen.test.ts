import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { CapabilityHostRequest } from '@aria/shared';
import { ComputerRuntime } from '../electron/runtime/computer';
import { LocalComputer } from '../electron/runtime/local-computer';
import { RuntimeStore } from '../electron/runtime/store';

const { openPath, capture, frame, nativeCommand, display } = vi.hoisted(() => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const thumbnail = {
    isEmpty: () => false,
    toPNG: () => bytes,
    getSize: () => ({ width: 8, height: 6 }),
  };
  return {
    frame: bytes,
    openPath: vi.fn<(_: string) => Promise<string>>(async () => ''),
    capture: vi.fn(async () => [{ display_id: '12', thumbnail }]),
    nativeCommand: vi.fn<(input: Record<string, unknown>) => Record<string, unknown>>(() => ({})),
    display: {
      id: 12,
      size: { width: 800, height: 600 },
      bounds: { x: -800, y: 0, width: 800, height: 600 },
      scaleFactor: 1,
      rotation: 0,
    },
  };
});
vi.mock('node:fs', async (actual) => {
  const fs = await actual<typeof import('node:fs')>();
  const existsSync = (file: Parameters<typeof fs.existsSync>[0]) =>
    String(file).endsWith('/aria-macos-computer') || fs.existsSync(file);
  return {
    ...fs,
    existsSync,
    default: { ...fs, existsSync },
  };
});
vi.mock('node:child_process', async (actual) => {
  const original = await actual<typeof import('node:child_process')>();
  const { EventEmitter } = await import('node:events');
  const spawn = () => {
    const child = new EventEmitter();
    const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
    const stdin = Object.assign(new EventEmitter(), {
      write(serialized: string) {
        const input = JSON.parse(serialized) as Record<string, unknown>;
        const response = nativeCommand(input);
        queueMicrotask(() =>
          stdout.emit('data', JSON.stringify({ id: input.id, ...response }) + '\n'),
        );
      },
    });
    return Object.assign(child, { stdin, stdout, stderr: { resume: vi.fn() }, kill: vi.fn() });
  };
  return { ...original, spawn, default: { ...original, spawn } };
});
vi.mock('electron', () => ({
  app: { getPath: () => '/home/fixture' },
  shell: { openPath },
  screen: { getAllDisplays: () => [display] },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true }) },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  desktopCapturer: { getSources: capture },
}));

async function localScreen() {
  const directory = await mkdtemp(path.join(tmpdir(), 'aria-local-screen-'));
  const store = new RuntimeStore(directory);
  let identity = 'fixture';
  const driver = new LocalComputer(() => identity);
  const approve = vi.fn<(_: string, detail: string) => Promise<boolean>>(async () => false);
  const runtime = new ComputerRuntime(
    store,
    [driver],
    () => identity,
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

  return {
    driver,
    runtime,
    dispatch,
    signal,
    approve,
    setIdentity(value: string) {
      identity = value;
    },
    async close() {
      await runtime.shutdown();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('shares only the approved display and requests separate permission to open its file manager', async () => {
  const { driver, runtime, dispatch, signal, approve, close } = await localScreen();
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
    await close();
  }
});

it('keeps explicit standing access across sessions and binds it to the chat and primary', async () => {
  const { driver, runtime, dispatch, signal, approve, setIdentity, close } = await localScreen();
  try {
    await driver.prepareScreen('chat', { id: 12, label: 'Display 1' }, signal, 'fixture');
    const open = () => dispatch('computer.open', { environment: 'local-desktop', mode: 'aria' });
    const sessionId = String((await open()).data?.sessionId);
    await expect(
      dispatch('computer.observe', { sessionId, format: 'image' }),
    ).resolves.toHaveProperty('computerImage');
    expect(approve).not.toHaveBeenCalled();
    await dispatch('computer.close', { sessionId });
    const next = String((await open()).data?.sessionId);
    expect(next).not.toBe(sessionId);
    const observation = await dispatch('computer.observe', {
      sessionId: next,
      format: 'structured',
    });
    await expect(
      dispatch('computer.act', {
        sessionId: next,
        observationId: (observation.data?.observation as { id: string }).id,
        actions: [{ type: 'open_file_manager' }],
      }),
    ).resolves.toMatchObject({ data: { outcomes: [{ status: 'submitted' }] } });
    expect(approve).not.toHaveBeenCalled();
    setIdentity('different-primary');
    await expect(
      dispatch('computer.observe', { sessionId: next, format: 'image' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    setIdentity('fixture');
    driver.revoke();
    expect(driver.ready()).toBe(false);
    expect(await runtime.preview('chat', next)).toBeUndefined();
  } finally {
    await close();
  }
});

it.runIf(process.platform === 'darwin')(
  'launches only Messages and binds approved pointer input to an image',
  async () => {
    nativeCommand.mockClear();
    nativeCommand.mockImplementation((input) => {
      if (input.operation === 'screen_probe')
        return { approved: true, accessibility: true, messages: true };
      if (input.operation === 'open_application') return { submitted: true, verified: true };
      return { submitted: true, verified: input.action === 'move' };
    });
    const { driver, dispatch, signal, approve, close } = await localScreen();
    try {
      await driver.prepareScreen('chat', { id: 12, label: 'Display 1' }, signal);
      const opened = await dispatch('computer.open', {
        environment: 'local-desktop',
        mode: 'aria',
      });
      expect(opened.data?.actions).toEqual([
        'screenshot',
        'open_file_manager',
        'open_application',
        'move',
        'click',
      ]);
      const sessionId = String(opened.data?.sessionId);
      const observe = async (format: 'structured' | 'image') => {
        const observed = await dispatch('computer.observe', { sessionId, format });
        return (observed.data?.observation as { id: string }).id;
      };
      const act = (observationId: string, action: object) =>
        dispatch('computer.act', {
          sessionId,
          observationId,
          actions: [action],
        });
      let id = await observe('structured');
      await expect(act(id, { type: 'move', x: 2, y: 2 })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(
        act(id, { type: 'open_application', application: 'other' }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      approve.mockResolvedValueOnce(true);
      await expect(
        act(id, { type: 'open_application', application: 'messages' }),
      ).resolves.toMatchObject({
        data: { outcomes: [{ action: 'open_application', status: 'verified' }] },
      });
      expect(nativeCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({ operation: 'open_application', application: 'messages' }),
      );
      approve.mockResolvedValueOnce(true);
      id = await observe('image');
      await expect(act(id, { type: 'click', x: 8, y: 2, button: 'left' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(act(id, { type: 'move', x: 2, y: 2 })).resolves.toMatchObject({
        data: { outcomes: [{ action: 'move', status: 'declined' }] },
      });
      expect(nativeCommand).toHaveBeenCalledTimes(2);
      approve.mockResolvedValueOnce(true);
      id = await observe('image');
      approve.mockImplementationOnce(async () => {
        const [source] = await capture();
        capture.mockResolvedValueOnce([
          {
            ...source,
            thumbnail: {
              ...source.thumbnail,
              toPNG: () => Buffer.concat([frame, Buffer.from([1])]),
            },
          },
        ]);
        return true;
      });
      await expect(act(id, { type: 'click', x: 2, y: 2, button: 'left' })).resolves.toMatchObject({
        data: { outcomes: [{ action: 'click', status: 'stale-approval' }] },
      });
      expect(nativeCommand).toHaveBeenCalledTimes(2);
      approve.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      id = await observe('image');
      await expect(act(id, { type: 'move', x: 3, y: 4 })).resolves.toMatchObject({
        data: { outcomes: [{ action: 'move', status: 'verified' }] },
      });
      expect(nativeCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          operation: 'screen_pointer',
          action: 'move',
          x: 3.5 / 8,
          y: 4.5 / 6,
          bounds: display.bounds,
        }),
      );
      approve.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      id = await observe('image');
      await expect(act(id, { type: 'click', x: 3, y: 4, button: 'left' })).resolves.toMatchObject({
        data: { outcomes: [{ action: 'click', status: 'submitted' }] },
      });
      expect(nativeCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'click', button: 'left' }),
      );
    } finally {
      nativeCommand.mockReset();
      await close();
    }
  },
);
