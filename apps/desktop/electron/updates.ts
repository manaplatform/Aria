import { app, dialog, shell } from 'electron';
import { AppImageUpdater, NsisUpdater, Provider, type UpdateInfo } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import type { AppUpdater } from 'electron-updater';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { prerelease } from 'semver';
import { z } from 'zod';
import type { UpdateCommand, UpdateState } from '@aria/shared';
import { findUpdate, releasePage, type VerifiedUpdate } from './update-feed';
import { downloadMacUpdate, verifyMacUpdate } from './mac-update';

const automaticCheckInterval = 6 * 60 * 60_000;

const trustSchema = z.object({
  version: z.string(),
  updateKeys: z.array(z.string()).max(8),
  windowsPins: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8),
});
const windowsPowerShell = path.join(
  process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);

function windowsSigner(file: string, pins: string[]): Promise<string | null> {
  // A static script and literal environment path avoid interpolating the download location.
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$s = Get-AuthenticodeSignature -LiteralPath $env:ARIA_UPDATE_FILE',
    'if ($s.Status -ne "Valid" -or $s.SignatureType -ne "Authenticode" -or !$s.TimeStamperCertificate) { exit 1 }',
    '$h = [Security.Cryptography.SHA256]::Create()',
    '[BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData)).Replace("-","").ToLowerInvariant()',
  ].join('; ');
  return new Promise((resolve) => {
    execFile(windowsPowerShell, ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, ARIA_UPDATE_FILE: file }, windowsHide: true, timeout: 20_000, maxBuffer: 4096,
    }, (error, stdout) => {
      resolve(!error && pins.includes(stdout.trim()) ? null :
        'Windows could not verify Aria’s signing certificate. Verify the certificate fingerprint and contact your administrator about device trust.');
    });
  });
}

function updaterForDevice(pins: string[]): AppUpdater | undefined {
  if (process.platform === 'win32' && pins.length && !process.env.PORTABLE_EXECUTABLE_FILE) {
    const updater = new NsisUpdater();
    updater.verifyUpdateCodeSignature = (_publishers, file) => windowsSigner(file, pins);
    return updater;
  }
  if (process.platform === 'linux' && process.env.APPIMAGE && existsSync(process.env.APPIMAGE))
    return new AppImageUpdater();
}

function setVerifiedProvider(updater: AppUpdater, release: VerifiedUpdate) {
  const file = release.download;
  const info: UpdateInfo = {
    version: release.version,
    files: [{ url: file.url, size: file.size, sha512: file.sha512 }],
    releaseDate: '',
    path: file.url,
    sha512: file.sha512,
  };
  class VerifiedProvider extends Provider<UpdateInfo> {
    constructor(_options: unknown, _updater: AppUpdater, runtime: ProviderRuntimeOptions) {
      super(runtime);
    }
    async getLatestVersion() {
      return info;
    }
    resolveFiles() {
      return [{ url: new URL(file.url), info: info.files[0] }];
    }
  }
  updater.setFeedURL({ provider: 'custom', updateProvider: VerifiedProvider });
}

export class DesktopUpdates {
  private state: UpdateState;
  private candidate?: VerifiedUpdate;
  private installer?: string;
  private updater?: AppUpdater;
  private trust?: z.infer<typeof trustSchema>;
  private writing = false;
  private readonly file: string;

  constructor(private readonly directory: string, private readonly emit: (state: UpdateState) => void) {
    this.file = path.join(directory, 'update-settings.json');
    const version = app.getVersion();
    this.state = { version, channel: prerelease(version) ? 'beta' : 'stable', status: 'unsupported', mode: 'manual' };
  }

  async load() {
    if (!app.isPackaged) return;
    try {
      this.trust = trustSchema.parse(JSON.parse(await readFile(path.join(process.resourcesPath, 'aria-update-trust.json'), 'utf8')));
      if (this.trust.version !== this.state.version || !this.trust.updateKeys.length) return;
      try {
        this.state.channel = z.enum(['stable', 'beta']).parse(JSON.parse(await readFile(this.file, 'utf8')).channel);
      } catch {
        // Use the installed version's channel when the file is missing or unreadable.
      }
      this.updater = updaterForDevice(this.trust.windowsPins);
      if (this.updater) {
        this.updater.autoDownload = false;
        this.updater.autoInstallOnAppQuit = false;
        this.updater.allowDowngrade = false;
        this.updater.disableDifferentialDownload = true;
        this.updater.disableWebInstaller = true;
        this.updater.on('error', () => {
          // Download errors reject the caller. Handle asynchronous installer errors during handoff.
          if (this.state.status === 'installing') {
            dialog.showErrorBox('Update installation failed', 'Open Aria and try the update again.');
            app.quit();
          }
        });
        this.updater.on('download-progress', ({ percent }) => {
          if (this.state.status === 'downloading') this.set({ progress: Math.min(100, Math.floor(percent)) });
        });
      }
      this.set({ status: 'idle', mode: process.platform === 'darwin' ? 'disk-image' : this.updater ? 'install' : 'manual' });
    } catch {
      this.set({ status: 'unsupported', error: 'Update configuration is unavailable in this build.' });
    }
  }

