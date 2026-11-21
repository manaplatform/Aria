import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, writeFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allTargets, applicationVersion, buildInventory, channelFor, createManifest, dateTag, feedName,
  inspectFile, manifestName, platformAssets, readJson, releaseTitle, repository, signatureName,
  sourcePattern, sumsName, validatePackageVersion,
} from './generate-metadata.mjs';
import { formatNotes } from './generate-notes.mjs';
import { findRelease, github, GitHubError, readReleaseState, releaseNoteMarker, tagAnnotation } from './github.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = process.env;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 24 * 1024 ** 2 });
const manifest = (commit) => applicationVersion(JSON.parse(git('show', `${commit}:package.json`)));
const commit = () => git('rev-parse', 'HEAD').trim();
const versionAtHead = () => validatePackageVersion(manifest(commit()));
const localVersion = async () => validatePackageVersion(applicationVersion(await readJson(path.join(root, 'package.json'))));

function previousRelease(state, target) {
  const result = [...state.published].sort((a, b) =>
    Date.parse(b.release.published_at) - Date.parse(a.release.published_at));
  return result.find((item) => {
    try {
      git('merge-base', '--is-ancestor', item.commit, target);
      return true;
    } catch (error) {
      if (error.status === 1) return false;
      throw new Error(`Cannot read release ancestry for ${item.tag}. Fetch full history and tags.`);
    }
  });
}

async function notes(api, state, source, tag, nativeNotes = '') {
  const previous = previousRelease(state, source);
  const records = git('-c', 'log.showSignature=false', 'log', '-z', '--format=%H%x00%s%x00%b',
    previous ? `${previous.commit}..${source}` : source).split('\0');
  const commits = [];
  for (let index = 0; index + 2 < records.length; index += 3) {
    commits.push({ sha: records[index], title: records[index + 1], body: records[index + 2] });
  }
  const byNumber = new Map();
  for (let offset = 0; offset < commits.length; offset += 6) {
    await Promise.all(commits.slice(offset, offset + 6).map(async (item) => {
      for (const pull of await api.pages(`/commits/${item.sha}/pulls`)) {
        if (!pull.merged_at || pull.base?.repo?.full_name !== repository) continue;
        if (!byNumber.has(pull.number)) byNumber.set(pull.number, {
          number: pull.number, user: pull.user?.login, title: pull.title,
          body: pull.body, labels: pull.labels.map(({ name }) => name), commits: new Set(),
        });
        byNumber.get(pull.number).commits.add(item.sha);
      }
    }));
  }
  return formatNotes({ commits, pulls: [...byNumber.values()], nativeNotes,
    previousTag: previous?.tag, commit: source, tag });
}

function required(...names) {
  for (const name of names)
    if (!env[name]?.trim()) throw new Error(`Configure ${name} in the designated GitHub release environment.`);
}

async function outputs(values) {
  if (env.GITHUB_OUTPUT)
    await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function defaultBranch() {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== `refs/heads/${event.repository.default_branch}`)
    throw new Error('Production release operations require manaplatform/Aria’s default branch.');
  return event;
}

async function prepare(mode) {
  if (!['preview', 'verify', 'publish'].includes(mode)) throw new Error('Select preview, verify, or publish.');
  if (mode === 'publish') {
    const event = defaultBranch();
    if (env.GITHUB_EVENT_NAME === 'push') {
      if (!sourcePattern.test(event.before) || /^0+$/.test(event.before))
        throw new Error('The previous default branch commit is unavailable. Use manual release dispatch.');
      if (manifest(event.before) === manifest(commit())) {
        await outputs({ run: false });
        console.log('The application version is unchanged.');
        return;
      }
    }
  }
  const version = versionAtHead();
  if (mode === 'publish') {
    const existing = findRelease(await readReleaseState(github()), version, commit());
    if (existing.alreadyPublished) {
      await outputs({ run: false });
      console.log(`Already published as ${existing.alreadyPublished}.`);
      return;
    }
    if (env.ARIA_RELEASE_ENABLED !== 'true' ||
        env.ARIA_DISTRIBUTION_AUTHORIZED !== 'true')
      throw new Error('Enable production releasing and confirm distribution terms in the repository variables.');
  }
  await outputs({ run: true, version, mode });
  console.log(`Aria ${version} (${channelFor(version)}) at ${commit()} in ${mode} mode.`);
}

async function preview(notesOnly = false) {
  const api = github();
  const source = commit();
  const version = await localVersion();
  const state = await readReleaseState(api);
  const match = findRelease(state, version, source);
  const tag = match.tag ?? match.alreadyPublished ?? dateTag(new Date(), state.tags);
  if (!notesOnly) console.log([
    releaseTitle(version, tag), `Version: ${version}`, `Tag: ${tag}`, `Source: ${source}`,
    `Channel: ${channelFor(version)}`, 'Expected assets:',
    ...buildInventory(version).map(({ filename }) => `  ${filename}`),
    ...allTargets().map(({ platform, arch }) => `  ${feedName(platform, arch)}`),
    ...['Aria.cdx.json', 'Aria-Windows-Signing.cer', manifestName, signatureName, sumsName].map((name) => `  ${name}`),
    '',
  ].join('\n'));
  console.log(await notes(api, state, source, match.tag ?? match.alreadyPublished));
}

