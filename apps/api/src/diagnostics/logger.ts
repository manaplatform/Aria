import { randomUUID } from 'node:crypto';
import {
  defaultDiagnosticConfig,
  diagnosticConfigSchema,
  diagnosticEventSchema,
  type DiagnosticContext,
  type DiagnosticLevel,
  type DiagnosticMetadata,
} from '@aria/shared';

type ParentPort = { postMessage(message: unknown): void };
let config = structuredClone(defaultDiagnosticConfig);
const rank: Record<DiagnosticLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};
export function configureDiagnostics(input: unknown) {
  const parsed = diagnosticConfigSchema.safeParse(input);
  if (parsed.success) config = parsed.data;
}
const port = () => (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
// Only fixed, structured fields cross the utility-process boundary; messages and errors never do.
export function diagnostic(
  level: DiagnosticLevel,
  component: string,
  subsystem: string,
  event: string,
  context: DiagnosticContext,
  metadata: DiagnosticMetadata = {},
) {
  try {
    if (
      (level === 'trace' && !config.trace) ||
      (level === 'debug' && !config.debug) ||
      rank[level] < rank[config.components[component] ?? config.level]
    )
      return;
    const parent = port();
    if (!parent || process.env.ARIA_MANAGED !== '1') return;
    const entry = diagnosticEventSchema.safeParse({
      version: 1,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      component,
      subsystem,
      event,
      message: event.replace(/[._-]+/g, ' '),
      context,
      processId: process.pid,
      appVersion: 'managed',
      metadata,
    });
    if (!entry.success) return;
    parent.postMessage({ type: 'diagnostic', entry: entry.data });
  } catch {
    /* Diagnostics must not interrupt execution. */
  }
}
