import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, writeFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allTargets, applicationVersion, buildInventory, channelFor, createManifest, dateTag, feedName,
  inspectFile, manifestName, platformAssets, readJson, releaseTitle, repository, sbomName, signatureName,
  sourcePattern, sumsName, tagPattern, validatePackageVersion, windowsCertificateName,
} from './generate-metadata.mjs';
import { formatNotes } from './generate-notes.mjs';
import { findRelease, github, GitHubError, readReleaseState, releaseNoteMarker, tagAnnotation } from './github.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const env = process.env;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 24 * 1024 ** 2 });
const sourcePackage = (source) => JSON.parse(git('show', `${source}:package.json`));
const versionAt = (source) => applicationVersion(sourcePackage(source));
const commit = () => git('rev-parse', 'HEAD').trim();
const releaseVersion = (source) => validatePackageVersion(versionAt(source));
const localVersion = async () => validatePackageVersion(applicationVersion(await readJson(path.join(root, 'package.json'))));

function isAncestor(source, target) {
  try {
    git('merge-base', '--is-ancestor', source, target);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function releaseSource(source) {
  if (!sourcePattern.test(source) || !isAncestor(source, commit()))
    throw new Error('The selected release source must be in the default-branch workflow history.');
  return source;
}

function previousRelease(state, target, channel) {
  const result = state.published.filter((item) => item.commit !== target && item.release.assets.length > 0 &&
    (channel === 'beta' || channelFor(item.version) === 'stable'))
    .sort((a, b) => Date.parse(b.release.published_at) - Date.parse(a.release.published_at));
  return result.find((item) => {
    try {
      return isAncestor(item.commit, target);
    } catch (error) {
      throw new Error(`Cannot read release ancestry for ${item.tag}. Fetch full history and tags.`);
    }
  });
}

function sourceLicense(source) {
  const { license } = sourcePackage(source);
  const declaration = typeof license === 'string' ? license.trim() : '';
  const prefix = 'SEE LICENSE IN ';
  const referenced = declaration.startsWith(prefix) ? declaration.slice(prefix.length).trim() : '';
  const tracked = git('ls-tree', '-r', '--name-only', '-z', source).split('\0');
  return {
    declaration,
    files: tracked.filter((file) => (referenced && file === referenced) || /^(LICENSE|COPYING)(?:[._-][^/]+)?$/i.test(file)),
    notices: tracked.find((file) => file === 'THIRD_PARTY_NOTICES.md'),
  };
}

async function collectNotes(api, state, source, channel) {
  const previous = previousRelease(state, source, channel);
  const records = git('-c', 'log.showSignature=false', 'log', '-z', '--format=%H%x00%s%x00%b',
    previous ? `${previous.commit}..${source}` : source).split('\0');
  const commits = [];
  for (let index = 0; index + 2 < records.length; index += 3) {
    commits.push({ sha: records[index], title: records[index + 1], body: records[index + 2] });
  }
  const shas = new Set(commits.map(({ sha }) => sha));
  const byNumber = new Map();
  for (let offset = 0; offset < commits.length; offset += 6) {
    await Promise.all(commits.slice(offset, offset + 6).map(async (item) => {
      for (const pull of await api.pages(`/commits/${item.sha}/pulls`)) {
        if (!pull.merged_at || pull.base?.repo?.full_name !== repository || !shas.has(pull.merge_commit_sha)) continue;
        if (!byNumber.has(pull.number)) byNumber.set(pull.number, {
          number: pull.number, user: pull.user?.login, title: pull.title,
          body: pull.body, labels: pull.labels.map(({ name }) => name), commits: new Set(),
        });
        byNumber.get(pull.number).commits.add(item.sha);
      }
    }));
  }
  return { commits, pulls: [...byNumber.values()], previousTag: previous?.tag, license: sourceLicense(source) };
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
  if (env.GITHUB_SHA !== commit()) throw new Error('The checked-out source does not match the release workflow commit.');
  return event;
}

const draftRequestMarker = (runId, tag) => `<!-- Aria release request run ${runId} tag ${tag} -->`;
const claimedReleaseMarker = (version, source, runId, tag) =>
  `${releaseNoteMarker(version, source)}\n\n${draftRequestMarker(runId, tag)}\n\n`;

function emptyReleaseRequest(release) {
  return !release.body?.trim() && release.assets.length === 0 &&
    (release.draft || release.immutable === false && (!release.name?.trim() || release.name === release.tag_name));
}

function withoutRelease(state, id) {
  return {
    ...state,
    releases: state.releases.filter((item) => item.id !== id),
    published: state.published.filter(({ release }) => release.id !== id),
  };
}

function publicPlaceholder(state, request, source) {
  return request?.id && tagPattern.test(request.tag) && state.tagCommits.get(request.tag) === source &&
    state.releases.find((release) => release.id === request.id && release.tag_name === request.tag &&
      !release.draft && emptyReleaseRequest(release));
}

export async function claimDraftRequest(api, { versionFor, runId, target }, state) {
  if (!/^\d+$/.test(runId)) throw new Error('The release request requires a GitHub Actions run ID.');
  state ??= await readReleaseState(api);
  const candidates = state.releases.filter(({ id, tag_name: tag }) => target ? id === target.id :
    tagPattern.test(tag) && state.tagCommits.has(tag))
    .map((release) => ({
      release, resumed: release.draft && release.body?.includes(draftRequestMarker(runId, release.tag_name)),
    })).sort((a, b) => Number(!!b.resumed) - Number(!!a.resumed) || a.release.id - b.release.id);
  for (const { release, resumed } of candidates) {
    const { id, tag_name: tag } = release;
    const source = state.tagCommits.get(tag);
    if (target && (tag !== target.tag || source !== target.source))
      throw new Error('The published release tag or commit changed before it could be claimed.');
    if (!resumed && (!emptyReleaseRequest(release) || (target && release.draft))) continue;
    let version, existing;
    try {
      version = versionFor(source);
      if (!version && target) throw new Error('The published release must point to a commit in the default-branch history.');
      if (!version) continue;
      existing = findRelease(resumed ? state : withoutRelease(state, id), version, source);
    } catch (error) {
      if (resumed || target) throw error;
      console.log(`Skipping release request ${tag}. ${error.message}`);
      continue;
    }
    if (existing.alreadyPublished || (existing.tag && existing.tag !== tag)) continue;
    const marker = claimedReleaseMarker(version, source, runId, tag);
    if (resumed) {
      if (existing.draft?.id !== id || !release.body.startsWith(marker))
        throw new Error('The claimed release draft or its tag changed. Check the draft and retry.');
    } else if (release.draft) {
      const current = await api.json(`/releases/${id}`);
      if (current.id !== id || current.tag_name !== tag || !current.draft || !emptyReleaseRequest(current))
        throw new Error('The release draft changed before it could be claimed.');
      const body = `${marker}Aria Release Creator is preparing this draft. [Follow the build](https://github.com/${repository}/actions/runs/${runId}).`;
      const confirmation = await api.json(`/releases/${id}`, { method: 'PATCH', body: {
        body, name: releaseTitle(version),
      } });
      if (confirmation.id !== id || !confirmation.draft || confirmation.tag_name !== tag || confirmation.body !== body)
        throw new Error('GitHub did not confirm the release draft request.');
    }
    return { id, source, tag };
  }
}

function dispatchedRelease(event) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || !event.inputs?.release_request) return;
  const { id, tag, source } = JSON.parse(event.inputs.release_request) ?? {};
  if (event.inputs.mode !== 'publish' || !Number.isSafeInteger(id) || id <= 0 ||
      typeof tag !== 'string' || !tagPattern.test(tag) || typeof source !== 'string' || !sourcePattern.test(source))
    throw new Error('A published release request requires its GitHub release ID, calendar tag, and source commit.');
  return { id, tag, source };
}

