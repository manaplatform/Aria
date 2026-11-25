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
  .trim()
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
export function normalizeWebDestination(input: string): string {
  const value = input.trim();
  if (!value || /[\s\\\u0000-\u001f\u007f]/u.test(value))
    throw new Error('Use a public HTTP(S) URL or bare domain.');
  if (/^https?:\/\//i.test(value)) return publicWebUrl(value).href;
  if (!/^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:[/?#].*)?$/u.test(value))
    throw new Error('Use a public HTTP(S) URL or bare domain.');
  return publicWebUrl(`https://${value}`).href;
}

const destinationUrl = z.string().trim().max(2000).refine((value) => {
  try {
    normalizeWebDestination(value);
    return true;
  } catch {
    return false;
  }
}, 'Use a public HTTP(S) URL or bare domain.');

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
export const webSearchEngineSchema = z.enum(['auto', 'brave', 'bing']);
export type WebSearchEngine = z.infer<typeof webSearchEngineSchema>;
export function browserSearchUrl(
  query: string,
  engine: Exclude<WebSearchEngine, 'auto'> = 'brave',
): string {
  const url = new URL(
    engine === 'bing' ? 'https://www.bing.com/search' : 'https://search.brave.com/search',
  );
  url.searchParams.set('q', query);
  return url.href;
}
export const webDestinationFields = {
    url: destinationUrl
      .optional()
      .describe(
        'Public HTTP(S) URL or bare domain supplied by the user, or exact URL observed by an earlier tool. Provide either url or sourceId.',
      ),
    sourceId: webReference
      .optional()
      .describe(
        'Copy a sourceId returned by a completed tool and include its producerStepId in dependsOn. Provide either sourceId or url.',
      ),
};
export const hasOneWebDestination = (value: { url?: string; sourceId?: string }) =>
  Boolean(value.url) !== Boolean(value.sourceId);
export const webDestination = z.strictObject(webDestinationFields)
  .refine(hasOneWebDestination, 'Provide exactly one of url or sourceId.');
export const webMethod = z.enum(['GET', 'HEAD']);
const excerpt = z.string().max(500);
export const webLinkSchema = z.strictObject({
  href: webUrlSchema,
  label: z.string().max(200),
});
export const webMetadataSchema = z.strictObject({
  description: excerpt.optional(),
  canonical: webUrlSchema.optional(),
  robots: excerpt.optional(),
  language: z.string().max(80).optional(),
  direction: z.string().max(20).optional(),
  viewport: excerpt.optional(),
  headings: z.array(z.strictObject({ level: z.number().int().min(1).max(6), text: excerpt })).max(40).optional(),
  images: z.strictObject({ total: z.number().int().nonnegative(), missingAlt: z.number().int().nonnegative() }).optional(),
  semantic: z.array(z.string().max(20)).max(10).optional(),
  alternates: z.array(z.strictObject({ language: z.string().max(80), href: webUrlSchema })).max(12).optional(),
  structuredTypes: z.array(z.string().max(100)).max(12).optional(),
  published: z.array(excerpt).max(6).optional(),
  modified: z.array(excerpt).max(6).optional(),
  dates: z.array(excerpt).max(8).optional(),
});
export const webFetchResultSchema = z.strictObject({
  url: webUrlSchema,
  title: z.string().max(300).optional(),
  status: z.number().int().min(100).max(599),
  redirects: z.array(z.strictObject({ url: webUrlSchema, status: z.number().int().min(300).max(399) })).max(5),
  headers: z.record(z.string(), excerpt),
  text: z.string().max(8000).optional(),
  metadata: webMetadataSchema.optional(),
  links: z.array(webLinkSchema).max(24).optional(),
  truncated: z.boolean().optional(),
  outcome: z.enum(['retrieved', 'http_error', 'restricted', 'unsupported']),
});
export type WebFetchResult = z.infer<typeof webFetchResultSchema>;
export const webToolArgs = {
  web_search: webSearchArgs,
  web_fetch: z.strictObject({ ...webDestinationFields, method: webMethod.optional() })
    .refine(hasOneWebDestination, 'Provide exactly one of url or sourceId.'),
  web_read: z.strictObject({ documentId: webReference }),
  web_find: z.strictObject({ documentId: webReference, query: z.string().trim().min(1).max(200) }),
} as const;

export const webPolicyLimits = {
  searches: { min: 1, default: 8, max: 12 },
  fetches: { min: 1, default: 8, max: 12 },
  navigations: { min: 1, default: 8, max: 12 },
  inspections: { min: 1, default: 12, max: 24 },
  screenshots: { min: 1, default: 2, max: 6 },
} as const;

export const webBudgetKeySchema = z.enum(Object.keys(webPolicyLimits) as (keyof typeof webPolicyLimits)[]);

export const webPolicySchema = z.strictObject({
  enabled: z.boolean(),
  aiBrowser: z.boolean(),
  searchEngine: webSearchEngineSchema.default('auto'),
  searches: z.number().int().min(webPolicyLimits.searches.min).max(webPolicyLimits.searches.max),
  fetches: z.number().int().min(webPolicyLimits.fetches.min).max(webPolicyLimits.fetches.max),
  navigations: z.number().int().min(1).max(webPolicyLimits.navigations.max).default(webPolicyLimits.navigations.default),
  inspections: z.number().int().min(1).max(webPolicyLimits.inspections.max).default(webPolicyLimits.inspections.default),
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
  searchEngine: 'auto',
  searches: webPolicyLimits.searches.default,
  fetches: webPolicyLimits.fetches.default,
  navigations: webPolicyLimits.navigations.default,
  inspections: webPolicyLimits.inspections.default,
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
