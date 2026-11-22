import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  allTargets, applicationVersion, buildInventory, channelFor, createManifest, dateTag, feedName,
  inspectFile, platformAssets, readJson, releaseTitle, validatePackageVersion,
} from './generate-metadata.mjs';
import { formatNotes } from './generate-notes.mjs';
import { findRelease, releaseNoteMarker, tagAnnotation } from './github.mjs';
import { publishDraft, reserveTag, uploadAssets, verifyBuilds } from './run.mjs';

const commit = 'a'.repeat(40);
const tag = 'v2026.11.22';
const version = '0.0.1';
const published = (version, sha = commit) => ({ version, commit: sha, tag });
const state = (extra = {}) => ({ tags: new Set(), reservations: [], published: [], releases: [], ...extra });

test('reads canonical SemVer and validates package limits', () => {
  assert.equal(applicationVersion({ version }), version);
  assert.equal(applicationVersion({ version: '1.2.3-beta.2+ci.4' }), '1.2.3-beta.2+ci.4');
  for (const invalid of [undefined, 1, 'v1.2.3', ' 1.2.3', '1.2', '01.2.3', '1.2.3-beta.02']) {
    assert.throws(() => applicationVersion({ version: invalid }), /canonical SemVer/);
  }
  assert.throws(() => validatePackageVersion('1.2.3+metadata'), /build metadata/);
  assert.throws(() => validatePackageVersion('1.2.100'), /bundle field limits/);
  assert.equal(channelFor('1.2.3-beta.1'), 'beta');
  assert.equal(channelFor('1.2.3'), 'stable');
});

test('allocates UTC date tags and formats the title from the reserved date', () => {
  const local = new Date('2026-11-22T00:30:00+03:30');
  assert.equal(dateTag(local, new Set()), 'v2026.11.21');
  const utc = new Date('2026-11-22T23:00:00Z');
  assert.equal(dateTag(utc, new Set([tag, tag + '-2', tag + '.1'])), tag + '-3');
  assert.equal(releaseTitle('0.0.2-beta.1', tag + '-2'), 'Aria v0.0.2-beta.1 — November 2026 Release');
});

test('release identity rejects duplicate precedence and recovers only its own draft', () => {
  assert.deepEqual(findRelease(state({ published: [published(version)] }), version, commit), { alreadyPublished: tag });
  assert.throws(() => findRelease(state({ published: [published(version + '+metadata')] }), version, commit), /already published/);
  assert.throws(() => findRelease(state({ published: [published('0.0.2')] }), version, commit), /older/);
  const draft = { draft: true, tag_name: tag, body: releaseNoteMarker(version, commit) };
  const reserved = state({ reservations: [published(version)], releases: [draft] });
  assert.deepEqual(findRelease(reserved, version, commit), { tag, draft });
  assert.throws(() => findRelease(reserved, version, 'b'.repeat(40)), /reserved/);
});

test('first-release notes avoid unsupported claims and deduplicate PR commits', () => {
  const fix = 'b'.repeat(40);
  const breaker = 'c'.repeat(40);
  const notes = formatNotes({ commit, tag, commits: [
    { sha: commit, title: 'Potential speed improvement', body: '' },
    { sha: fix, title: 'fix: repair startup', body: '' },
    { sha: breaker, title: 'feat!: remove an obsolete setting', body: '' },
  ], pulls: [{ number: 7, title: 'Repair startup [details]', user: 'aria-dev',
    labels: ['bug'], body: '', commits: new Set([fix]) }] });
  assert.match(notes, /Bug Fixes[\s\S]*#7/);
  assert.match(notes, /Breaking Changes/);
  assert.match(notes, /Browse commit history/);
  assert.match(notes, /Contributors[\s\S]*@aria-dev/);
  assert.match(notes, /ad hoc signed and unnotarized/);
  assert.doesNotMatch(notes, /Speed|speed|Performance|Security|fix: repair/);
});

test('manifest hashes actual bytes and includes all six feeds', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aria-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filenames = [...buildInventory(version).map(({ filename }) => filename),
    ...allTargets().map(({ platform, arch }) => feedName(platform, arch)), 'Aria.cdx.json', 'Aria-Windows-Signing.cer'];
  for (const filename of filenames) await writeFile(path.join(directory, filename), filename);
  const manifest = await createManifest(directory, { version, tag, commit, buildTimestamp: '2026-11-22T00:00:00Z' });
  assert.equal(manifest.platforms.length, 6);
  assert.equal(manifest.assets.length, filenames.length);
  for (const arch of ['x64', 'arm64']) {
    const macAssets = manifest.assets.filter((asset) => asset.platform === 'macos' && asset.arch === arch);
    assert.equal(macAssets.find((asset) => asset.inAppUpdate)?.format, 'dmg');
    assert.ok(macAssets.every((asset) => asset.signing === 'ad-hoc' && asset.notarized === false));
  }
  const sample = manifest.assets[0];
  assert.match(sample.url, /releases\/download\/v2026\.11\.22\/Aria-/);
  assert.equal(sample.sha256, (await inspectFile(directory, sample.filename)).sha256);
  await rm(path.join(directory, sample.filename));
  await assert.rejects(() => createManifest(directory, { version, tag, commit }), /ENOENT/);
});

