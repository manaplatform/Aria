import { z } from 'zod';
import { identifier } from './model-registry.js';

export const loopLimitsSchema = z.strictObject({
  iterations: z.number().int().min(2).max(48),
  steps: z.number().int().min(4).max(32).default(20),
  inputTokens: z.number().int().min(8192).max(600_000).default(600_000),
  outputTokens: z.number().int().min(4096).max(65_536).default(65_536),
  activeMs: z.number().int().min(10_000).max(1_800_000),
  concurrency: z.number().int().min(1).max(6),
  toolMs: z.number().int().min(1_000).max(181_000),
  readRetries: z.number().int().min(0).max(4),
  stagnantRounds: z.number().int().min(2).max(8),
});
export type LoopLimits = z.infer<typeof loopLimitsSchema>;
export const defaultLoopLimits: LoopLimits = {
  iterations: 12,
  steps: 20,
  inputTokens: 600_000,
  outputTokens: 65_536,
  activeMs: 300_000,
  concurrency: 3,
  toolMs: 181_000,
  readRetries: 2,
  stagnantRounds: 3,
};
export const loopCheckpointLifetime = 24 * 60 * 60_000;
export const loopCheckpointBytes = 40_000;

const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const executionIdentitySchema = z.strictObject({ executionId: z.uuid(), generation });
export const executionStateSchema = z.enum([
  'created',
  'running',
  'waiting_for_tool',
  'waiting_for_permission',
  'waiting_for_user',
  'paused',
  'recovering',
  'completed',
  'partial',
  'failed',
  'cancelled',
]);
export const executionTerminalStates = new Set<z.infer<typeof executionStateSchema>>([
  'completed',
  'partial',
  'failed',
  'cancelled',
]);
export const executionSnapshotSchema = executionIdentitySchema.extend({
  state: executionStateSchema,
  durability: z.enum(['pending', 'live', 'saved']),
  iteration: z.number().int().min(0).max(48),
  pausing: z.boolean().optional(),
  question: z.strictObject({ id: z.uuid(), text: z.string().min(1).max(1000) }).optional(),
});
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;

const controlScope = executionIdentitySchema.extend({
  requestId: identifier,
  conversationId: identifier,
  assistantMessageId: identifier,
  commandId: z.uuid(),
});
const steeringText = z.string().trim().min(1).max(2000);
export const loopCommandSchema = z.discriminatedUnion('action', [
  controlScope.extend({ action: z.literal('pause') }),
  controlScope.extend({ action: z.literal('resume') }),
  controlScope.extend({ action: z.literal('steer'), text: steeringText }),
  controlScope.extend({ action: z.literal('answer'), questionId: z.uuid(), text: steeringText }),
]);
export type LoopCommand = z.infer<typeof loopCommandSchema>;

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const loopBudgetSchema = z.strictObject({
  steps: counter,
  inputReserved: counter,
  outputReserved: counter,
  cost: counter,
  providerRequests: counter,
  responseContinuations: counter,
  controlCalls: counter,
  nativeToolCalls: counter,
  inputTokens: counter.optional(),
  outputTokens: counter.optional(),
  memoryInputEstimate: counter,
  artifactBytes: counter,
  artifactIds: z.array(z.uuid()).max(4),
  directToolCalls: counter,
  programChildCalls: counter,
  searches: counter,
  fetches: counter,
  screenshots: counter,
  navigations: counter.optional(),
  inspections: counter.optional(),
  validationFailures: counter.optional(),
});
export type LoopBudget = z.infer<typeof loopBudgetSchema>;

export const loopReceiptSchema = z.strictObject({
  id: identifier,
  operation: identifier,
  state: z.enum(['pending', 'completed', 'failed', 'uncertain', 'blocked']),
  evidenceIds: z.array(z.uuid()).max(6).optional(),
  durationMs: counter.optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  failureCategory: z.string().max(40).optional(),
  phase: z.string().max(40).optional(),
  retryEligible: z.boolean().optional(),
  retryAt: counter.optional(),
  attemptCount: z.number().int().min(1).max(32).optional(),
  sourceId: z.uuid().optional(),
  dependencyState: z.enum(['ready', 'invalid', 'none']).optional(),
});
export const loopCheckpointSchema = executionIdentitySchema.extend({
  version: z.literal(1),
  revision: generation,
  userMessageId: identifier,
  state: executionStateSchema,
  elapsedMs: counter,
  iteration: counter,
  stagnant: counter,
  limits: loopLimitsSchema,
  budget: loopBudgetSchema,
  privateContent: z.boolean(),
  memoryContent: z.boolean(),
  pendingProviderWork: z.boolean(),
  spendingLimit: counter.optional(),
  steering: z.array(steeringText).max(8),
  question: executionSnapshotSchema.shape.question,
  receipts: z.array(loopReceiptSchema).max(48),
});
export type LoopCheckpoint = z.infer<typeof loopCheckpointSchema>;
export const managedExecutionSchema = executionIdentitySchema.extend({
  userMessageId: identifier,
  recovery: loopCheckpointSchema.optional(),
});
export type ManagedExecution = z.infer<typeof managedExecutionSchema>;

export const loopRecoveryRequestSchema = executionIdentitySchema.extend({
  conversationId: identifier,
  assistantMessageId: identifier,
});
export type LoopRecoveryRequest = z.infer<typeof loopRecoveryRequestSchema>;
