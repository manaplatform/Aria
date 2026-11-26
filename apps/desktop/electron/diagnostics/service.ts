import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  defaultDiagnosticConfig,
  diagnosticConfigSchema,
  diagnosticEventSchema,
  type DiagnosticConfig,
  type DiagnosticContext,
  type DiagnosticEvent,
  type DiagnosticFilter,
  type DiagnosticLevel,
  type DiagnosticMetadata,
  type DiagnosticPage,
  type DiagnosticError,
} from '@aria/shared';

const priorities: Record<DiagnosticLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};
const maxFileBytes = 10_000_000;
const maxQueue = 2000;
const maxLive = 500;
const secret =
  /(?:bearer|authorization|password|cookie|secret|token|api[_-]?key|private[_-]?key|github_pat_|gh[pousr]_|sk-[a-z0-9])/i;
const safeValue = (value: string) =>
  !secret.test(value) && !value.includes('://') && !value.includes('..');

function safeError(error: unknown): DiagnosticError | undefined {
  if (!(error instanceof Error)) return undefined;
  try {
    const code = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('code' in value)) return undefined;
      const item = value.code;
      return typeof item === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(item) && safeValue(item)
        ? item
        : undefined;
    };
    const frames = (error.stack ?? '')
      .split('\n')
      .slice(1)
      .flatMap((line) => {
        const match = /:(\d+):(\d+)\)?$/.exec(line);
        return match ? [`at [application]:${match[1]}:${match[2]}`] : [];
      })
      .slice(0, 20);
    const causes: { code?: string }[] = [];
    let current: unknown = error.cause;
    for (let i = 0; i < 4 && current instanceof Error; i++) {
      causes.push({ code: code(current) });
      current = current.cause;
    }
    return { code: code(error), frames, causes };
  } catch {
    return { frames: [], causes: [] };
  }
}

export class Diagnostics {
  private config: DiagnosticConfig = structuredClone(defaultDiagnosticConfig);
  private readonly sessionId = randomUUID();
  private queue: DiagnosticEvent[] = [];
  private temporary: DiagnosticEvent[] = [];
  private pendingLive: DiagnosticEvent[] = [];
  private liveTimer?: ReturnType<typeof setTimeout>;
  private writeTimer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private configWriting: Promise<void> = Promise.resolve();
  private bytes = 0;
  private dropped = 0;
  private failed = false;
  private directoryIdentity?: { dev: number; ino: number };
  private closed = false;
  private filename = '';
  private size = 0;
  readonly directory: string;

