import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  allTargets, applicationVersion, buildInventory, channelFor, createManifest, dateTag, feedName,
  downloadUrl, inspectFile, manifestName, platformAssets, readJson, releaseTitle,
  sbomName, signatureName, sumsName, validatePackageVersion, windowsCertificateName,
} from './generate-metadata.mjs';
import { formatNotes } from './generate-notes.mjs';
import { findRelease, GitHubError, releaseNoteMarker, tagAnnotation } from './github.mjs';
import { publishDraft, publishRelease, reserveTag, uploadAssets, verifyBuilds } from './run.mjs';
import { windowsSignerPins } from './windows-signer-pins.mjs';

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

test('Windows production signer pins accept an empty rotation setting', () => {
  const primary = 'a'.repeat(64);
  const env = { ARIA_WINDOWS_SIGNER_SHA256: ` ${primary.toUpperCase()}\n` };
  for (const additional of [undefined, '', ' \t ']) {
    assert.deepEqual(windowsSignerPins({ ...env, ARIA_WINDOWS_ADDITIONAL_SIGNERS_SHA256: additional },
      { required: true }), [primary]);
  }
  const first = 'b'.repeat(64);
  const second = 'c'.repeat(64);
  assert.deepEqual(windowsSignerPins({ ...env,
    ARIA_WINDOWS_ADDITIONAL_SIGNERS_SHA256: `${first.toUpperCase()}, ${second}`,
  }, { required: true }), [primary, first, second]);
  assert.deepEqual(windowsSignerPins({}), []);
});

test('Windows production signer pins reject missing, malformed, or incomplete settings', () => {
  const env = { ARIA_WINDOWS_SIGNER_SHA256: 'a'.repeat(64) };
  assert.throws(() => windowsSignerPins({}, { required: true }), /Set ARIA_WINDOWS_SIGNER_SHA256/);
  assert.throws(() => windowsSignerPins({ ARIA_WINDOWS_SIGNER_SHA256: 'a'.repeat(40) }, { required: true }),
    /ARIA_WINDOWS_SIGNER_SHA256 must be a 64-character/);
  for (const additional of ['g'.repeat(64), `${'b'.repeat(64)},`]) {
    assert.throws(() => windowsSignerPins({ ...env, ARIA_WINDOWS_ADDITIONAL_SIGNERS_SHA256: additional },
      { required: true }), /ARIA_WINDOWS_ADDITIONAL_SIGNERS_SHA256 must contain comma-separated/);
  }
});

test('allocates UTC date tags and formats the title from the reserved date', () => {
  const local = new Date('2026-11-22T00:30:00+03:30');
  assert.equal(dateTag(local, new Set()), 'v2026.11.21');
  const utc = new Date('2026-11-22T23:00:00Z');
  assert.equal(dateTag(utc, new Set([tag, tag + '-2', tag + '.1'])), tag + '-3');
  assert.equal(releaseTitle('0.0.2-beta.1', tag + '-2'), 'Aria v0.0.2-beta.1 — 2026.11.22');
});

