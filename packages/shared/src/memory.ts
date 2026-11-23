import { z } from 'zod';
import { identifier } from './model-registry.js';

export const memoryCategories = [
  'episode',
  'fact',
  'preference',
  'procedure',
  'project',
  'task',
] as const;
export const memoryCategory = z.enum(memoryCategories);
export const memoryTaskState = z.enum([
  'pending',
  'in-progress',
  'waiting',
  'completed',
  'cancelled',
  'expired',
]);
const reference = z.string().uuid();
const time = z.number().int().nonnegative().max(8_640_000_000_000_000);
const name = z.string().trim().min(1).max(100);
const content = z.string().trim().min(1).max(1400);

export const memorySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  retentionDays: z.number().int().min(1).max(3650).nullable(),
  suggestions: z.boolean(),
  temporaryChats: z.boolean(),
  embedding: z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('lexical') }),
    z.strictObject({ mode: z.literal('local') }),
    z.strictObject({ mode: z.literal('remote'), connectionId: reference, model: name }),
  ]),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;
export const defaultMemorySettings: MemorySettings = {
  enabled: false,
  retentionDays: null,
  suggestions: false,
  temporaryChats: true,
  embedding: { mode: 'lexical' },
};

export const memoryEntity = z.strictObject({
  name,
  kind: z.enum([
    'project',
    'person',
    'organization',
    'repository',
    'file',
    'application',
    'conversation',
    'task',
    'technology',
    'decision',
  ]),
  aliases: z.array(name).max(4).optional(),
  id: reference.optional(),
  qualifier: name.optional(),
});
export const memoryInput = z.strictObject({
  category: memoryCategory,
  content,
  factKey: name.optional(),
  importance: z.number().int().min(0).max(3).optional(),
  expiresAt: time.optional(),
  taskState: memoryTaskState.optional(),
  dependsOn: z.array(reference).max(6).optional(),
  entities: z.array(memoryEntity).max(6).optional(),
  relationships: z
    .array(
      z.strictObject({
        from: z.number().int().min(0).max(5),
        to: z.number().int().min(0).max(5),
        relation: name,
      }),
    )
    .max(6)
    .optional(),
});
export type MemoryInput = z.infer<typeof memoryInput>;

export const memorySearch = z.strictObject({
  query: z.string().trim().min(1).max(400).optional(),
  match: z.enum(['terms', 'phrase', 'hybrid', 'semantic']).optional(),
  category: memoryCategory.optional(),
  entity: name.optional(),
  expand: z.boolean().optional(),
  from: time.optional(),
  to: time.optional(),
  historical: z.boolean().optional(),
  scope: z.enum(['conversation', 'project', 'profile']).optional(),
  limit: z.number().int().min(1).max(30).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

const edit = z.strictObject({
  id: reference,
  revision: z.number().int().positive(),
  value: memoryInput,
});
const forget = edit.pick({ id: true, revision: true });
export const memoryOperations = {
  'memory.search': memorySearch,
  'memory.read': z.strictObject({ id: reference, historical: z.boolean().optional() }),
  'memory.get_context': z.strictObject({}),
  'memory.get_project_context': z.strictObject({
    limit: memorySearch.shape.limit,
    cursor: memorySearch.shape.cursor,
  }),
  'memory.get_pending_tasks': z.strictObject({
    limit: memorySearch.shape.limit,
    cursor: memorySearch.shape.cursor,
  }),
  'memory.get_timeline': memorySearch.pick({
    from: true,
    to: true,
    category: true,
    scope: true,
    limit: true,
    cursor: true,
  }),
  'memory.resolve_entity': z.strictObject({ name, kind: memoryEntity.shape.kind.optional() }),
  'memory.remember': z.strictObject({
    value: memoryInput,
    scope: z.enum(['conversation', 'project', 'profile']).optional(),
  }),
  'memory.update': edit,
  'memory.forget': forget,
} as const;

export const memoryCandidates = z.array(memoryInput).max(3);
export const memorySuggestions = z.array(z.string().trim().min(3).max(160)).max(3);
export const memoryClear = z.strictObject({
  category: memoryCategory.optional(),
  projectId: identifier.optional(),
});

export const memoryManagementSearch = memorySearch.extend({
  projectId: identifier.optional(),
  conversationId: identifier.optional(),
  pending: z.boolean().optional(),
});
export type MemorySearch = z.infer<typeof memoryManagementSearch>;
export const memorySource = z.strictObject({
  conversationId: identifier,
  messageId: identifier,
});
export type MemorySource = z.infer<typeof memorySource>;
export type MemoryScope =
  { kind: 'profile' } | { kind: 'project'; id: string } | { kind: 'conversation'; id: string };

export interface MemoryRecord {
  id: string;
  revision: number;
  scope: MemoryScope;
  value: MemoryInput;
  sources: MemorySource[];
  origin: 'user' | 'extractive';
  confirmation: 'confirmed' | 'inferred';
  confidence: number;
  sensitivity: 'private';
  state: 'active' | 'superseded' | 'conflicting' | 'expired';
  supersedes?: string;
  createdAt: number;
  updatedAt: number;
  observedAt: number;
}
export interface MemorySearchResult {
  records: MemoryRecord[];
  cursor?: string;
}
export interface MemoryDiagnostics {
  searches: number;
  hits: number;
  searchMs: number;
  candidates: number;
  duplicates: number;
  databaseBytes: number;
  walBytes: number;
  workerHeapBytes: number;
  embeddingRequests: number;
  embeddingMs: number;
  extractionBatches: number;
  extractionMs: number;
}

export interface MemoryStatus {
  settings: MemorySettings;
  state: 'ready' | 'unavailable';
  embedding: 'lexical' | 'ready' | 'unavailable' | 'indexing' | 'approval-required';
  records: number;
  pending: number;
  failures: number;
}
export interface MemoryTurnOptions {
  enabled: boolean;
  suggestions: boolean;
  temporary?: boolean;
  workingSummary?: string;
  privateHistory?: boolean;
}
