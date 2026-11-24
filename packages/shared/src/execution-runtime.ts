import { z } from 'zod';
import { memoryOperations } from './memory.js';
import { computerImage, computerOperations } from './computer-use.js';
import { loopLimitsSchema } from './loop.js';

const id = z.string().uuid();
export const openAIRuntimeFeatureSchema = z.enum([
  'hosted-shell',
  'local-shell',
  'file-search',
  'computer',
  'computer-image',
]);
export type OpenAIRuntimeFeature = z.infer<typeof openAIRuntimeFeatureSchema>;
export const executionLimits = {
  commandMs: 60_000,
  operationMs: 110_000,
  commandOutputBytes: 6_000,
  workspaces: 3,
  idleMs: 20 * 60_000,
  assetBytes: 20_000_000,
  searchResults: 6,
  indexedCharacters: 1_000_000,
} as const;

export const workspaceFilename = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u);

export const runtimeOperations = {
  ...computerOperations,
  ...memoryOperations,
  'shell.inspect': z.strictObject({}),
  'shell.open': z.strictObject({
    inlineSkills: z
      .array(z.strictObject({ id: z.string().max(100), version: z.string().max(100) }))
      .max(2)
      .optional(),
    backend: z.enum(['managed', 'openai-local', 'openai-hosted']),
    allowDomains: z
      .array(
        z
          .string()
          .min(4)
          .max(253)
          .regex(/^[a-z0-9.-]+$/i),
      )
      .max(8)
      .optional(),
    hostedSkills: z
      .array(
        z.strictObject({
          skill_id: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z0-9_-]+$/),
          version: z.string().regex(/^\d+$/).max(20),
        }),
      )
      .max(4)
      .optional(),
    inputs: z.array(id).max(8).optional(),
  }),
  'shell.run': z.strictObject({
    sessionId: id,
    commands: z.array(z.string().min(1).max(4000)).min(1).max(4),
    timeoutMs: z.number().int().min(100).max(executionLimits.commandMs).optional(),
  }),
  'shell.fetch': z.strictObject({
    sessionId: id,
    url: z.url({ protocol: /^https$/ }).max(500),
    name: workspaceFilename,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  'knowledge.prepare_search': z.strictObject({ fileIds: z.array(id).min(1).max(6) }),
  'knowledge.list': z.strictObject({}),
  'knowledge.search': z.strictObject({
    query: z.string().trim().min(1).max(500),
    mode: z.enum(['keyword', 'phrase', 'semantic', 'hybrid']),
    collectionIds: z.array(id).min(1).max(8).optional(),
    fileIds: z.array(id).min(1).max(8).optional(),
    limit: z.number().int().min(1).max(executionLimits.searchResults).optional(),
    alternatives: z.array(z.string().trim().min(1).max(300)).max(2).optional(),
    adjacent: z.boolean().optional(),
  }),
  'files.read_document': z.strictObject({
    fileId: id,
    offset: z.number().int().min(0).max(executionLimits.indexedCharacters).optional(),
  }),
  'skills.run_script': z.strictObject({
    sessionId: id,
    skill: z.strictObject({
      id: z.string().max(100),
      version: z.string().min(1).max(100),
    }),
    scriptId: id,
    arguments: z.array(z.string().max(500)).max(12).optional(),
    timeoutMs: z.number().int().min(100).max(executionLimits.commandMs).optional(),
  }),
  'artifacts.publish': z.strictObject({
    sessionId: id,
    filename: workspaceFilename,
  }),
} as const;

export type RuntimeOperation = keyof typeof runtimeOperations;
export type RuntimeArgs<Operation extends RuntimeOperation> = z.infer<
  (typeof runtimeOperations)[Operation]
>;

export const evidenceSchema = z.strictObject({
  id,
  fileId: id,
  name: z.string().min(1).max(255),
  version: z.string().regex(/^[a-f0-9]{64}$/),
  chunkId: z.string().min(1).max(150),
  collectionId: id.optional(),
  excerpt: z.string().max(1500),
  nearby: z
    .object({ before: z.string().max(200).optional(), after: z.string().max(200).optional() })
    .strict()
    .optional(),
  query: z.string().max(500),
  provenance: z.enum(['local', 'openai']),
  score: z.number().optional(),
  location: z
    .strictObject({
      kind: z.enum(['lines', 'page', 'sheet', 'slide', 'section']),
      start: z.number().int().positive(),
      end: z.number().int().positive(),
      label: z.string().max(200).optional(),
    })
    .optional(),
});
export const runtimeCallSchema = z.strictObject({
  operation: z.union([
    z.object(runtimeOperations).keyof(),
    z.literal('knowledge.record_native'),
    z.literal('hosted.resources'),
    z.literal('program.start'),
    z.literal('program.exchange'),
    z.literal('program.stop'),
    z.literal('program.journal'),
    z.literal('program.checkpoint'),
  ]),
  stepId: id,
  callId: z.string().min(1).max(256),
  programId: z.string().uuid().optional(),
  input: z.record(z.string(), z.unknown()),
  primary: z.strictObject({
    connectionId: id,
    model: z.string().min(1).max(200),
    endpoint: z.url(),
  }),
});

export type DocumentEvidence = z.infer<typeof evidenceSchema>;

export const desktopArtifactSchema = z.strictObject({
  id,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  size: z.number().int().min(1).max(64_000_000),
  storage: z.literal('desktop'),
});

export const runtimeResultSchema = z.strictObject({
  computerImage: computerImage.optional(),
  text: z.string().max(12_000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  evidence: z.array(evidenceSchema).max(executionLimits.searchResults).optional(),
  artifact: desktopArtifactSchema.optional(),
  privateContent: z.boolean().optional(),
  commandProblem: z
    .strictObject({
      code: z.enum(['EXECUTION_FAILED', 'TIMEOUT', 'CANCELLED', 'OUTCOME_UNCERTAIN']),
      message: z.string().max(400),
    })
    .optional(),
});
export type RuntimeResult = z.infer<typeof runtimeResultSchema>;

export const runtimeSettingsSchema = z.strictObject({
  engineSocket: z.string().max(1000),
  desktopImage: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  computerIdleMinutes: z.number().int().min(1).max(20).optional(),
  computerLifetimeMinutes: z.number().int().min(2).max(45).optional(),
  computerBatchLimit: z.number().int().min(1).max(8).optional(),
  artifactRetentionDays: z.number().int().min(1).max(365).optional(),
  embeddingTarget: z
    .strictObject({ connectionId: id, model: z.string().min(1).max(200) })
    .optional(),
  commandMs: z.number().int().min(100).max(executionLimits.commandMs),
  loop: loopLimitsSchema.optional(),
});
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export interface KnowledgeCollection {
  id: string;
  name: string;
  enabled: boolean;
  files: { id: string; name: string; status: 'queued' | 'ready' }[];
}

export interface ExecutionHistoryEntry {
  id: string;
  operation: string;
  state: string;
  started: number;
  elapsed: number | null;
  exitCode: number | null;
}
