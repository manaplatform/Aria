import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DesktopUpdates } from '../electron/updates';
import { findUpdate } from '../electron/update-feed';

const mock = vi.hoisted(() => ({
  installedVersion: '1.0.0',
  installer: '',
  version: '1.1.0',
  quitAndInstall: vi.fn(),
  openPath: vi.fn(async () => ''),
  xattr: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { get isPackaged() { return true; }, getVersion: () => mock.installedVersion, quit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: mock.openPath },
}));

vi.mock('node:child_process', async (original) => {
  const childProcess = await original<typeof import('node:child_process')>();
  const execFile = (file: string, args: string[], _options: unknown, callback: (error: Error | null) => void) => {
    mock.xattr(file, args);
    callback(null);
  };
  return { ...childProcess, execFile, default: { ...childProcess, execFile } };
});

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  class AppImageUpdater extends EventEmitter {
    setFeedURL = vi.fn();
    checkForUpdates = vi.fn(async () => ({ isUpdateAvailable: true }));
    async downloadUpdate() {
      this.emit('download-progress', { percent: 21 });
      this.emit('update-downloaded', { downloadedFile: mock.installer, version: mock.version });
      return [];
    }
    quitAndInstall = mock.quitAndInstall;
  }
  return { AppImageUpdater, Provider: class {} };
});

vi.mock('../electron/update-feed', async (original) => ({
  ...await original<typeof import('../electron/update-feed')>(), findUpdate: vi.fn(),
}));