function selectedRelease(event) {
  const id = Number(env.RELEASE_DRAFT_ID || 0);
  const tag = env.RELEASE_DRAFT_TAG;
  const source = env.RELEASE_SOURCE || commit();
  const target = dispatchedRelease(event);
  if (target && (id !== target.id || tag !== target.tag || source !== target.source))
    throw new Error('Publication requires the same release ID, tag, and commit selected by the release event.');
  if (env.GITHUB_EVENT_NAME === 'schedule' && (!Number.isSafeInteger(id) || id <= 0 || !tagPattern.test(tag)))
    throw new Error('Scheduled publication requires a claimed GitHub release and its tag.');
  return { id, tag, source };
}

async function claimDraft() {
  const event = defaultBranch();
  const target = dispatchedRelease(event);
  if (!target && !['push', 'schedule'].includes(env.GITHUB_EVENT_NAME))
    throw new Error('Release requests require a default-branch push, scheduled run, or published release event.');
  required('GH_TOKEN');
  if (env.ARIA_RELEASE_ENABLED !== 'true' || env.ARIA_DISTRIBUTION_AUTHORIZED !== 'true')
    throw new Error('The repository has not enabled and authorized production releases.');
  const workflowCommit = commit();
  const scanAncestors = Boolean(target) || env.GITHUB_EVENT_NAME === 'schedule' || (sourcePattern.test(event.before) &&
    !/^0+$/.test(event.before) && versionAt(event.before) === versionAt(workflowCommit));
  const selected = await claimDraftRequest(github(), {
    versionFor: (source) => source === workflowCommit || (scanAncestors && isAncestor(source, workflowCommit))
      ? releaseVersion(source) : undefined,
    runId: env.GITHUB_RUN_ID, target,
  });
  if (selected) await outputs(selected);
}

