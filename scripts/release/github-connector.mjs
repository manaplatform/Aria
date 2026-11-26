import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const githubManifestPath = 'apps/desktop/electron/connectors/providers.json';

export function githubIdentity(manifest, required) {
  const github = manifest?.github;
  if (github === null && !required) return null;
  if (!github || Object.keys(github).length !== 2 || typeof github.clientId !== 'string' ||
      github.clientId.length < 8 || github.clientId.length > 120 ||
      !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/.test(github.clientId) ||
      typeof github.slug !== 'string' || !/^[a-z0-9-]{1,100}$/.test(github.slug)) {
    throw new Error(`Aria Connect release configuration is missing or invalid. Register or verify the official GitHub App and update ${githubManifestPath}.`);
  }
  return { clientId: github.clientId, slug: github.slug };
}

export function githubIdentityDigest(identity) {
  return identity && createHash('sha256').update(JSON.stringify([identity.clientId, identity.slug])).digest('hex');
}

export async function readGithubIdentity(filename, required) {
  const manifest = await readFile(filename, 'utf8').then(JSON.parse).catch(() => undefined);
  return githubIdentity(manifest, required);
}

export async function verifyGithubRegistration(identity, { request = fetch, wait = delay } = {}) {
  async function json(url, options, failure) {
    try {
      const response = await request(url, { ...options, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (response.ok) return await response.json();
      await response.body?.cancel();
    } catch {
      // The response can contain an active device code. Keep it out of diagnostics.
    }
    throw new Error(failure);
  }
  const metadataFailure = 'Could not verify the official Aria GitHub App metadata. Check GitHub availability and public App registration.';
  const app = await json(`https://api.github.com/apps/${identity.slug}`, {
    headers: { accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
  }, metadataFailure);
  if (typeof app?.owner?.login !== 'string' || app.owner.login.toLowerCase() !== 'manaplatform' ||
      app.slug !== identity.slug || app.client_id !== identity.clientId)
    throw new Error('The bundled GitHub App identity does not match the public manaplatform registration.');

  const flowFailure = 'Could not verify GitHub Device Flow for the official Aria App. Check that Device Flow is enabled and GitHub is reachable.';
  const post = (route, fields) => json(`https://github.com/login/${route}`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: identity.clientId, ...fields }),
  }, flowFailure);
  const device = await post('device/code', { scope: 'offline_access' });
  if (!device || typeof device.device_code !== 'string' || !/^[a-zA-Z0-9_-]{40}$/.test(device.device_code) ||
      typeof device.user_code !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(device.user_code) ||
      device.verification_uri !== 'https://github.com/login/device' || !Number.isInteger(device.interval) ||
      device.interval < 1 || device.interval > 60 || !Number.isInteger(device.expires_in) ||
      device.expires_in <= device.interval || device.expires_in > 900) throw new Error(flowFailure);
  await wait(device.interval * 1000);
  const poll = await post('oauth/access_token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code,
  });
  if (poll?.error !== 'authorization_pending') throw new Error(flowFailure);
}
