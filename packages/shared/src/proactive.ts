import { z } from 'zod';
import { publicWebUrl } from './web.js';
import type { ConductorActivity } from './conductor.js';
import { defaultLoopLimits, loopLimitsSchema, managedExecutionSchema } from './loop.js';
import type { ChatRequest, MediaAsset } from './index.js';

const id = z.uuid();
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const title = z.string().trim().min(1).max(200);
const instruction = z.string().trim().min(1).max(4000);
const pageOffset = z.number().int().nonnegative().max(1_000_000);
const zone = z.string().min(1).max(100);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const webOrigin = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .refine((value) => {
    try {
      return publicWebUrl(value).origin === value;
    } catch {
      return false;
    }
  }, 'Supply a public site origin, such as https://example.com.');

export const proactiveKind = z.enum(['pulse', 'automation', 'agenda']);
export const proactiveJobState = z.enum([
  'scheduled',
  'queued',
  'running',
  'pausing',
  'paused',
  'waiting_approval',
  'waiting_user',
  'blocked',
  'retry_scheduled',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'uncertain',
  'skipped',
]);
export type ProactiveJobState = z.infer<typeof proactiveJobState>;
export const proactiveTerminal = new Set<ProactiveJobState>([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
export const proactiveRequestSchema = z.strictObject({
  kind: proactiveKind,
  jobId: id,
  attemptId: id,
  execution: managedExecutionSchema,
  expectedRevision: z.string().min(1).max(100),
  limits: loopLimitsSchema,
  spendingLimit: time,
  scope: z.strictObject({
    publicSearch: z.boolean(),
    publicOrigins: z.array(webOrigin).max(16),
    memory: z.boolean(),
  }),
  context: z.string().min(1).max(16_000),
  answer: z.string().trim().min(1).max(2000).optional(),
});
export type ProactiveRequest = z.infer<typeof proactiveRequestSchema>;

export function proactiveRunEnvelope(run: ProactiveRequest): ChatRequest {
  // Existing transports use these slots to correlate receipts. The owner is the job.
  return {
    requestId: run.attemptId,
    conversationId: run.jobId,
    assistantMessageId: run.jobId,
    messages: run.answer ? [{ role: 'user', content: run.answer }] : [],
    expectedRevision: run.expectedRevision,
    execution: run.execution,
    memory: { enabled: run.scope.memory, suggestions: false },
  };
}

export const missedSchedule = z.enum(['skip', 'run_once', 'catch_up']);
const calendar = { zone, followSystem: z.boolean().default(false), at: localTime };
const minutes = z.number().int().min(1).max(525_600);
export const proactiveTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), at: z.string().max(50), zone }),
  z.strictObject({ kind: z.literal('interval'), minutes, anchor: time }),
  z.strictObject({ kind: z.literal('daily'), ...calendar }),
  z.strictObject({
    kind: z.literal('weekly'),
    ...calendar,
    weekday: z.number().int().min(1).max(7),
  }),
  z.strictObject({ kind: z.literal('monthly'), ...calendar, day: z.number().int().min(1).max(31) }),
  z.strictObject({
    kind: z.literal('cron'),
    zone,
    followSystem: z.boolean().default(false),
    expression: z.string().trim().min(9).max(120),
  }),
  z.strictObject({
    kind: z.literal('condition'),
    minutes,
    anchor: time,
    origin: webOrigin,
    cooldownMinutes: minutes.default(30),
  }),
  z.strictObject({
    kind: z.literal('event'),
    event: z.enum(['runtime.resumed', 'desktop.unlocked']),
  }),
  z.strictObject({
    kind: z.literal('task_event'),
    event: z.enum(['task.completed', 'task.dependencies_ready']),
    taskId: id,
  }),
  z.strictObject({ kind: z.literal('manual') }),
]);
export type ProactiveTrigger = z.infer<typeof proactiveTriggerSchema>;

