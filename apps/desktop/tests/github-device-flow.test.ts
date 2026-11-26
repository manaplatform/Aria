import { describe, expect, it, vi } from 'vitest';
import { GithubAuthorization } from '../electron/connectors/github/authorization';

const config = { clientId: 'Iv1_fixture', slug: 'aria-connect' };
const device = {
  device_code: 'd'.repeat(40), user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
};
const tokens = {
  access_token: 'ghu_fixture_access_token', refresh_token: 'ghr_fixture_refresh_token',
  expires_in: 28_800, refresh_token_expires_in: 15_897_600, token_type: 'bearer',
};

function fixture(replies: (Response | Error)[], challenge = device) {
  let now = 1_000;
  const wait = vi.fn(async (ms: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    now += ms;
  });
  const request = vi.fn<typeof fetch>(async (url, options) => {
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    const form = new URLSearchParams(String(options?.body));
    expect(form.get('client_id')).toBe(config.clientId);
    expect(form.has('client_secret')).toBe(false);
    if (url === 'https://github.com/login/device/code') {
      expect(form.get('scope')).toBe('offline_access');
      return Response.json(challenge);
    }
    expect(url).toBe('https://github.com/login/oauth/access_token');
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error('Unexpected fixture request');
    return reply;
  });
  const auth = new GithubAuthorization(config, request, { now: () => now, wait });
  const present = vi.fn(async () => {});
  return { auth, wait, request, present };
}

describe('GitHub Device Flow', () => {
  it('handles pending, slow_down, Retry-After and a transient failure before accepting tokens', async () => {
    const { auth, wait, request, present } = fixture([
      Response.json({ error: 'authorization_pending' }),
      Response.json({ error: 'slow_down', interval: 12 }),
      new Response(null, { status: 429, headers: { 'retry-after': '20' } }),
      new Error('fixture network failure'),
      Response.json(tokens),
    ]);
    const result = await auth.authorize(present, new AbortController().signal);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([5000, 5000, 12000, 20000, 48000]);
    expect(present).toHaveBeenCalledExactlyOnceWith({ userCode: device.user_code, expiresAt: 901_000 });
    expect(result).toMatchObject({ flow: 'device', accessToken: tokens.access_token, refreshToken: tokens.refresh_token });
    for (const [, options] of request.mock.calls.slice(1)) {
      const form = new URLSearchParams(String(options?.body));
      expect(form.get('device_code')).toBe(device.device_code);
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    }
  });

  it.each([
    'https://github.com.evil.example/login/device', 'https://github.com/login/device?code=other',
    'https://github.com:443/login/device', 'https://github.com/login/device/',
  ])('rejects a noncanonical verification endpoint %s', async (verification_uri) => {
    const { auth, present, request } = fixture([], { ...device, verification_uri });
    await expect(auth.authorize(present, new AbortController().signal)).rejects.toMatchObject({ category: 'AUTH_RESPONSE' });
    expect(present).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['access_denied', 'AUTH_DENIED'], ['expired_token', 'AUTH_TIMEOUT'],
    ['token_expired', 'AUTH_TIMEOUT'], ['device_flow_disabled', 'AUTH_CONFIGURATION'],
  ])('returns a safe error for %s', async (error, category) => {
    const { auth, present } = fixture([Response.json({ error, error_description: device.device_code })]);
    await expect(auth.authorize(present, new AbortController().signal)).rejects.toMatchObject({ category });
  });

  it('expires locally without another poll and cancels without accepting tokens', async () => {
    const { auth, wait, request, present } = fixture([], { ...device, expires_in: 3 });
    await expect(auth.authorize(present, new AbortController().signal)).rejects.toMatchObject({ category: 'AUTH_TIMEOUT' });
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([3000]);
    expect(request).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    await expect(auth.authorize(async () => controller.abort(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
