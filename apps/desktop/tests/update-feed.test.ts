import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { findUpdate } from '../electron/update-feed';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keys = [publicKey.export({ format: 'der', type: 'spki' }).toString('base64')];
const base = 'https://github.com/manaplatform/Aria/releases';
const target = { platform: 'linux', arch: 'arm64' } as const;
const macTarget = { platform: 'macos', arch: 'arm64' } as const;
const digest = (algorithm: string, value: string, encoding: 'hex' | 'base64') =>
  createHash(algorithm).update(value).digest(encoding);

function fixture(releases: { version: string; tag: string; tamper?: 'manifest' | 'feed' | 'url' }[],
  device: typeof target | typeof macTarget = target, legacyMacFeed = false) {
  const files = new Map<string, string>();
  const entries = releases.map(({ version, tag, tamper }) => {
    const prerelease = version.includes('-');
    const prefix = `Aria-${version}-${device.platform}-${device.arch}`;
    const installer = `${prefix}.${device.platform === 'linux' ? 'AppImage' : legacyMacFeed ? 'zip' : 'dmg'}`;
    const metadata = `update-${device.platform}-${device.arch}.yml`;
    const url = (name: string) => `${base}/download/${tag}/${name}`;
    const binary = 'fixture archive';
    const sha512 = digest('sha512', binary, 'base64');
    const feed = JSON.stringify({ version, files: [{ url: installer, sha512, size: binary.length }] });
    const asset = (filename: string, value: string) => ({
      filename, url: tamper === 'url' ? 'https://example.com/elsewhere' : url(filename),
      size: value.length, sha256: digest('sha256', value, 'hex'), sha512: digest('sha512', value, 'base64'),
    });
    const manifest = JSON.stringify({
      schemaVersion: 1, name: 'Aria', version, tag, commit: 'a'.repeat(40),
      channel: prerelease ? 'beta' : 'stable', assets: [asset(installer, binary), asset(metadata, feed),
        ...(legacyMacFeed ? [asset(`${prefix}.dmg`, 'manual disk image')] : [])],
    });
    files.set(url('release-manifest.json'), tamper === 'manifest' ? manifest + ' ' : manifest);
    files.set(url('release-manifest.sig'), sign(null, Buffer.from(manifest), privateKey).toString('base64'));
    files.set(url(metadata), tamper === 'feed' ? feed.replace(installer, 'other.AppImage') : feed);
    return { draft: false, tag_name: tag, prerelease, assets: ['release-manifest.json', 'release-manifest.sig'].map((name) => ({ name })) };
  });
  return (async (url: URL) => {
    if (url.hostname === 'api.github.com') return Response.json(entries);
    const content = files.get(String(url));
    return content ? new Response(content) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

describe('verified Aria update feed', () => {
  test('orders by app SemVer independently of calendar tags', async () => {
    const request = fixture([
      { version: '2.1.0', tag: 'v2026.12.10-2' },
      { version: '2.2.0', tag: 'v2026.11.02' },
      { version: '2.3.0-beta.1', tag: 'v2026.11.01' },
    ]);
    await expect(findUpdate('2.0.0', 'stable', target, keys, request)).resolves.toMatchObject({
      version: '2.2.0', tag: 'v2026.11.02', download: { url: expect.stringContaining('linux-arm64.AppImage') },
    });
    await expect(findUpdate('2.0.0', 'beta', target, keys, request)).resolves.toMatchObject({ version: '2.3.0-beta.1' });
    await expect(findUpdate('2.3.0-beta.1', 'stable', target, keys, request)).resolves.toBeUndefined();
  });

  test('accepts final versions as upgrades from beta and rejects an equal version', async () => {
    const request = fixture([{ version: '2.0.0', tag: 'v2026.11.02' }]);
    await expect(findUpdate('2.0.0-beta.3', 'beta', target, keys, request)).resolves.toMatchObject({ version: '2.0.0' });
    await expect(findUpdate('2.0.0', 'beta', target, keys, request)).resolves.toBeUndefined();
  });

  test.each(['manifest', 'feed', 'url'] as const)('rejects tampered %s metadata', async (tamper) => {
    const request = fixture([{ version: '2.0.0', tag: 'v2026.11.02', tamper }]);
    await expect(findUpdate('1.0.0', 'stable', target, keys, request)).rejects.toThrow(/signature|checksum|inconsistent/);
  });

  test.each([false, true])('selects the signed architecture-specific DMG (legacy feed: %s)', async (legacy) => {
    const request = fixture([{ version: '2.0.0', tag: 'v2026.11.02' }], macTarget, legacy);
    const image = legacy ? 'manual disk image' : 'fixture archive';
    await expect(findUpdate('1.0.0', 'stable', macTarget, keys, request)).resolves.toMatchObject({
      download: {
        url: `${base}/download/v2026.11.02/Aria-2.0.0-macos-arm64.dmg`,
        size: image.length, sha256: digest('sha256', image, 'hex'), sha512: digest('sha512', image, 'base64'),
      },
    });
    await expect(findUpdate('1.0.0', 'stable', { ...macTarget, arch: 'x64' }, keys, request)).resolves.toBeUndefined();
  });
});
