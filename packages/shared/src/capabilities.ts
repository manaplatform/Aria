import { z } from 'zod';
import {
  openAIRuntimeFeatureSchema,
  runtimeCallSchema,
  runtimeResultSchema,
} from './execution-runtime.js';
import { identifier } from './model-registry.js';
import { programSettingsSchema, type ProgramSettings } from './programmatic.js';

export const capabilityId = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
export const effectSchema = z.enum(['read', 'local', 'billable', 'consequential']);
export const toolDiscoverySchema = z.enum(['aria', 'openai-responses']);
export const skillRefSchema = z.strictObject({
  id: capabilityId,
  version: z.string().max(100).min(1),
});
export const skillSummarySchema = skillRefSchema.extend({
  name: z.string().max(64).min(1),
  description: z.string().max(1024).min(1),
  compatibility: z.string().max(500).optional(),
  provenance: z.enum(['builtin', 'local']),
  dependencies: z.array(z.string().max(100)).max(32),
  enabled: z.boolean(),
});
export const builtinSourceSkill = {
  id: 'skills.compare_sources',
  name: 'compare-sources',
  version: '1',
  description:
    'Compare claims from independent sources, reconcile disagreements, and cite publisher evidence.',
  provenance: 'builtin',
  dependencies: [],
  enabled: true,
} satisfies SkillSummary;

export const toolPolicySchema = z.strictObject({
  revision: identifier,
  disabled: z.array(capabilityId).max(1024),
  discovery: toolDiscoverySchema,
  nativeVerified: z.boolean().optional(),
  desktopRuntime: z.boolean().optional(),
  computerBrowser: z.boolean().optional(),
  computerVirtual: z.boolean().optional(),
  computerLocal: z.boolean().optional(),
  nativeRuntime: z.array(openAIRuntimeFeatureSchema).max(5).optional(),
  programming: programSettingsSchema.optional(),
  nativeProgramVerified: z.boolean().optional(),
  skills: z.array(skillSummarySchema).max(128),
});
export const defaultToolPolicy: ToolPolicy = {
  revision: 'initial',
  disabled: [],
  discovery: 'aria',
  skills: [builtinSourceSkill],
};

export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SkillRef = z.infer<typeof skillRefSchema>;
export type ToolEffect = z.infer<typeof effectSchema>;
export type ToolDiscovery = z.infer<typeof toolDiscoverySchema>;
export interface ToolSummary {
  id: string;
  namespace: string;
  name: string;
  description: string;
  version: string;
  provenance: string;
  effect: ToolEffect;
  permission: string;
  available: boolean;
  reason?: string;
  programmatic?: ('managed' | 'openai-responses')[];
}

export interface SkillPreview {
  token: string;
  skill: SkillSummary;
  instructions: string;
  resources: string[];
}

export interface SkillResource {
  id: string;
  name: string;
}

export interface SkillContent {
  text: string;
  resources?: SkillResource[];
  scripts?: SkillResource[];
  programs?: SkillResource[];
  nextOffset?: number;
}

export const toolProblemSchema = z.strictObject({
  code: z.enum([
    'INVALID_ARGUMENT',
    'CAPABILITY_UNAVAILABLE',
    'PERMISSION_DENIED',
    'BUDGET_EXCEEDED',
    'DUPLICATE_DISPATCH',
    'OUTCOME_UNCERTAIN',
    'TIMEOUT',
    'EXECUTION_FAILED',
    'CANCELLED',
    'INVALID_PROGRAM',
    'INVALID_TOOL_OUTPUT',
    'CALLER_MISMATCH',
    'CONTINUATION_FAILED',
    'INVALID_REFERENCE',
  ]),
  message: z.string().max(2000),
});
export type ToolProblem = z.infer<typeof toolProblemSchema>;

export type OpenAISkillBinding =
  | { type: 'skill_reference'; skill_id: string; version: string }
  | {
      type: 'inline';
      name: string;
      description: string;
      source: { type: 'base64'; media_type: 'application/zip'; data: string };
    };

export interface ToolSettings {
  discovery: ToolDiscovery;
  nativeVerified: boolean;
  tools: ToolSummary[];
  skills: SkillSummary[];
  programming?: ProgramSettings;
  nativeProgramVerified?: boolean;
}

const scope = {
  requestId: identifier,
  conversationId: identifier,
  assistantMessageId: identifier,
  revision: identifier,
  voiceSessionId: identifier.optional(),
};
export const capabilityHostRequest = z.discriminatedUnion('type', [
  runtimeCallSchema.extend({ ...scope, id: z.string().uuid(), type: z.literal('runtime') }),
  z.strictObject({
    ...scope,
    id: z.string().uuid(),
    type: z.literal('reserve'),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    operation: z.strictObject({
      id: capabilityId,
      stepId: identifier,
      callId: z.string().min(1).max(256),
    }).optional(),
  }),
  z.strictObject({
    ...scope,
    id: z.string().uuid(),
    type: z.literal('receipt'),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['completed', 'failed', 'uncertain']),
  }),
  z.strictObject({
    ...scope,
    id: z.string().uuid(),
    type: z.literal('skill'),
    skill: skillRefSchema,
    resourceId: z.string().uuid().optional(),
    offset: z.number().int().min(0).max(1_048_576),
  }),
]);
export const capabilityHostReply = z.discriminatedUnion('ok', [
  z.strictObject({
    id: z.string().uuid(),
    ok: z.literal(true),
    runtime: runtimeResultSchema.optional(),
    content: z
      .strictObject({
        text: z.string().max(12_000),
        resources: z
          .array(z.strictObject({ id: z.string().uuid(), name: z.string().max(240) }))
          .max(256)
          .optional(),
        scripts: z
          .array(z.strictObject({ id: z.string().uuid(), name: z.string().max(240) }))
          .max(256)
          .optional(),
        programs: z.array(z.object({ id: z.string().uuid(), name: z.string().max(240) })).max(256).optional(),
        nextOffset: z.number().int().positive().optional(),
      })
      .optional(),
  }),
  z.strictObject({
    id: z.string().uuid(),
    ok: z.literal(false),
    code: toolProblemSchema.shape.code,
    message: z.string().max(400).optional(),
  }),
]);
export type CapabilityHostRequest = z.infer<typeof capabilityHostRequest>;
export type CapabilityHostReply = z.infer<typeof capabilityHostReply>;
