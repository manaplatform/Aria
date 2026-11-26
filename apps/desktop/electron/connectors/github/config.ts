import { z } from 'zod';

export const githubConfig = z.strictObject({
  clientId: z.string().regex(/^[A-Za-z0-9_]{8,120}$/),
  slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
});
export type GithubConfig = z.infer<typeof githubConfig>;

export function githubRegistration(config: GithubConfig) {
  return ['github-device', config.clientId, config.slug].join('|');
}
