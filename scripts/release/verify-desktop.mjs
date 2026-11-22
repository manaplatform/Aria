import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { applicationVersion, inspectFile, platformAssets, readJson, windowsCertificateName } from './generate-metadata.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = path.join(root, 'apps', 'desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const { _electron } = require('playwright');
const { expect } = require('@playwright/test');
const { createProviderFixture } = await import('../../tests/provider-fixture.ts');
const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const arch = process.arch;
const version = applicationVersion(await readJson(path.join(root, 'package.json')));
const [input, destination, mode] = process.argv.slice(2);
const artifacts = path.resolve(input);
const production = mode === 'publish';
const target = platformAssets(version, platform, arch);
const asset = (format) => path.join(artifacts, target.find((item) => item.format === format).filename);

function run(exe, args, cwd = root, capture = false, options = {}) {
  return execFileSync(exe, args, {
    cwd, timeout: 120_000, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    ...options,
  });
}

async function smoke(executable, userData, fixture, verifyPersistence = false, env = {}) {
  const session = await _electron.launch({
    executablePath: executable,
    args: platform === 'linux' ? ['--password-store=gnome-libsecret'] : [],
    timeout: 35_000,
    cwd: path.dirname(executable),
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: undefined, VITE_DEV_SERVER_URL: undefined,
      ARIA_TEST_DATA_DIR: userData, OPENAI_API_KEY: verifyPersistence ? undefined : 'release-smoke-test',
      OPENAI_MODEL: verifyPersistence ? undefined : 'fixture-model',
      OPENAI_BASE_URL: verifyPersistence ? undefined : fixture.baseUrl,
      PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : '/usr/bin:/bin',
      ...env,
    },
  });
  try {
    const info = await session.evaluate(({ app }) => ({
      packaged: app.isPackaged, version: app.getVersion(), arch: process.arch,
    }));
    assert.deepEqual(info, { packaged: true, version, arch });
    const page = await session.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Chat navigation' })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.aria.chatStatus()), { timeout: 30_000 })
      .toMatchObject({ state: 'ready' });
    assert.equal(await page.evaluate(() => window.aria.localComputerSupported()), platform !== 'linux');
    const packages = await page.evaluate(async () => (await window.aria.toolSettings()).skills.map((skill) => skill.name));
    // Examples are deliberately disabled until authorized. Their packaged roots are
    // checked below even on profiles that have never enabled them.
    assert.ok(Array.isArray(packages));
    if (verifyPersistence) {
      assert.equal((await page.evaluate(() => window.aria.chatStatus())).configured, true);
      const profile = await page.evaluate(async () => (await window.aria.load()).data.preferences.profileName);
      assert.equal(profile, 'Package smoke profile');
      const messages = await page.evaluate(async () => (await window.aria.load()).data.chat.messages);
      assert.ok(messages.some(({ content }) => content === 'Aria package fixture reply'));
    } else {
      if (!(await page.evaluate(() => window.aria.chatStatus())).configured)
        await page.evaluate(() => window.aria.importRegistryEnvironment());
      await expect.poll(() => page.evaluate(() => window.aria.chatStatus()), { timeout: 25_000 })
        .toMatchObject({ state: 'ready', configured: true });
      const chat = page.locator('textarea').first();
      await chat.fill('Verify this packaged Aria.');
      await chat.press('Enter');
      await expect(page.getByText('fixture reply', { exact: false }).first()).toBeVisible({ timeout: 25_000 });
      const resources = await session.evaluate(() => process.resourcesPath);
      for (const name of ['app.asar', 'aria-api/dist/main.js', 'aria-skills/chart-generation/SKILL.md',
        'aria-runtime-recipes/program-runner/runner.mts', 'aria-runtime-recipes/virtual-desktop/Dockerfile'])
        assert.ok(existsSync(path.join(resources, name)), `Bundled resource is missing: ${name}`);
      await page.getByRole('button', { name: 'Open settings', exact: true }).click();
      const profile = page.getByRole('textbox', { name: 'Display name' });
      await profile.fill('Package smoke profile');
      await profile.press('Enter');
    }
  } finally {
    await session.close();
  }
}

const codesign = '/usr/bin/codesign';
const macArchitecture = arch === 'x64' ? 'x86_64' : 'arm64';
const macExecutable = (app) => path.join(app, 'Contents', 'MacOS', 'Aria');
const machoMagic = new Set(['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca']);