export const proactiveSettingsSchema = z.strictObject({
  pulseEnabled: z.boolean(),
  pulsePaused: z.boolean(),
  pulseMemory: z.boolean().default(false),
  intervalMinutes: minutes,
  mode: z.enum(['adaptive', 'always', 'pending']),
  background: z.boolean(),
  emergencyPaused: z.boolean(),
  quietHours: z.strictObject({ zone, start: localTime, end: localTime }).nullable(),
  nativeNotifications: z.boolean(),
  concurrency: z.number().int().min(1).max(2),
  dailyMicros: time.max(100_000_000_000),
  dailyInputTokens: time.max(100_000_000),
  dailyOutputTokens: time.max(100_000_000),
  retentionDays: z.number().int().min(1).max(365),
  missed: missedSchedule,
});
export type ProactiveSettings = z.infer<typeof proactiveSettingsSchema>;
export const defaultProactiveSettings: ProactiveSettings = {
  pulseEnabled: false,
  pulsePaused: false,
  pulseMemory: false,
  intervalMinutes: 30,
  mode: 'adaptive',
  background: false,
  emergencyPaused: false,
  quietHours: null,
  nativeNotifications: false,
  concurrency: 1,
  dailyMicros: 1_000_000,
  dailyInputTokens: 200_000,
  dailyOutputTokens: 32_000,
  retentionDays: 30,
  missed: 'run_once',
};
export const defaultProactiveLimits = {
  ...defaultLoopLimits,
  iterations: 6,
  steps: 12,
  inputTokens: 48_000,
  outputTokens: 12_288,
  activeMs: 120_000,
  toolMs: 35_000,
  concurrency: 2,
  readRetries: 1,
};

export const proactiveScopeSchema = proactiveRequestSchema.shape.scope;
export const automationDraftSchema = z.strictObject({
  title,
  instruction,
  action: instruction,
  trigger: proactiveTriggerSchema,
  scope: proactiveScopeSchema,
  expiresAt: time.nullable().default(null),
  missed: missedSchedule.optional(),
  notifications: z.enum(['meaningful', 'all', 'none']).default('meaningful'),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  limits: loopLimitsSchema.default(defaultProactiveLimits),
  maxMicros: time.max(100_000_000_000).default(150_000),
});
export type AutomationDraft = z.infer<typeof automationDraftSchema>;
export const taskPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export const taskState = z.enum([
  'draft',
  'pending',
  'ready',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
]);
export const objectiveState = z.enum(['open', 'active', 'blocked', 'completed', 'cancelled']);
export const agendaTaskDraft = z.strictObject({
  title,
  description: z.string().trim().max(4000).default(''),
  blocker: z.string().trim().max(400).default(''),
  priority: taskPriority.default('normal'),
  deadline: time.nullable().default(null),
  objectiveId: id.nullable().default(null),
  parentId: id.nullable().default(null),
  dependencies: z.array(id).max(32).default([]),
});
export const agendaObjectiveDraft = z.strictObject({
  title,
  description: z.string().trim().max(4000).default(''),
});
export const pulseActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('no_action') }),
  z.strictObject({ action: z.literal('create_task'), task: agendaTaskDraft }),
  z.strictObject({ action: z.literal('execute_task'), id, revision }),
  z.strictObject({ action: z.literal('continue_task'), id, revision }),
  z.strictObject({ action: z.literal('update_task'), id, revision, task: agendaTaskDraft }),
  z.strictObject({ action: z.literal('schedule_follow_up'), automation: automationDraftSchema }),
  z.strictObject({ action: z.literal('notify_user'), message: title }),
  z.strictObject({ action: z.literal('request_approval'), message: title }),
  z.strictObject({ action: z.literal('request_clarification'), question: title }),
  z.strictObject({ action: z.literal('complete_objective'), id, revision }),
]);

