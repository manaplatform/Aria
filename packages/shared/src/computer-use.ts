import { z } from 'zod';
import { webUrlSchema } from './web.js';

const id = z.string().uuid();
const dimension = z.number().int().min(1).max(8192);
const axis = z.number().int().min(0).max(8191);
const point = { x: axis, y: axis };
const keys = z.array(z.string().min(1).max(20)).min(1).max(4);
const filename = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u);

export const computerLimits = {
  idleMs: 20 * 60_000,
  lifetimeMs: 45 * 60_000,
  actionMs: 15_000,
  actions: 8,
  imageBytes: 1024 * 1024,
  frameSide: 1024,
  sessions: 4,
} as const;

export const computerEnvironment = z.enum(['managed-browser', 'virtual-desktop', 'local-desktop']);
export const computerMode = z.enum(['aria', 'openai-responses']);
export const computerStatus = z.enum([
  'initializing',
  'ready',
  'running',
  'waiting-for-approval',
  'waiting-for-user',
  'paused',
  'recovering',
  'completed',
  'failed',
  'cancelled',
  'expired',
]);

export const computerAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('screenshot') }),
  z.strictObject({ type: z.literal('open_file_manager') }),
  z.strictObject({
    type: z.literal('open_application'),
    application: z
      .string()
      .max(120)
      .regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ._&+()'’\-]*$/u)
      .describe('Exact installed macOS app name or bundle identifier'),
  }),
  z.strictObject({
    type: z.literal('click'),
    ...point,
    button: z.enum(['left', 'right', 'middle']),
    keys: keys.optional(),
  }),
  z.strictObject({ type: z.literal('double_click'), ...point, keys: keys.optional() }),
  z.strictObject({ type: z.literal('move'), ...point, keys: keys.optional() }),
  z.strictObject({
    type: z.literal('drag'),
    path: z.array(z.strictObject(point)).min(2).max(32),
    keys: keys.optional(),
  }),
  z.strictObject({
    type: z.literal('scroll'),
    ...point,
    scrollX: z.number().int().min(-1500).max(1500),
    scrollY: z.number().int().min(-1500).max(1500),
    keys: keys.optional(),
  }),
  z.strictObject({ type: z.literal('keypress'), keys }),
  z.strictObject({ type: z.literal('type'), text: z.string().min(1).max(1000) }),
  z.strictObject({ type: z.literal('set_value'), elementId: id, text: z.string().max(4000) }),
  z.strictObject({ type: z.literal('wait') }),
]);

export const computerObservation = z.strictObject({
  id,
  sessionId: id,
  targetId: id,
  revision: id,
  at: z.number().int().positive(),
  environment: computerEnvironment,
  width: dimension,
  height: dimension,
  devicePixelRatio: z.number().positive().max(10),
  url: z.string().max(2000).optional(),
  title: z.string().max(300).optional(),
  screenshot: z.strictObject({ width: dimension, height: dimension }).optional(),
  state: z.record(z.string(), z.unknown()).optional(),
});

export const computerImage = z.strictObject({
  observation: computerObservation,
  bytes: z
    .instanceof(Uint8Array)
    .refine((value) => value.length > 0 && value.length <= computerLimits.imageBytes),
});

export const computerOperations = {
  'computer.inspect': z.strictObject({}),
  'computer.open': z.strictObject({
    environment: computerEnvironment,
    mode: computerMode,
    tabId: id.optional(),
    restoreId: id.optional(),
    resumeId: id.optional(),
    application: z.enum(['mousepad', 'writer']).optional(),
  }),
  'computer.observe': z.strictObject({ sessionId: id, format: z.enum(['structured', 'image']) }),
  'computer.act': z.strictObject({
    sessionId: id,
    observationId: id.optional(),
    actions: z.array(computerAction).min(1).max(computerLimits.actions),
    screenshot: z.boolean().optional(),
  }),
  'computer.close': z.strictObject({ sessionId: id }),
  'computer.navigate': z.discriminatedUnion('target', [
    z.strictObject({ sessionId: id, target: z.literal('url'), url: webUrlSchema }),
    z.strictObject({ sessionId: id, target: z.literal('source'), sourceId: id }),
    z.strictObject({ sessionId: id, target: z.literal('tab'), tabId: id }),
  ]),
  'computer.run_script': z.strictObject({
    sessionId: id,
    script: z.string().min(1).max(8000),
    actions: z.array(computerAction).max(computerLimits.actions).optional(),
  }),
  'computer.transfer': z.discriminatedUnion('direction', [
    z.strictObject({
      sessionId: id,
      direction: z.literal('download'),
      observationId: id,
      elementId: id,
      filename,
    }),
    z.strictObject({
      sessionId: id,
      direction: z.literal('upload'),
      observationId: id,
      elementId: id,
      fileId: id,
    }),
    z.strictObject({ sessionId: id, direction: z.literal('stage'), fileId: id }),
    z.strictObject({ sessionId: id, direction: z.literal('publish'), filename }),
    z.strictObject({ sessionId: id, direction: z.literal('save_capture'), observationId: id }),
  ]),
} as const;

export const computerProviderCall = z.strictObject({
  responseId: z.string().min(1).max(256),
  itemId: z.string().min(1).max(256),
  callId: z.string().min(1).max(256),
  checks: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(256),
        code: z.string().max(120).optional(),
        message: z.string().max(400).optional(),
      }),
    )
    .max(8),
});
export const computerRuntimeAct = computerOperations['computer.act'].extend({
  provider: computerProviderCall.optional(),
});

export const computerSupervision = z.strictObject({
  sessionId: id,
  action: z.enum([
    'pause',
    'resume',
    'take-control',
    'private-auth',
    'return-control',
    'stop',
    'close',
  ]),
});

export const computerUserInput = z.strictObject({ sessionId: id, action: computerAction });

export const computerSessionSummary = z.strictObject({
  id,
  conversationId: z.string().min(1).max(200),
  environment: computerEnvironment,
  mode: computerMode,
  targetId: id,
  status: computerStatus,
  operation: z.string().max(100).optional(),
  history: z
    .array(
      z.strictObject({ at: z.number(), action: z.string().max(100), outcome: z.string().max(100) }),
    )
    .max(24),
});

export type ComputerAction = z.infer<typeof computerAction>;
export type LocalDesktopAccess = {
  display?: string;
  state: 'off' | 'ready' | 'primary-changed' | 'screen-permission' | 'pointer-permission' | 'unavailable';
};
export type ComputerObservation = z.infer<typeof computerObservation>;
export type ComputerImage = z.infer<typeof computerImage>;
export type ComputerEnvironment = z.infer<typeof computerEnvironment>;
export type ComputerSessionSummary = z.infer<typeof computerSessionSummary>;
export type ComputerSupervision = z.infer<typeof computerSupervision>;
export type ComputerProviderCall = z.infer<typeof computerProviderCall>;
