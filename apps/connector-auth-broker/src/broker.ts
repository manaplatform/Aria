import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const attemptMs = 10 * 60_000;
const proofPattern = /^[A-Za-z0-9_-]{43}$/;
const prefix = '/v1/github/';
const security = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
};
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const proof = (value: unknown): value is string => typeof value === 'string' && proofPattern.test(value);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const credential = (value: unknown, start: string): value is string =>
  typeof value === 'string' && value.startsWith(start) && /^[a-zA-Z0-9_]{16,255}$/.test(value);

type Session = { challenge: string; secretHash: string; expires: number; code?: string; denied?: boolean };
const routes = ['start', 'callback', 'status', 'complete', 'cancel', 'refresh', 'revoke', 'done'] as const;
type Route = (typeof routes)[number] | 'other';
type BrokerOptions = {
  origin: string; clientId: string; clientSecret: string;
  request?: typeof fetch; now?: () => number; observe?: (route: Route, status: number, elapsedMs: number) => void;
};
type Body = Record<string, unknown>;
class Problem extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const respond = (res: ServerResponse, status: number, data: Body = {}) => {
  res.writeHead(status, { ...security, 'content-type': 'application/json' }).end(JSON.stringify(data));
};

async function json(req: IncomingMessage): Promise<Body> {
  if (req.headers['content-type'] !== 'application/json') throw new Problem(415, 'invalid_request');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const data of req) {
    const chunk = Buffer.from(data as Buffer);
    size += chunk.length;
    if (size > 4096) throw new Problem(413, 'invalid_request');
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Body;
  } catch { /* Invalid input is reported below. */ }
  throw new Problem(400, 'invalid_request');
}

