import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { CapabilityHostRequest } from '@aria/shared';
import { ComputerRuntime } from '../electron/runtime/computer';
import { LocalComputer } from '../electron/runtime/local-computer';
import { RuntimeStore } from '../electron/runtime/store';

const { openPath, capture, frame, nativeCommand, display, screenPermission, displays } = vi.hoisted(
  () => {
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
      screenPermission: vi.fn(() => 'granted'),
      displays: vi.fn(),
      display: {
        id: 12,
        size: { width: 800, height: 600 },
        bounds: { x: -800, y: 0, width: 800, height: 600 },
        scaleFactor: 1,
        rotation: 0,
      },
    };
  },
);
vi.mock('node:fs', async (actual) => {
  const fs = await actual<typeof import('node:fs')>();
  const existsSync = (file: Parameters<typeof fs.existsSync>[0]) =>
    String(file).endsWith('aria-macos-computer') ||
    String(file).endsWith('Aria.Computer.exe') ||
    fs.existsSync(file);
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
  screen: {
    getAllDisplays: () => displays() ?? [display],
    dipToScreenRect: (_window: unknown, bounds: typeof display.bounds) => bounds,
  },
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => ({
      isEmpty: () => false,
      getSize: () => ({ width: 8, height: 6 }),
      crop: () => ({ isEmpty: () => false, toPNG: () => bytes }),
    }),
  },
  systemPreferences: { getMediaAccessStatus: screenPermission },
  desktopCapturer: { getSources: capture },
}));

