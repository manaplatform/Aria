// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDiagnosticConfig, DiagnosticLogger } from '@aria/shared';
import { Diagnostics } from '../electron/diagnostics/service';

let root: string;
let service: Diagnostics;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'aria-diagnostics-'));
  service = new Diagnostics(root, '0.3.0');
  await service.initialize();
});
afterEach(async () => {
  await service.close();
  await rm(root, { recursive: true, force: true });
});

describe('local diagnostics', () => {
  it('filters levels, preserves correlation and never persists temporary events', async () => {
    service.log('debug', 'api', 'model', 'model.debug');
    service.log('info', 'chat', 'execution', 'chat.started', {
      requestId: 'r1',
      correlationId: 'r1',
      executionId: 'e1',
    });
    service.log(
      'info',
      'chat',
      'execution',
      'chat.started',
      { conversationId: 'temp', correlationId: 'temp' },
      {},
      true,
    );
    expect((await service.query({})).events).toHaveLength(2);
    expect((await service.query({ correlationId: 'r1' })).events[0].context.executionId).toBe('e1');
    expect((await service.query({}, false)).events).toHaveLength(1);
    service.discardTemporary('temp');
    expect((await service.query({})).events).toHaveLength(1);
    const names = await readdir(service.directory);
    const raw = await readFile(
      path.join(
        service.directory,
        names.find((name) => name.endsWith('.jsonl'))!,
      ),
      'utf8',
    );
    expect(raw).not.toContain('temp');
  });
  it('rejects untrusted metadata and secret-shaped strings before storage or publication', async () => {
    const batches: unknown[] = [];
    const logger = new Diagnostics(root, '0.3.0', (events) => batches.push(...events));
    await logger.initialize();
    logger.log(
      'info',
      'api',
      'model',
      'model.selected',
      { correlationId: 'r1' },
      { model: 'sk-secret12345', status: 'ok' },
    );
    logger.log('info', 'api', 'model', 'model.started', {}, {
      prompt: 'my private prompt',
    } as never);
    await logger.flush();
    const entries = (await logger.query({})).events;
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain('sk-secret12345');
    expect(JSON.stringify(entries)).not.toContain('my private prompt');
    expect(logger.status().dropped).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(JSON.stringify(batches)).not.toContain('secret');
    await logger.close();
  });
  it('applies configuration changes and retains them across restart', async () => {
    await service.configure({
      ...defaultDiagnosticConfig,
      debug: true,
      level: 'debug',
      retentionDays: 3,
    });
    service.log('debug', 'api', 'model', 'model.started');
    expect((await service.query({})).events).toHaveLength(1);
    const another = new Diagnostics(root, '0.3.0');
    await another.initialize();
    expect(another.status().config.retentionDays).toBe(3);
    await another.close();
  });
  it('persists concurrent configuration changes in their submitted order', async () => {
    await Promise.all([
      service.configure({ ...defaultDiagnosticConfig, retentionDays: 5 }),
      service.configure({ ...defaultDiagnosticConfig, retentionDays: 9 }),
    ]);
    const restarted = new Diagnostics(root, '0.3.0');
    await restarted.initialize();
    expect(restarted.status().config.retentionDays).toBe(9);
    await restarted.close();
  });
  it('expires old files and keeps permissions private on POSIX', async () => {
    service.log('info', 'desktop', 'lifecycle', 'startup.started');
    await service.flush();
    const name = (await readdir(service.directory)).find((item) => item.endsWith('.jsonl'))!;
    const filename = path.join(service.directory, name);
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600);
    const old = new Date(Date.now() - 10 * 86_400_000);
    await utimes(filename, old, old);
    await service.configure({ ...defaultDiagnosticConfig, retentionDays: 2 });
    expect(
      (await readdir(service.directory)).filter((item) => item.endsWith('.jsonl')),
    ).toHaveLength(0);
  });
  it('bounds its queue and counts discarded events under pressure', async () => {
    for (let i = 0; i < 3000; i++) service.log('info', 'chat', 'execution', 'chat.started');
    await service.flush();
    expect(service.status().dropped).toBe(1000);
    expect((await service.query({ limit: 500 })).events).toHaveLength(500);
  });
  it('filters several executions without including unrelated events', async () => {
    for (const executionId of ['one', 'two', 'three'])
      service.log('info', 'chat', 'execution', 'chat.completed', { executionId });
    const result = await service.query({ executionIds: ['one', 'two'] });
    expect(result.events.map((event) => event.context.executionId).sort()).toEqual(['one', 'two']);
  });
  it('isolates storage failures from callers', async () => {
    await rm(service.directory, { recursive: true, force: true });
    await writeFile(service.directory, 'not a directory');
    expect(() => service.log('error', 'desktop', 'lifecycle', 'startup.failed')).not.toThrow();
    await expect(service.flush()).resolves.toBeUndefined();
    expect(service.status()).toMatchObject({ error: true, dropped: 1 });
  });
  it('applies component overrides while keeping debug and trace behind their gates', async () => {
    await service.configure({
      ...defaultDiagnosticConfig,
      debug: true,
      components: { api: 'debug', chat: 'trace' },
    });
    service.log('debug', 'api', 'model', 'model.started');
    service.log('debug', 'desktop', 'model', 'model.started');
    service.log('trace', 'chat', 'execution', 'chat.started');
    expect((await service.query({})).events.map((event) => event.component)).toEqual(['api']);
    await service.configure({
      ...defaultDiagnosticConfig,
      debug: true,
      trace: true,
      components: { chat: 'trace' },
    });
    service.log('trace', 'chat', 'execution', 'chat.started');
    expect(
      (await service.query({ level: 'trace' })).events.map((event) => event.component),
    ).toContain('chat');
  });
  it('inherits child context and does not build disabled metadata', async () => {
    const rootLogger = new DiagnosticLogger(service, 'api', 'model', {
      requestId: 'r1',
      correlationId: 'r1',
    });
    const child = rootLogger.child({ operationId: 'child1' });
    let calls = 0;
    child.emit('debug', 'model.debug', () => {
      calls++;
      return {};
    });
    child.emit('info', 'model.started', () => {
      calls++;
      return { count: 1 };
    });
    expect(calls).toBe(1);
    expect((await service.query({})).events[0].context).toMatchObject({
      requestId: 'r1',
      correlationId: 'r1',
      operationId: 'child1',
    });
  });
  it('stores sanitized stack frames and bounded causes without exception messages', async () => {
    const cause = Object.assign(new Error('private cause'), { code: 'EIO' });
    const failure = Object.assign(new Error('private exception', { cause }), { code: 'EACCES' });
    service.log('error', 'desktop', 'storage', 'storage.failed', {}, {}, false, failure);
    const event = (await service.query({})).events[0];
    expect(event.error?.code).toBe('EACCES');
    expect(event.error?.causes[0].code).toBe('EIO');
    expect(event.error?.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(event)).not.toContain('private');
    expect(JSON.stringify(event)).not.toContain(root);
  });
  it('rotates and enforces the total size bound under sustained writes', async () => {
    await service.configure({ ...defaultDiagnosticConfig, maxBytes: 1_000_000 });
    for (let batch = 0; batch < 6; batch++) {
      for (let index = 0; index < 900; index++)
        service.log('info', 'chat', 'execution', 'chat.started', {
          correlationId: `batch-${batch}`,
        });
      await service.flush();
    }
    expect(service.status().bytes).toBeLessThanOrEqual(1_000_000);
    expect((await service.query({ limit: 500 })).events.length).toBe(500);
  });
  it('does not follow a replaced log directory', async () => {
    if (process.platform === 'win32') return;
    const outside = await mkdtemp(path.join(tmpdir(), 'aria-outside-'));
    try {
      await rm(service.directory, { recursive: true, force: true });
      await symlink(outside, service.directory);
      service.log('error', 'desktop', 'lifecycle', 'startup.failed');
      await service.flush();
      expect(await readdir(outside)).toHaveLength(0);
      expect(service.status().error).toBe(true);
    } finally {
      await rm(service.directory, { force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