const recordRef = { id, revision };
export const proactiveOperations = {
  'agenda.list_tasks': z.strictObject({
    offset: pageOffset.optional(),
    state: taskState.optional(),
  }),
  'agenda.get_task': z.strictObject({ id }),
  'agenda.create_task': agendaTaskDraft,
  'agenda.update_task': z.strictObject({ ...recordRef, task: agendaTaskDraft }),
  'agenda.complete_task': z.strictObject(recordRef),
  'agenda.cancel_task': z.strictObject(recordRef),
  'agenda.list_objectives': z.strictObject({ offset: pageOffset.optional() }),
  'agenda.create_objective': agendaObjectiveDraft,
  'agenda.get_job': z.strictObject({ id }),
  'automation.list': z.strictObject({ offset: pageOffset.optional() }),
  'automation.create': automationDraftSchema,
  'automation.update': z.strictObject({ ...recordRef, automation: automationDraftSchema }),
  'automation.pause': z.strictObject(recordRef),
  'automation.resume': z.strictObject(recordRef),
  'automation.delete': z.strictObject(recordRef),
  'automation.run_now': z.strictObject(recordRef),
  'automation.report_condition': z.strictObject({
    result: z.enum(['met', 'not_met', 'unknown']),
    evidenceStepId: id.optional(),
  }),
  'pulse.get_status': z.strictObject({}),
  'pulse.submit_actions': z.strictObject({ actions: z.array(pulseActionSchema).min(1).max(8) }),
  'notification.propose': z.strictObject({ message: title }),
} as const;
export type ProactiveOperation = keyof typeof proactiveOperations;
export const proactiveOperationIds = Object.keys(proactiveOperations) as ProactiveOperation[];
export const proactiveReadOperations = new Set<ProactiveOperation>([
  'agenda.list_tasks',
  'agenda.get_task',
  'agenda.list_objectives',
  'agenda.get_job',
  'automation.list',
  'pulse.get_status',
]);

const command = { commandId: id };
export const proactiveCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('snapshot'),
    offset: pageOffset.optional(),
    query: z.string().trim().max(100).optional(),
    taskState: taskState.optional(),
    priority: taskPriority.optional(),
  }),
  z.strictObject({
    action: z.literal('settings'),
    ...command,
    revision,
    value: proactiveSettingsSchema,
  }),
  z.strictObject({ action: z.literal('pulse'), ...command }),
  z.strictObject({ action: z.literal('task_create'), ...command, task: agendaTaskDraft }),
  z.strictObject({
    action: z.literal('task_update'),
    ...command,
    ...recordRef,
    task: agendaTaskDraft,
  }),
  z.strictObject({
    action: z.literal('task_state'),
    ...command,
    ...recordRef,
    state: z.enum(['completed', 'cancelled']),
  }),
  z.strictObject({
    action: z.literal('task_run'),
    ...command,
    ...recordRef,
    scope: proactiveScopeSchema,
  }),
  z.strictObject({
    action: z.literal('objective_create'),
    ...command,
    objective: agendaObjectiveDraft,
  }),
  z.strictObject({
    action: z.literal('objective_update'),
    ...command,
    ...recordRef,
    objective: agendaObjectiveDraft,
  }),
  z.strictObject({
    action: z.literal('objective_state'),
    ...command,
    ...recordRef,
    state: z.enum(['completed', 'cancelled']),
  }),
  z.strictObject({ action: z.literal('automation_preview'), trigger: proactiveTriggerSchema }),
  z.strictObject({
    action: z.literal('automation_create'),
    ...command,
    automation: automationDraftSchema,
  }),
  z.strictObject({
    action: z.literal('automation_update'),
    ...command,
    ...recordRef,
    automation: automationDraftSchema,
  }),
  z.strictObject({
    action: z.literal('automation_control'),
    ...command,
    ...recordRef,
    control: z.enum(['enable', 'disable', 'pause', 'resume', 'delete', 'run_now']),
  }),
  z.strictObject({
    action: z.literal('job_reconcile'),
    ...command,
    ...recordRef,
    status: z.enum(['effect_verified', 'close_without_retry']),
  }),
  z.strictObject({
    action: z.literal('job_control'),
    ...command,
    ...recordRef,
    control: z.enum(['pause', 'resume', 'cancel', 'retry']),
  }),
  z.strictObject({
    action: z.literal('request_resolve'),
    ...command,
    ...recordRef,
    decision: z.enum(['approve', 'decline', 'answer']),
    text: z.string().trim().min(1).max(2000).optional(),
  }),
  z.strictObject({ action: z.literal('notification_read'), ...command, id }),
  z.strictObject({ action: z.literal('detail'), id }),
  z.strictObject({ action: z.literal('artifact_export'), jobId: id, id }),
  z.strictObject({ action: z.literal('memory_save'), jobId: id, revision }),
]);
export type ProactiveCommand = z.infer<typeof proactiveCommandSchema>;

