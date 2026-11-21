const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const target = path.resolve(__dirname, '../dist-electron/computer-helpers');
if (process.platform === 'darwin') {
  fs.mkdirSync(target, { recursive: true });
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  execFileSync(
    '/usr/bin/xcrun',
    [
      'swiftc',
      '-O',
      '-target',
      `${architecture}-apple-macos15.2`,
      path.resolve(__dirname, '../local-computer/macos.swift'),
      '-o',
      path.join(target, 'aria-macos-computer'),
    ],
    { stdio: 'inherit' },
  );
}
if (process.platform === 'win32') {
  fs.mkdirSync(target, { recursive: true });
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  execFileSync(
    'dotnet',
    [
      'publish',
      path.resolve(__dirname, '../local-computer/windows/Aria.Computer.csproj'),
      '--configuration',
      'Release',
      '--runtime',
      `win-${architecture}`,
      '--self-contained',
      'true',
      '-p:PublishSingleFile=true',
      '--artifacts-path',
      path.join(target, 'build'),
      '--output',
      target,
    ],
    { stdio: 'inherit' },
  );
  if (process.env.ARIA_STAGE_RELEASE_NOTICES === '1') {
    const artifacts = path.join(target, 'build', 'obj');
    const assetsFile = fs.readdirSync(artifacts, { recursive: true })
      .find((file) => path.basename(file) === 'project.assets.json');
    if (!assetsFile) throw new Error('Could not locate the restored Windows helper runtime inventory.');
    const assets = JSON.parse(fs.readFileSync(path.join(artifacts, assetsFile), 'utf8'));
    const runtimes = new Map();
    const match = new RegExp(`^Microsoft\\.(NETCore|WindowsDesktop)\\.App\\.Runtime\\.win-${architecture}$`, 'i');
    for (const framework of Object.values(assets.project.frameworks)) {
      for (const { name, version: range } of framework.downloadDependencies ?? []) {
        if (match.test(name)) runtimes.set(name, range.replace(/^\[(.+)\]$/, '$1'));
      }
    }
    if (runtimes.size !== 2) throw new Error('Expected the matching .NET and Windows Desktop runtime packs.');
    const licenses = path.join(target, 'licenses');
    fs.mkdirSync(licenses, { recursive: true });
    for (const [name, version] of runtimes) {
      const directory = Object.keys(assets.packageFolders)
        .map((folder) => path.join(folder, name.toLowerCase(), version))
        .find((folder) => fs.existsSync(folder));
      if (!directory) throw new Error(`Could not find the restored runtime pack ${name}@${version}.`);
      const files = fs.readdirSync(directory)
        .filter((file) => /^(license|third[-_ ]?party[-_ ]?notices)(\..*)?$/i.test(file));
      if (!files.length) throw new Error(`Missing runtime notices for ${name}@${version}.`);
      for (const file of files) fs.copyFileSync(path.join(directory, file), path.join(licenses, `${name}-${file}`));
    }
    fs.writeFileSync(path.join(licenses, 'runtimes.json'), JSON.stringify(
      [...runtimes].map(([name, version]) => ({ name, version })), null, 2,
    ));
  }
}