export function createBroker(options: BrokerOptions) {
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.origin !== options.origin || origin.username ||
      !/^[A-Za-z0-9_]{8,120}$/.test(options.clientId) || !options.clientSecret)
    throw new Error('Configure a GitHub client and an exact HTTPS broker origin.');
  const callback = origin.origin + prefix + 'callback';
  const sessions = new Map<string, Session>();
  const buckets = new Map<string, { until: number; count: number }>();
  const now = options.now ?? Date.now;
  const request = options.request ?? fetch;

  function rate(key: string, maximum: number) {
    const current = buckets.get(key);
    if (current && current.until > now()) {
      if (++current.count > maximum) throw new Problem(429, 'rate_limited');
      return;
    }
    if (buckets.size >= 10_000) throw new Problem(429, 'rate_limited');
    buckets.set(key, { until: now() + 60_000, count: 1 });
  }

  async function githubToken(params: Record<string, string>) {
    let response: Response;
    try {
      response = await request('https://github.com/login/oauth/access_token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: options.clientId, client_secret: options.clientSecret, ...params }),
      });
    } catch {
      throw new Problem(502, 'provider_unavailable');
    }
    let data: Body;
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty response');
      let length = 0;
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 8192) throw new Error('response too large');
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      data = JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as Body;
    } catch { throw new Problem(502, 'provider_unavailable'); }
    if (!data || typeof data !== 'object') throw new Problem(502, 'provider_unavailable');
    if (data.error === 'bad_refresh_token' || data.error === 'bad_verification_code')
      throw new Problem(410, 'authorization_expired');
    if (response.status === 429) throw new Problem(429, 'rate_limited');
    if (!response.ok || data.error || !credential(data.access_token, 'ghu_') ||
        !credential(data.refresh_token, 'ghr_') || data.token_type !== 'bearer' ||
        typeof data.expires_in !== 'number' || !Number.isSafeInteger(data.expires_in) ||
        data.expires_in < 1 || data.expires_in > 86_400 ||
        typeof data.refresh_token_expires_in !== 'number' || !Number.isSafeInteger(data.refresh_token_expires_in) ||
        data.refresh_token_expires_in < 1 || data.refresh_token_expires_in > 32_000_000)
      throw new Problem(502, 'provider_unavailable');
    return {
      accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresIn: data.expires_in, refreshExpiresIn: data.refresh_token_expires_in,
    };
  }

  return createServer({ requestTimeout: 12_000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    const started = now();
    let category: Route = 'other';
    res.once('finish', () => options.observe?.(category, res.statusCode, Math.max(0, now() - started)));
    const handle = async () => {
      for (const [key, entry] of sessions) if (entry.expires <= now()) sessions.delete(key);
      for (const [key, entry] of buckets) if (entry.until <= now()) buckets.delete(key);
      const url = new URL(req.url ?? '/', origin);
      if (req.headers.host !== origin.host || url.origin !== origin.origin || (req.url ?? '').startsWith('//'))
        throw new Problem(400, 'invalid_request');
      if (req.method === 'GET' && url.pathname === '/health' && !url.search) {
        respond(res, 200, { status: 'ready' });
        return;
      }
      const route = url.pathname.slice(prefix.length);
      if (!url.pathname.startsWith(prefix)) throw new Problem(404, 'invalid_request');
      category = routes.find((item) => item === route) ?? 'other';
      // A configured ingress must replace forwarded addresses. The socket bucket remains the global ceiling.
      const peer = req.socket.remoteAddress ?? 'unknown';
      rate('global:' + peer, 2400);
      if (route === 'callback' && req.method === 'GET') {
        rate('callback:' + peer, 600);
        for (const name of url.searchParams.keys()) {
          if (!['state', 'code', 'error', 'error_description', 'error_uri'].includes(name) ||
              url.searchParams.getAll(name).length !== 1) throw new Problem(400, 'invalid_callback');
        }
        const state = url.searchParams.get('state');
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const session = proof(state) ? sessions.get(hash(state)) : undefined;
        if (!session || session.code || session.denied || Boolean(code) === Boolean(error) ||
            (code && !/^[a-zA-Z0-9_-]{1,256}$/.test(code))) throw new Problem(400, 'invalid_callback');
        if (code) session.code = code;
        else session.denied = true;
        res.writeHead(303, { ...security, location: prefix + 'done' }).end();
        return;
      }
      if (route === 'done' && req.method === 'GET' && !url.search) {
        res.writeHead(200, { ...security, 'content-type': 'text/html; charset=utf-8' })
          .end('<!doctype html><html lang="en"><title>Aria Connect</title><h1>Return to Aria</h1><p>Check Settings → Connectors to finish connecting GitHub.</p></html>');
        return;
      }
      if (req.method !== 'POST' || url.search || req.headers.origin) throw new Problem(400, 'invalid_request');
      const body = await json(req);
      if (route === 'refresh') {
        rate('refresh:' + peer, 240);
        if (!credential(body.refreshToken, 'ghr_')) throw new Problem(400, 'invalid_request');
        respond(res, 200, await githubToken({ grant_type: 'refresh_token', refresh_token: body.refreshToken }));
        return;
      }
      if (route === 'revoke') {
        rate('revoke:' + peer, 120);
        if (!credential(body.accessToken, 'ghu_')) throw new Problem(400, 'invalid_request');
        const basic = Buffer.from(options.clientId + ':' + options.clientSecret).toString('base64');
        const response = await request('https://api.github.com/applications/' + options.clientId + '/grant', {
          method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: {
            authorization: 'Basic ' + basic, accept: 'application/vnd.github+json',
            'content-type': 'application/json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Aria-Connect',
          },
          body: JSON.stringify({ access_token: body.accessToken }),
        }).catch(() => undefined);
        if (response?.status !== 204) throw new Problem(502, 'revocation_unverified');
        respond(res, 200, { revoked: true });
        return;
      }
      if (!proof(body.state) || !proof(body.secret)) throw new Problem(400, 'invalid_request');
      const key = hash(body.state);
      if (route === 'start') {
        rate('start:' + peer, 180);
        if (!proof(body.challenge) || sessions.has(key)) throw new Problem(400, 'invalid_request');
        if (sessions.size >= 2000) throw new Problem(429, 'rate_limited');
        sessions.set(key, { challenge: body.challenge, secretHash: hash(body.secret), expires: now() + attemptMs });
        respond(res, 201, { callback, expiresIn: attemptMs / 1000 });
        return;
      }
      const session = sessions.get(key);
      if (!session || !same(session.secretHash, hash(body.secret))) throw new Problem(410, 'session_expired');
      if (route === 'cancel') {
        sessions.delete(key);
        respond(res, 200, { status: 'cancelled' });
      } else if (route === 'status') {
        respond(res, 200, { status: session.denied ? 'denied' : session.code ? 'ready' : 'pending' });
      } else if (route === 'complete') {
        if (!session.code || !proof(body.verifier) || !same(session.challenge, hash(body.verifier)))
          throw new Problem(400, 'invalid_exchange');
        sessions.delete(key);
        respond(res, 200, await githubToken({ code: session.code, code_verifier: body.verifier, redirect_uri: callback }));
      } else {
        throw new Problem(404, 'invalid_request');
      }
    };
    void handle().catch((error: unknown) => {
      if (!res.headersSent && !res.destroyed) {
        respond(res, error instanceof Problem ? error.status : 500, {
          error: error instanceof Problem ? error.code : 'broker_unavailable',
        });
      }
    });
  });
}