type RecordBase = { id: string; revision: number; created: number; updated: number };
export type AgendaTask = RecordBase &
  z.infer<typeof agendaTaskDraft> & {
    state: z.infer<typeof taskState>;
    progress: number;
    completedBy: 'user' | 'verified_run' | null;
  };
export type AgendaObjective = RecordBase &
  z.infer<typeof agendaObjectiveDraft> & { state: z.infer<typeof objectiveState> };
export type ProactiveAutomation = RecordBase &
  AutomationDraft & {
    state: 'enabled' | 'paused' | 'disabled' | 'expired' | 'deleted';
    nextDue: number | null;
    lastRun: number | null;
    condition: 'met' | 'not_met' | null;
    permissionCurrent: boolean;
  };
export type ProactiveJob = RecordBase & {
  kind: z.infer<typeof proactiveKind>;
  ownerId: string | null;
  due: number;
  state: ProactiveJobState;
  generation: number;
  reason: string | null;
  result?: string;
};
export type ProactiveAttempt = {
  id: string;
  generation: number;
  started: number;
  finished: number | null;
  state: string;
  modelRequests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
};
export type ProactivePending = RecordBase & {
  kind: 'automation' | 'clarification' | 'approval';
  jobId: string | null;
  message: string;
  automation?: AutomationDraft;
};
export type ProactiveNotification = {
  id: string;
  category: string;
  jobId: string | null;
  targetId: string | null;
  targetKind: 'agenda' | 'automation' | 'job';
  message: string;
  created: number;
  read: boolean;
};
export type ProactiveSnapshot = {
  settings: ProactiveSettings;
  revision: number;
  ready: boolean;
  status?: string;
  pulse: {
    last: number | null;
    next: number | null;
    history: { at: number; state: string; reason: string | null }[];
  };
  counts: { open: number; running: number; blocked: number; objectives: number };
  metrics: {
    queued: number;
    attempts: number;
    retries: number;
    recoveries: number;
    pulseSkips: number;
    pulseDurationMs: number;
    pulseModelRequests: number;
    jobDurationMs: number;
    scheduleDelayMs: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
    duplicateClaims: number;
  };
  tasks: AgendaTask[];
  objectives: AgendaObjective[];
  automations: ProactiveAutomation[];
  jobs: ProactiveJob[];
  requests: ProactivePending[];
  notifications: ProactiveNotification[];
  nextOffset: number | null;
};
export type ProactiveResult =
  | { kind: 'snapshot'; value: ProactiveSnapshot }
  | {
      kind: 'detail';
      task?: AgendaTask;
      objective?: AgendaObjective;
      automation?: ProactiveAutomation;
      job?: ProactiveJob;
      attempts: ProactiveAttempt[];
      history: ProactiveJob[];
      activity?: ConductorActivity[];
      artifacts?: MediaAsset[];
    }
  | { kind: 'preview'; times: number[] }
  | { kind: 'accepted'; id?: string }
  | {
      kind: 'error';
      code: 'validation' | 'conflict' | 'permission' | 'unavailable';
      message: string;
    };
export type ProactiveEvent = {
  sequence: number;
  target?: { kind: 'agenda' | 'automation' | 'job'; id: string };
};
