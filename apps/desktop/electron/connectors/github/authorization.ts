import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { boundedBytes, GithubError } from './client';

export const githubConfig = z.strictObject({
  origin: z.string().url().refine((value) => new URL(value).protocol === 'https:' && new URL(value).origin === value),
  clientId: z.string().regex(/^[A-Za-z0-9_]{8,120}$/),
  slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
});
export type GithubConfig = z.infer<typeof githubConfig>;
export const githubTokens = z.strictObject({
  accessToken: z.string().regex(/^ghu_[a-zA-Z0-9_]{12,251}$/),
  refreshToken: z.string().regex(/^ghr_[a-zA-Z0-9_]{12,251}$/),
  expiresIn: z.number().int().min(1).max(86_400),
  refreshExpiresIn: z.number().int().min(1).max(32_000_000),
});
export const savedTokens = githubTokens.pick({ accessToken: true, refreshToken: true }).extend({
  expiresAt: z.number().int().positive(), refreshExpiresAt: z.number().int().positive(),
});
export type SavedTokens = z.infer<typeof savedTokens>;

const randomProof = () => randomBytes(32).toString('base64url');
const status = z.strictObject({ status: z.enum(['pending', 'ready', 'denied']) });

export class GithubAuthorization {
  constructor(readonly config: GithubConfig, private readonly request: typeof fetch = fetch) {}
  get registration() { return [this.config.origin, this.config.clientId, this.config.slug].join('|'); }
  get installUrl() { return 'https://github.com/apps/' + this.config.slug + '/installations/new'; }

  private async send<T>(action: string, args: object, result: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const endpoint = this.config.origin + '/v1/github/' + action;
    let response: Response | undefined;
    try {
      response = await this.request(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(args),
      });
      if (response.status === 410) throw new GithubError('PERMISSION_DENIED', 'GitHub authorization expired. Start a new connection.', 'AUTH_EXPIRED');
      if (!response.ok) throw new GithubError('EXECUTION_FAILED',
        action === 'revoke' ? 'GitHub revocation could not be verified.' : 'The Aria Connect broker is temporarily unavailable.',
        action === 'revoke' ? 'REVOCATION_UNVERIFIED' : 'BROKER_UNAVAILABLE');
      return result.parse(JSON.parse((await boundedBytes(response.body, 8192)).toString('utf8')));
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      signal.throwIfAborted();
      if (error instanceof GithubError) throw error;
      throw new GithubError('EXECUTION_FAILED', 'The Aria Connect broker is temporarily unavailable.', 'BROKER_UNAVAILABLE');
    }
  }

  private pair(pair: z.infer<typeof githubTokens>): SavedTokens {
    return {
      accessToken: pair.accessToken, refreshToken: pair.refreshToken,
      expiresAt: Date.now() + pair.expiresIn * 1000, refreshExpiresAt: Date.now() + pair.refreshExpiresIn * 1000,
    };
  }

  async authorize(open: (url: string) => Promise<void>, signal: AbortSignal) {
    const proof = { state: randomProof(), secret: randomProof() };
    const verifier = randomProof();
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
    const expected = this.config.origin + '/v1/github/callback';
    const start = z.strictObject({ callback: z.literal(expected), expiresIn: z.number().int().min(1).max(600) });
    try {
      await this.send('start', { ...proof, challenge }, start, attempt);
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: this.config.clientId, redirect_uri: expected, state: proof.state,
        code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
      }).toString();
      attempt.throwIfAborted();
      await open(url.href);
      for (;;) {
        await delay(2000, undefined, { signal: attempt });
        const reply = await this.send('status', proof, status, attempt);
        if (reply.status === 'pending') continue;
        if (reply.status === 'denied')
          throw new GithubError('PERMISSION_DENIED', 'GitHub authorization was declined.', 'AUTH_DENIED');
        return this.pair(await this.send('complete', { ...proof, verifier }, githubTokens, attempt));
      }
    } catch (error) {
      if (!signal.aborted && attempt.aborted)
        throw new GithubError('TIMEOUT', 'GitHub sign-in timed out. Start a new connection.', 'AUTH_TIMEOUT');
      throw error;
    } finally {
      void this.send('cancel', proof, z.object({ status: z.literal('cancelled') }), AbortSignal.timeout(4000)).catch(() => {});
    }
  }

  async refresh(refreshToken: string, signal: AbortSignal) {
    return this.pair(await this.send('refresh', { refreshToken }, githubTokens, signal));
  }
  async revoke(accessToken: string, signal: AbortSignal) {
    await this.send('revoke', { accessToken }, z.strictObject({ revoked: z.literal(true) }), signal);
  }
}
