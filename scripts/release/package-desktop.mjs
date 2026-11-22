import { build, Arch, Platform } from '../../apps/desktop/node_modules/electron-builder/out/index.js';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createPublicKey, randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applicationVersion, inspectFile, platformAssets, readJson, repository, validatePackageVersion, windowsCertificateName,
} from './generate-metadata.mjs';
import { bundleApi } from './bundle-api.mjs';
import { windowsSignerPins } from './windows-signer-pins.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const desktop = path.join(root, 'apps', 'desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const version = validatePackageVersion(applicationVersion(await readJson(path.join(root, 'package.json'))));
const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const arch = process.arch;
const env = process.env;
const mode = process.argv[2];
const output = path.resolve(process.argv[3] ?? path.join(desktop, 'out', 'release-packages'));
const production = mode === 'publish';
const target = platformAssets(version, platform, arch);

function run(executable, args, options) {
  return execFileSync(executable, args, { cwd: root, stdio: 'inherit', ...options });
}

function requireEnvironment(...names) {
  for (const name of names)
    if (!env[name]?.trim()) throw new Error(`Set ${name} in the designated signing environment.`);
}

function publicKeys() {
  if (production) requireEnvironment('ARIA_UPDATE_PUBLIC_KEYS');
  const keys = env.ARIA_UPDATE_PUBLIC_KEYS?.split(',').filter(Boolean) ?? [];
  for (const key of keys) {
    const decoded = Buffer.from(key, 'base64');
    if (decoded.toString('base64') !== key || createPublicKey({ key: decoded, format: 'der', type: 'spki' }).asymmetricKeyType !== 'ed25519')
      throw new Error('ARIA_UPDATE_PUBLIC_KEYS must contain comma-separated base64 DER Ed25519 public keys.');
  }
  return keys;
}

