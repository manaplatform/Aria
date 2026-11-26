import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { createBroker } from './broker.ts';

const accessToken = 'ghu_fixture_access_token';
const refreshToken = 'ghr_fixture_refresh_token';
const proof = () => randomBytes(32).toString('base64url');

test('accepts only the live callback and the desktop possessing both secrets', async () => {
  let calls = 0;
  let now = 1;
  const server = createBroker({
    origin: 'https://broker.aria.example', clientId: 'Iv1_fixture', clientSecret: 'fixture-secret',
    now: () => now,
    request: async (url, options) => {
      assert.equal(url, 'https://github.com/login/oauth/access_token');
      const args = options?.body as URLSearchParams;
      assert.equal(args.get('client_secret'), 'fixture-secret');
      calls++;
      return Response.json({ access_token: accessToken, refresh_token: refreshToken,
        expires_in: 28000, refresh_token_expires_in: 1500000, token_type: 'bearer' });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  const request = (route: string, body?: object, host = 'broker.aria.example') =>
    new Promise<Response>((resolve, reject) => {
      const send = http.request(base + route, {
        method: body ? 'POST' : 'GET', headers: { host, ...(body && { 'content-type': 'application/json' }) },
      }, (received) => {
        const chunks: Buffer[] = [];
        received.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        received.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(received.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          resolve(new Response(Buffer.concat(chunks), { status: received.statusCode, headers }));
        });
      });
      send.on('error', reject);
      send.end(body ? JSON.stringify(body) : undefined);
    });
  const post = (route: string, body: object) => request('/v1/github/' + route, body);
  const verifier = proof();
  const pair = { state: proof(), secret: proof() };
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  try {
    assert.equal((await post('start', { ...pair, challenge })).status, 201);
    assert.equal((await request('/v1/github/callback?code=invalid&state=' + proof())).status, 400);
    assert.equal((await request('/v1/github/callback?code=invalid&code=second&state=' + pair.state)).status, 400);
    assert.equal((await request('/v1/github/callback?code=valid&state=' + pair.state, undefined, 'lookalike.example')).status, 400);
    assert.equal((await post('status', { ...pair, secret: proof() })).status, 410);
    assert.deepEqual(await (await post('status', pair)).json(), { status: 'pending' });
    const callbackPath = '/v1/github/callback?code=valid_code&state=' + pair.state;
    const callback = await request(callbackPath);
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), '/v1/github/done');
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await request(callbackPath)).status, 400);
    assert.equal((await post('complete', { ...pair, verifier: proof() })).status, 400);
    const result = await post('complete', { ...pair, verifier });
    assert.equal(result.status, 200);
    assert.equal((await result.json() as { accessToken: string }).accessToken, accessToken);
    assert.equal((await post('complete', { ...pair, verifier })).status, 410);
    assert.equal(calls, 1);

    for (const finish of ['cancel', 'expire'] as const) {
      const attempt = { state: proof(), secret: proof() };
      assert.equal((await post('start', { ...attempt, challenge })).status, 201);
      if (finish === 'cancel') assert.equal((await post('cancel', attempt)).status, 200);
      else now += 600001;
      assert.equal((await request('/v1/github/callback?code=valid&state=' + attempt.state)).status, 400);
      assert.equal((await post('status', attempt)).status, 410);
    }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
