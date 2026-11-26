import { createHash } from 'node:crypto';
import type { GithubArguments, GithubOperation, GithubRepository } from '@aria/shared';
import { GithubClient, GithubError, filePath, sanitizeGithubText, segment } from './client';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown) => typeof value === 'string' ? value : '';
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const cap = (value: string, length = 1400) => sanitizeGithubText(value).slice(0, length);
const fields = ['id', 'number', 'title', 'name', 'path', 'filename', 'sha', 'status', 'state', 'conclusion',
  'tag_name', 'default_branch', 'draft', 'prerelease', 'created_at', 'updated_at', 'published_at',
  'run_attempt', 'workflow_id', 'check_run_id', 'head_branch', 'head_sha', 'event', 'additions',
  'deletions', 'changes', 'size', 'content_type', 'total_commits', 'ahead_by', 'behind_by', 'merged'] as const;

function summary(value: unknown) {
  const row = object(value);
  const result: ObjectValue = {};
  for (const key of fields) {
    const field = row[key];
    if (typeof field === 'string') result[key] = cap(field, 350);
    if (typeof field === 'number' || typeof field === 'boolean') result[key] = field;
  }
  for (const key of ['body', 'description', 'patch'] as const) {
    if (typeof row[key] === 'string') result[key] = cap(row[key]);
  }
  if (typeof object(row.user).login === 'string') result.author = cap(str(object(row.user).login), 100);
  if (typeof object(row.commit).message === 'string') result.message = cap(str(object(row.commit).message), 350);
  if (typeof object(row.commit).sha === 'string') result.commitSha = cap(str(object(row.commit).sha), 64);
  if (typeof object(row.head).sha === 'string') result.headSha = cap(str(object(row.head).sha), 64);
  if (typeof object(row.base).ref === 'string') result.base = cap(str(object(row.base).ref), 220);
  if (typeof object(row.head).ref === 'string') result.head = cap(str(object(row.head).ref), 220);
  if (Array.isArray(row.labels)) result.labels = row.labels.slice(0, 25).map((item) => cap(str(object(item).name), 50));
  if (Array.isArray(row.assets)) result.assets = row.assets.slice(0, 30).map(summary);
  return result;
}

