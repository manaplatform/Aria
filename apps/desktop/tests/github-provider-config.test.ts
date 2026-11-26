import { describe, expect, it } from 'vitest';
import { githubProviderConfig } from '../electron/connectors/provider-config';

const bundled = { clientId: 'Iv1.1234567890abcdef', slug: 'aria-fixture' };
const override = { clientId: 'Iv23liFixtureRegistration', slug: 'development-fixture' };
const env = { ARIA_DEV_GITHUB_CLIENT_ID: override.clientId, ARIA_DEV_GITHUB_APP_SLUG: override.slug };

describe('GitHub connector provider manifest', () => {
  it('uses the same bundled public identity in development and packages', () => {
    expect(githubProviderConfig(false, {}, bundled)).toEqual(bundled);
    expect(githubProviderConfig(true, env, bundled)).toEqual(bundled);
    expect(githubProviderConfig(false, { ARIA_CONNECT_GITHUB_CLIENT_ID: 'Iv1.legacy' }, bundled)).toEqual(bundled);
  });

  it('requires a valid complete development override and ignores it in packages', () => {
    expect(githubProviderConfig(false, env, bundled)).toEqual(override);
    expect(githubProviderConfig(false, { ARIA_DEV_GITHUB_APP_SLUG: override.slug }, bundled)).toBeUndefined();
    expect(githubProviderConfig(false, { ...env, ARIA_DEV_GITHUB_CLIENT_ID: '' }, bundled)).toBeUndefined();
    expect(githubProviderConfig(true, env, null)).toBeUndefined();
  });

  it('fails closed if the bundled registration is absent, malformed or contains a secret', () => {
    for (const manifest of [null, {}, { ...bundled, clientId: bundled.clientId + ' ' },
      { ...bundled, slug: '../fixture' }, { ...bundled, secret: 'test-secret' }]) {
      expect(githubProviderConfig(true, {}, manifest)).toBeUndefined();
    }
  });
});