  get snapshot() {
    return this.state;
  }

  startAutomaticChecks() {
    if (this.state.mode !== 'disk-image') return;
    const check = () => {
      if (['idle', 'current', 'error'].includes(this.state.status)) void this.command({ action: 'check' });
    };
    check();
    setInterval(check, automaticCheckInterval).unref();
  }

  private set(update: Partial<UpdateState>) {
    this.state = { ...this.state, ...update };
    this.emit(this.state);
  }

  async command(command: UpdateCommand, install?: (perform: () => void) => void) {
    if (command.action === 'open-release') {
      await shell.openExternal(this.candidate?.url ?? releasePage);
      return;
    }
    if (this.writing || ['checking', 'downloading', 'installing', 'unsupported'].includes(this.state.status)) return;
    this.writing = true;
    try {
      if (command.action === 'channel') {
        if (this.state.channel === command.channel) return;
        const temporary = `${this.file}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ channel: command.channel }), { mode: 0o600 });
          await rename(temporary, this.file);
        } finally {
          await rm(temporary, { force: true });
        }
        this.candidate = undefined;
        this.installer = undefined;
        this.set({ channel: command.channel, status: 'idle', available: undefined, error: undefined, progress: undefined });
      } else if (command.action === 'check') await this.check();
      else if (command.action === 'download' && this.state.status === 'available') await this.download();
      else if (command.action === 'open-installer' && this.state.status === 'ready' && this.state.mode === 'disk-image') {
        const expected = this.candidate?.download;
        if (!this.installer || !expected) throw new Error('Download the verified disk image before opening it.');
        await verifyMacUpdate(this.installer, expected);
        const failure = await shell.openPath(this.installer);
        if (failure) throw new Error('macOS could not open the disk image. Download the update again or open the release in your browser.');
      } else if (command.action === 'install' && this.state.status === 'ready' && this.updater && install) {
        await this.verifyInstaller();
        this.set({ status: 'installing' });
        const updater = this.updater;
        install(() => updater.quitAndInstall(false, true));
      }
    } catch (error) {
      const message = error instanceof z.ZodError ? 'Aria received malformed update metadata.'
        : error instanceof Error ? error.message.slice(0, 400) : 'The update check failed.';
      this.set({ status: 'error', error: message });
    } finally {
      this.writing = false;
    }
  }

  installCancelled() {
    if (this.state.status === 'installing') this.set({ status: 'ready' });
  }

  private async check() {
    this.candidate = undefined;
    this.installer = undefined;
    this.set({ status: 'checking', available: undefined, progress: undefined, error: undefined });
    const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform as 'darwin' | 'win32' | 'linux'] as
      'macos' | 'windows' | 'linux' | undefined;
    const arch = process.arch;
    if (!this.trust || !platform || arch !== 'arm64' && arch !== 'x64') {
      this.set({ status: 'unsupported' });
      return;
    }
    this.candidate = await findUpdate(this.state.version, this.state.channel, { platform, arch }, this.trust.updateKeys);
    this.set(this.candidate
      ? { status: 'available', available: this.candidate.version }
      : { status: 'current' });
  }

  private async download() {
    if (!this.candidate || this.state.mode === 'manual') return;
    this.set({ status: 'downloading', progress: 0, error: undefined });
    if (this.state.mode === 'disk-image') {
      this.installer = await downloadMacUpdate(this.directory, this.candidate.download, (progress) => {
        if (progress !== this.state.progress) this.set({ progress });
      });
    } else if (this.updater) {
      await this.downloadNativeUpdate(this.updater, this.candidate);
    }
    this.set({ status: 'ready', progress: 100 });
  }

  private async downloadNativeUpdate(updater: AppUpdater, candidate: VerifiedUpdate) {
    setVerifiedProvider(updater, candidate);
    updater.allowPrerelease = this.state.channel === 'beta';
    updater.allowDowngrade = false;
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) throw new Error('The verified update is no longer available for installation.');
    const received = ({ downloadedFile }: { downloadedFile: string }) => {
      this.installer = downloadedFile;
    };
    updater.once('update-downloaded', received);
    try {
      await updater.downloadUpdate();
    } finally {
      updater.removeListener('update-downloaded', received);
    }
    await this.verifyInstaller();
  }

  private async verifyInstaller() {
    const expected = this.candidate?.download;
    const installer = this.installer;
    if (!expected || !installer) throw new Error('Download the verified update before installing.');
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(installer)) hash.update(chunk);
    if (hash.digest('base64') !== expected.sha512) throw new Error('The downloaded update failed checksum validation.');
    if (process.platform === 'win32') {
      const error = await windowsSigner(installer, this.trust?.windowsPins ?? []);
      if (error) throw new Error(error);
    }
  }
}
