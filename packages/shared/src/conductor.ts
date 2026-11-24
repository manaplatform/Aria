import { z } from 'zod';
import type { MemoryInput } from './memory.js';
import { evidenceSchema } from './execution-runtime.js';
import { capabilityId, effectSchema, type ToolProblem } from './capabilities.js';
import { browserOps, browserToolArgs } from './browser.js';
import { webToolArgs } from './web.js';
import { identifier, modelCapabilitySchema, modelRefSchema } from './model-registry.js';
import type { ChatMessage, ChatRequest } from './index.js';
import type { ExecutionSnapshot } from './loop.js';

/** Select complete saved turns and keep their privacy metadata until the wire projection. */
export function selectChatContext(
  messages: readonly ChatMessage[],
  revision?: string,
): { messages: ChatRequest['messages']; privateContent: boolean; memoryPrivate?: boolean } {
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
  if (lastUser < 0) return { messages: [], privateContent: false };
  const latest = messages[lastUser];
  const pairs: { user: ChatMessage; assistant: ChatMessage; privateContent: boolean }[] = [];
  for (let index = 0; index < lastUser; index++) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (user.role !== 'user' || assistant?.role !== 'assistant' ||
      assistant.status !== 'completed' || !assistant.content ||
      (assistant.operation && assistant.operation.mode !== 'chat')) continue;
    const privateContent = Boolean(
      assistant.run?.privateContent || assistant.activity?.some((step) => step.privateContent),
    );
    if (privateContent && revision !== undefined && assistant.run?.revision !== revision) continue;
    pairs.push({ user, assistant, privateContent });
  }
  const recent = pairs.slice(-20);
  const sizeOf = ({ user, assistant }: (typeof recent)[number]) =>
    user.content.length + assistant.content.length;
  let size = latest.content.length + recent.reduce((total, pair) => total + sizeOf(pair), 0);
  while (size > 100_000 && recent.length) size -= sizeOf(recent.shift()!);
  return {
    messages: [
      ...recent.flatMap(({ user, assistant }) => [
        { role: 'user' as const, content: user.content },
        { role: 'assistant' as const, content: assistant.content },
      ]),
      { role: 'user', content: latest.content },
    ],
    privateContent: recent.some((pair) => pair.privateContent),
    ...(recent.some((pair) => pair.assistant.run?.memoryContent) && { memoryPrivate: true }),
  };
}

export const conductorLimits = {
  milliseconds: 300_000,
  primaryCalls: 12,
  controlCalls: 6,
  activity: 24,
  steps: 12,
  parallel: 3,
  turns: 4,
  searches: 2,
  inputTokens: 600_000,
  outputTokens: 65_536,
  maxModelOutputTokens: 4096,
  contextTokens: 160_000,
  resultCharacters: 12_000,
  attachmentBytes: 80_000_000,
  artifactBytes: 64_000_000,
  artifacts: 4,
} as const;

export function modelOutputLimit(contextTokens?: number) {
  if (contextTokens === undefined) return conductorLimits.maxModelOutputTokens;
  return Math.min(conductorLimits.maxModelOutputTokens, Math.max(1, Math.floor(contextTokens / 4)));
}
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
    executionId: stepId.optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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
      'uncertain',
    ]),
    effect: effectSchema.optional(),
    callId: z.string().max(256).optional(),
    parentStepId: stepId.optional(),
    programStatus: z.enum(['complete', 'partial', 'failed', 'cancelled', 'uncertain']).optional(),
    programResultSaved: z.boolean().optional(),
    inputSummary: z.string().max(200).optional(),
    resultSummary: z.string().max(200).optional(),
    outcomeUnverified: z.boolean().optional(),
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
    privateContent: z.boolean().optional(),
    memoryContent: z.boolean().optional(),
    storedResponses: z.boolean().optional(),
    usage: z.strictObject({
      providerRequests: z.number().int().nonnegative(),
      responseContinuations: z.number().int().nonnegative(),
      directToolCalls: z.number().int().nonnegative(),
      programChildCalls: z.number().int().nonnegative(),
      controlCalls: z.number().int().nonnegative().optional(),
      nativeToolCalls: z.number().int().nonnegative().optional(),
      accountedCostUsdMicros: z.number().int().nonnegative().optional(),
      inputTokens: z.number().int().nonnegative().optional(),
      memoryInputEstimate: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      iterations: z.number().int().nonnegative().optional(),
      recoveries: z.number().int().nonnegative().optional(),
      noProgress: z.boolean().optional(),
      activeMs: z.number().int().nonnegative().optional(),
    }).optional(),
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
      ? {
          ...step,
          status: (step.status === 'running' || step.status === 'processing') &&
            (step.effect === 'billable' || step.effect === 'consequential')
            ? 'uncertain'
            : 'cancelled',
        }
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
  | { type: 'execution'; execution: ExecutionSnapshot }
  | { type: 'delta'; text: string }
  | { type: 'reset' }
  | { type: 'activity'; activity: ConductorActivity }
  | { type: 'artifact'; artifact: ArtifactReference }
  | { type: 'completed'; partial?: boolean; run?: ConductorRunInfo; suggestions?: string[]; memoryCandidates?: MemoryInput[] }
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
