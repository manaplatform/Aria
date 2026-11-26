import { setTimeout as delay } from 'node:timers/promises';
import { githubPermissions, githubPublicSearchInput, githubPublicSearchLimit, githubPublicSearchResult,
  githubRepository, type GithubRepository } from '@aria/shared';
import { z } from 'zod';
import { downloadPublicBytes } from '../../browser/http-fetch';
import { RuntimeError } from '../../runtime/store';

const origin = 'https://api.github.com';
export const githubApiVersion = '2026-03-10';
const githubSecret = /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g;
export const sanitizeGithubText = (value: string) => value.replace(githubSecret, '[redacted GitHub credential]');
export const segment = (value: string | number) => encodeURIComponent(String(value));
export const filePath = (value: string) => value.split('/').map(segment).join('/');

export class GithubError extends RuntimeError {
  constructor(
    code: ConstructorParameters<typeof RuntimeError>[0], message: string,
    readonly category: string, readonly retryAfterMs?: number,
  ) { super(code, message); }
}

export async function boundedBytes(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.length;
      if (bytes > limit) throw new GithubError('BUDGET_EXCEEDED', 'The GitHub response exceeds the download limit.', 'RESPONSE_LIMIT');
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type CacheEntry = { etag: string; value: unknown; next: boolean };
type RequestOptions = { method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; body?: object; readonlyGraphql?: boolean; fresh?: boolean; onDispatch?: () => void; onAccepted?: () => void };
const idSchema = z.number().int().positive().safe();
const userSchema = z.object({ id: idSchema, login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/), avatar_url: z.string().url().max(500).optional() });
const installationsSchema = z.object({
  installations: z.array(z.object({
    id: idSchema, app_slug: z.string(), suspended_at: z.string().nullable().optional(),
    permissions: z.record(z.string(), z.unknown()),
  })),
});
const repoSchema = z.object({
  id: idSchema, full_name: z.string(), private: z.boolean(), description: z.string().nullable().optional(),
  default_branch: z.string().max(220), permissions: z.object({ push: z.boolean(), admin: z.boolean().optional(), maintain: z.boolean().optional() }).optional(),
});
const repositoriesSchema = z.object({ repositories: z.array(repoSchema) });
const searchPage = z.object({ items: z.array(z.unknown()), incomplete_results: z.boolean() });
const searchItem = z.object({
  full_name: githubPublicSearchResult.shape.results.element.shape.name,
  private: z.literal(false), visibility: z.literal('public').optional(),
  description: z.string().nullable(), stargazers_count: z.number().int().nonnegative().safe(), language: z.string().nullable(),
});

function retryAfter(response: Response) {
  const retry = response.headers.get('retry-after');
  if (retry) {
    const value = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
    if (Number.isFinite(value)) return Math.max(0, value);
  }
  const reset = response.headers.get('x-ratelimit-reset');
  return reset && /^\d+$/.test(reset) ? Math.max(0, Number(reset) * 1000 - Date.now()) : 60_000;
}

export class GithubClient {
  private readonly cache = new Map<string, CacheEntry>();
  private tail = Promise.resolve();
  private limitedUntil = 0;
  private lastWrite = 0;

  constructor(private readonly request: typeof fetch = fetch) {}
  invalidate() { this.cache.clear(); }

