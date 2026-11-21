import { z } from 'zod';
import { webDestination, webReference, webUrlSchema, webSearchArgs } from './web.js';

const tab = { tabId: webReference };
const page = { ...tab, documentId: webReference };
const element = { ...page, elementId: webReference };
const value = z.string().max(1000);

export const browserToolArgs = {
  browser_open: webDestination,
  browser_navigate: z.union([
    z.strictObject({ ...tab, url: webUrlSchema }),
    z.strictObject({ ...tab, sourceId: webReference }),
  ]),
  browser_get_tabs: z.strictObject({}),
  browser_switch_tab: z.strictObject(tab),
  browser_get_page: z.strictObject(tab),
  browser_extract: z.strictObject({
    ...page,
    selection: z.boolean().optional(),
    query: z.string().min(1).max(200).optional(),
  }),
  browser_scroll: z.strictObject({ ...page, delta: z.number().int().min(-2000).max(2000) }),
  browser_click: z.strictObject(element),
  browser_type: z.strictObject({ ...element, value }),
  browser_submit: z.strictObject({
    ...element,
    fields: z.array(z.strictObject({ elementId: webReference, value })).max(12),
  }),
  browser_screenshot: z.strictObject(page),
} as const;
export const browserOps = Object.keys(browserToolArgs) as [BrowserOp, ...BrowserOp[]];
export type BrowserOp = keyof typeof browserToolArgs;
export const browserBridgeArgs = {
  ...browserToolArgs,
  web_search: webSearchArgs,
  web_fetch: z.strictObject({ url: webUrlSchema }),
} as const;
export type BrowserBridgeOp = keyof typeof browserBridgeArgs;
const bridgeOps = [...browserOps, 'web_search', 'web_fetch'] as const;
export const browserRequestSchema = z.strictObject({
  v: z.literal(1),
  generation: webReference,
  operationId: webReference,
  requestId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  stepId: z.string().min(1).max(64),
  deadline: z.number().int().positive(),
  op: z.enum(bridgeOps),
  args: z.record(z.string(), z.unknown()),
});
export const browserResponseSchema = z.strictObject({
  v: z.literal(1),
  generation: webReference,
  operationId: webReference,
  requestId: z.string(),
  conversationId: z.string(),
  stepId: z.string(),
  op: z.enum(bridgeOps),
  result: z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      text: z.string().max(12_000),
      url: z.string().max(2000).optional(),
      title: z.string().max(300).optional(),
      screenshot: z.instanceof(Uint8Array).optional(),
    }),
    z.strictObject({
      ok: z.literal(false),
      code: z.string().max(40),
      message: z.string().max(400),
    }),
  ]),
});
export const browserProgressSchema = browserResponseSchema.omit({ result: true }).extend({
  progress: z.literal('approval'),
});
export const browserCancelSchema = z.strictObject({
  generation: webReference,
  operationId: webReference,
});
export const browserLayoutSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  conversationId: z.string().max(200).nullable(),
  bounds: z
    .strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
    })
    .nullable(),
});
export const browserCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), input: z.string().trim().max(2000).optional() }),
  z.strictObject({
    kind: z.literal('navigate'),
    ...tab,
    input: z.string().trim().min(1).max(2000),
  }),
  z.strictObject({
    kind: z.enum([
      'close',
      'select',
      'back',
      'forward',
      'reload',
      'stop',
      'bookmark',
      'external',
      'share-link',
      'share-selection',
      'recover',
    ]),
    ...tab,
  }),
  z.strictObject({
    kind: z.literal('zoom'),
    ...tab,
    delta: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  }),
  z.strictObject({
    kind: z.literal('find'),
    ...tab,
    query: z.string().max(200),
    forward: z.boolean(),
  }),
  z.strictObject({ kind: z.enum(['clear-history', 'clear-site-data', 'revoke-permissions']) }),
]);
export type BrowserRequest = z.infer<typeof browserRequestSchema>;
export type BrowserResponse = z.infer<typeof browserResponseSchema>;
export type BrowserLayout = z.infer<typeof browserLayoutSchema>;
export type BrowserCommand = z.infer<typeof browserCommandSchema>;
export interface BrowserTab {
  id: string;
  profile: 'personal' | 'ai';
  url: string;
  title: string;
  icon?: string;
  loading: boolean;
  error?: string;
  crashed?: boolean;
  back: boolean;
  forward: boolean;
  zoom: number;
  matches?: { count: number; index: number };
}
export interface BrowserEntry {
  url: string;
  title: string;
  at: number;
}
export interface BrowserState {
  tabs: BrowserTab[];
  selected: string | null;
  history: BrowserEntry[];
  bookmarks: BrowserEntry[];
  permissions: { origin: string; permission: string }[];
  warning?: string;
}
