import { publicAddress } from './public-address.js';
import { z } from 'zod';

export function publicWebUrl(value: string): URL {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !url.hostname ||
    url.hostname.endsWith('.') ||
    value.length > 2000
  )
    throw new Error('Use a public HTTP or HTTPS address on its standard port.');
  const host = url.hostname.toLowerCase();
  if (
    (!host.includes('.') && !host.startsWith('[')) ||
    /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host)
  )
    throw new Error('Local and private destinations are blocked.');
  if (
    (host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host)) &&
    !publicAddress(host.replace(/^\[|\]$/g, ''))
  )
    throw new Error('Local and private destinations are blocked.');
  return url;
}

export const webUrlSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      publicWebUrl(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use a public HTTP or HTTPS URL.');
export const webReference = z.string().uuid();
export const webSearchArgs = z.strictObject({
  query: z.string().trim().min(1).max(400),
});
export const browserSearchResultsSchema = z.strictObject({
  results: z
    .array(
      z.strictObject({
        url: webUrlSchema,
        title: z.string().max(300),
        snippet: z.string().max(400).optional(),
      }),
    )
    .max(8),
});
export function browserSearchUrl(query: string): string {
  const url = new URL('https://search.brave.com/search');
  url.searchParams.set('q', query);
  return url.href;
}
export const webDestination = z.union([
  z.strictObject({ url: webUrlSchema }),
  z.strictObject({ sourceId: webReference }),
]);
export const webToolArgs = {
  web_search: webSearchArgs,
  web_fetch: webDestination,
  web_read: z.strictObject({ documentId: webReference }),
  web_find: z.strictObject({ documentId: webReference, query: z.string().trim().min(1).max(200) }),
} as const;

export const webPolicyLimits = {
  searches: { min: 1, default: 8, max: 12 },
  fetches: { min: 1, default: 8, max: 12 },
  screenshots: { min: 1, default: 2, max: 6 },
} as const;

export const webPolicySchema = z.strictObject({
  enabled: z.boolean(),
  aiBrowser: z.boolean(),
  searches: z.number().int().min(webPolicyLimits.searches.min).max(webPolicyLimits.searches.max),
  fetches: z.number().int().min(webPolicyLimits.fetches.min).max(webPolicyLimits.fetches.max),
  screenshots: z
    .number()
    .int()
    .min(webPolicyLimits.screenshots.min)
    .max(webPolicyLimits.screenshots.max),
  addressSearch: z.boolean(),
  persistentSiteData: z.boolean(),
  history: z.boolean(),
  restoreTabs: z.boolean(),
});
export const defaultWebPolicy: z.infer<typeof webPolicySchema> = {
  enabled: true,
  aiBrowser: true,
  searches: webPolicyLimits.searches.default,
  fetches: webPolicyLimits.fetches.default,
  screenshots: webPolicyLimits.screenshots.default,
  addressSearch: false,
  persistentSiteData: false,
  history: false,
  restoreTabs: false,
};
export const webSettingsInputSchema = webPolicySchema;
export const runtimeWebSchema = webPolicySchema;
export type WebPolicy = z.infer<typeof webPolicySchema>;
export type WebSettingsInput = z.infer<typeof webSettingsInputSchema>;
export type WebSettings = WebPolicy & { warning?: string };
export type RuntimeWeb = WebPolicy;