function reportPublished(state, tag, version) {
  const { release } = state.published.find((item) => item.tag === tag);
  if (!release.assets.length)
    throw new Error(`Published release ${tag} already occupies Aria ${version} and has no assets. Use a new version in root package.json.`);
  console.log(`Already published as ${tag}.`);
}

async function prepare(mode) {
  if (!['preview', 'verify', 'publish'].includes(mode)) throw new Error('Select preview, verify, or publish.');
  let request;
  if (mode === 'publish') {
    const event = defaultBranch();
    request = selectedRelease(event);
    if (env.GITHUB_EVENT_NAME === 'push' && !request.id) {
      if (!sourcePattern.test(event.before) || /^0+$/.test(event.before))
        throw new Error('The previous default branch commit is unavailable. Use manual release dispatch.');
      if (versionAt(event.before) === versionAt(commit())) {
        if (!git('diff', '--name-only', event.before, commit(), '--',
          '.github/workflows/release.yml', '.github/workflows/release-build.yml', 'scripts/release',
          'apps/desktop/electron/update-feed.ts').trim()) {
          await outputs({ run: false });
          console.log('The application version and release automation are unchanged.');
          return;
        }
        mode = 'verify';
        console.log('The release automation changed. Running native package verification.');
      }
    }
  }
  const source = releaseSource(request?.source ?? (env.RELEASE_SOURCE || commit()));
  const version = releaseVersion(source);
  if (mode === 'publish') {
    const state = await readReleaseState(github());
    if (request.id && state.tagCommits.get(request.tag) !== source)
      throw new Error('The selected release tag no longer points to the build commit.');
    const placeholder = publicPlaceholder(state, request, source);
    const existing = findRelease(placeholder ? withoutRelease(state, placeholder.id) : state, version, source);
    if (existing.alreadyPublished) {
      reportPublished(state, existing.alreadyPublished, version);
      await outputs({ run: false });
      return;
    }
    if (env.ARIA_RELEASE_ENABLED !== 'true' ||
        env.ARIA_DISTRIBUTION_AUTHORIZED !== 'true')
      throw new Error('Enable production releasing and confirm distribution terms in the repository variables.');
  }
  await outputs({ run: true, mode, source });
  console.log(`Aria ${version} (${channelFor(version)}) at ${source} in ${mode} mode.`);
}

async function preview(notesOnly = false) {
  const api = github();
  const source = commit();
  const version = await localVersion();
  const state = await readReleaseState(api);
  const match = findRelease(state, version, source);
  const existingTag = match.tag ?? match.alreadyPublished;
  const tag = tagPattern.test(existingTag) ? existingTag : dateTag(new Date(), state.tags);
  const channel = channelFor(version);
  if (!notesOnly) console.log([
    releaseTitle(version), `Version: ${version}`, `Tag: ${tag}`, `Source: ${source}`,
    `Channel: ${channel}`, ...(match.alreadyPublished ? [`Version already published as ${match.alreadyPublished}.`] : []),
    'Expected assets:',
    ...buildInventory(version).map(({ filename }) => `  ${filename}`),
    ...allTargets().map(({ platform, arch }) => `  ${feedName(platform, arch)}`),
    ...[sbomName, windowsCertificateName, manifestName, signatureName, sumsName].map((name) => `  ${name}`),
    '',
  ].join('\n'));
  const notes = await collectNotes(api, state, source, channel);
  console.log(formatNotes({ ...notes, commit: source, tag, version, channel, compareTarget: source }));
}

