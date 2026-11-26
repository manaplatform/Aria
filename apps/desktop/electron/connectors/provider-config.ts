import providers from './providers.json';
import { githubConfig } from './github/config';

export function githubProviderConfig(packaged: boolean, env: NodeJS.ProcessEnv, manifest: unknown = providers.github) {
  const { ARIA_DEV_GITHUB_CLIENT_ID: clientId, ARIA_DEV_GITHUB_APP_SLUG: slug } = env;
  const override = !packaged && (clientId !== undefined || slug !== undefined);
  return githubConfig.safeParse(override ? { clientId, slug } : manifest).data;
}
