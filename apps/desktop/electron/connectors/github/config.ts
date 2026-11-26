import { z } from 'zod';

export const githubConfig = z.strictObject({
  clientId: z.string().min(8).max(120).regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?$/),
  slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
});
export type GithubConfig = z.infer<typeof githubConfig>;

export function githubRegistration(config: GithubConfig) {
  return ['github-device', config.clientId, config.slug].join('|');
}