export async function verifyBuilds(input, output, production, source = commit()) {
  const version = releaseVersion(source);
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
    if (platform === 'macos' && (receipt.signing !== 'ad-hoc' || receipt.notarized !== false))
      throw new Error(`Missing ad hoc signing verification for macOS ${arch}.`);
    timestamps.push(receipt.timestamp);
    const files = platformAssets(version, platform, arch).map(({ filename }) => filename);
    if (production && platform === 'windows') files.push(windowsCertificateName);
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
  await writeFile(path.join(output, sbomName), JSON.stringify({
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

export async function reserveTag(api, state, version, source, stage, now = new Date()) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const existing = findRelease(state, version, source);
    if (existing.alreadyPublished) return existing;
    const tag = existing.tag ?? dateTag(now, state.tags);
    const staged = await stage(tag);
    if (existing.tag) return { tag, staged };
    const annotated = await api.json('/git/tags', { method: 'POST', body: {
      tag, message: tagAnnotation(version, source), object: source, type: 'commit',
      tagger: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com', date: now.toISOString() },
    } });
    try {
      await api.json('/git/refs', { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: annotated.sha } });
      return { tag, staged };
    } catch (error) {
      state = await readReleaseState(api);
      const match = findRelease(state, version, source);
      if (match.alreadyPublished) return match;
      if (match.tag === tag) return { tag, staged };
      if (!match.tag && (!(error instanceof GitHubError) || error.status !== 422 || !state.tags.has(tag)))
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
  return verified;
}

async function stageRelease(directory, identity, key) {
  const release = await createManifest(directory, identity);
  const manifestBytes = Buffer.from(JSON.stringify(release, null, 2) + '\n');
  await writeFile(path.join(directory, manifestName), manifestBytes);
  await writeFile(path.join(directory, signatureName), sign(null, manifestBytes, key).toString('base64') + '\n');
  const expected = new Map(release.assets.map((asset) => [asset.filename, asset]));
  for (const name of [manifestName, signatureName]) expected.set(name, await inspectFile(directory, name));
  await writeFile(path.join(directory, sumsName), [...expected].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { sha256 }]) => `${sha256}  ${name}\n`).join(''));
  expected.set(sumsName, await inspectFile(directory, sumsName));
  return { release, expected };
}