export async function verifyBuilds(input, output, production) {
  const version = versionAtHead();
  const source = commit();
  const directories = await readdir(input);
  const targets = allTargets();
  if (directories.length !== targets.length) throw new Error('One or more required platform build receipts are missing.');
  await mkdir(output, { recursive: true });
  const components = new Map();
  const timestamps = [];
  for (const { platform, arch } of targets) {
    const directory = path.join(input, `aria-${platform}-${arch}`);
    const receipt = await readJson(path.join(directory, 'receipt.json'));
    if (receipt.version !== version || receipt.commit !== source || receipt.platform !== platform ||
        receipt.arch !== arch || !Number.isFinite(Date.parse(receipt.timestamp)) ||
        production && !receipt.production) throw new Error(`Invalid build receipt for ${platform}-${arch}.`);
    timestamps.push(receipt.timestamp);
    const files = platformAssets(version, platform, arch).map(({ filename }) => filename);
    if (production && platform === 'windows') files.push('Aria-Windows-Signing.cer');
    for (const filename of files) {
      const actual = await inspectFile(directory, filename);
      if (actual.sha256 !== receipt.files[filename]?.sha256 || actual.size !== receipt.files[filename]?.size)
        throw new Error(`Build receipt digest mismatch for ${filename}.`);
      if (filename.endsWith('.cer') && arch === 'arm64') {
        if (actual.sha256 !== (await inspectFile(output, filename)).sha256)
          throw new Error('Windows jobs used different signing certificates.');
      } else await copyFile(path.join(directory, filename), path.join(output, filename));
    }
    for (const component of receipt.components)
      components.set(component['bom-ref'], component);
  }
  for (const { platform, arch } of targets) {
    const { filename } = platformAssets(version, platform, arch).find((asset) => asset.inAppUpdate);
    const { size, sha512 } = await inspectFile(output, filename);
    // JSON is a valid YAML document and avoids executable YAML tags or anchors.
    await writeFile(path.join(output, feedName(platform, arch)),
      JSON.stringify({ version, files: [{ url: filename, sha512, size }] }, null, 2) + '\n');
  }
  await writeFile(path.join(output, 'Aria.cdx.json'), JSON.stringify({
    bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: { component: { type: 'application', name: 'Aria', version } },
    components: [...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
  }, null, 2) + '\n');
  await outputs({ timestamp: timestamps.sort().at(-1) });
}

function trustKeys() {
  required('ARIA_UPDATE_PRIVATE_KEY', 'ARIA_UPDATE_PUBLIC_KEYS');
  const key = createPrivateKey({ key: Buffer.from(env.ARIA_UPDATE_PRIVATE_KEY, 'base64'), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
  if (key.asymmetricKeyType !== 'ed25519' || !env.ARIA_UPDATE_PUBLIC_KEYS.split(',').includes(publicKey))
    throw new Error('The release manifest signing key does not match the bundled Ed25519 trust keys.');
  return key;
}

export async function reserveTag(api, state, version, source, now = new Date()) {
  const existing = findRelease(state, version, source);
  if (existing.tag) return existing.tag;
  for (let attempt = 0; attempt < 4; attempt++) {
    const tag = dateTag(now, state.tags);
    const annotated = await api.json('/git/tags', { method: 'POST', body: {
      tag, message: tagAnnotation(version, source), object: source, type: 'commit',
      tagger: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com', date: now.toISOString() },
    } });
    try {
      await api.json('/git/refs', { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: annotated.sha } });
      return tag;
    } catch (error) {
      state = await readReleaseState(api);
      const match = findRelease(state, version, source);
      if (match.tag) return match.tag;
      if (!(error instanceof GitHubError) || error.status !== 422 || !state.tags.has(tag))
        throw error;
    }
  }
  throw new Error('Could not reserve a release tag after multiple remote tag collisions.');
}

async function verifiedAsset(api, remote, file) {
  return remote.state === 'uploaded' && remote.size === file.size &&
    await api.assetDigest(remote) === file.sha256;
}

export async function uploadAssets(api, draft, directory, expected) {
  const route = `/releases/${draft.id}/assets`;
  const assets = new Map((await api.pages(route)).map((asset) => [asset.name, asset]));
  for (const name of assets.keys())
    if (!expected.has(name)) throw new Error(`Unexpected asset ${name} on the draft. Review it before retrying.`);
  for (const [name, file] of expected) {
    const remote = assets.get(name);
    if (remote && await verifiedAsset(api, remote, file)) continue;
    if (remote) await api.json(`/releases/assets/${remote.id}`, { method: 'DELETE' });
    try {
      const type = name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
      await api.upload(draft.id, name, type, file.size, path.join(directory, name));
    } catch (error) {
      const uploaded = (await api.pages(route)).find((asset) => asset.name === name);
      if (!uploaded || !await verifiedAsset(api, uploaded, file)) throw error;
    }
  }
  const verified = await api.pages(route);
  if (verified.length !== expected.size || new Set(verified.map(({ name }) => name)).size !== expected.size)
    throw new Error('The uploaded draft has the wrong asset inventory.');
  for (const remote of verified) {
    const file = expected.get(remote.name);
    if (!file || !await verifiedAsset(api, remote, file)) throw new Error(`Release asset verification failed for ${remote.name}.`);
  }
}

async function publish(directory, buildTimestamp) {
  defaultBranch();
  required('GH_TOKEN');
  if (env.ARIA_RELEASE_ENABLED !== 'true' || env.ARIA_DISTRIBUTION_AUTHORIZED !== 'true')
    throw new Error('The repository has not enabled and authorized production releases.');
  const key = trustKeys();
  if (!buildTimestamp || !Number.isFinite(Date.parse(buildTimestamp))) throw new Error('Build timestamp is missing.');
  const version = versionAtHead();
  const source = commit();
  const api = github();
  let state = await readReleaseState(api);
  let existing = findRelease(state, version, source);
  if (existing.alreadyPublished) return console.log(`Already published as ${existing.alreadyPublished}.`);
  const tag = await reserveTag(api, state, version, source);
  state = await readReleaseState(api);
  existing = findRelease(state, version, source);
  if (existing.alreadyPublished) return console.log(`Already published as ${existing.alreadyPublished}.`);
  if (existing.tag !== tag) throw new Error('The remote tag no longer matches the reserved source.');

  const previous = previousRelease(state, source);
  const native = await api.json('/releases/generate-notes', { method: 'POST', body: {
    tag_name: tag, target_commitish: source, ...(previous ? { previous_tag_name: previous.tag } : {}),
    configuration_file_path: '.github/release.yml',
  } });
  const title = releaseTitle(version, tag);
  const body = `${releaseNoteMarker(version, source)}\n\n${await notes(api, state, source, tag, native.body)}`;
  const beta = channelFor(version) === 'beta';
  const release = await createManifest(directory, { version, tag, commit: source, buildTimestamp });
  const manifestBytes = Buffer.from(JSON.stringify(release, null, 2) + '\n');
  await writeFile(path.join(directory, manifestName), manifestBytes);
  await writeFile(path.join(directory, signatureName), sign(null, manifestBytes, key).toString('base64') + '\n');
  const expected = new Map(release.assets.map((asset) => [asset.filename, asset]));
  for (const name of [manifestName, signatureName]) expected.set(name, await inspectFile(directory, name));
  await writeFile(path.join(directory, sumsName), [...expected].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { sha256 }]) => `${sha256}  ${name}\n`).join(''));
  expected.set(sumsName, await inspectFile(directory, sumsName));

  let draft = existing.draft;
  if (!draft) {
    try {
      draft = await api.json('/releases', { method: 'POST', body: {
        tag_name: tag, target_commitish: source, name: title, body, draft: true, prerelease: beta,
      } });
    } catch (error) {
      draft = findRelease(await readReleaseState(api), version, source).draft;
      if (!draft) throw error;
    }
  }
  await uploadAssets(api, draft, directory, expected);
  const confirmed = findRelease(await readReleaseState(api), version, source);
  if (confirmed.draft?.id !== draft.id || confirmed.tag !== tag)
    throw new Error('The release draft or tag changed during verification.');
  const result = await publishDraft(api, draft.id, { tag, beta, name: title, body });
  console.log(`Published ${result.html_url}`);
}