test('production preparation skips an unchanged main version and rejects a tag named main', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aria-release-event-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const event = path.join(directory, 'event.json');
  const outputs = path.join(directory, 'output');
  await writeFile(event, JSON.stringify({ before: source, repository: { default_branch: 'main' } }));
  const prepare = (ref) => spawnSync(process.execPath,
    [fileURLToPath(new URL('./run.mjs', import.meta.url)), 'prepare', 'publish'], {
      encoding: 'utf8', env: {
        ...process.env, GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: outputs, GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'manaplatform/Aria', GITHUB_SHA: source, GITHUB_REF: ref,
        ARIA_RELEASE_ENABLED: 'false', ARIA_DISTRIBUTION_AUTHORIZED: 'false',
      },
    });
  const unchanged = prepare('refs/heads/main');
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.equal(await readFile(outputs, 'utf8'), 'run=false\n');
  const tag = prepare('refs/tags/main');
  assert.equal(tag.status, 1);
  assert.match(tag.stderr, /require manaplatform\/Aria’s default branch/);
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
  const security = 'd'.repeat(40);
  const skipped = 'e'.repeat(40);
  const dmg = platformAssets(version, 'macos', 'arm64').find(({ format }) => format === 'dmg');
  const beta = '0.0.2-beta.1';
  const notes = formatNotes({ commit, tag, version: beta, channel: 'beta',
    assets: [dmg, ...platformAssets(version, 'windows', 'x64')], verified: [{ name: dmg.filename }, { name: sumsName }],
    license: { declaration: 'MIT', files: ['LICENSE.md'], notices: 'THIRD_PARTY_NOTICES.md' }, commits: [
    { sha: commit, title: 'Potential speed improvement', body: '' },
    { sha: fix, title: 'fix: repair startup', body: '' },
    { sha: breaker, title: 'feat!: remove an obsolete setting', body: '' },
    { sha: security, title: 'fix(security): tighten origin validation', body: '' },
    { sha: skipped, title: 'feat: hidden experiment', body: '' },
  ], pulls: [{ number: 7, title: 'Repair startup [details]', user: 'aria-dev',
    labels: ['bug', 'desktop'], body: '', commits: new Set([fix, security]) },
  { number: 9, title: 'Hidden experiment', user: 'ignored', labels: ['skip-release-notes'], body: '', commits: new Set([skipped]) }] });
  assert.match(notes, /Bug fixes\n\n- Repair startup \\\[details\\\] \(\[#7\]/);
  assert.match(notes, /Breaking changes\n\n- remove an obsolete setting/);
  assert.match(notes, /Security updates\n\n- tighten origin validation \(\[#7\]/);
  assert.match(notes, /Browse commit history/);
  assert.match(notes, /Contributors[\s\S]*@aria-dev/);
  assert.match(notes, /Beta prerelease/);
  assert.match(notes, /Apple Silicon \(arm64\)/);
  assert.ok(notes.includes(downloadUrl(tag, dmg.filename)));
  assert.match(notes, /ad hoc signed and unnotarized/);
  assert.match(notes, /MIT[\s\S]*LICENSE\.md[\s\S]*Third-party notices/);
  assert.doesNotMatch(notes, /speed|#9|New features|Improvements|fix: repair|Intel|Windows|Linux|{{/);
});

test('manifest hashes actual bytes and includes all six feeds', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aria-release-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filenames = [...buildInventory(version).map(({ filename }) => filename),
    ...allTargets().map(({ platform, arch }) => feedName(platform, arch)), sbomName, windowsCertificateName];
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

async function buildFixture(t, production) {
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
    const filenames = platformAssets(version, platform, arch).map(({ filename }) => filename);
    if (production && platform === 'windows') filenames.push(windowsCertificateName);
    for (const filename of filenames) {
      await writeFile(path.join(directory, filename), filename);
      files[filename] = await inspectFile(directory, filename);
    }
    await writeFile(path.join(directory, 'receipt.json'), JSON.stringify({
      commit, version, platform, arch, files, production, components: [], timestamp: new Date().toISOString(),
      ...(platform === 'macos' ? { signing: 'ad-hoc', notarized: false } : {}),
    }));
  }
  return { builds, output, version, commit };
}

test('build verification requires ad hoc macOS receipts and generates DMG update feeds', async (t) => {
  const { builds, output, version } = await buildFixture(t, false);
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
  const reservation = await reserveTag(api, state(), version, commit, (candidate) => candidate,
    new Date('2026-11-22T11:00:00Z'));
  assert.deepEqual(reservation, { tag, staged: tag });
  assert.equal(attempts, 1);
});

test('a same-day remote tag collision restages signed metadata for the new candidate', async () => {
  const attempts = [];
  const staged = [];
  const api = {
    async json(route, { body }) {
      if (route === '/git/tags') return { sha: 'annotated' };
      assert.equal(route, '/git/refs');
      attempts.push(body.ref);
      if (attempts.length === 1) throw new GitHubError(422, route);
    },
    async pages(route) {
      return route === '/releases' ? [] : [{ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: commit } }];
    },
  };
  const result = await reserveTag(api, state(), version, commit, (candidate) => {
    staged.push(candidate);
    return candidate;
  }, new Date('2026-11-22T11:00:00Z'));
  assert.deepEqual(staged, [tag, tag + '-2']);
  assert.deepEqual(attempts, staged.map((candidate) => `refs/tags/${candidate}`));
  assert.deepEqual(result, { tag: tag + '-2', staged: tag + '-2' });
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
  const response = { id: 23, draft: false, prerelease: true, tag_name: tag, name: 'title', body: 'notes' };
  const api = { json: async (_route, options) => {
    if (!options) return response;
    assert.equal(options.body.make_latest, 'false');
    throw new Error('connection lost after publishing');
  } };
  assert.equal(await publishDraft(api, 23, { tag, beta: true, name: 'title', body: 'notes' }), response);
});

test('verified build through publication signs metadata, rejects corrupt uploads and retries the same tag', async (t) => {
  const { builds, output, version, commit } = await buildFixture(t, true);
  await verifyBuilds(builds, output, true);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const timestamp = '2026-11-22T10:30:00Z';
  const now = new Date('2026-11-22T11:00:00Z');
  const reserved = tag + '-2';
  const sample = buildInventory(version)[0].filename;
  const remote = new Map();
  const uploads = [];
  let tagObject;
  let draft;
  let ref;
  let corrupt = true;
  const api = {
    async pages(route) {
      if (route === '/git/matching-refs/tags/v') return [
        { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: commit } },
        ...(ref ? [ref] : []),
      ];
      if (route === '/releases') return draft ? [{ ...draft, assets: [...remote.values()] }] : [];
      if (route === '/releases/23/assets') return [...remote.values()];
      if (route === `/commits/${commit}/pulls`) return [{
        number: 123, merge_commit_sha: commit, merged_at: timestamp, labels: [],
        base: { repo: { full_name: 'manaplatform/Aria' } },
        title: 'feat: Add guided setup', body: '', user: { login: 'aria-dev' },
      }];
      if (/^\/commits\/[a-f0-9]{40}\/pulls$/.test(route)) return [];
      throw new Error(`Unexpected list ${route}`);
    },
    async json(route, options) {
      if (route === '/git/tags/reservation') return tagObject;
      const { method, body } = options;
      if (route === '/git/tags') {
        assert.equal(tagObject, undefined, 'retry must reuse the annotated tag');
        assert.equal(body.tag, reserved);
        assert.equal(body.message, tagAnnotation(version, commit));
        const bytes = await readFile(path.join(output, manifestName));
        const signature = Buffer.from(await readFile(path.join(output, signatureName), 'utf8'), 'base64');
        assert.ok(verify(null, bytes, publicKey, signature));
        const manifest = JSON.parse(bytes);
        assert.equal(manifest.tag, reserved);
        assert.equal(manifest.commit, commit);
        assert.equal(manifest.version, version);
        assert.equal(manifest.buildTimestamp, timestamp);
        assert.equal(manifest.platforms.length, 6);
        const checksums = await readFile(path.join(output, sumsName), 'utf8');
        for (const filename of [...manifest.assets.map((asset) => asset.filename), manifestName, signatureName]) {
          const { sha256 } = await inspectFile(output, filename);
          assert.ok(checksums.includes(`${sha256}  ${filename}\n`));
        }
        tagObject = { object: { type: body.type, sha: body.object }, message: body.message, sha: 'reservation' };
        return tagObject;
      }
      if (route === '/git/refs') {
        assert.deepEqual(body, { ref: `refs/tags/${reserved}`, sha: 'reservation' });
        ref = { ref: body.ref, object: { type: 'tag', sha: body.sha } };
        return ref;
      }
      if (route === '/releases') {
        assert.equal(draft, undefined, 'retry must reuse the existing draft');
        assert.equal(body.tag_name, reserved);
        assert.equal(body.target_commitish, commit);
        assert.equal(body.name, releaseTitle(version, reserved));
        assert.ok(body.draft);
        assert.match(body.body, /New features[\s\S]*Add guided setup/);
        assert.doesNotMatch(body.body, /releases\/download/);
        draft = { ...body, id: 23 };
        return draft;
      }
      if (route.startsWith('/releases/assets/') && method === 'DELETE') {
        assert.equal(route, `/releases/assets/${remote.get(sample).id}`);
        remote.delete(sample);
        return null;
      }
      if (route === '/releases/23' && method === 'PATCH') {
        assert.equal(body.make_latest, channelFor(version) === 'stable' ? 'true' : 'false');
        assert.ok(!corrupt && !body.draft);
        draft = { ...draft, ...body };
        return draft;
      }
      throw new Error(`Unexpected mutation ${route}`);
    },
    async upload(id, name, _type, size, file) {
      assert.equal(id, draft.id);
      assert.ok(draft.draft);
      const digest = await inspectFile(path.dirname(file), path.basename(file));
      assert.equal(digest.size, size);
      uploads.push(name);
      remote.set(name, { id: uploads.length, name, state: 'uploaded', size,
        digest: corrupt && name === sample ? 'corrupted' : digest.sha256 });
    },
    async assetDigest(asset) {
      return asset.digest;
    },
  };

  await rm(path.join(output, sample));
  await assert.rejects(() => publishRelease(api, output, timestamp, privateKey, now), /ENOENT/);
  assert.equal(tagObject, undefined);
  await writeFile(path.join(output, sample), sample);
  await assert.rejects(() => publishRelease(api, output, timestamp, privateKey, now), /asset verification failed/);
  assert.ok(draft.draft);
  const firstUploads = uploads.length;

  corrupt = false;
  const later = new Date('2026-11-23T12:00:00Z');
  const result = await publishRelease(api, output, timestamp, privateKey, later);
  assert.equal(result.tag_name, reserved);
  assert.equal(result.name, releaseTitle(version, reserved));
  assert.equal(result.prerelease, channelFor(version) === 'beta');
  assert.deepEqual(uploads.slice(firstUploads), [sample]);
  for (const filename of [...buildInventory(version).map((asset) => asset.filename),
    sumsName, manifestName, signatureName, windowsCertificateName, sbomName]) {
    assert.ok(result.body.includes(downloadUrl(reserved, filename)), filename);
  }
  assert.match(result.body, /Apple Silicon \(arm64\)[\s\S]*Intel \(x64\)[\s\S]*### Windows[\s\S]*### Linux/);
  assert.match(result.body, /self-signed Authenticode certificate/);
  assert.match(result.body, /Full changelog/);
  assert.equal(await publishRelease(api, output, timestamp, privateKey, later), undefined);
  assert.equal(uploads.length, firstUploads + 1);
});