describe('desktop update lifecycle', () => {
  let directory: string;
  const binary = 'signed installer fixture';
  const download = {
    url: 'https://github.com/manaplatform/Aria/releases/download/v2026.11.22/Aria-1.1.0-macos-arm64.dmg',
    sha256: createHash('sha256').update(binary).digest('hex'),
    sha512: createHash('sha512').update(binary).digest('base64'), size: binary.length,
  };

  function device(platform: 'darwin' | 'linux') {
    const processStub = Object.create(process);
    Object.defineProperties(processStub, {
      resourcesPath: { value: directory }, platform: { value: platform }, arch: { value: 'arm64' },
      env: { value: { ...process.env, APPIMAGE: mock.installer } },
    });
    vi.stubGlobal('process', processStub);
  }

  beforeEach(async () => {
    mock.installedVersion = '1.0.0';
    mock.quitAndInstall.mockReset();
    mock.openPath.mockClear();
    mock.xattr.mockClear();
    vi.mocked(findUpdate).mockReset();
    directory = await mkdtemp(path.join(os.tmpdir(), 'aria-update-lifecycle-'));
    mock.installer = path.join(directory, 'update.AppImage');
    device('linux');
    await writeFile(path.join(directory, 'aria-update-trust.json'), JSON.stringify({
      version: '1.0.0', updateKeys: ['test-public-key'], windowsPins: [],
    }));
    await writeFile(mock.installer, binary);
    vi.mocked(findUpdate).mockResolvedValue({
      version: mock.version, tag: 'v2026.11.22', url: 'https://github.com/manaplatform/Aria/releases/tag/v2026.11.22',
      download,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  test('persists the channel and waits for the save-and-shutdown handoff before installation', async () => {
    const emit = vi.fn();
    const updates = new DesktopUpdates(directory, emit);
    const handoff = vi.fn<(perform: () => void) => void>();
    await updates.load();
    await updates.command({ action: 'channel', channel: 'beta' }, handoff);
    const channel = JSON.parse(await readFile(path.join(directory, 'update-settings.json'), 'utf8'));
    expect(channel).toEqual({ channel: 'beta' });
    await updates.command({ action: 'check' }, handoff);
    await updates.command({ action: 'download' }, handoff);
    expect(updates.snapshot).toMatchObject({ status: 'ready', available: '1.1.0', progress: 100 });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading', progress: 21 }));
    await updates.command({ action: 'install' }, handoff);
    expect(mock.quitAndInstall).not.toHaveBeenCalled();
    expect(updates.snapshot.status).toBe('installing');
    handoff.mock.calls[0][0]();
    expect(mock.quitAndInstall).toHaveBeenCalledExactlyOnceWith(false, true);
    mock.installedVersion = '1.1.0';
    await writeFile(path.join(directory, 'aria-update-trust.json'), JSON.stringify({
      version: '1.1.0', updateKeys: ['test-public-key'], windowsPins: [],
    }));
    const restarted = new DesktopUpdates(directory, vi.fn());
    await restarted.load();
    expect(restarted.snapshot).toMatchObject({ version: '1.1.0', channel: 'beta', status: 'idle' });
  });

  test('rejects a downloaded installer changed before the restart', async () => {
    const updates = new DesktopUpdates(directory, vi.fn());
    const handoff = vi.fn();
    await updates.load();
    await updates.command({ action: 'check' }, handoff);
    await updates.command({ action: 'download' }, handoff);
    await writeFile(mock.installer, 'changed bytes');
    await updates.command({ action: 'install' }, handoff);
    expect(handoff).not.toHaveBeenCalled();
    expect(updates.snapshot).toMatchObject({ status: 'error', error: expect.stringContaining('checksum') });
  });

  test('automatically checks on macOS and opens a verified, quarantined DMG on request', async () => {
    device('darwin');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const request = vi.fn(async () => new Response(binary));
    vi.stubGlobal('fetch', request);
    const updates = new DesktopUpdates(directory, vi.fn());
    await updates.load();
    updates.startAutomaticChecks();
    await vi.waitFor(() => expect(updates.snapshot).toMatchObject({ mode: 'disk-image', status: 'available' }));
    expect(request).not.toHaveBeenCalled();
    await updates.command({ action: 'download' });
    expect(updates.snapshot).toMatchObject({ status: 'ready', progress: 100 });
    expect(request).toHaveBeenCalledWith(new URL(download.url), expect.objectContaining({ redirect: 'manual' }));
    expect(mock.xattr).toHaveBeenCalledWith('/usr/bin/xattr',
      ['-w', 'com.apple.quarantine', expect.stringMatching(/^0081;.*;Aria;/), expect.stringContaining('.dmg')]);
    const handoff = vi.fn();
    await updates.command({ action: 'install' }, handoff);
    expect(handoff).not.toHaveBeenCalled();
    expect(mock.openPath).not.toHaveBeenCalled();
    await updates.command({ action: 'open-installer' });
    const file = path.join(directory, 'Aria-update.dmg');
    expect(mock.openPath).toHaveBeenCalledExactlyOnceWith(file);
    expect(await readFile(file, 'utf8')).toBe(binary);
    await writeFile(file, 'x'.repeat(binary.length));
    await updates.command({ action: 'open-installer' });
    expect(mock.openPath).toHaveBeenCalledTimes(1);
    expect(updates.snapshot).toMatchObject({ status: 'error', error: expect.stringContaining('checksum') });
  });

  test.each([
    ['oversized', () => new Response(binary + 'extra'), 'signed size'],
    ['truncated', () => new Response(binary.slice(1)), 'size validation'],
    ['modified', () => new Response('x'.repeat(binary.length)), 'checksum'],
    ['redirected', () => Response.redirect('https://example.com/update.dmg'), 'untrusted location'],
  ] as const)('rejects a macOS download that is %s', async (_case, response, error) => {
    device('darwin');
    const request = vi.fn(async () => response());
    vi.stubGlobal('fetch', request);
    const updates = new DesktopUpdates(directory, vi.fn());
    await updates.load();
    await updates.command({ action: 'check' });
    await updates.command({ action: 'download' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(updates.snapshot).toMatchObject({ status: 'error', error: expect.stringContaining(error) });
    expect(await readdir(directory)).toEqual(['aria-update-trust.json', 'update.AppImage']);
    expect(mock.xattr).not.toHaveBeenCalled();
  });
});