export async function publishDraft(api, id, { tag, beta, name, body }) {
  let result;
  try {
    result = await api.json(`/releases/${id}`, { method: 'PATCH', body: {
      draft: false, prerelease: beta, make_latest: beta ? 'false' : 'true', name, body,
    } });
  } catch (error) {
    result = await api.json(`/releases/${id}`);
    if (result.draft || result.tag_name !== tag) throw error;
  }
  if (result.draft || result.tag_name !== tag || result.prerelease !== beta)
    throw new Error('GitHub did not confirm publication of the expected release.');
  return result;
}

async function main(command, args) {
  switch (command) {
    case 'check': {
      const version = await localVersion();
      console.log(`Aria ${version} (${channelFor(version)}), ${buildInventory(version).length} required packages.`);
      break;
    }
    case 'preview': await preview(); break;
    case 'notes': await preview(true); break;
    case 'prepare': await prepare(args[0]); break;
    case 'verify-builds': await verifyBuilds(args[0], args[1], args[2] === 'publish'); break;
    case 'publish': await publish(args[0], args[1]); break;
    case 'create':
      if (args.length === 1 && args[0] === '--dry-run') await preview();
      else if (!args.length) execFileSync('gh', ['workflow', 'run', 'release.yml', '--repo', repository, '--ref', 'main', '-f', 'mode=publish'], { stdio: 'inherit' });
      else throw new Error('Use release:create or release:create --dry-run.');
      break;
    default: throw new Error('Unknown release command.');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv[2], process.argv.slice(3)).catch((error) => {
    console.error(`Aria release: ${error.message}`);
    process.exitCode = 1;
  });