test('build verification requires ad hoc macOS receipts and generates DMG update feeds', async (t) => {
  const input = await mkdtemp(path.join(os.tmpdir(), 'aria-build-receipts-'));
  const output = path.join(input, 'verified');
  const builds = path.join(input, 'incoming');
  t.after(() => rm(input, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const version = applicationVersion(JSON.parse(git('show', 'HEAD:package.json')));
  const commit = git('rev-parse', 'HEAD');
  for (const { platform, arch } of allTargets()) {
    const directory = path.join(builds, `aria-${platform}-${arch}`);
    await mkdir(directory, { recursive: true });
    const files = {};
    for (const { filename } of platformAssets(version, platform, arch)) {
      await writeFile(path.join(directory, filename), filename);
      files[filename] = await inspectFile(directory, filename);
    }
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify({
      commit, version, platform, arch, files, components: [], timestamp: new Date().toISOString(),
      ...(platform === 'macos' ? { signing: 'ad-hoc', notarized: false } : {}),
    }));
  }
  await verifyBuilds(builds, output, false);
  for (const arch of ['x64', 'arm64']) {
    const feed = await readJson(path.join(output, feedName('macos', arch)));
    const filename = `Aria-${version}-macos-${arch}.dmg`;
    const { size, sha512 } = await inspectFile(output, filename);
    assert.deepEqual(feed, { version, files: [{ url: filename, size, sha512 }] });
  }
  const pathToReceipt = path.join(builds, 'aria-macos-arm64', 'receipt.json');
  const receipt = await readJson(pathToReceipt);
  await writeFile(pathToReceipt, JSON.stringify({ ...receipt, signing: undefined }));
  await assert.rejects(() => verifyBuilds(builds, output, false), /Missing ad hoc signing verification/);
});

test('lost tag creation response reuses the authoritative annotated tag', async () => {
  let attempts = 0;
  const api = {
    json: async (route, options) => {
      if (route === '/git/tags') {
        if (options) return { sha: 'tag-object' };
      }
      if (route === '/git/refs') {
        attempts++;
        throw new Error('connection interrupted after creation');
      }
      if (route === '/git/tags/tag-object') return { object: { sha: commit, type: 'commit' }, message: tagAnnotation(version, commit) };
      throw new Error(`Unexpected route ${route}`);
    },
    pages: async (route) => route === '/releases' ? [] :
      [{ ref: `refs/tags/${tag}`, object: { sha: 'tag-object', type: 'tag' } }],
  };
  assert.equal(await reserveTag(api, state(), version, commit, new Date('2026-11-22T11:00:00Z')), tag);
  assert.equal(attempts, 1);
});

test('partial upload recovery skips matching bytes and verifies a lost upload response', async () => {
  const matches = { id: 1, name: 'first.exe', state: 'uploaded', size: 5, sha: 'one' };
  const failed = { id: 2, name: 'second.dmg', state: 'starter', size: 0 };
  const remote = [matches, failed];
  const uploaded = [];
  const api = {
    pages: async () => [...remote],
    assetDigest: async (item) => item.sha,
    json: async (route, { method }) => {
      assert.equal(method, 'DELETE');
      assert.match(route, /\/2$/);
      remote.pop();
    },
    upload: async (_id, name, _mime, size) => {
      uploaded.push(name);
      remote.push({ id: 3, state: 'uploaded', name, size, sha: 'two' });
      throw new Error('connection lost after asset upload');
    },
  };
  await uploadAssets(api, { id: 23 }, '/build', new Map([
    [matches.name, { sha256: 'one', size: 5 }], [failed.name, { sha256: 'two', size: 7 }],
  ]));
  assert.deepEqual(uploaded, [failed.name]);
});

test('a lost publication response is reconciled by release ID', async () => {
  const response = { id: 23, draft: false, prerelease: true, tag_name: tag };
  const api = { json: async (_route, options) => {
    if (!options) return response;
    assert.equal(options.body.make_latest, 'false');
    throw new Error('connection lost after publishing');
  } };
  assert.equal(await publishDraft(api, 23, { tag, beta: true, name: 'title', body: 'notes' }), response);
});
