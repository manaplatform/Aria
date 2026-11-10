const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electronPackagePath = require.resolve('electron/package.json');
const electronDirectory = path.dirname(electronPackagePath);
const electronPackage = require(electronPackagePath);
const distDirectory = path.join(electronDirectory, 'dist');
const metadataPath = path.join(electronDirectory, 'path.txt');
const versionPath = path.join(distDirectory, 'version');

function isElectronInstalled() {
  try {
    const executableRelativePath = fs.readFileSync(metadataPath, 'utf8');
    const installedVersion = fs.readFileSync(versionPath, 'utf8').replace(/^v/, '');
    return installedVersion === electronPackage.version &&
      fs.existsSync(path.join(distDirectory, executableRelativePath));
  } catch {
    return false;
  }
}

if (!isElectronInstalled()) {
  // Clear an incomplete extraction before using Electron's own installer.
  fs.rmSync(distDirectory, { recursive: true, force: true });
  fs.rmSync(metadataPath, { force: true });

  const env = { ...process.env };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;

  const result = spawnSync(process.execPath, [path.join(electronDirectory, 'install.js')], {
    env,
    stdio: 'inherit',
    timeout: 180_000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron installer exited with status ${result.status ?? result.signal}`);
  }
  if (!isElectronInstalled()) {
    throw new Error('Electron installer finished without installing its binary and version metadata.');
  }
}

console.log(`Electron ${electronPackage.version} is installed.`);
