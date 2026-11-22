import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
}));

vi.mock('electron', () => ({
  app: { get isPackaged() { return true; }, getVersion: () => mock.installedVersion, quit: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  class MacUpdater extends EventEmitter {
    setFeedURL = vi.fn();
    checkForUpdates = vi.fn(async () => ({ isUpdateAvailable: true }));
    async downloadUpdate() {
      this.emit('download-progress', { percent: 21 });
      this.emit('update-downloaded', { downloadedFile: mock.installer, version: mock.version });
      // Electron Updater's macOS adapter returns no paths when automatic
      // installation at quit is disabled.
      return [];
    }
    quitAndInstall = mock.quitAndInstall;
  }
  return { MacUpdater, Provider: class {} };
});

vi.mock('../electron/update-feed', () => ({ findUpdate: vi.fn() }));

describe('desktop update lifecycle', () => {
  let directory: string;
  const binary = 'signed app zip fixture';

  beforeEach(async () => {
    mock.installedVersion = '1.0.0';
    mock.quitAndInstall.mockReset();
    directory = await mkdtemp(path.join(os.tmpdir(), 'aria-update-lifecycle-'));
    mock.installer = path.join(directory, 'update.zip');
    const processStub = Object.create(process);
    Object.defineProperties(processStub, {
      resourcesPath: { value: directory }, platform: { value: 'darwin' }, arch: { value: 'arm64' },
    });
    vi.stubGlobal('process', processStub);
    await writeFile(path.join(directory, 'aria-update-trust.json'), JSON.stringify({
      version: '1.0.0', updateKeys: ['test-public-key'], windowsPins: [],
    }));
    await writeFile(mock.installer, binary);
    vi.mocked(findUpdate).mockResolvedValue({
      version: mock.version, tag: 'v2026.11.22', url: 'https://github.com/manaplatform/Aria/releases/tag/v2026.11.22',
      download: {
        url: 'https://github.com/manaplatform/Aria/releases/download/v2026.11.22/update.zip',
        sha512: createHash('sha512').update(binary).digest('base64'), size: binary.length,
      },
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
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
});
