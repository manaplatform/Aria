import { z } from 'zod';
import { evidenceSchema } from './execution-runtime.js';
import { capabilityId, type ToolProblem } from './capabilities.js';
import { browserOps, browserToolArgs } from './browser.js';
import { webToolArgs } from './web.js';
import { identifier, modelCapabilitySchema, modelRefSchema } from './model-registry.js';

export const conductorLimits = {
  milliseconds: 300_000,
  primaryCalls: 12,
  controlCalls: 6,
  activity: 24,
  steps: 12,
  parallel: 3,
  turns: 4,
  searches: 2,
  resultCharacters: 12_000,
  attachmentBytes: 80_000_000,
  artifactBytes: 64_000_000,
  artifacts: 4,
} as const;
export const toolIds = [
  'read_attachment',
  'create_text_artifact',
  'web_search',
  'web_fetch',
  'web_read',
  'web_find',
  ...browserOps,
] as const;
export const localWebToolIds = ['web_fetch', 'web_read', 'web_find', ...browserOps] as const;
export const researchToolArgs = { ...webToolArgs, ...browserToolArgs };
export type ResearchToolId = keyof typeof researchToolArgs;
export const outputKinds = ['text', 'image', 'audio', 'file', 'sources', 'data'] as const;
export const stepId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const referenceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(16_000) }).strict(),
  z.object({ kind: z.literal('attachment'), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('result'), stepId }).strict(),
]);
export const executionStepSchema = z
  .object({
    id: stepId,
    target: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('model'),
          model: modelRefSchema.describe(
            'Copy the exact connection-qualified reference from a listed operation target, not the display name or bare model ID.',
          ),
        })
        .strict(),
      z
        .object({
          kind: z.literal('tool'),
          tool: z.union([z.enum(toolIds), capabilityId]),
          model: modelRefSchema.nullable().describe('Use null for local tools.'),
        })
        .strict(),
    ]),
    capability: z.union([
      modelCapabilitySchema,
      z.enum(['read-file', 'create-file', ...localWebToolIds]),
      capabilityId,
    ]),
    instructions: z.string().trim().min(1).max(4000),
    args: z
      .record(z.string().max(50), z.unknown())
      .optional()
      .describe(
        'Use the argument schema in the operation descriptor. Opaque IDs must come from a successful dependency.',
      ),
    inputs: z.array(referenceInput).max(8),
    dependsOn: z.array(stepId).max(conductorLimits.steps),
    output: z.enum(outputKinds),
    summary: z.string().trim().min(1).max(200),
  })
  .strict();
export const sourceSchema = z
  .object({
    url: z
      .string()
      .max(2000)
      .refine((url) => {
        try {
          const parsed = new URL(url);
          return (
            ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
          );
        } catch {
          return false;
        }
      }),
    title: z.string().max(300),
    id: z.string().uuid().optional(),
    publisher: z.string().max(300).optional(),
    domain: z.string().max(253).optional(),
    publishedAt: z.iso.datetime().optional(),
    retrievedAt: z.iso.datetime().optional(),
    contentType: z.string().max(100).optional(),
    provenance: z.enum(['hosted', 'publisher', 'browser']).optional(),
  })
  .strict();
export const artifactReferenceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().max(255),
    mimeType: z.string().max(100),
    size: z.number().int().positive().max(conductorLimits.artifactBytes),
    storage: z.literal('desktop').optional(),
    hostedExecution: z.strictObject({ stepId, sessionId: z.string().uuid() }).optional(),
  })
  .strict();
export const activitySchema = z
  .object({
    stepId,
    capability: executionStepSchema.shape.capability,
    target: z.string().max(310),
    summary: z.string().max(200),
    status: z.enum([
      'queued',
      'running',
      'approval',
      'processing',
      'completed',
      'failed',
      'blocked',
      'cancelled',
    ]),
    callId: z.string().max(256).optional(),
    parentStepId: stepId.optional(),
    programStatus: z.enum(['complete', 'partial', 'failed', 'cancelled', 'uncertain']).optional(),
    inputSummary: z.string().max(200).optional(),
    resultSummary: z.string().max(200).optional(),
    at: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().optional(),
    error: z.string().max(400).optional(),
    resultId: z.string().uuid().optional(),
    sources: z.array(sourceSchema).max(8).optional(),
    evidence: z.array(evidenceSchema).max(6).optional(),
    executionDetails: z.string().max(12_000).optional(),
    privateContent: z.boolean().optional(),
  })
  .strict();
export const runInfoSchema = z
  .object({
    revision: z.string().max(100),
    primary: modelRefSchema,
    primaryName: z.string().max(310).optional(),
    billableChildStarted: z.boolean(),
  })
  .strict();
export const conductorAttemptSchema = z
  .object({
    requestId: identifier,
    run: runInfoSchema,
    activity: z.array(activitySchema).max(conductorLimits.activity),
    outcome: z.enum(['completed', 'failed', 'interrupted', 'stopped']),
  })
  .strict();
export type ConductorAttempt = z.infer<typeof conductorAttemptSchema>;
export function endActivity(activity?: ConductorActivity[]): ConductorActivity[] | undefined {
  return activity?.map((step) =>
    ['running', 'queued', 'approval', 'processing'].includes(step.status)
      ? { ...step, status: 'cancelled' }
      : step,
  );
}
export type ExecutionStep = z.infer<typeof executionStepSchema>;
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type ConductorActivity = z.infer<typeof activitySchema>;
export type ConductorSource = z.infer<typeof sourceSchema>;
export type ConductorRunInfo = z.infer<typeof runInfoSchema>;
export type ConductorEvent =
  | { type: 'started'; run?: ConductorRunInfo }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'activity'; activity: ConductorActivity }
  | { type: 'artifact'; artifact: ArtifactReference }
  | { type: 'completed'; partial?: boolean; run?: ConductorRunInfo }
  | {
      type: 'failed';
      error: string;
      interrupted: boolean;
      run?: ConductorRunInfo;
      settingsHelp?: boolean;
      problem?: ToolProblem;
    }
  | { type: 'stopped' };
export const chatEventIdentity = z.object({
  requestId: identifier,
  conversationId: identifier,
  assistantMessageId: identifier,
});
