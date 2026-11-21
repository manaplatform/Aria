import { z } from 'zod';

export const programLimits = {
  code: 16_000,
  frame: 48_000,
  result: 12_000,
  intermediate: 2_000_000,
  toolCalls: 8,
  parallel: 3,
  milliseconds: 80_000,
} as const;

export const programSettingsSchema = z.strictObject({
  backend: z.enum(['off', 'managed', 'openai-responses']),
  continuation: z.enum(['stateless', 'stored']),
  toolCalls: z.number().int().min(1).max(12),
  parallel: z.number().int().min(1).max(3),
  milliseconds: z.number().int().min(5000).max(120_000),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
});
export type ProgramSettings = z.infer<typeof programSettingsSchema>;
export const defaultProgramSettings: ProgramSettings = {
  backend: 'off',
  continuation: 'stateless',
  toolCalls: programLimits.toolCalls,
  parallel: programLimits.parallel,
  milliseconds: programLimits.milliseconds,
};

const toolId = z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
const reference = z.string().min(1).max(256);
const fields = z.enum(['string', 'number', 'boolean', 'array', 'object', 'null']);
const contractKey = z.string().max(80).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);
export const programRequestSchema = z.strictObject({
  objective: z.string().trim().min(1).max(500),
  termination: z.string().trim().min(1).max(500),
  tools: z.array(toolId).max(8),
  code: z.string().min(1).max(programLimits.code),
  dataContract: z
    .array(z.strictObject({ key: contractKey, type: fields }))
    .max(12)
    .refine((items) => new Set(items.map(({ key }) => key)).size === items.length),
});
export type ProgramRequest = z.infer<typeof programRequestSchema>;

export const programStatus = z.enum(['complete', 'partial', 'failed', 'cancelled', 'uncertain']);
export const programValueSchema = z.strictObject({
  objective: z.string().trim().min(1).max(500),
  data: z.json(),
  missing: z.array(z.string().max(300)).max(12),
  checks: z.array(z.strictObject({ name: z.string().max(120), passed: z.boolean() })).max(12),
  evidence: z.array(reference).max(24),
  artifacts: z.array(reference).max(8),
  warnings: z.array(z.string().max(300)).max(8).optional(),
});
export type ProgramValue = z.infer<typeof programValueSchema>;

export const programCallSchema = z.strictObject({
  type: z.literal('call'),
  id: z.number().int().min(1).max(64),
  handle: z.string().uuid(),
  input: z.json(),
});
export const programFrameSchema = z.discriminatedUnion('type', [
  programCallSchema,
  z.strictObject({ type: z.literal('result'), value: z.json() }),
  z.strictObject({
    type: z.literal('failure'),
    code: z.enum(['INVALID_PROGRAM', 'BUDGET_EXCEEDED', 'EXECUTION_FAILED']),
  }),
]);
export type ProgramFrame = z.infer<typeof programFrameSchema>;
export const programReplySchema = z.strictObject({
  id: programCallSchema.shape.id,
  value: z.json(),
});

export const programChildRecordSchema = z.strictObject({
  callId: reference,
  tool: toolId,
  version: z.string().min(1).max(100),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const programJournalSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('open'),
    backend: z.enum(['managed', 'openai-responses']),
    deadline: z.number().int().positive(),
  }),
  programChildRecordSchema.extend({ action: z.literal('reserve') }),
  z.strictObject({
    action: z.literal('receipt'),
    callId: programChildRecordSchema.shape.callId,
    state: z.enum(['completed', 'failed', 'blocked', 'cancelled', 'uncertain']),
    stepId: z.string().uuid(),
  }),
  z.strictObject({ action: z.literal('finish'), state: programStatus }),
]);

// Bound nesting before handing model or guest values to recursive validators or serializers.
export function programJson(value: unknown, maximum: number): z.infer<ReturnType<typeof z.json>> {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++visited > maximum || entry.depth > 24) throw new Error('Program value exceeds its limit.');
    const node = entry.value;
    if (node === null || typeof node === 'string' || typeof node === 'boolean') continue;
    if (typeof node === 'number' && Number.isFinite(node)) continue;
    if (typeof node !== 'object' || !node) throw new Error('Invalid program JSON value.');
    const members = Object.entries(node);
    if (members.length + pending.length + visited > maximum)
      throw new Error('Program value exceeds its limit.');
    for (const [key, child] of members) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype')
        throw new Error('Invalid program JSON key.');
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximum)
    throw new Error('Program value exceeds its byte limit.');
  return value as z.infer<ReturnType<typeof z.json>>;
}
