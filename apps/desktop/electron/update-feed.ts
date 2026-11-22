import { createHash, createPublicKey, verify } from 'node:crypto';
import { gt, parse, rcompare } from 'semver';
import { z } from 'zod';
import type { UpdateChannel } from '@aria/shared';

const repo = 'manaplatform/Aria';
const base = `https://github.com/${repo}/releases`;
const api = `https://api.github.com/repos/${repo}/releases`;
const calendarTag = /^v\d{4}\.\d{2}\.\d{2}(?:-(?:[2-9]|[1-9]\d+))?$/;
const stableSemVer = (version: string) => parse(version)?.version === version;
export const releasePage = base;

const size = z.number().int().positive().max(2 * 1024 ** 3);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha512 = z.string().regex(/^[a-zA-Z0-9+/]{86}==$/);
const asset = z.object({
  filename: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  url: z.string(),
  size,
  sha256: digest,
  sha512,
});
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.literal('Aria'),
  version: z.string().refine(stableSemVer),
  tag: z.string().regex(calendarTag),
  channel: z.enum(['stable', 'beta']),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  assets: z.array(asset).max(100),
});
const listingSchema = z.array(z.object({
  tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string() })).max(100),
})).max(100);
const feedSchema = z.object({
  version: z.string(),
  files: z.tuple([z.object({ url: z.string(), sha512, size })]),
});

type Target = { platform: 'windows' | 'macos' | 'linux'; arch: 'x64' | 'arm64' };
export type VerifiedUpdate = {
  tag: string;
  version: string;
  url: string;
  download: { url: string; sha256: string; sha512: string; size: number };
};

function assetUrl(tag: string, filename: string) {
  return `${base}/download/${tag}/${filename}`;
}

export async function fetchUpdateResponse(url: string, signal: AbortSignal, request: typeof fetch = fetch) {
  let next = new URL(url);
  let response: Response;
  for (let redirects = 0; ; redirects++) {
    if (next.protocol !== 'https:' || next.port || next.username || next.password ||
        !['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname))
      throw new Error('The update request points to an untrusted location.');
    response = await request(next, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    if (redirects === 3 || !response.headers.has('location')) throw new Error('The update feed redirect could not be validated.');
    next = new URL(response.headers.get('location')!, next);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(response.status === 403 || response.status === 429
      ? 'GitHub’s update service is rate limited. Try again later.'
      : `The GitHub update service returned HTTP ${response.status}.`);
  }
  return response.body;
}

async function readBytes(url: string, limit: number, request: typeof fetch) {
  const stream = await fetchUpdateResponse(url, AbortSignal.timeout(25_000), request);
  const reader = stream.getReader();
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error('An update metadata response exceeded its size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

export function readSignedManifest(bytes: Buffer, signature: Buffer, keys: string[]) {
  const signed = Buffer.from(signature.toString('utf8').trim(), 'base64');
  if (signed.length !== 64 || !keys.some((encoded) => {
    const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && verify(null, bytes, key, signed);
  })) throw new Error('Aria could not verify the signature on the release manifest.');
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (Boolean(parse(manifest.version)?.prerelease.length) !== (manifest.channel === 'beta') ||
      new Set(manifest.assets.map((item) => item.filename)).size !== manifest.assets.length ||
      manifest.assets.some((item) => item.url !== assetUrl(manifest.tag, item.filename)))
    throw new Error('Aria received inconsistent signed release metadata.');
  return manifest;
}

export async function findUpdate(
  current: string, channel: UpdateChannel, target: Target, keys: string[],
  request: typeof fetch = fetch,
): Promise<VerifiedUpdate | undefined> {
  const candidates = [];
  let verified = false;
  let invalid: unknown;
  for (let page = 1; page <= 5; page++) {
    const entries = listingSchema.parse(JSON.parse((await readBytes(
      `${api}?per_page=30&page=${page}`, 4 * 1024 * 1024, request)).toString('utf8')));
    for (const release of entries) {
      if (release.draft || !calendarTag.test(release.tag_name) || release.prerelease && channel === 'stable') continue;
      const names = new Set(release.assets.map(({ name }) => name));
      if (!names.has('release-manifest.json') && !names.has('release-manifest.sig')) continue;
      try {
        if (!names.has('release-manifest.json') || !names.has('release-manifest.sig'))
          throw new Error('Aria found an incomplete update manifest. Try again later.');
        const [bytes, signature] = await Promise.all([
          readBytes(assetUrl(release.tag_name, 'release-manifest.json'), 256 * 1024, request),
          readBytes(assetUrl(release.tag_name, 'release-manifest.sig'), 1024, request),
        ]);
        const manifest = readSignedManifest(bytes, signature, keys);
        if (manifest.tag !== release.tag_name || (manifest.channel === 'beta') !== release.prerelease)
          throw new Error('Aria found an update whose signed tag or channel differs from the release.');
        verified = true;
        if (gt(manifest.version, current)) candidates.push(manifest);
      } catch (error) {
        // Historical releases can carry signatures from retired keys. Select
        // only verified releases and surface errors when none can be trusted.
        invalid ??= error;
      }
    }
    if (entries.length < 30) break;
  }
  if (!verified && invalid) throw invalid;
  for (const manifest of candidates.sort((a, b) => rcompare(a.version, b.version))) {
    const filename = `update-${target.platform}-${target.arch}.yml`;
    const record = manifest.assets.find((item) => item.filename === filename);
    if (!record) continue;
    const bytes = await readBytes(record.url, 8192, request);
    if (bytes.length !== record.size || createHash('sha256').update(bytes).digest('hex') !== record.sha256)
      throw new Error('Aria could not verify the update metadata checksum.');
    const feed = feedSchema.parse(JSON.parse(bytes.toString('utf8')));
    const [file] = feed.files;
    const extension = { windows: 'exe', macos: 'dmg', linux: 'AppImage' }[target.platform];
    const prefix = `Aria-${manifest.version}-${target.platform}-${target.arch}`;
    const expectedFile = `${prefix}.${extension}`;
    // Historical manifests pointed the macOS feed at a ZIP. Verify that feed's
    // binding and use the DMG from the same signed manifest for manual updates.
    const listed = manifest.assets.find((item) => item.filename === file.url);
    const binary = manifest.assets.find((item) => item.filename === expectedFile);
    if (feed.version !== manifest.version || !binary || !listed ||
        (file.url !== expectedFile && !(target.platform === 'macos' && file.url === `${prefix}.zip`)) ||
        listed.sha512 !== file.sha512 || listed.size !== file.size)
      throw new Error('The signed update does not match the installer for this device.');
    return {
      version: manifest.version, tag: manifest.tag, url: `${base}/tag/${manifest.tag}`,
      download: { url: binary.url, sha256: binary.sha256, sha512: binary.sha512, size: binary.size },
    };
  }
}
