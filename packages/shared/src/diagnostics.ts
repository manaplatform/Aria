import { z } from 'zod';

export const diagnosticLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export const diagnosticLevelSchema = z.enum(diagnosticLevels);
export type DiagnosticLevel = z.infer<typeof diagnosticLevelSchema>;
const safeId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\w.:/-]+$/);
export const diagnosticContextSchema = z.strictObject({
  sessionId: safeId.optional(),
  conversationId: safeId.optional(),
  executionId: safeId.optional(),
  requestId: safeId.optional(),
  correlationId: safeId.optional(),
  operationId: safeId.optional(),
  parentOperationId: safeId.optional(),
  generation: z.number().int().positive().optional(),
});
export type DiagnosticContext = z.infer<typeof diagnosticContextSchema>;
// Metadata is intentionally restricted to fixed, non-content fields. Never add raw tool inputs here.
export const diagnosticMetadataSchema = z.strictObject({
  status: safeId.optional(),
  capability: safeId.optional(),
  provider: safeId.optional(),
  model: safeId.optional(),
  phase: safeId.optional(),
  reason: safeId.optional(),
  code: safeId.optional(),
  count: z.number().finite().optional(),
  inputTokens: z.number().finite().optional(),
  outputTokens: z.number().finite().optional(),
  iteration: z.number().finite().optional(),
  retry: z.number().finite().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
  firstTokenMs: z.number().finite().nonnegative().optional(),
  dropped: z.number().finite().optional(),
  temporary: z.boolean().optional(),
});
export type DiagnosticMetadata = z.infer<typeof diagnosticMetadataSchema>;
export const diagnosticErrorSchema = z.strictObject({
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,60}$/)
    .optional(),
  frames: z.array(z.string().regex(/^at \[application\]:\d+:\d+$/)).max(20),
  causes: z
    .array(
      z
        .object({
          code: z
            .string()
            .regex(/^[A-Z][A-Z0-9_]{1,60}$/)
            .optional(),
        })
        .strict(),
    )
    .max(4),
});
export type DiagnosticError = z.infer<typeof diagnosticErrorSchema>;
export const diagnosticEventSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  level: diagnosticLevelSchema,
  component: safeId,
  subsystem: safeId,
  event: safeId,
  message: z.string().max(240),
  context: diagnosticContextSchema,
  processId: z.number().int().nonnegative(),
  appVersion: z.string().max(40),
  metadata: diagnosticMetadataSchema,
  error: diagnosticErrorSchema.optional(),
});
export type DiagnosticEvent = z.infer<typeof diagnosticEventSchema>;
export const diagnosticConfigSchema = z.strictObject({
  level: diagnosticLevelSchema,
  debug: z.boolean(),
  trace: z.boolean(),
  components: z.record(safeId, diagnosticLevelSchema).refine((v) => Object.keys(v).length <= 64),
  retentionDays: z.number().int().min(1).max(90),
  maxBytes: z.number().int().min(1_000_000).max(1_000_000_000),
});
export type DiagnosticConfig = z.infer<typeof diagnosticConfigSchema>;
export const defaultDiagnosticConfig: DiagnosticConfig = {
  level: 'info',
  debug: false,
  trace: false,
  components: {},
  retentionDays: 7,
  maxBytes: 100_000_000,
};
export const diagnosticFilterSchema = z.strictObject({
  level: diagnosticLevelSchema.optional(),
  component: safeId.optional(),
  search: z.string().max(200).optional(),
  executionId: safeId.optional(),
  executionIds: z.array(safeId).max(100).optional(),
  correlationId: safeId.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.number().int().min(0).max(1_000_000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type DiagnosticFilter = z.infer<typeof diagnosticFilterSchema>;
export type DiagnosticPage = { events: DiagnosticEvent[]; nextCursor?: number };
export type DiagnosticStatus = {
  config: DiagnosticConfig;
  bytes: number;
  dropped: number;
  error: boolean;
};

export interface DiagnosticSink {
  enabled(level: DiagnosticLevel, component: string): boolean;
  log(
    level: DiagnosticLevel,
    component: string,
    subsystem: string,
    event: string,
    context?: DiagnosticContext,
    metadata?: DiagnosticMetadata,
    temporary?: boolean,
    error?: unknown,
  ): void;
}

/** A context-bound facade; disabled events never construct their metadata. */
export class DiagnosticLogger {
  constructor(
    private readonly sink: DiagnosticSink,
    private readonly component: string,
    private readonly subsystem: string,
    private readonly context: DiagnosticContext = {},
    private readonly metadata: DiagnosticMetadata = {},
    private readonly temporary = false,
  ) {}
  child(context: DiagnosticContext, metadata: DiagnosticMetadata = {}) {
    return new DiagnosticLogger(
      this.sink,
      this.component,
      this.subsystem,
      { ...this.context, ...context },
      { ...this.metadata, ...metadata },
      this.temporary,
    );
  }
  emit(
    level: DiagnosticLevel,
    event: string,
    metadata?: () => DiagnosticMetadata,
    error?: unknown,
  ) {
    try {
      if (!this.sink.enabled(level, this.component)) return;
      this.sink.log(
        level,
        this.component,
        this.subsystem,
        event,
        this.context,
        { ...this.metadata, ...metadata?.() },
        this.temporary,
        error,
      );
    } catch {
      /* Logging cannot alter application behavior. */
    }
  }
}
