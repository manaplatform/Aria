import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import semver from 'semver';
import {
  applicationVersion, marker, repository, sourcePattern, tagPattern,
} from './generate-metadata.mjs';

export class GitHubError extends Error {
  constructor(status, operation) {
    super(`GitHub returned HTTP ${status} for ${operation}.`);
    this.status = status;
  }
}

export function localToken() {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
    return process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim(); } catch { return ''; }
}

export function github(token = localToken(), request = fetch) {
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  async function send(url, options = {}) {
    const result = await request(url, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: AbortSignal.timeout(options.timeout ?? 90_000),
    });
    if (!result.ok) {
      const error = new GitHubError(result.status, new URL(url).pathname);
      await result.body?.cancel();
      throw error;
    }
    return result;
  }
  async function json(route, options = {}) {
    const { body, method = 'GET' } = options;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await send(`${base}${route}`, {
          method, ...(body ? {
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
          } : {}),
        });
        return result.status === 204 ? null : await result.json();
      } catch (error) {
        if (method !== 'GET' || attempt === 2 ||
            error instanceof GitHubError && ![429, 500, 502, 503, 504].includes(error.status))
          throw error;
        await setTimeout(1000 * (attempt + 1));
      }
    }
  }
  async function pages(route) {
    const result = [];
    const delimiter = route.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const items = await json(`${route}${delimiter}per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error('Unexpected GitHub list response.');
      result.push(...items);
      if (items.length < 100) return result;
    }
  }
  async function upload(id, filename, type, size, file) {
    return (await send(`https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(filename)}`, {
      method: 'POST', duplex: 'half', timeout: 15 * 60_000,
      headers: { 'content-type': type, 'content-length': String(size) }, body: createReadStream(file),
    })).json();
  }
  async function assetDigest(asset) {
    if (/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) return asset.digest.slice(7);
    const response = await send(`${base}/releases/assets/${asset.id}`, {
      headers: { accept: 'application/octet-stream' }, timeout: 15 * 60_000,
    });
    if (response.headers.get('content-type')?.includes('json') && asset.content_type !== 'application/json') {
      await response.body?.cancel();
      throw new Error(`GitHub did not return the uploaded bytes for ${asset.name}.`);
    }
    const hash = createHash('sha256');
    for await (const bytes of response.body) hash.update(bytes);
    return hash.digest('hex');
  }
  return { json, pages, upload, assetDigest };
}

export function tagAnnotation(version, commit) {
  return `${marker}\nversion=${version}\ncommit=${commit}\n`;
}

export function releaseNoteMarker(version, commit) {
  return `<!-- ${marker}\nversion=${version}\ncommit=${commit}\n-->`;
}

function annotation(text, objectSha) {
  const [header, versionLine, commitLine] = text.trim().split('\n');
  const version = versionLine?.slice('version='.length);
  const commit = commitLine?.slice('commit='.length);
  if (header !== marker) return undefined;
  if (!versionLine?.startsWith('version=') || !semver.valid(version) ||
      !commitLine?.startsWith('commit=') || !sourcePattern.test(commit) || commit !== objectSha)
    throw new Error('Found a malformed Aria release tag annotation.');
  return { version, commit };
}

export async function readReleaseState(api) {
  const [refs, releases] = await Promise.all([
    api.pages('/git/matching-refs/tags/v'),
    api.pages('/releases'),
  ]);
  const tags = new Set([
    ...refs.map((ref) => ref.ref.slice('refs/tags/'.length)),
    ...releases.map((release) => release.tag_name),
  ]);
  const reservations = [];
  const published = [];
  const resolve = async (tag) => {
    const ref = refs.find((item) => item.ref === `refs/tags/${tag}`) ??
      await api.json(`/git/ref/tags/${encodeURIComponent(tag)}`);
    let object = ref.object;
    const identity = object.type === 'tag' ? await api.json(`/git/tags/${object.sha}`) : null;
    if (identity) object = identity.object;
    for (let depth = 0; object.type === 'tag' && depth < 8; depth++)
      object = (await api.json(`/git/tags/${object.sha}`)).object;
    if (object.type !== 'commit' || !sourcePattern.test(object.sha))
      throw new Error(`Release tag ${tag} does not resolve to an app source commit.`);
    return { commit: object.sha, managed: identity ? annotation(identity.message, object.sha) : undefined };
  };

  const candidates = new Set([
    ...refs.map((ref) => ref.ref.slice(10)).filter((tag) => tagPattern.test(tag)),
    ...releases.filter((release) => !release.draft).map((release) => release.tag_name),
  ]);
  const identities = new Map();
  const pending = [...candidates];
  while (pending.length) {
    const batch = pending.splice(0, 8);
    await Promise.all(batch.map(async (tag) => identities.set(tag, await resolve(tag))));
  }
  for (const [tag, identity] of identities) {
    if (identity.managed) reservations.push({ tag, ...identity.managed });
  }
  for (const release of releases.filter((item) => !item.draft)) {
    const { commit, managed } = identities.get(release.tag_name);
    let version = managed?.version;
    if (!version) {
      const asset = await api.json(`/contents/package.json?ref=${commit}`);
      version = applicationVersion(JSON.parse(Buffer.from(asset.content, 'base64').toString('utf8')));
    }
    published.push({ release, tag: release.tag_name, commit, version });
  }
  const tagCommits = new Map([...identities].map(([tag, { commit }]) => [tag, commit]));
  return { tags, releases, reservations, published, tagCommits };
}

export function findRelease(state, version, commit) {
  const published = state.published.filter((release) => semver.eq(release.version, version));
  if (published.length) {
    if (published.length === 1 && published[0].version === version && published[0].commit === commit)
      return { alreadyPublished: published[0].tag };
    throw new Error(`Application version ${version} is already published on a different release.`);
  }
  const channelPeers = state.published.filter(({ version: other }) =>
    Boolean(semver.prerelease(other)) === Boolean(semver.prerelease(version)));
  if (channelPeers.some(({ version: other }) => semver.gt(other, version)))
    throw new Error(`Application version ${version} is older than a published version in its channel.`);
  const reserved = state.reservations.filter((item) => semver.eq(item.version, version));
  if (reserved.length > 1 || reserved.some((item) => item.commit !== commit || item.version !== version))
    throw new Error(`Application version ${version} is reserved by a different source. Retry the original workflow or choose a new version.`);
  const reservedTag = reserved[0]?.tag;
  const drafts = state.releases.filter((item) => item.draft &&
    (item.tag_name === reservedTag || item.body?.startsWith(releaseNoteMarker(version, commit))));
  if (drafts.length > 1 || drafts.some((item) =>
    !item.body?.startsWith(releaseNoteMarker(version, commit)) ||
    (reservedTag ? item.tag_name !== reservedTag :
      !tagPattern.test(item.tag_name) || state.tagCommits?.get(item.tag_name) !== commit)))
    throw new Error(`A conflicting draft exists for application version ${version}.`);
  return { tag: reservedTag ?? drafts[0]?.tag_name, draft: drafts[0] };
}
