import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { DeviceCode } from '@aria/shared';
import { boundedBytes, GithubError } from './client';
import { githubRegistration, type GithubConfig } from './config';

const deviceEndpoint = 'https://github.com/login/device/code';
const tokenEndpoint = 'https://github.com/login/oauth/access_token';
export const githubVerificationUrl = 'https://github.com/login/device';
const deviceGrant = 'urn:ietf:params:oauth:grant-type:device_code';
const session = z.object({
  device_code: z.string().regex(/^[a-zA-Z0-9_-]{40}$/),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verification_uri: z.literal(githubVerificationUrl),
  expires_in: z.number().int().min(1).max(900),
  interval: z.number().int().min(1).max(900),
});
const responseTokens = z.object({
  access_token: z.string().regex(/^ghu_[a-zA-Z0-9_]{12,251}$/),
  refresh_token: z.string().regex(/^ghr_[a-zA-Z0-9_]{12,251}$/),
  expires_in: z.number().int().min(1).max(86_400),
  refresh_token_expires_in: z.number().int().min(1).max(32_000_000),
  token_type: z.literal('bearer'),
});
export const savedTokens = z.strictObject({
  flow: z.literal('device'),
  accessToken: responseTokens.shape.access_token,
  refreshToken: responseTokens.shape.refresh_token,
  expiresAt: z.number().int().positive(),
  refreshExpiresAt: z.number().int().positive(),
});
export type SavedTokens = z.infer<typeof savedTokens>;

const providerError = z.object({
  error: z.string().max(80),
  interval: z.number().int().min(1).max(86_400).optional(),
});
const expired = () => new GithubError('TIMEOUT', 'The GitHub verification code expired. Start again from Settings.', 'AUTH_TIMEOUT');
const temporary = () => new GithubError('EXECUTION_FAILED', 'GitHub is temporarily unreachable. Check your connection and try again.', 'AUTH_NETWORK');
const invalid = () => new GithubError('INVALID_TOOL_OUTPUT', 'GitHub returned an invalid authorization response.', 'AUTH_RESPONSE');

const clock: { now(): number; wait(ms: number, signal: AbortSignal): Promise<void> } = {
  now: () => Date.now(),
  wait: (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }),
};

function retryAfter(value: string | null, now: number) {
  if (!value) return 60_000;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(1000, ms) : 60_000;
}

export class GithubAuthorization {
  constructor(
    readonly config: GithubConfig,
    private readonly request: typeof fetch = fetch,
    private readonly time = clock,
  ) {}
  get registration() { return githubRegistration(this.config); }
  get installUrl() { return 'https://github.com/apps/' + this.config.slug + '/installations/new'; }