function verifyAdHoc(file, architectures = [], deep = false) {
  run(codesign, ['--verify', '--strict', '--all-architectures', ...(deep ? ['--deep'] : []), file]);
  for (const architecture of architectures.length ? architectures : [undefined]) {
    const architectureArgs = architecture ? ['--architecture', architecture] : [];
    const info = spawnSync(codesign, ['--display', '--verbose=4', ...architectureArgs, file], {
      encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(info.status, 0, `Unable to inspect the signature on ${file}: ${info.stderr}`);
    assert.match(info.stderr, /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\badhoc\b/m,
      `Expected an ad hoc signature on ${file}${architecture ? ` (${architecture})` : ''}.`);
  }
}

function macArchitectures(file) {
  return run('/usr/bin/lipo', ['-archs', file], root, true).trim().split(/\s+/);
}

async function verifyMacBundle(app) {
  const main = macExecutable(app);
  const helper = path.join(app, 'Contents', 'Resources', 'aria-computer', 'aria-macos-computer');
  for (const file of [main, helper]) assert.deepEqual(macArchitectures(file), [macArchitecture], file);
  verifyAdHoc(app, [macArchitecture], true);
  // Strict recursive validation follows bundle code locations. Check loose native
  // code in Resources too, including native modules and the Swift helper.
  const header = Buffer.alloc(4);
  for (const entry of await readdir(app, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const handle = await open(file, 'r');
    const { bytesRead } = await handle.read(header, 0, header.length, 0).finally(() => handle.close());
    if (bytesRead !== header.length || !machoMagic.has(header.toString('hex'))) continue;
    const architectures = macArchitectures(file);
    assert.ok(architectures.includes(macArchitecture), `${file} lacks ${macArchitecture}.`);
    verifyAdHoc(file, architectures);
  }
}

async function verifyMac(temp, fixture) {
  const mount = path.join(temp, 'mount');
  const installed = path.join(temp, 'Applications', 'Aria.app');
  const userData = path.join(temp, 'profile');
  await mkdir(mount);
  await mkdir(path.dirname(installed), { recursive: true });
  run('hdiutil', ['verify', asset('dmg')]);
  verifyAdHoc(asset('dmg'));
  run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, asset('dmg')]);
  try {
    const bundled = path.join(mount, 'Aria.app');
    await verifyMacBundle(bundled);
    run('ditto', [bundled, installed]);
  } finally {
    run('hdiutil', ['detach', mount]);
  }
  await smoke(macExecutable(installed), userData, fixture);
  await rm(installed, { recursive: true });
  run('ditto', ['-x', '-k', asset('zip'), path.dirname(installed)]);
  await verifyMacBundle(installed);
  await smoke(macExecutable(installed), userData, fixture, true);
}

async function verifyWindows(temp, fixture) {
  const installed = path.join(temp, 'Aria');
  const userData = path.join(temp, 'profile');
  const installerTemp = path.join(temp, 'tmp');
  await mkdir(installerTemp);
  const runInstaller = (exe, location) => run(exe, ['/S', location], temp, false, {
    timeout: 600_000,
    // NSIS reads the last argument as an unquoted path, including any spaces.
    windowsVerbatimArguments: true,
    argv0: `"${exe}"`,
    env: { ...process.env, TEMP: installerTemp, TMP: installerTemp },
  });
  const uninstaller = path.join(installed, 'Uninstall Aria.exe');
  console.log('Installing the Windows package for verification.');
  runInstaller(asset('exe'), `/D=${installed}`);
  try {
    console.log('Verifying installed Windows signatures.');
    if (production || process.env.GITHUB_ACTIONS === 'true')
      run(process.execPath, [path.join(root, 'scripts/release/package-desktop.mjs'),
        'verify-windows-install', artifacts, installed, mode]);
    console.log('Testing the installed Windows app.');
    await smoke(path.join(installed, 'Aria.exe'), userData, fixture);
    await smoke(path.join(installed, 'Aria.exe'), userData, fixture, true);
    // The NSIS wrapper spawns Electron separately. Start the unpacked portable
    // payload with the same portable environment to verify its native runtime.
    console.log('Testing the portable Windows app.');
    const wrapper = path.join(temp, 'portable-wrapper');
    const app = path.join(temp, 'portable-app');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const installed7z = path.join(programFiles, '7-Zip', '7z.exe');
    const sevenZip = existsSync(installed7z) ? installed7z : '7z';
    run(sevenZip, ['x', '-y', `-o${wrapper}`, asset('portable.exe')]);
    const embedded = (await readdir(wrapper, { recursive: true })).find((file) =>
      new RegExp(`^app-${arch === 'x64' ? '64' : 'arm64'}\\.(7z|zip)$`).test(path.basename(file)));
    assert.ok(embedded, 'Portable installer lacks its expected architecture payload.');
    run(sevenZip, ['x', '-y', `-o${app}`, path.join(wrapper, embedded)]);
    await smoke(path.join(app, 'Aria.exe'), userData, fixture, true, {
      PORTABLE_EXECUTABLE_FILE: asset('portable.exe'),
    });
  } finally {
    if (existsSync(uninstaller)) {
      console.log('Uninstalling the Windows smoke-test package.');
      runInstaller(uninstaller, `_?=${installed}`);
    }
  }
}

async function verifyLinux(temp, fixture) {
  const userData = path.join(temp, 'profile');
  const deb = path.join(temp, 'deb');
  const rpm = path.join(temp, 'rpm');
  const tar = path.join(temp, 'tar');
  await mkdir(rpm);
  await mkdir(tar);
  run('dpkg-deb', ['-x', asset('deb'), deb]);
  const debArch = run('dpkg-deb', ['-f', asset('deb'), 'Architecture'], temp, true).trim();
  assert.equal(debArch, arch === 'x64' ? 'amd64' : 'arm64');
  await smoke(path.join(deb, 'opt', 'Aria', 'aria'), userData, fixture);
  const rpmArch = run('rpm', ['-qp', '--queryformat', '%{ARCH}', asset('rpm')], temp, true).trim();
  assert.equal(rpmArch, arch === 'x64' ? 'x86_64' : 'aarch64');
  run('bsdtar', ['-xf', asset('rpm'), '-C', rpm]);
  await smoke(path.join(rpm, 'opt', 'Aria', 'aria'), userData, fixture, true);
  run('tar', ['-xzf', asset('tar.gz'), '-C', tar]);
  const entries = await readdir(tar);
  const archivedBin = entries.includes('aria') ? path.join(tar, 'aria')
    : path.join(tar, entries.length === 1 ? entries[0] : 'Aria', 'aria');
  await smoke(archivedBin, userData, fixture, true);
  run(asset('AppImage'), ['--appimage-extract'], temp);
  await smoke(path.join(temp, 'squashfs-root', 'aria'), userData, fixture, true, { APPIMAGE: asset('AppImage') });
}

async function inventory() {
  const nodes = new Map();
  const add = ({ name, version: packageVersion, license }) => {
    if (!name || !packageVersion || name.startsWith('@aria/')) return;
    const purl = `pkg:npm/${name.startsWith('@') ? name.replace('@', '%40') : name}@${packageVersion}`;
    nodes.set(purl, { type: 'library', name, version: packageVersion, 'bom-ref': purl, purl,
      ...(license ? { licenses: [{ license: { name: String(license) } }] } : {}) });
  };
  const notices = await readJson(path.join(desktop, 'dist', 'third-party', 'inventory.json'));
  for (const item of notices) add(item);
  add(require('electron/package.json'));
  if (platform === 'windows') {
    const packs = await readJson(path.join(desktop, 'dist-electron', 'computer-helpers', 'licenses', 'runtimes.json'));
    for (const { name, version: runtimeVersion } of packs) {
      const purl = `pkg:nuget/${name}@${runtimeVersion}`;
      nodes.set(purl, { type: 'framework', name, version: runtimeVersion, 'bom-ref': purl, purl });
    }
  }
  return [...nodes.values()];
}

const fixture = await createProviderFixture();
fixture.finalReply('Verify this packaged Aria.', 'Aria package fixture reply');
const temporaryRoot = platform === 'windows' && process.env.RUNNER_TEMP ? process.env.RUNNER_TEMP : os.tmpdir();
const temporary = await mkdtemp(path.join(temporaryRoot, 'aria-'));
let verificationFailed = false;
try {
  await { windows: verifyWindows, macos: verifyMac, linux: verifyLinux }[platform](temporary, fixture);
  if (destination) {
    await mkdir(destination, { recursive: true });
    const filenames = target.map(({ filename }) => filename);
    if (production && platform === 'windows') filenames.push(windowsCertificateName);
    const files = {};
    for (const filename of filenames) {
      files[filename] = await inspectFile(artifacts, filename);
      const original = realpathSync(path.join(artifacts, filename));
      await copyFile(original, path.join(destination, filename));
    }
    await writeFile(path.join(destination, 'receipt.json'), JSON.stringify({
      version, platform, arch, production, files,
      ...(platform === 'macos' ? { signing: 'ad-hoc', notarized: false } : {}),
      timestamp: new Date().toISOString(), commit: run('git', ['rev-parse', 'HEAD'], root, true).trim(),
      components: await inventory(),
    }, null, 2) + '\n');
  }
} catch (error) {
  verificationFailed = true;
  throw error;
} finally {
  await fixture.close();
  try {
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    if (!verificationFailed) throw error;
    console.warn(`Could not clean up the package smoke-test directory. ${error.message}`);
  }
}
