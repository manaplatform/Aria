import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';

export const repository = 'manaplatform/Aria';
export const sourcePattern = /^[a-f0-9]{40}$/;
export const tagPattern = /^v\d{4}\.\d{2}\.\d{2}(?:\.[1-9]\d*|-(?:[2-9]|[1-9]\d+))?$/;
export const marker = 'Aria Release Creator v1';
export const manifestName = 'release-manifest.json';
export const signatureName = 'release-manifest.sig';
export const sumsName = 'SHA256SUMS.txt';
export const sbomName = 'Aria.cdx.json';
export const windowsCertificateName = 'Aria-Windows-Signing.cer';

export function applicationVersion(manifest) {
  const version = manifest?.version;
  const parsed = typeof version === 'string' ? semver.parse(version) : null;
  if (!parsed || parsed.raw !== version ||
      parsed.version + (parsed.build.length ? `+${parsed.build.join('.')}` : '') !== version)
    throw new Error('Root package.json must contain a canonical SemVer application version.');
  return version;
}

export function validatePackageVersion(version) {
  if (semver.parse(version).build.length)
    throw new Error('Release versions cannot include build metadata. Choose a unique SemVer precedence for installer and updater compatibility.');
  if (semver.major(version) > 9999 || semver.minor(version) > 99 || semver.patch(version) > 99)
    throw new Error('Release version exceeds the macOS bundle field limits (major 9999, minor and patch 99).');
  return version;
}

export function channelFor(version) {
  return semver.prerelease(version) ? 'beta' : 'stable';
}

export function dateTag(date, tags) {
  const prefix = `v${date.toISOString().slice(0, 10).replaceAll('-', '.')}`;
  if (!tags.has(prefix)) return prefix;
  let suffix = 2;
  while (tags.has(`${prefix}-${suffix}`)) suffix++;
  return `${prefix}-${suffix}`;
}

export function releaseDate(tag) {
  if (!tagPattern.test(tag)) throw new Error('Invalid Aria release tag.');
  return tag.slice(1, 11);
}

export function releaseTitle(version) {
  return `v${version}`;
}

const platforms = {
  windows: ['exe', 'portable.exe'],
  macos: ['dmg', 'zip'],
  linux: ['deb', 'rpm', 'AppImage', 'tar.gz'],
};

export function platformAssets(version, platform, arch) {
  if (!Object.hasOwn(platforms, platform) || !['x64', 'arm64'].includes(arch))
    throw new Error('Unsupported release build target.');
  const prefix = `Aria-${version}-${platform}-${arch}`;
  return platforms[platform].map((format) => ({
    filename: format === 'portable.exe' ? `${prefix}-portable.exe` : `${prefix}.${format}`,
    platform, arch, format,
    inAppUpdate: ['exe', 'dmg', 'AppImage'].includes(format),
    ...(platform === 'macos' ? { signing: 'ad-hoc', notarized: false } : {}),
  }));
}

export function allTargets() {
  return Object.keys(platforms).flatMap((platform) =>
    ['x64', 'arm64'].map((arch) => ({ platform, arch })));
}

export function feedName(platform, arch) {
  return `update-${platform}-${arch}.yml`;
}

export function downloadUrl(tag, filename) {
  return `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(filename)}`;
}

export function buildInventory(version) {
  return allTargets().flatMap(({ platform, arch }) => platformAssets(version, platform, arch));
}

export async function inspectFile(directory, filename) {
  const file = path.join(directory, filename);
  const stat = await lstat(file);
  if (!stat.isFile() || !stat.size) throw new Error(`Expected a nonempty regular asset: ${filename}`);
  const sha256 = createHash('sha256');
  const sha512 = createHash('sha512');
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { size: stat.size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') };
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function createManifest(directory, { version, tag, commit, buildTimestamp }) {
  if (!tagPattern.test(tag) || !sourcePattern.test(commit))
    throw new Error('Invalid release manifest identity.');
  const assets = await Promise.all(buildInventory(version).map(async (asset) => ({
    ...asset, url: downloadUrl(tag, asset.filename), ...await inspectFile(directory, asset.filename),
  })));
  const metadata = [
    ...allTargets().map(({ platform, arch }) => feedName(platform, arch)),
    sbomName, windowsCertificateName,
  ];
  for (const filename of metadata) {
    assets.push({ filename, url: downloadUrl(tag, filename), ...await inspectFile(directory, filename) });
  }
  return {
    schemaVersion: 1,
    name: 'Aria',
    version,
    tag,
    commit,
    buildTimestamp,
    channel: channelFor(version),
    platforms: allTargets(),
    assets,
  };
}
