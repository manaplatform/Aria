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
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  cursor: webReference.optional(),
});
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

export const webPolicySchema = z.strictObject({
  enabled: z.boolean(),
  braveEnabled: z.boolean(),
  aiBrowser: z.boolean(),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  searches: z.number().int().min(1).max(2),
  fetches: z.number().int().min(1).max(4),
  screenshots: z.number().int().min(1).max(2),
  addressSearch: z.boolean(),
  persistentSiteData: z.boolean(),
  history: z.boolean(),
  restoreTabs: z.boolean(),
});
export const defaultWebPolicy: z.infer<typeof webPolicySchema> = {
  enabled: true,
  braveEnabled: false,
  aiBrowser: false,
  searches: 2,
  fetches: 4,
  screenshots: 2,
  addressSearch: false,
  persistentSiteData: false,
  history: false,
  restoreTabs: false,
};
export const webSettingsInputSchema = webPolicySchema.extend({
  apiKey: z.string().trim().min(1).max(1000).nullable().optional(),
});
export const runtimeWebSchema = webPolicySchema.extend({
  braveKey: z.string().min(1).max(1000).optional(),
});
export type WebPolicy = z.infer<typeof webPolicySchema>;
export type WebSettingsInput = z.infer<typeof webSettingsInputSchema>;
export type WebSettings = WebPolicy & { hasKey: boolean; warning?: string };
export type RuntimeWeb = z.infer<typeof runtimeWebSchema>;