export async function publishRelease(api, directory, buildTimestamp, key, now = new Date(), request) {
  if (!buildTimestamp || !Number.isFinite(Date.parse(buildTimestamp))) throw new Error('Build timestamp is missing.');
  const source = releaseSource(request?.source ?? commit());
  const version = releaseVersion(source);
  let state = await readReleaseState(api);
  if (!request?.id && request?.runId) {
    const claimed = await claimDraftRequest(api, {
      runId: request.runId, versionFor: (tagCommit) => tagCommit === source ? version : undefined,
    }, state);
    if (claimed) {
      request = { ...request, ...claimed };
      state = await readReleaseState(api);
    }
  }
  const placeholder = publicPlaceholder(state, request, source);
  const eligible = placeholder ? withoutRelease(state, placeholder.id) : state;
  const match = findRelease(eligible, version, source);
  const requestMarker = request?.id ? draftRequestMarker(request.runId, request.tag) : undefined;
  if (placeholder && (match.alreadyPublished || (match.tag && match.tag !== request.tag)))
    throw new Error('Another release already occupies the selected version.');
  if (request?.id && !placeholder && (match.alreadyPublished ? match.alreadyPublished !== request.tag :
    match.tag !== request.tag || match.draft?.id !== request.id ||
    !match.draft.body.startsWith(claimedReleaseMarker(version, source, request.runId, request.tag))))
    throw new Error('The claimed release draft or its tag changed. Check the draft and retry.');
  const stage = (tag) => stageRelease(directory, { version, tag, commit: source, buildTimestamp }, key);
  const reservation = placeholder ? { tag: request.tag, staged: await stage(request.tag) } :
    await reserveTag(api, state, version, source, stage, now);
  if (placeholder) {
    state = await readReleaseState(api);
    const current = publicPlaceholder(state, request, source);
    if (!current) throw new Error('The public release request changed before it could be prepared.');
    const existing = findRelease(withoutRelease(state, current.id), version, source);
    if (existing.alreadyPublished || (existing.tag && existing.tag !== request.tag))
      throw new Error('Another release already occupies the selected version.');
    const body = `${claimedReleaseMarker(version, source, request.runId, request.tag)}Preparing verified release assets.`;
    const updated = await api.json(`/releases/${current.id}`, { method: 'PATCH', body: {
      draft: true, name: releaseTitle(version), body,
    } });
    if (updated.id !== current.id || !updated.draft || updated.tag_name !== request.tag || updated.body !== body)
      throw new Error('GitHub did not convert the public placeholder to the expected draft.');
  }
  state = await readReleaseState(api);
  const existing = findRelease(state, version, source);
  if (existing.alreadyPublished) {
    if (request?.id && existing.alreadyPublished !== request.tag)
      throw new Error('The claimed version was published using a different tag.');
    reportPublished(state, existing.alreadyPublished, version);
    return;
  }
  const { tag, staged } = reservation;
  if (!tag || existing.tag !== tag || (request?.id &&
      (existing.draft?.id !== request.id ||
       !existing.draft.body.startsWith(claimedReleaseMarker(version, source, request.runId, tag)))))
    throw new Error('The remote tag or draft no longer matches the selected source.');
  const { release, expected } = staged;
  const { channel, assets } = release;
  const beta = channel === 'beta';
  const name = releaseTitle(version);
  const notes = await collectNotes(api, state, source, channel);
  const render = (verified) => [
    releaseNoteMarker(version, source), requestMarker, formatNotes({
      ...notes, version, tag, commit: source, channel, buildTimestamp, assets, verified,
    }),
  ].filter(Boolean).join('\n\n');

  let draft = existing.draft;
  if (!draft) {
    try {
      draft = await api.json('/releases', { method: 'POST', body: {
        tag_name: tag, target_commitish: source, name, body: render(), draft: true, prerelease: beta,
      } });
    } catch (error) {
      draft = findRelease(await readReleaseState(api), version, source).draft;
      if (!draft) throw error;
    }
  }
  if (!draft.draft || draft.tag_name !== tag || !draft.body?.startsWith(releaseNoteMarker(version, source)))
    throw new Error('GitHub did not confirm creation of the expected draft.');
  const verified = await uploadAssets(api, draft, directory, expected);
  const confirmed = findRelease(await readReleaseState(api), version, source);
  if (confirmed.draft?.id !== draft.id || confirmed.tag !== tag || confirmed.draft.body !== draft.body)
    throw new Error('The release draft or tag changed during verification.');
  return publishDraft(api, draft.id, { tag, beta, name, body: render(verified) });
}

async function publish(directory, buildTimestamp) {
  const request = selectedRelease(defaultBranch());
  required('GH_TOKEN');
  if (env.ARIA_RELEASE_ENABLED !== 'true' || env.ARIA_DISTRIBUTION_AUTHORIZED !== 'true')
    throw new Error('The repository has not enabled and authorized production releases.');
  const result = await publishRelease(github(), directory, buildTimestamp, trustKeys(), new Date(), {
    ...request, runId: env.GITHUB_RUN_ID,
  });
  if (result) console.log(`Published ${result.html_url}`);
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
  if (result.id !== id || result.draft || result.tag_name !== tag || result.prerelease !== beta ||
      result.name !== name || result.body !== body)
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
    case 'claim-draft': await claimDraft(); break;
    case 'prepare': await prepare(args[0]); break;
    case 'verify-builds':
      await verifyBuilds(args[0], args[1], args[2] === 'publish', releaseSource(env.RELEASE_SOURCE || commit()));
      break;
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