function powershell(script, variables = {}, stdio = 'inherit') {
  return run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`],
    { env: { ...env, ...variables }, stdio, encoding: 'utf8' });
}

function withWindowsTrust(cert, operation) {
  if (env.GITHUB_ACTIONS !== 'true') throw new Error('Installer trust verification requires a disposable GitHub runner.');
  const thumbprint = powershell(`
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($env:ARIA_CER_PATH)
    $entry = 'Cert:\\LocalMachine\\Root\\' + $certificate.Thumbprint
    if (Test-Path -LiteralPath $entry) { 'already-trusted' }
    else { (Import-Certificate -FilePath $env:ARIA_CER_PATH -CertStoreLocation Cert:\\LocalMachine\\Root).Thumbprint }
  `,
    { ARIA_CER_PATH: cert }, ['ignore', 'pipe', 'inherit']).trim();
  if (thumbprint !== 'already-trusted' && !/^[0-9a-f]{40}$/i.test(thumbprint))
    throw new Error('Cannot identify the temporary Windows signer trust.');
  return Promise.resolve().then(operation).finally(() => {
    if (thumbprint !== 'already-trusted')
      powershell('Remove-Item -LiteralPath ("Cert:\\LocalMachine\\Root\\" + $env:ARIA_CER_THUMBPRINT)',
        { ARIA_CER_THUMBPRINT: thumbprint });
  });
}

function verifyWindowsSigning(files, signer) {
  powershell(`
    foreach ($path in ($env:ARIA_SIGNED_FILES | ConvertFrom-Json)) {
      $signature = Get-AuthenticodeSignature -LiteralPath $path
      if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate -or
          $signature.SignerCertificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256) -ne $env:ARIA_SIGNER) {
        throw ('Windows signature, timestamp, or signer mismatch: ' + [System.IO.Path]::GetFileName($path))
      }
    }`, { ARIA_SIGNED_FILES: JSON.stringify(files), ARIA_SIGNER: signer });
}

async function certificate(temporary, signer) {
  requireEnvironment('WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD');
  const pfx = path.join(temporary, 'signer.pfx');
  const cer = path.join(output, windowsCertificateName);
  await writeFile(pfx, Buffer.from(env.WIN_CSC_LINK, 'base64'), { mode: 0o600 });
  powershell(`
    $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
      $env:ARIA_PFX_PATH, $env:WIN_CSC_KEY_PASSWORD,
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    if (!$certificate.HasPrivateKey -or $certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow -or
        $certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or
        $certificate.Subject -ne $certificate.Issuer) { throw 'Expected a current self-signed Windows code-signing key.' }
    $eku = $certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' }
    if ('1.3.6.1.5.5.7.3.3' -notin $eku.EnhancedKeyUsages.Value) { throw 'The certificate lacks the code-signing EKU.' }
    [System.IO.File]::WriteAllBytes($env:ARIA_CER_PATH, $certificate.Export('Cert'))
  `, { ARIA_PFX_PATH: pfx, ARIA_CER_PATH: cer });
  const publicCert = new X509Certificate(await readFile(cer));
  if (publicCert.fingerprint256.replaceAll(':', '').toLowerCase() !== signer ||
      !publicCert.verify(publicCert.publicKey)) throw new Error('The Windows PFX does not match the pinned self-signed certificate.');
  env.WIN_CSC_LINK = pfx;
  return { cer, publisher: publicCert.subject.split('\n').find((field) => field.startsWith('CN='))?.slice(3) };
}

async function testCertificate(temporary) {
  const pfx = path.join(temporary, 'verification.pfx');
  const password = randomBytes(24).toString('hex');
  const fingerprint = powershell(`
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Aria Release Verification' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(1)
    try {
      $password = ConvertTo-SecureString -String $env:ARIA_TEST_PFX_PASSWORD -AsPlainText -Force
      Export-PfxCertificate -Cert $cert -FilePath $env:ARIA_TEST_PFX -Password $password | Out-Null
      $cert.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256)
    } finally {
      Remove-Item -LiteralPath ('Cert:\\CurrentUser\\My\\' + $cert.Thumbprint) -DeleteKey
    }
  `, { ARIA_TEST_PFX: pfx, ARIA_TEST_PFX_PASSWORD: password }, ['ignore', 'pipe', 'inherit']).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid verification certificate fingerprint.');
  env.WIN_CSC_LINK = (await readFile(pfx)).toString('base64');
  env.WIN_CSC_KEY_PASSWORD = password;
  return fingerprint;
}

async function packageDesktop() {
  if (!['verify', 'publish', 'dir'].includes(mode)) throw new Error('Select a packaging mode.');
  if (production && env.GITHUB_ACTIONS !== 'true') throw new Error('Production packaging requires GitHub Actions.');
  const updateKeys = publicKeys();
  const windowsPins = windowsSignerPins(env, { required: production && platform === 'windows' });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aria-package-'));
  const configDirectory = path.join(desktop, 'out', 'package-config');
  await mkdir(output, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  try {
    const testSigning = mode === 'verify' && platform === 'windows' && env.GITHUB_ACTIONS === 'true';
    if (testSigning) windowsPins.splice(0, windowsPins.length, await testCertificate(temporary));
    const buildConfig = path.join(configDirectory, 'update-trust.json');
    await writeFile(buildConfig, JSON.stringify({ updateKeys, windowsPins: production ? windowsPins : [], version }));
    const windows = (production && platform === 'windows') || testSigning
      ? await certificate(temporary, windowsPins[0]) : null;
    if (windows && !windows.publisher) throw new Error('Use a Windows signing certificate with a publisher CN.');
    const core = version.split('-')[0];
    const targetNames = {
      windows: ['nsis', 'portable'], macos: ['dmg', 'zip'], linux: ['deb', 'rpm', 'AppImage', 'tar.gz'],
    };
    const targetPlatform = { windows: Platform.WINDOWS, macos: Platform.MAC, linux: Platform.LINUX }[platform];
    const resource = (from, to, filter) => ({ from: path.join(desktop, from), to, ...(filter ? { filter } : {}) });
    const extraResources = [
      resource('skills', 'aria-skills'),
      resource('program-runner', 'aria-runtime-recipes/program-runner', ['Dockerfile', 'package*.json', 'runner.mts']),
      resource('virtual-desktop', 'aria-runtime-recipes/virtual-desktop'),
      { from: buildConfig, to: 'aria-update-trust.json' },
    ];
    if (platform !== 'linux') extraResources.push(resource('dist-electron/computer-helpers', 'aria-computer',
      platform === 'windows' ? ['Aria.Computer.exe', 'licenses/**/*'] : ['aria-macos-computer']));
    const config = {
      appId: 'io.github.manaplatform.aria',
      productName: 'Aria',
      electronVersion: require('electron/package.json').version,
      directories: { output },
      extraMetadata: {
        version, name: 'aria', description: 'Aria desktop AI assistant',
        homepage: `https://github.com/${repository}`, author: 'Aria maintainers',
      },
      files: ['dist/**/*', 'dist-electron/**/*', '!dist-electron/api{,/**/*}',
        '!dist-electron/computer-helpers{,/**/*}', '!dist/renderer-licenses.json'],
      extraResources,
      asar: true,
      npmRebuild: false,
      allowMissingDependencies: false,
      // The runtime installs its own verified provider before any update check.
      publish: { provider: 'generic', url: `https://github.com/${repository}/releases` },
      icon: path.join(desktop, 'public', 'aria-icon.png'),
      artifactName: 'Aria-${version}-' + platform + '-${arch}.${ext}',
      forceCodeSigning: Boolean(windows) || platform === 'macos',
      win: {
        signExecutable: Boolean(windows),
        signtoolOptions: {
          signingHashAlgorithms: ['sha256'], ...windows && { publisherName: windows.publisher },
          rfc3161TimeStampServer: 'https://timestamp.digicert.com',
        },
      },
      nsis: { runAfterFinish: false, deleteAppDataOnUninstall: false },
      portable: { artifactName: 'Aria-${version}-windows-${arch}-portable.${ext}' },
      mac: {
        identity: '-',
        hardenedRuntime: true,
        notarize: false,
        strictVerify: true,
        bundleShortVersion: core,
        bundleVersion: core,
        extendInfo: { NSMicrophoneUsageDescription: 'Aria uses the microphone for Live Voice.' },
        binaries: ['Contents/Resources/aria-computer/aria-macos-computer'],
      },
      // Electron Builder's DMG signer searches for a certificate. Sign the finished image below.
      dmg: { sign: false, writeUpdateInfo: false },
      linux: {
        executableName: 'aria',
        category: 'Utility',
        maintainer: 'Aria maintainers <manaplatform@users.noreply.github.com>',
      },
      afterPack: async (context) => {
        const resources = platform === 'macos'
          ? path.join(context.appOutDir, 'Aria.app', 'Contents', 'Resources')
          : path.join(context.appOutDir, 'resources');
        await bundleApi(path.join(desktop, 'dist-electron', 'api'), path.join(resources, 'aria-api'));
        if (!windows) return;
        const helper = path.join(resources, 'aria-computer', 'Aria.Computer.exe');
        if (!await context.packager.signIf(helper))
          throw new Error('Windows native computer helper was not signed.');
      },
    };
    const pack = () => build({
      projectDir: desktop, config, publish: 'never',
      targets: targetPlatform.createTarget(mode === 'dir' ? ['dir'] : targetNames[platform], Arch[arch]),
    });
    if (windows) {
      await withWindowsTrust(windows.cer, async () => {
        await pack();
        const appDirectory = path.join(output, arch === 'x64' ? 'win-unpacked' : 'win-arm64-unpacked');
        verifyWindowsSigning([
          ...target.map(({ filename }) => path.join(output, filename)),
          path.join(appDirectory, 'Aria.exe'),
          path.join(appDirectory, 'resources', 'aria-computer', 'Aria.Computer.exe'),
        ], windowsPins[0]);
      });
    } else await pack();

    if (platform === 'macos' && mode !== 'dir') {
      const dmg = path.join(output, target.find(({ format }) => format === 'dmg').filename);
      run('/usr/bin/codesign', ['--sign', '-', '--timestamp=none', dmg]);
    }
    if (mode !== 'dir')
      for (const { filename } of target) await inspectFile(output, filename);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (mode === 'verify-windows-install') {
  const installed = path.resolve(process.argv[4]);
  const cert = path.join(output, windowsCertificateName);
  const expected = process.argv[5] === 'publish' ? windowsSignerPins(env, { required: true })[0]
    : (new X509Certificate(await readFile(cert))).fingerprint256.replaceAll(':', '').toLowerCase();
  await withWindowsTrust(cert, async () => {
    const names = ['Aria.exe', 'Uninstall Aria.exe', 'resources/aria-computer/Aria.Computer.exe'];
    verifyWindowsSigning(names.map((name) => path.join(installed, name)), expected);
  });
} else await packageDesktop();
