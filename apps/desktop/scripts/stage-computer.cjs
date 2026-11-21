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
}