const invalid = (message: string) => new GithubError('INVALID_REFERENCE', message, 'STALE_TARGET');
const fail = () => new GithubError('INVALID_TOOL_OUTPUT', 'GitHub returned incomplete operation data.', 'INVALID_PROVIDER_OUTPUT');
export function decodeGithubFile(input: unknown) {
  const value = object(input);
  const encoded = str(value.content).replace(/\s/g, '');
  if (value.type === 'symlink' || value.type === 'submodule' || value.submodule_git_url ||
      value.encoding !== 'base64' || typeof value.content !== 'string' || !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded))
    throw new GithubError('INVALID_REFERENCE', 'This GitHub path has no supported text representation.', 'UNSUPPORTED_FILE');
  const bytes = Buffer.from(encoded, 'base64');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
    throw new GithubError('INVALID_REFERENCE', 'The selected file is binary or uses an unsupported encoding.', 'UNSUPPORTED_FILE');
  }
  if (text.includes('\u0000')) throw new GithubError('INVALID_REFERENCE', 'The selected file is binary.', 'UNSUPPORTED_FILE');
  return sanitizeGithubText(text);
}
type Projected = {
  value?: unknown; text?: string; suffix?: string; nextPage?: number; nextOffset?: number;
  partial?: boolean; verified?: boolean; observation?: string; asset?: { bytes: Buffer; name: string };
};
type Method = 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function operateGithub<K extends GithubOperation>(
  client: GithubClient, token: string, repository: GithubRepository, operation: K,
  parsed: GithubArguments<K>, signal: AbortSignal, onWrite?: { dispatch(): void; accepted(): void },
): Promise<Projected> {
  const args = parsed as ObjectValue;
  const key = (name: string) => str(args[name]);
  const id = (name: string) => number(args[name]) ?? 0;
  const [owner, name] = repository.name.split('/');
  const base = '/repos/' + segment(owner) + '/' + segment(name);
  const get = (route: string, params?: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined) query.set(key, String(value));
    return client.json(token, base + route + (query.size ? '?' + query.toString() : ''), signal);
  };
  const read = async (route: string, params?: Record<string, string | number | undefined>) => object((await get(route, params)).value);
  const write = async (route: string, method: Method, body?: object) =>
    (await client.json(token, base + route, signal, { method, body, onDispatch: onWrite?.dispatch, onAccepted: onWrite?.accepted })).value;
  const page = id('page') || 1;
  const paging = { page, per_page: 15 };
  const list = async (route: string, options: Record<string, string | number | undefined> = {}, collection?: string) => {
    const result = await get(route, { ...paging, ...options });
    const items = collection ? object(result.value)[collection] : result.value;
    if (!Array.isArray(items)) throw fail();
    return { value: items.slice(0, 15).map(summary), ...(result.next && page < 100 && { nextPage: page + 1 }),
      ...(result.next && page === 100 && { partial: true }) };
  };
  const confirmRef = async (type: 'heads' | 'tags', ref: string, expected: string) => {
    const resolved = object((await read('/git/ref/' + type + '/' + filePath(ref))).object);
    let current = str(resolved.sha);
    let kind = str(resolved.type);
    for (let depth = 0; kind === 'tag' && depth < 3; depth++) {
      const tag = object((await read('/git/tags/' + segment(current))).object);
      current = str(tag.sha);
      kind = str(tag.type);
    }
    if (kind !== 'commit' || current.toLowerCase() !== expected.toLowerCase())
      throw invalid('The GitHub ref moved. Read the current revision and review the operation again.');
  };
  const compareSha = (current: unknown, expected: string) => {
    if (str(current).toLowerCase() !== expected.toLowerCase()) throw invalid('The GitHub revision changed. Read it again.');
  };
  const portion = (text: string, offset: number) => {
    const content = cap(text.slice(offset, offset + 7000), 8000);
    return { text: content, ...(text.length > offset + 7000 && { nextOffset: offset + 7000, partial: true }) };
  };
  const fromFile = (value: ObjectValue, offset = 0) => ({ value: summary(value), ...portion(decodeGithubFile(value), offset) });
  const search = async (collection: 'code' | 'issues', kind?: 'issue' | 'pr') => {
    // Treat the user’s query as text. Append the only repository qualifier here.
    const terms = key('query').replace(/[^\p{L}\p{N}\s_.-]/gu, ' ').trim().replace(/\s+/g, ' ');
    if (!terms) throw new GithubError('INVALID_ARGUMENT', 'Provide search text.', 'INVALID_QUERY');
    const query = new URLSearchParams({
      q: '"' + terms + '" repo:' + repository.name + (kind ? ' is:' + kind : ''),
      per_page: '15', page: String(page),
    });
    const result = await client.json(token, '/search/' + collection + '?' + query.toString(), signal);
    const data = object(result.value);
    if (!Array.isArray(data.items)) throw fail();
    const expected = '/repos/' + repository.name.toLowerCase();
    const items = data.items.filter((value) => {
      const item = object(value);
      if (collection === 'code') return number(object(item.repository).id) === repository.id;
      try {
        const url = new URL(str(item.repository_url));
        return url.origin === 'https://api.github.com' && url.pathname.toLowerCase() === expected;
      } catch { return false; }
    });
    return { value: items.map(summary), ...(result.next && page < 67 && { nextPage: page + 1 }),
      partial: data.incomplete_results === true || data.items.length !== items.length || result.next && page >= 67 };
  };
  const issue = '/issues/' + id('number');
  const pull = '/pulls/' + id('number');
  const run = '/actions/runs/' + id('runId');
  const release = '/releases/' + id('releaseId');
  const workflow = '/actions/workflows/' + id('workflowId');
  const payload = { ...args };
  delete payload.repository;
  const mutationResult = async (route: string, method: 'POST' | 'PATCH', body: object, suffix?: string) => {
    const value = object(await write(route, method, body));
    return { value: summary(value), suffix, verified: Boolean(number(value.id) || str(value.name)) };
  };
  const post = (route: string, body: object, suffix?: string) => mutationResult(route, 'POST', body, suffix);
  const patch = (route: string, body: object, suffix?: string) => mutationResult(route, 'PATCH', body, suffix);

  switch (operation) {
    case 'github.get_repository': {
      const data = await read('');
      if (number(data.id) !== repository.id) throw invalid('The repository identity changed. Refresh repository access.');
      return { value: summary(data) };
    }
    case 'github.get_tree': {
      const selected = key('path');
      const result = await get('/contents' + (selected ? '/' + filePath(selected) : ''), { ref: key('ref') || undefined });
      if (!Array.isArray(result.value)) throw invalid('The path is not a directory.');
      const offset = id('offset');
      const next = offset + 30;
      return { value: result.value.slice(offset, next).map(summary), nextOffset: result.value.length > next ? next : undefined,
        partial: result.value.length > next || result.value.length >= 1000 };
    }
    case 'github.get_readme':
    case 'github.read_file': {
      const selected = operation === 'github.get_readme' ? '/readme' : '/contents/' + filePath(key('path'));
      const value = await read(selected, { ref: key('ref') || undefined });
      return { ...fromFile(value, id('offset')), suffix: '/blob/' + segment(key('ref') || repository.defaultBranch) + '/' + filePath(str(value.path)) };
    }
    case 'github.search_code': return search('code');
    case 'github.list_branches': return list('/branches');
    case 'github.list_commits': return list('/commits', { sha: key('ref') || undefined, path: key('path') || undefined });
    case 'github.compare_commits': {
      const route = '/compare/' + segment(key('base')) + '...' + segment(key('head'));
      const result = await get(route, paging);
      const data = object(result.value);
      return { value: { ...summary(data), commits: array(data.commits).slice(0, 15).map(summary),
        files: array(data.files).slice(0, 15).map(summary) }, nextPage: result.next && page < 100 ? page + 1 : undefined,
        partial: array(data.files).length > 15, suffix: route };
    }
    case 'github.list_issues': {
      const result = await get('/issues', { ...paging, state: key('state') || 'open' });
      if (!Array.isArray(result.value)) throw fail();
      return { value: result.value.filter((item) => !object(item).pull_request).map(summary),
        nextPage: result.next && page < 100 ? page + 1 : undefined };
    }
    case 'github.search_issues': return search('issues', 'issue');
    case 'github.get_issue': {
      const data = await read(issue);
      if (data.pull_request) throw invalid('Use the pull request operation for this number.');
      return { value: summary(data), suffix: issue };
    }
    case 'github.list_issue_comments': return { ...await list(issue + '/comments'), suffix: issue };
    case 'github.create_issue': {
      const data = object(await write('/issues', 'POST', payload));
      if (!number(data.number)) return { verified: false };
      return { value: summary(data), suffix: '/issues/' + data.number };
    }
    case 'github.update_issue': {
      await read(issue).then((data) => { if (data.pull_request) throw invalid('This number is a pull request.'); });
      const update = { ...payload };
      delete update.number;
      if (!Object.keys(update).length) throw invalid('Provide an issue update.');
      return patch(issue, update, issue);
    }
    case 'github.add_issue_comment': return post(issue + '/comments', { body: args.body }, issue);
    case 'github.list_labels': return list('/labels');
    case 'github.create_label': return post('/labels', payload);
    case 'github.update_label': return patch('/labels/' + segment(key('name')), {
      new_name: args.newName, color: args.color, description: args.description,
    });
    case 'github.add_issue_labels': {
      const labels = array(await write(issue + '/labels', 'POST', { labels: args.labels })).map(summary);
      return { value: labels, suffix: issue, verified: array(args.labels).every((label) =>
        labels.some((candidate) => str(candidate.name).toLowerCase() === str(label).toLowerCase())) };
    }
    case 'github.remove_issue_label': {
      const remaining = await write(issue + '/labels/' + segment(key('label')), 'DELETE');
      return { value: array(remaining).map(summary), suffix: issue,
        verified: Array.isArray(remaining) && !remaining.some((item) => object(item).name === args.label) };
    }
    case 'github.list_pull_requests': return list('/pulls', { state: key('state') || 'open' });
    case 'github.search_pull_requests': return search('issues', 'pr');
    case 'github.get_pull_request': return { value: summary(await read(pull)), suffix: '/pull/' + id('number') };
    case 'github.list_pull_request_files': return { ...await list(pull + '/files'), suffix: '/pull/' + id('number') + '/files' };
    case 'github.list_review_comments': return { ...await list(pull + '/comments'), suffix: '/pull/' + id('number') };
    case 'github.create_pull_request': {
      await read('/git/ref/heads/' + filePath(key('base')));
      await read('/git/ref/heads/' + filePath(key('head')));
      const data = object(await write('/pulls', 'POST', payload));
      return { value: summary(data), verified: Boolean(number(data.number)), suffix: '/pull/' + (number(data.number) ?? '') };
    }
    case 'github.review_pull_request': {
      compareSha(object((await read(pull)).head).sha, key('headSha'));
      return post(pull + '/reviews', { commit_id: args.headSha, event: args.event, body: args.body }, '/pull/' + id('number'));
    }
    case 'github.merge_pull_request': {
      compareSha(object((await read(pull)).head).sha, key('headSha'));
      const data = object(await write(pull + '/merge', 'PUT', { sha: args.headSha, merge_method: args.method }));
      return { value: summary(data), verified: data.merged === true, suffix: '/pull/' + id('number') };
    }
    case 'github.list_workflows': return list('/actions/workflows', {}, 'workflows');
    case 'github.list_workflow_runs': {
      const results = await list((id('workflowId') ? workflow : '/actions') + '/runs', { status: key('status') || undefined }, 'workflow_runs');
      if (page !== 1 || id('workflowId') || key('status') !== 'failure') return results;
      const latest = results.value.find((run) => number(run.id) && run.conclusion === 'failure');
      return { ...results, observation: latest ? String(latest.id) + '/' + (number(latest.run_attempt) ?? 0) : 'none' };
    }
    case 'github.get_workflow_run': return { value: summary(await read(run)), suffix: run };
    case 'github.list_workflow_jobs': return { ...await list(run + '/jobs', {}, 'jobs'), suffix: run };
    case 'github.read_workflow_logs': {
      const job = await read('/actions/jobs/' + id('jobId'));
      if (number(job.run_id) !== id('runId')) throw invalid('The job does not belong to this workflow run.');
      const bytes = await client.download(token, '/repos/' + segment(owner) + '/' + segment(name) +
        '/actions/jobs/' + id('jobId') + '/logs', 2_000_000, signal);
      return { ...portion(bytes.toString('utf8'), id('offset')), suffix: run + '/job/' + id('jobId') };
    }
    case 'github.dispatch_workflow': {
      const info = await read(workflow);
      if (info.state !== 'active') throw invalid('This workflow is not active.');
      const requested = key('ref').replace(/^refs\/(heads|tags)\//, '');
      const tag = key('ref').startsWith('refs/tags/');
      await confirmRef(tag ? 'tags' : 'heads', requested, key('expectedHead'));
      const result = object(await write(workflow + '/dispatches', 'POST', { ref: requested, inputs: args.inputs }));
      const runId = number(result.workflow_run_id) ?? number(result.id);
      if (!runId) return { verified: false, suffix: '/actions' };
      return { value: summary(await read('/actions/runs/' + runId)), suffix: '/actions/runs/' + runId };
    }
    case 'github.cancel_workflow_run':
    case 'github.rerun_workflow': {
      const before = await read(run);
      const cancelling = operation === 'github.cancel_workflow_run';
      await write(run + (cancelling ? '/cancel' : '/rerun'), 'POST');
      const after = await read(run);
      return { value: summary(after), suffix: run, verified: cancelling ?
        after.status === 'completed' && after.conclusion === 'cancelled' :
        Number(after.run_attempt ?? 0) > Number(before.run_attempt ?? 0) };
    }
    case 'github.list_releases': {
      const results = await list('/releases');
      if (page !== 1) return results;
      const latest = results.value.find((release) => number(release.id) && release.draft === false && str(release.published_at));
      return { ...results, observation: latest ? String(latest.id) + '/0' : 'none' };
    }
    case 'github.get_release': return { value: summary(await read(release)), suffix: '/releases' };
    case 'github.list_tags': return list('/tags');
    case 'github.create_release': {
      await confirmRef('tags', key('tag'), key('tagSha'));
      return post('/releases', { tag_name: args.tag, name: args.name, body: args.body,
        draft: args.publish !== true, prerelease: args.prerelease }, '/releases/tag/' + segment(key('tag')));
    }
    case 'github.update_release': {
      const before = await read(release);
      if (args.publish === true) {
        const tag = str(before.tag_name);
        const expected = key('tagSha');
        if (!expected || !tag) throw invalid('Supply the verified tag commit SHA before publishing.');
        await confirmRef('tags', tag, expected);
      }
      return patch(release, { name: args.name, body: args.body, draft: args.publish === true ? false : undefined,
        prerelease: args.prerelease }, '/releases/tag/' + segment(str(before.tag_name)));
    }
    case 'github.get_release_asset': {
      const data = await read(release);
      const asset = array(data.assets).map(object).find((item) => item.id === id('assetId'));
      if (!asset) throw invalid('The asset does not belong to this release.');
      const limit = 20_000_000;
      if (!number(asset.size) || Number(asset.size) > limit) throw invalid('This asset is empty or exceeds the download limit.');
      const bytes = await client.download(token, base + '/releases/assets/' + id('assetId'), limit, signal);
      const digest = str(asset.digest);
      if (bytes.length !== asset.size || digest && digest !== 'sha256:' + createHash('sha256').update(bytes).digest('hex'))
        throw new GithubError('INVALID_TOOL_OUTPUT', 'The downloaded asset differs from the release metadata.', 'ASSET_VERIFICATION');
      return { value: summary(asset), suffix: '/releases/tag/' + segment(str(data.tag_name)),
        asset: { bytes, name: cap(str(asset.name), 160) } };
    }
    case 'github.create_branch': {
      compareSha((await read('/commits/' + segment(key('from')))).sha, key('from'));
      const result = object(await write('/git/refs', 'POST', { ref: 'refs/heads/' + key('branch'), sha: key('from') }));
      return { value: { ref: cap(str(result.ref), 240), sha: cap(str(object(result.object).sha), 64) },
        verified: result.ref === 'refs/heads/' + key('branch') && object(result.object).sha === args.from,
        suffix: '/tree/' + segment(key('branch')) };
    }
    case 'github.commit_files': {
      const input = parsed as GithubArguments<'github.commit_files'>;
      await confirmRef('heads', input.branch, input.expectedHead);
      const names = new Set<string>();
      for (const file of input.files) {
        const identity = file.path.toLowerCase();
        if (names.has(identity) || file.path.split('/').some((item) => item.toLowerCase() === '.git')) throw invalid('File paths must be unique repository paths.');
        names.add(identity);
        if (identity.startsWith('.github/workflows/') && repository.permissions.workflows !== 'write')
          throw new GithubError('PERMISSION_DENIED', 'The GitHub App needs Workflows write permission for this file.', 'PROVIDER_PERMISSION');
        const existing = await read('/contents/' + filePath(file.path), { ref: input.expectedHead })
          .catch((error: unknown) => { if (error instanceof GithubError && error.category === 'NOT_FOUND') return null; throw error; });
        if (existing && (existing.type !== 'file' || existing.submodule_git_url) ||
            (existing?.sha ?? null) !== file.previousSha) throw invalid('A file changed or is not a regular file. Read its current revision.');
      }
      const result = await client.json(token, '/graphql', signal, {
        method: 'POST', onDispatch: onWrite?.dispatch, onAccepted: onWrite?.accepted,
        body: { query: 'mutation Commit($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
          variables: { input: { branch: { repositoryNameWithOwner: repository.name, refName: 'refs/heads/' + input.branch },
            expectedHeadOid: input.expectedHead, message: { headline: input.message },
            fileChanges: { additions: input.files.map((file) => ({ path: file.path, contents: Buffer.from(file.text).toString('base64') })) } } } },
      });
      const oid = str(object(object(object(object(result.value).data).createCommitOnBranch).commit).oid);
      if (!/^[\da-f]{40}$/i.test(oid)) throw new GithubError('OUTCOME_UNCERTAIN', 'GitHub did not return the new commit. Inspect the branch before attempting another write.', 'COMMIT_UNVERIFIED');
      return { value: { sha: oid }, suffix: '/commit/' + oid };
    }
    default: throw new GithubError('INVALID_ARGUMENT', 'This GitHub operation is unavailable.', 'INVALID_OPERATION');
  }
}