async function localScreen() {
  const directory = await mkdtemp(path.join(tmpdir(), 'aria-local-screen-'));
  const approve = vi.fn<(_: string, detail: string) => Promise<boolean>>(async () => false);
  let identity = 'fixture';
  let foreground = 'chat';
  let store: RuntimeStore;
  let driver: LocalComputer;
  let runtime: ComputerRuntime;
  const launch = () => {
    store = new RuntimeStore(directory);
    driver = new LocalComputer(store, () => identity);
    runtime = new ComputerRuntime(
      store,
      [driver],
      () => identity,
      (owner) => owner === foreground,
      approve,
      () => undefined,
      { read: vi.fn(), adopt: vi.fn(), script: vi.fn() },
    );
  };
  const shutdown = async () => {
    await runtime.shutdown();
    driver.reset();
    store.close();
  };
  launch();
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
    get driver() {
      return driver;
    },
    get runtime() {
      return runtime;
    },
    get store() {
      return store;
    },
    dispatch,
    signal,
    approve,
    setIdentity(value: string) {
      identity = value;
    },
    selectChat(owner: string) {
      const previous = foreground;
      foreground = owner;
      runtime.leave(previous);
    },
    async restart() {
      await shutdown();
      launch();
    },
    async close() {
      await shutdown();
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
    ).rejects.toThrow('disconnected');
    await driver.prepareScreen('chat', { id: 12, label: 'Display 1' }, signal);
    await expect(dispatch('computer.inspect', {}, 'other')).resolves.toMatchObject({
      data: {
        environments: expect.arrayContaining([
          expect.objectContaining({ environment: 'local-desktop', available: false, actions: [] }),
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

const supportsScreenMouse = process.platform === 'darwin' || process.platform === 'win32';

it.runIf(process.platform === 'darwin')(
  'opens a resolved app only after approval, even with an ongoing display grant',
  async () => {
    const token = randomUUID();
    const target = { token, path: '/Applications/Termius.app', bundleId: 'com.termius-dmg.mac' };
    nativeCommand.mockImplementation(({ operation, application }) => {
      if (operation === 'screen_probe')
        return { approved: true, displayKey: 'first', applicationLaunch: true };
      if (operation === 'resolve_application') {
        if (application === 'Termius') return { application: target };
        return { error: 'macOS could not identify one installed app.' };
      }
      return { submitted: true, verified: true };
    });
    const { driver, dispatch, signal, approve, close } = await localScreen();
    try {
      await driver.prepareScreen('', { id: 12, label: 'Display 1' }, signal, 'fixture');
      const opened = await dispatch('computer.open', { environment: 'local-desktop', mode: 'aria' });
      expect(opened.data?.actions).toContain('open_application');
      const sessionId = String(opened.data?.sessionId);
      const observe = () => dispatch('computer.observe', { sessionId, format: 'structured' });
      let observed = await observe();
      const launch = (application: string) =>
        dispatch('computer.act', {
          sessionId,
          observationId: (observed.data?.observation as { id: string }).id,
          actions: [{ type: 'open_application', application }],
        });
      const launches = () =>
        nativeCommand.mock.calls.filter(([input]) => input.operation === 'open_application');
      for (const input of ['/Applications/Termius.app', 'https://example.com', 'Termius; whoami']) {
        await expect(launch(input)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      }
      await expect(launch('Missing App')).rejects.toThrow('could not identify one installed app');
      expect(approve).not.toHaveBeenCalled();
      expect(launches()).toHaveLength(0);

      await expect(launch('Termius')).resolves.toMatchObject({
        data: { outcomes: [{ action: 'open_application', status: 'declined' }] },
      });
      expect(approve).toHaveBeenCalledWith(
        'Allow this computer action once?',
        expect.stringContaining('/Applications/Termius.app\ncom.termius-dmg.mac'),
        expect.any(AbortSignal),
      );
      expect(launches()).toHaveLength(0);

      await expect(launch('Termius')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      observed = await observe();
      approve.mockResolvedValueOnce(true);
      await expect(launch('Termius')).resolves.toMatchObject({
        data: { outcomes: [{ action: 'open_application', status: 'verified' }] },
      });
      expect(launches()).toEqual([
        [expect.objectContaining({ token, displayKey: 'first', bounds: display.bounds })],
      ]);
    } finally {
      nativeCommand.mockReset();
      await close();
    }
  },
);

it.runIf(supportsScreenMouse)(
  'restores the display grant across app launches and chats',
  async () => {
    const fixture = await localScreen();
    const { approve, dispatch, signal } = fixture;
    const firstDisplay = { id: 12, label: 'Display 1' };
    const secondDisplay = { ...display, id: 34, bounds: { ...display.bounds, x: 0 } };
    nativeCommand.mockImplementation((input) => {
      if (input.operation === 'screen_probe') {
        return {
          approved: true,
          accessibility: true,
          displayKey: input.displayId === 12 ? 'first' : 'second',
        };
      }
      return { submitted: true };
    });
    const open = (chat = 'chat') =>
      dispatch('computer.open', { environment: 'local-desktop', mode: 'aria' }, chat);
    try {
      await fixture.driver.prepareScreen('', firstDisplay, signal, 'fixture');
      const sessionId = String((await open()).data?.sessionId);
      await expect(
        dispatch('computer.observe', { sessionId, format: 'image' }),
      ).resolves.toHaveProperty('computerImage');

      await fixture.restart();
      fixture.selectChat('other');
      const next = String((await open('other')).data?.sessionId);
      expect(next).not.toBe(sessionId);
      await expect(
        dispatch('computer.observe', { sessionId, format: 'image' }, 'other'),
      ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
      await expect(
        dispatch('computer.observe', { sessionId: next, format: 'image' }, 'other'),
      ).resolves.toHaveProperty('computerImage');
      expect(approve).not.toHaveBeenCalled();

      fixture.setIdentity('different-primary');
      await expect(
        dispatch('computer.observe', { sessionId: next, format: 'image' }, 'other'),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(fixture.driver.access(signal)).resolves.toMatchObject({
        state: 'primary-changed',
      });
      fixture.setIdentity('fixture');

      displays.mockReturnValueOnce([secondDisplay]);
      await expect(fixture.driver.access(signal)).resolves.toMatchObject({ state: 'unavailable' });
      await expect(fixture.driver.access(signal)).resolves.toMatchObject({ state: 'ready' });
      if (process.platform === 'darwin') {
        screenPermission.mockReturnValue('denied');
        await expect(fixture.driver.access(signal)).resolves.toMatchObject({
          state: 'screen-permission',
        });
        screenPermission.mockReset();
      }

      const originalGrant = fixture.store.localDesktopGrant();
      await expect(
        fixture.driver.prepareScreen('', { id: 99, label: 'Unplugged' }, signal, 'fixture'),
      ).rejects.toThrow('disconnected');
      expect(fixture.store.localDesktopGrant()).toEqual(originalGrant);

      displays.mockReturnValue([display, secondDisplay]);
      capture.mockImplementation(async () => {
        const thumbnail = {
          isEmpty: () => false,
          toPNG: () => frame,
          getSize: () => ({ width: 8, height: 6 }),
        };
        return [
          { display_id: '12', thumbnail },
          { display_id: '34', thumbnail },
        ];
      });
      await fixture.driver.prepareScreen('', { id: 34, label: 'Display 2' }, signal, 'fixture');
      expect(fixture.store.localDesktopGrant()).toMatchObject({
        displayKey: 'second',
        label: 'Display 2',
      });
      await expect(
        dispatch('computer.observe', { sessionId: next, format: 'image' }, 'other'),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      fixture.driver.revoke();
      await fixture.restart();
      await expect(fixture.driver.access(signal)).resolves.toEqual({ state: 'off' });
      await expect(open('other')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    } finally {
      displays.mockReset();
      capture.mockReset();
      nativeCommand.mockReset();
      await fixture.close();
    }
  },
);

it.runIf(supportsScreenMouse)(
  'binds every verified local mouse gesture to an approved image',
  async () => {
    nativeCommand.mockClear();
    let visualVersion = 0;
    capture.mockImplementation(async () => [
      {
        display_id: '12',
        thumbnail: {
          isEmpty: () => false,
          toPNG: () => Buffer.concat([frame, Buffer.from([visualVersion])]),
          getSize: () => ({ width: 8, height: 6 }),
        },
      },
    ]);
    nativeCommand.mockImplementation((input) => {
      if (input.operation === 'screen_probe')
        return {
          approved: true,
          displayKey: 'first',
          accessibility: true,
        };
      if (input.operation === 'screen_pointer') visualVersion++;
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
        'move',
        'click',
        'double_click',
        'drag',
        'scroll',
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
      const pointerCommands = () =>
        nativeCommand.mock.calls
          .map(([input]) => input)
          .filter(({ operation }) => operation === 'screen_pointer');
      approve.mockResolvedValueOnce(true);
      id = await observe('image');
      await expect(act(id, { type: 'click', x: 8, y: 2, button: 'left' })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      await expect(act(id, { type: 'move', x: 2, y: 2 })).resolves.toMatchObject({
        data: { outcomes: [{ action: 'move', status: 'declined' }] },
      });
      expect(pointerCommands()).toHaveLength(0);
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
      expect(pointerCommands()).toHaveLength(0);
      approve.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      id = await observe('image');
      await expect(act(id, { type: 'move', x: 3, y: 4 })).resolves.toMatchObject({
        data: { outcomes: [{ action: 'move', status: 'verified' }] },
      });
      expect(pointerCommands().at(-1)).toEqual(
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
      expect(pointerCommands().at(-1)).toMatchObject({ action: 'click', button: 'left' });
      expect(pointerCommands()).toHaveLength(2);
      for (const action of [
        { type: 'click', x: 1, y: 1, button: 'right' },
        { type: 'click', x: 1, y: 1, button: 'middle' },
        { type: 'double_click', x: 1, y: 1 },
        {
          type: 'drag',
          path: [
            { x: 1, y: 1 },
            { x: 7, y: 5 },
          ],
        },
        { type: 'scroll', x: 1, y: 1, scrollX: 100, scrollY: -200 },
      ]) {
        approve.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
        id = await observe('image');
        await expect(act(id, action)).resolves.toMatchObject({
          data: { outcomes: [{ action: action.type, status: 'submitted' }] },
        });
        expect(pointerCommands().at(-1)?.action).toBe(action.type);
      }
      approve.mockResolvedValueOnce(true);
      id = await observe('image');
      await expect(
        act(id, {
          type: 'drag',
          path: [
            { x: 1, y: 1 },
            { x: 8, y: 5 },
          ],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(pointerCommands()).toHaveLength(7);
    } finally {
      nativeCommand.mockReset();
      capture.mockReset();
      await close();
    }
  },
);

it.runIf(supportsScreenMouse)(
  'fences a pending capture and mouse action when the grant is revoked',
  async () => {
    const { driver, runtime, dispatch, signal, close } = await localScreen();
    nativeCommand.mockImplementation((input) =>
      input.operation === 'screen_probe'
        ? { approved: true, displayKey: 'first', accessibility: true }
        : { submitted: true },
    );
    try {
      await driver.prepareScreen('', { id: 12, label: 'Display 1' }, signal, 'fixture');
      const { data } = await dispatch('computer.open', {
        environment: 'local-desktop',
        mode: 'aria',
      });
      const sessionId = String(data?.sessionId);
      const initial = await dispatch('computer.observe', { sessionId, format: 'image' });
      let captureStarted!: () => void;
    const capturing = new Promise<void>((resolve) => {
      captureStarted = resolve;
    });
    let release!: (sources: Awaited<ReturnType<typeof capture>>) => void;
    const held = new Promise<Awaited<ReturnType<typeof capture>>>((resolve) => {
      release = resolve;
    });
    const sources = await capture();
      capture.mockImplementationOnce(() => {
        captureStarted();
        return held;
      });

      const action = dispatch('computer.act', {
        sessionId,
        observationId: initial.computerImage?.observation.id,
        actions: [{ type: 'click', x: 2, y: 2, button: 'left' }],
      }).catch((error: unknown) => error);
      await capturing;
      driver.revoke();
      const stopped = runtime.closeLocalSessions();
      release(sources);
      await stopped;
      expect(await action).toMatchObject({ name: 'AbortError' });
      expect(
        nativeCommand.mock.calls.some(([request]) => request.operation === 'screen_pointer'),
      ).toBe(false);
      await expect(driver.access(signal)).resolves.toEqual({ state: 'off' });
    } finally {
      nativeCommand.mockReset();
      await close();
    }
  },
);