  private async serial<T>(signal: AbortSignal, work: () => Promise<T>) {
    const previous = this.tail;
    const result = previous.then(() => {
      signal.throwIfAborted();
      return work();
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private async send(token: string, route: string, signal: AbortSignal, options: RequestOptions = {}, accept = 'application/vnd.github+json') {
    const target = new URL(origin + route);
    if (!route.startsWith('/') || target.origin !== origin || target.username || target.password)
      throw new GithubError('INVALID_ARGUMENT', 'The GitHub route is invalid.', 'INVALID_TARGET');
    const method = options.method ?? 'GET';
    const cached = method === 'GET' && !options.fresh ? this.cache.get(target.href) : undefined;
    const read = method === 'GET' || options.readonlyGraphql;
    return this.serial(signal, async () => {
      if (this.limitedUntil > Date.now())
        throw new GithubError('BUDGET_EXCEEDED', 'GitHub is rate limiting this account. Try again after the retry window.', 'RATE_LIMIT', this.limitedUntil - Date.now());
      if (!read) {
        const wait = Math.max(0, this.lastWrite + 1000 - Date.now());
        if (wait) await delay(wait, undefined, { signal });
        this.lastWrite = Date.now();
        this.invalidate();
      }
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        options.onDispatch?.();
        const result = await this.request(target, {
          method, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          headers: {
            accept, authorization: 'Bearer ' + token, 'user-agent': 'Aria-Connect',
            'x-github-api-version': githubApiVersion,
            ...(options.body && { 'content-type': 'application/json' }),
            ...(cached && accept === 'application/vnd.github+json' && { 'if-none-match': cached.etag }),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        }).catch(() => undefined);
        if (!result || result.status >= 500) {
          await result?.body?.cancel().catch(() => {});
          if (read && attempt === 0 && !signal.aborted) {
            await delay(250, undefined, { signal });
            continue;
          }
          signal.throwIfAborted();
          throw new GithubError(read ? 'EXECUTION_FAILED' : 'OUTCOME_UNCERTAIN',
            read ? 'GitHub did not return a usable response.' : 'GitHub did not confirm the write. Verify its outcome before retrying.',
            'PROVIDER_UNAVAILABLE');
        }
        let error: GithubError | undefined;
        if (result.status === 401) error = new GithubError('PERMISSION_DENIED', 'GitHub rejected this authorization.', 'AUTH_REJECTED');
        if (result.status === 403 && result.headers.has('x-github-sso'))
          error = new GithubError('PERMISSION_DENIED', 'Complete organization single sign-on and reconnect GitHub.', 'ORGANIZATION_SSO');
        if (result.status === 429 || result.status === 403 && (
          result.headers.get('x-ratelimit-remaining') === '0' || result.headers.has('retry-after')
        )) {
          const wait = retryAfter(result);
          this.limitedUntil = Date.now() + Math.max(1000, wait);
          error = new GithubError('BUDGET_EXCEEDED', 'GitHub is rate limiting this account. Try again after the retry window.', 'RATE_LIMIT', wait);
        }
        if (result.status === 403 && !error) {
          const message = (await boundedBytes(result.body, 16_384).catch(() => Buffer.alloc(0))).toString();
          if (/secondary rate limit|abuse detection/i.test(message)) {
            const wait = retryAfter(result);
            this.limitedUntil = Date.now() + Math.max(1000, wait);
            error = new GithubError('BUDGET_EXCEEDED', 'GitHub is rate limiting this account. Try again after the retry window.', 'RATE_LIMIT', wait);
          }
        }
        if (error) { await result.body?.cancel().catch(() => {}); throw error; }
        if (result.status === 304 && cached) return { result, cached };
        if (result.status >= 400) {
          await result.body?.cancel().catch(() => {});
          if (result.status === 404) throw new GithubError('INVALID_REFERENCE',
            'GitHub could not find this resource with the current permissions.', 'NOT_FOUND');
          if (result.status === 403) throw new GithubError('PERMISSION_DENIED',
            'GitHub denied this action. Check the repository, organization restrictions, and App permissions.', 'PROVIDER_PERMISSION');
          if (result.status === 409 || result.status === 422) throw new GithubError('INVALID_ARGUMENT',
            'GitHub rejected the current input or revision. Check the ref, branch rules, and provider permissions.', 'PROVIDER_VALIDATION');
          throw new GithubError('EXECUTION_FAILED', 'GitHub rejected this request.', 'PROVIDER_REJECTED');
        }
        if (result.ok) options.onAccepted?.();
        return { result };
      }
    });
  }

  async json(token: string, route: string, signal: AbortSignal, options?: RequestOptions) {
    const { result, cached } = await this.send(token, route, signal, options);
    if (cached) return { value: cached.value, next: cached.next };
    if (!result.ok) {
      await result.body?.cancel().catch(() => {});
      throw new GithubError('INVALID_REFERENCE', 'GitHub returned an unexpected redirect. Refresh repository access.', 'UNEXPECTED_REDIRECT');
    }
    const next = /rel="next"/.test(result.headers.get('link') ?? '');
    if (result.status === 204 || result.status === 202 && !result.body) return { value: null, next };
    const bytes = await boundedBytes(result.body, 2_200_000);
    if (!bytes.length) return { value: null, next };
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw new GithubError('INVALID_TOOL_OUTPUT', 'GitHub returned an unsupported response.', 'INVALID_PROVIDER_OUTPUT'); }
    const etag = result.headers.get('etag');
    if (!options?.method && !options?.fresh && etag && bytes.length <= 48_000 &&
        /^\/(?:user(?:\/installations.*)?$|repos\/[^/]+\/[^/]+(?:$|\/branches|\/actions\/workflows|\/git\/ref))/.test(route)) {
      if (this.cache.size >= 80) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(origin + route, { etag, value, next });
    }
    return { value, next };
  }

  async download(token: string, route: string, limit: number, signal: AbortSignal) {
    const { result } = await this.send(token, route, signal, {}, 'application/octet-stream');
    if (result.ok) return boundedBytes(result.body, limit);
    const target = result.headers.get('location');
    await result.body?.cancel().catch(() => {});
    if (result.status !== 302 || !target) throw new GithubError('EXECUTION_FAILED', 'GitHub did not provide a download.', 'DOWNLOAD_UNAVAILABLE');
    try {
      return await downloadPublicBytes(target, limit, signal);
    } catch {
      signal.throwIfAborted();
      throw new GithubError('EXECUTION_FAILED', 'The GitHub download could not be verified within its limits.', 'DOWNLOAD_UNAVAILABLE');
    }
  }

  async user(token: string, signal: AbortSignal) {
    const parsed = userSchema.safeParse((await this.json(token, '/user', signal)).value);
    if (!parsed.success) throw new GithubError('INVALID_TOOL_OUTPUT', 'GitHub did not return a verified account.', 'INVALID_PROVIDER_OUTPUT');
    let avatar: string | null = null;
    if (parsed.data.avatar_url) {
      const url = new URL(parsed.data.avatar_url);
      if (url.origin === 'https://avatars.githubusercontent.com' && !url.username && !url.password) avatar = url.origin + url.pathname;
    }
    return { id: parsed.data.id, login: parsed.data.login, avatar };
  }

  async searchPublicRepositories(token: string, input: z.infer<typeof githubPublicSearchInput>, signal: AbortSignal,
    onDispatch: () => void) {
    if (sanitizeGithubText(input.query) !== input.query)
      throw new GithubError('INVALID_ARGUMENT', 'Search with a repository name or keywords.', 'INVALID_QUERY');
    const page = input.page ?? 1;
    const terms = input.query.includes('/') ? 'repo:' + input.query : `"${input.query}" in:name,description`;
    const query = new URLSearchParams({ q: `${terms} is:public`, page: String(page), per_page: String(githubPublicSearchLimit) });
    const response = await this.json(token, '/search/repositories?' + query, signal, { onDispatch });
    const parsed = searchPage.safeParse(response.value);
    if (!parsed.success)
      throw new GithubError('INVALID_TOOL_OUTPUT', 'GitHub did not return repository search results.', 'INVALID_PROVIDER_OUTPUT');
    const results = parsed.data.items.slice(0, githubPublicSearchLimit).flatMap((entry) => {
      const item = searchItem.safeParse(entry);
      if (!item.success || sanitizeGithubText(item.data.full_name) !== item.data.full_name) return [];
      const { full_name, description, stargazers_count, language } = item.data;
      return [{ name: full_name, description: description && sanitizeGithubText(description).slice(0, 500),
        stars: stargazers_count, language: language && sanitizeGithubText(language).slice(0, 80) }];
    });
    const match = input.query.toLowerCase();
    const exact = (name: string) => Number(name.toLowerCase().split('/')[1] === match);
    results.sort((a, b) => exact(b.name) - exact(a.name));
    const hasNext = results.length === githubPublicSearchLimit && response.next;
    return githubPublicSearchResult.parse({ results, nextPage: hasNext && page < 100 ? page + 1 : undefined,
      partial: parsed.data.incomplete_results || hasNext && page === 100 });
  }

  async repositories(token: string, slug: string, signal: AbortSignal) {
    const repositories: GithubRepository[] = [];
    for (let page = 1; page <= 10; page++) {
      const result = await this.json(token, '/user/installations?per_page=100&page=' + page, signal);
      const installations = installationsSchema.parse(result.value).installations;
      for (const installation of installations) {
        if (installation.app_slug !== slug || installation.suspended_at) continue;
        const permissions = githubPermissions.parse(Object.fromEntries(Object.entries(installation.permissions)
          .filter(([name]) => githubPermissions.keyType.safeParse(name).success)));
        for (let repositoryPage = 1; repositoryPage <= 10; repositoryPage++) {
          const result = await this.json(token, '/user/installations/' + installation.id +
            '/repositories?per_page=100&page=' + repositoryPage, signal);
          for (const repository of repositoriesSchema.parse(result.value).repositories) {
            if (repositories.length >= 1000) break;
            repositories.push(githubRepository.parse({
              id: repository.id, installation: installation.id, name: repository.full_name, private: repository.private,
              description: repository.description ? sanitizeGithubText(repository.description).slice(0, 500) : null,
              defaultBranch: repository.default_branch, permissions,
              writeAccess: repository.permissions?.push === true || repository.permissions?.admin === true ||
                repository.permissions?.maintain === true,
            }));
          }
          if (!result.next || repositories.length >= 1000) break;
        }
        if (repositories.length >= 1000) break;
      }
      if (!result.next || repositories.length >= 1000) break;
    }
    return repositories;
  }
}