  private async send(endpoint: typeof deviceEndpoint | typeof tokenEndpoint, args: Record<string, string>, signal: AbortSignal) {
    signal.throwIfAborted();
    let response: Response | undefined;
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      response = await this.request(endpoint, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: requestSignal,
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ client_id: this.config.clientId, ...args }),
      });
      requestSignal.throwIfAborted();
      if (response.status === 429 || response.status === 403 && response.headers.has('retry-after')) {
        const wait = retryAfter(response.headers.get('retry-after'), this.time.now());
        throw new GithubError('BUDGET_EXCEEDED', 'GitHub is rate limiting authorization. Try again after the retry window.', 'RATE_LIMIT', wait);
      }
      if (response.status >= 500) throw temporary();
      const bytes = await boundedBytes(response.body, 8192);
      requestSignal.throwIfAborted();
      let data: unknown;
      try { data = JSON.parse(bytes.toString('utf8')); } catch { throw invalid(); }
      const error = providerError.safeParse(data);
      if (error.success) return { error: error.data };
      if (!response.ok) throw invalid();
      return { data };
    } catch (error) {
      void response?.body?.cancel().catch(() => {});
      signal.throwIfAborted();
      if (error instanceof GithubError) throw error;
      throw temporary();
    }
  }

  private pair(data: unknown): SavedTokens {
    const parsed = responseTokens.safeParse(data);
    if (!parsed.success) throw invalid();
    const token = parsed.data;
    const now = this.time.now();
    return {
      flow: 'device', accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: now + token.expires_in * 1000, refreshExpiresAt: now + token.refresh_token_expires_in * 1000,
    };
  }

  private failure(code: string) {
    if (code === 'access_denied')
      return new GithubError('PERMISSION_DENIED', 'GitHub authorization was declined.', 'AUTH_DENIED');
    if (code === 'device_flow_disabled' || code === 'incorrect_client_credentials' || code === 'unsupported_grant_type')
      return new GithubError('CAPABILITY_UNAVAILABLE', 'GitHub could not authorize this build’s GitHub App. Contact Aria support.', 'AUTH_CONFIGURATION');
    return invalid();
  }

  async authorize(present: (code: DeviceCode) => Promise<void>, signal: AbortSignal) {
    const requestedAt = this.time.now();
    const initial = await this.send(deviceEndpoint, { scope: 'offline_access' }, signal);
    if (initial.error) throw this.failure(initial.error.error);
    const parsed = session.safeParse(initial.data);
    if (!parsed.success) throw invalid();
    const { device_code, user_code, expires_in, interval } = parsed.data;
    const expiresAt = requestedAt + expires_in * 1000;
    const remainingLifetime = expiresAt - this.time.now();
    if (remainingLifetime <= 0) throw expired();
    const lifetime = AbortSignal.timeout(remainingLifetime);
    const active = AbortSignal.any([signal, lifetime]);
    let minimum = interval * 1000;
    let wait = minimum;
    let networkFailures = 0;
    try {
      await present({ userCode: user_code, expiresAt });
      for (;;) {
        active.throwIfAborted();
        const remaining = expiresAt - this.time.now();
        if (remaining <= 0) throw expired();
        await this.time.wait(Math.min(remaining, wait), active);
        if (this.time.now() >= expiresAt) throw expired();
        const reply = await this.send(tokenEndpoint, { grant_type: deviceGrant, device_code }, active).catch((error: unknown) => {
          if (!(error instanceof GithubError) || !['AUTH_NETWORK', 'RATE_LIMIT'].includes(error.category)) throw error;
          networkFailures++;
          wait = Math.max(minimum, error.retryAfterMs ?? Math.min(60_000, minimum * 2 ** Math.min(networkFailures, 6)));
          return undefined;
        });
        if (!reply) continue;
        active.throwIfAborted();
        if (this.time.now() >= expiresAt) throw expired();
        if (!reply.error) return this.pair(reply.data);
        networkFailures = 0;
        switch (reply.error.error) {
          case 'authorization_pending':
            break;
          case 'slow_down':
            minimum = Math.max(minimum + 5000, (reply.error.interval ?? 0) * 1000);
            break;
          case 'expired_token':
          case 'token_expired':
          case 'incorrect_device_code':
            throw expired();
          default:
            throw this.failure(reply.error.error);
        }
        wait = minimum;
      }
    } catch (error) {
      signal.throwIfAborted();
      if (lifetime.aborted) throw expired();
      throw error;
    }
  }

  async refresh(credentials: SavedTokens, signal: AbortSignal) {
    if (credentials.flow !== 'device')
      throw new GithubError('PERMISSION_DENIED', 'Reconnect this account using GitHub Device Flow.', 'AUTH_EXPIRED');
    const reply = await this.send(tokenEndpoint, { grant_type: 'refresh_token', refresh_token: credentials.refreshToken }, signal);
    if (!reply.error) return this.pair(reply.data);
    if (['bad_refresh_token', 'invalid_grant', 'expired_token', 'token_expired', 'access_denied'].includes(reply.error.error))
      throw new GithubError('PERMISSION_DENIED', 'GitHub authorization expired or was revoked. Reconnect from Settings.', 'AUTH_EXPIRED');
    throw this.failure(reply.error.error);
  }
}