  constructor(
    root: string,
    private readonly appVersion: string,
    private readonly publish?: (events: DiagnosticEvent[]) => void,
    private readonly subscribed: () => boolean = () => true,
  ) {
    this.directory = path.join(root, 'logs');
  }
  async initialize(legacyLevel?: 'info' | 'warn' | 'error') {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Invalid diagnostic directory');
      if (process.platform !== 'win32') await fs.chmod(this.directory, 0o700);
      this.directoryIdentity = { dev: stat.dev, ino: stat.ino };
      try {
        const raw = await fs.readFile(path.join(this.directory, 'config.json'), 'utf8');
        this.config = diagnosticConfigSchema.parse(JSON.parse(raw));
      } catch {
        if (legacyLevel) this.config.level = legacyLevel;
      }
      await this.prune();
    } catch {
      this.failed = true;
      this.directoryIdentity = undefined;
    }
  }
  private async checkDirectory() {
    const info = await fs.lstat(this.directory);
    if (
      !this.directoryIdentity ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== this.directoryIdentity.dev ||
      info.ino !== this.directoryIdentity.ino
    )
      throw new Error('Diagnostic directory changed');
  }
  status() {
    return {
      config: structuredClone(this.config),
      bytes: this.bytes,
      dropped: this.dropped,
      error: this.failed,
    };
  }
  enabled(level: DiagnosticLevel, component: string) {
    if ((level === 'trace' && !this.config.trace) || (level === 'debug' && !this.config.debug))
      return false;
    return priorities[level] >= priorities[this.config.components[component] ?? this.config.level];
  }
  log(
    level: DiagnosticLevel,
    component: string,
    subsystem: string,
    event: string,
    context: DiagnosticContext = {},
    metadata: DiagnosticMetadata = {},
    temporary = false,
    error?: unknown,
  ) {
    try {
      if (!this.enabled(level, component) || this.closed) return;
      const clean = (input: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(input).filter(
            ([, value]) => typeof value !== 'string' || safeValue(value),
          ),
        );
      const candidate = {
        version: 1,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        level,
        component,
        subsystem,
        event,
        message: event.replace(/[._-]+/g, ' '),
        context: { ...clean(context), sessionId: this.sessionId },
        processId: process.pid,
        appVersion: this.appVersion,
        metadata: clean(metadata),
        error: safeError(error),
      };
      const parsed = diagnosticEventSchema.safeParse(candidate);
      if (!parsed.success || ![component, subsystem].every(safeValue)) {
        this.dropped++;
        return;
      }
      this.accept(parsed.data, temporary);
    } catch {
      this.dropped++;
      this.failed = true;
    }
  }

  acceptRemote(input: unknown, temporary: boolean) {
    try {
      const parsed = diagnosticEventSchema.safeParse(input);
      if (!parsed.success) {
        this.dropped++;
        return;
      }
      const e = parsed.data;
      if (!this.enabled(e.level, e.component) || this.closed) return;
      // Reconstruct the message and discard unsafe values, including anything from a child process.
      const safeEntries = (v: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(v).filter(([, x]) => typeof x !== 'string' || safeValue(x)),
        );
      const clean = diagnosticEventSchema.safeParse({
        ...e,
        message: e.event.replace(/[._-]+/g, ' '),
        context: { ...safeEntries(e.context), sessionId: this.sessionId },
        metadata: safeEntries(e.metadata),
        error: undefined,
        appVersion: this.appVersion,
      });
      const model =
        e.component === 'api' &&
        e.subsystem === 'model' &&
        [
          'model.selected',
          'model.started',
          'model.first_token',
          'model.completed',
          'model.failed',
          'model.cancelled',
        ].includes(e.event);
      const tool =
        e.component === 'conductor' &&
        e.subsystem === 'tool' &&
        /^tool\.(queued|running|approval|processing|completed|failed|blocked|cancelled|uncertain)$/.test(
          e.event,
        );
      const loop =
        e.component === 'conductor' &&
        e.subsystem === 'loop' &&
        ['loop.iteration', 'loop.no_progress'].includes(e.event);
      if (!clean.success || (!model && !tool && !loop)) {
        this.dropped++;
        return;
      }
      this.accept(clean.data, temporary);
    } catch {
      this.dropped++;
      this.failed = true;
    }
  }

  private accept(event: DiagnosticEvent, temporary: boolean) {
    if (temporary) {
      this.temporary.push(event);
      if (this.temporary.length > maxLive) {
        this.temporary.shift();
        this.dropped++;
      }
    } else {
      if (this.queue.length >= maxQueue) {
        this.dropped++;
        return;
      }
      this.queue.push(event);
      if (!this.writeTimer)
        this.writeTimer = setTimeout(() => {
          this.writeTimer = undefined;
          void this.flush();
        }, 100);
    }
    if (!this.publish || !this.subscribed()) return;
    if (this.pendingLive.length < maxLive) this.pendingLive.push(event);
    else this.dropped++;
    if (!this.liveTimer)
      this.liveTimer = setTimeout(() => {
        this.liveTimer = undefined;
        const batch = this.pendingLive.splice(0);
        try {
          this.publish?.(batch);
        } catch {
          /* The viewer is optional. */
        }
      }, 100);
  }
  discardTemporary(conversationId: string) {
    this.temporary = this.temporary.filter(
      (entry) => entry.context.conversationId !== conversationId,
    );
    this.pendingLive = this.pendingLive.filter(
      (entry) => entry.context.conversationId !== conversationId,
    );
  }
  async configure(value: DiagnosticConfig) {
    const config = diagnosticConfigSchema.parse(value);
    if (Object.keys(config.components).some((name) => !safeValue(name)))
      throw new Error('Invalid diagnostic component name.');
    this.config = config;
    this.configWriting = this.configWriting.then(async () => {
      try {
        await this.checkDirectory();
        const target = path.join(this.directory, 'config.json');
        const temp = path.join(this.directory, `.config-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
          await fs.rename(temp, target);
        } finally {
          await fs.rm(temp, { force: true }).catch(() => undefined);
        }
        await this.flush();
        const prune = this.writing.then(() => this.prune());
        this.writing = prune.catch(() => {
          this.failed = true;
        });
        await prune;
      } catch {
        this.failed = true;
      }
    });
    await this.configWriting;
    return this.status();
  }
  async flush() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    const batch = this.queue.splice(0);
    if (!batch.length) return this.writing;
    this.writing = this.writing.then(async () => {
      let written = 0;
      try {
        await this.checkDirectory();
        while (written < batch.length) {
          if (!this.filename || this.size >= Math.min(maxFileBytes, this.config.maxBytes)) {
            this.filename = `events-${Date.now()}-${randomUUID()}.jsonl`;
            this.size = 0;
          }
          const lines: string[] = [];
          let chunkBytes = 0;
          while (written + lines.length < batch.length) {
            const line = JSON.stringify(batch[written + lines.length]) + '\n';
            const length = Buffer.byteLength(line);
            if (this.size + chunkBytes + length > Math.min(maxFileBytes, this.config.maxBytes))
              break;
            lines.push(line);
            chunkBytes += length;
          }
          if (!lines.length) {
            this.filename = '';
            this.size = 0;
            if (
              Buffer.byteLength(JSON.stringify(batch[written])) + 1 >
              Math.min(maxFileBytes, this.config.maxBytes)
            ) {
              written++;
              this.dropped++;
            }
            continue;
          }
          const file = await fs.open(
            path.join(this.directory, this.filename),
            constants.O_WRONLY |
              constants.O_APPEND |
              constants.O_CREAT |
              (constants.O_NOFOLLOW ?? 0),
            0o600,
          );
          try {
            await file.writeFile(lines.join(''));
          } finally {
            await file.close();
          }
          written += lines.length;
          this.size += chunkBytes;
          this.bytes += chunkBytes;
        }
        await this.prune();
        this.failed = false;
      } catch {
        this.dropped += batch.length - written;
        this.failed = true;
        this.filename = '';
        this.size = 0;
      }
    });
    return this.writing;
  }
  private async files() {
    await this.checkDirectory();
    const names = await fs.readdir(this.directory, { withFileTypes: true });
    const result: { name: string; size: number; time: number }[] = [];
    for (const entry of names) {
      if (!entry.isFile() || !/^events-\d+-[\da-f-]+\.jsonl$/.test(entry.name)) continue;
      const stat = await fs.lstat(path.join(this.directory, entry.name));
      if (stat.isFile() && !stat.isSymbolicLink())
        result.push({ name: entry.name, size: stat.size, time: stat.mtimeMs });
    }
    return result.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  }
  private async prune() {
    const files = await this.files();
    let total = files.reduce((n, f) => n + f.size, 0);
    const cutoff = Date.now() - this.config.retentionDays * 86_400_000;
    for (const file of [...files].reverse()) {
      if (file.time < cutoff || total > this.config.maxBytes) {
        await fs.unlink(path.join(this.directory, file.name));
        total -= file.size;
        if (file.name === this.filename) {
          this.filename = '';
          this.size = 0;
        }
      }
    }
    this.bytes = total;
  }
  async query(filter: DiagnosticFilter, includeTemporary = true): Promise<DiagnosticPage> {
    await this.flush();
    const limit = filter.limit ?? 100;
    const skip = filter.cursor ?? 0;
    const found: DiagnosticEvent[] = [];
    let matches = 0;
    const test = (e: DiagnosticEvent) => {
      if (filter.level && priorities[e.level] < priorities[filter.level]) return false;
      if (filter.component && e.component !== filter.component) return false;
      if (filter.executionId && e.context.executionId !== filter.executionId) return false;
      if (
        filter.executionIds?.length &&
        (!e.context.executionId || !filter.executionIds.includes(e.context.executionId))
      )
        return false;
      if (filter.correlationId && e.context.correlationId !== filter.correlationId) return false;
      if ((filter.from && e.timestamp < filter.from) || (filter.to && e.timestamp > filter.to))
        return false;
      return (
        !filter.search || JSON.stringify(e).toLowerCase().includes(filter.search.toLowerCase())
      );
    };
    const take = (e: DiagnosticEvent) => {
      if (test(e) && matches++ >= skip && found.length <= limit) found.push(e);
    };
    if (includeTemporary) for (const e of [...this.temporary].reverse()) take(e);
    try {
      for (const file of await this.files()) {
        if (found.length > limit) break;
        for await (const line of this.reverseLines(file.name, file.size)) {
          try {
            const entry = diagnosticEventSchema.safeParse(JSON.parse(line));
            if (entry.success) take(entry.data);
          } catch {
            /* incomplete record */
          }
          if (found.length > limit) break;
        }
      }
    } catch {
      this.failed = true;
    }
    return {
      events: found.slice(0, limit),
      ...(found.length > limit && { nextCursor: skip + limit }),
    };
  }
  private async *reverseLines(name: string, size: number): AsyncGenerator<string> {
    const handle = await fs.open(
      path.join(this.directory, name),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let position = size;
    let tail = Buffer.alloc(0);
    try {
      while (position > 0) {
        const length = Math.min(65_536, position);
        position -= length;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        const bytes = Buffer.concat([buffer.subarray(0, bytesRead), tail]);
        let end = bytes.length;
        for (let index = bytes.length - 1; index >= 0; index--) {
          if (bytes[index] !== 10) continue;
          if (end > index + 1) yield bytes.subarray(index + 1, end).toString('utf8');
          end = index;
        }
        // A corrupted oversized line must not cause unbounded buffering.
        tail = end <= 65_536 ? Buffer.from(bytes.subarray(0, end)) : Buffer.alloc(0);
      }
      if (tail.length) yield tail.toString('utf8');
    } finally {
      await handle.close();
    }
  }
  async clear() {
    void this.flush();
    const clear = this.writing.then(async () => {
      for (const file of await this.files()) await fs.unlink(path.join(this.directory, file.name));
      this.filename = '';
      this.size = 0;
      this.bytes = 0;
      this.temporary = [];
      this.pendingLive = [];
    });
    this.writing = clear.catch(() => {
      this.failed = true;
    });
    await clear;
  }
  async close() {
    this.closed = true;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    await this.configWriting;
    await this.flush();
    this.temporary = [];
    this.pendingLive = [];
  }
}
