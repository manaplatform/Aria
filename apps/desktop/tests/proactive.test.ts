import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  automationDraftSchema,
  defaultProactiveSettings,
  type ProactiveCommand,
} from '@aria/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../electron/runtime/store';
import { ProactiveStore } from '../electron/proactive/store';
import { ProactiveService } from '../electron/proactive/service';
import { occurrence, preview, quietUntil } from '../electron/proactive/schedule';
import type { ProactiveHost } from '../electron/proactive/host';

const commandId = () => ({ commandId: randomUUID() });
const tz = 'America/New_York';
const timestamp = (value: string) => Date.parse(value);
const cleanup: (() => Promise<void>)[] = [];

async function runtime() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aria-proactive-'));
  const sqlite = new RuntimeStore(directory);
  let now = timestamp('2026-11-26T09:00:00Z');
  let provider: string | undefined = 'provider-one';
  let encryption = true;
  const store = new ProactiveStore(
    sqlite,
    {
      available: async () => encryption,
      encrypt: async (text) => Buffer.from(Buffer.from(text).toString('base64')),
      decrypt: async (payload) => ({
        result: Buffer.from(payload.toString(), 'base64').toString(),
      }),
    },
    () => now,
  );
  const host: ProactiveHost = {
    identity: () => (provider ? { provider, revision: 'registry' } : undefined),
    run: vi.fn(async (request, _signal, event) => {
      event({
        requestId: request.attemptId,
        conversationId: request.jobId,
        assistantMessageId: request.jobId,
        sequence: 1,
        type: 'delta',
        text: 'Fixture result.',
      });
      event({
        requestId: request.attemptId,
        conversationId: request.jobId,
        assistantMessageId: request.jobId,
        sequence: 2,
        type: 'completed',
      });
    }),
    changed: vi.fn(),
    notify: vi.fn(() => true),
  };
  const service = new ProactiveService(store, host);
  cleanup.push(async () => {
    await service.close();
    sqlite.close();
    await rm(directory, { recursive: true, force: true });
  });
  const handle = (command: ProactiveCommand) => service.handle(command);
  async function accepted(command: ProactiveCommand) {
    const result = await handle(command);
    expect(result.kind, JSON.stringify(result)).toBe('accepted');
    return result.kind === 'accepted' ? result.id : undefined;
  }
  return {
    directory,
    sqlite,
    store,
    host,
    service,
    handle,
    accepted,
    move: (ms: number) => {
      now += ms;
    },
    provider: (value?: string) => {
      provider = value;
    },
    encryption: (value: boolean) => {
      encryption = value;
    },
  };
}

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

describe('desktop proactive runtime', () => {
  it('evaluates schedule modes across DST, month boundaries, and quiet hours', () => {
    const daily = { kind: 'daily', zone: tz, at: '02:30', followSystem: false } as const;
    expect(preview(daily, timestamp('2026-03-07T08:00:00Z'))[0]).toBe(
      timestamp('2026-03-09T06:30:00Z'),
    );
    expect(
      preview({ ...daily, at: '01:30' }, timestamp('2026-11-01T04:55:00Z')).slice(0, 2),
    ).toEqual([timestamp('2026-11-01T05:30:00Z'), timestamp('2026-11-02T06:30:00Z')]);
    expect(
      preview({ ...daily, kind: 'monthly', day: 31 }, timestamp('2026-04-01T00:00:00Z'))[0],
    ).toBe(timestamp('2026-05-31T06:30:00Z'));
    expect(
      occurrence(
        { kind: 'once', at: '2026-11-01T01:30-05:00', zone: tz },
        timestamp('2026-11-01T00:00:00Z'),
      )?.at,
    ).toBe(timestamp('2026-11-01T06:30:00Z'));
    expect(() => preview({ kind: 'once', at: '2026-11-01T01:30', zone: tz }, 0)).toThrow();
    expect(
      preview({ ...daily, kind: 'weekly', weekday: 1 }, timestamp('2026-03-08T12:00:00Z'))[0],
    ).toBe(timestamp('2026-03-09T06:30:00Z'));
    expect(
      preview(
        { kind: 'cron', expression: '0 9 * * 1-5', zone: tz, followSystem: true },
        timestamp('2026-11-26T09:00:00Z'),
        'UTC',
      )[0],
    ).toBe(timestamp('2026-11-27T09:00:00Z'));
    expect(
      quietUntil({ zone: tz, start: '22:00', end: '07:00' }, timestamp('2026-11-27T05:00:00Z')),
    ).toBe(timestamp('2026-11-27T12:00:00Z'));
  });

  it('persists encrypted task contents and rejects dependency cycles, conflicting revisions and duplicate commands', async () => {
    const { accepted, handle, store } = await runtime();
    const task = {
      title: 'A private responsibility',
      description: '',
      blocker: '',
      priority: 'normal',
      deadline: null,
      objectiveId: null,
      parentId: null,
      dependencies: [],
    } as const;
    const first: Extract<ProactiveCommand, { action: 'task_create' }> = {
      action: 'task_create',
      ...commandId(),
      task: { ...task, dependencies: [] },
    };
    const a = (await accepted(first))!;
    expect(await accepted(first)).toBe(a);
    const b = (await accepted({
      ...first,
      ...commandId(),
      task: { ...task, title: 'B', dependencies: [a] },
    }))!;
    expect(
      await handle({
        action: 'task_update',
        id: a,
        revision: 1,
        ...commandId(),
        task: { ...task, dependencies: [b] },
      }),
    ).toMatchObject({ kind: 'error', code: 'validation' });
    expect(
      await handle({
        action: 'task_update',
        id: a,
        revision: 2,
        ...commandId(),
        task: { ...task, dependencies: [] },
      }),
    ).toMatchObject({ kind: 'error', code: 'conflict' });
    expect(
      Buffer.from(
        store.one<{ payload: Uint8Array }>('SELECT payload FROM agenda_tasks WHERE id=?', a)!
          .payload,
      ).toString(),
    ).not.toContain(task.title);
    await accepted({
      action: 'task_state',
      id: a,
      revision: 1,
      ...commandId(),
      state: 'completed',
    });
    expect(store.one('SELECT state FROM agenda_tasks WHERE id=?', b)).toMatchObject({
      state: 'ready',
    });
  });

  it('reserves the daily budget atomically, fences stale claims and quarantines an uncertain effect', async () => {
    const { store, move, sqlite } = await runtime();
    const id = store.enqueue({ kind: 'pulse', occurrence: 'one', due: store.now() })!;
    const reserve = { input: 20, output: 10, cost: 12 };
    const claim = store.claim(id, 'worker-one', 'provider-one', reserve, defaultProactiveSettings)!;
    expect(claim.attempt).toBeTruthy();
    expect(
      store.claim(id, 'worker-two', 'provider-one', reserve, defaultProactiveSettings),
    ).toBeUndefined();
    expect(
      sqlite.reserveDispatch(id, id, claim.attempt, 'blinded-command', undefined, {
        id: 'browser.browser_submit',
        stepId: 'effect-one',
        callId: 'call',
        revision: 'revision',
      }),
    ).toBe(true);
    move(31_000);
    expect(store.renew(claim)).toBe(false);
    expect(store.reconcile()).toBe(1);
    expect(store.job(id)?.state).toBe('uncertain');
    expect(store.finish(claim, 'completed')).toBe(false);
    store.requeueInterrupted();
    expect(store.job(id)?.state).toBe('uncertain');
    const next = store.enqueue({ kind: 'pulse', occurrence: 'two', due: store.now() })!;
    expect(
      store.claim(next, 'worker-two', 'provider-one', reserve, {
        ...defaultProactiveSettings,
        dailyMicros: 12,
      }),
    ).toBeUndefined();
    expect(store.job(next)?.reason).toMatch(/budget/);
    expect(store.attempts(id)[0]).toMatchObject({ cost: 12, state: 'uncertain' });
  });

  it('skips disabled and idle Pulse, prevents overlaps and accepts a manual evaluation', async () => {
    const { store, service, move, accepted, host } = await runtime();
    service.pulse.tick();
    expect(service.pulse.status().history).toHaveLength(0);
    await accepted({
      action: 'settings',
      ...commandId(),
      revision: 1,
      value: { ...defaultProactiveSettings, pulseEnabled: true, intervalMinutes: 1 },
    });
    move(60_000);
    service.pulse.tick();
    expect(service.pulse.status().history[0].state).toBe('skipped');
    const id = await accepted({ action: 'pulse', ...commandId() });
    expect(id).toBeTruthy();
    await accepted({ action: 'pulse', ...commandId() });
    expect(store.activeFor('pulse')).toHaveLength(1);
    service.start();
    await vi.waitFor(() => expect(store.job(id!)?.state).toBe('completed'));
    expect(host.run).toHaveBeenCalledTimes(1);
    expect(await service.notifications.list(0)).toHaveLength(0);
  });

  it('queues only the latest missed occurrence, records a result and stops an outdated grant', async () => {
    const { store, service, move, accepted, host, provider } = await runtime();
    const draft = automationDraftSchema.parse({
      title: 'Periodic report',
      instruction: 'Report every five minutes.',
      action: 'Summarize current responsibilities.',
      trigger: { kind: 'interval', anchor: store.now(), minutes: 5 },
      scope: { publicSearch: false, publicOrigins: [], memory: false },
    });
    const id = (await accepted({
      action: 'automation_create',
      ...commandId(),
      automation: draft,
    }))!;
    move(21 * 60_000);
    await service.automations.tick();
    expect(store.activeFor('automation', id)).toHaveLength(1);
    const run = store.activeFor('automation', id)[0];
    expect(run.due).toBe(timestamp('2026-11-26T09:20:00Z'));
    service.start();
    await vi.waitFor(() => expect(store.job(run.id)?.state).toBe('completed'));
    provider('provider-two');
    move(5 * 60_000);
    await service.automations.tick();
    service.wake();
    await vi.waitFor(() =>
      expect(store.activeFor('automation', id).find((job) => job.state === 'blocked')).toBeTruthy(),
    );
    expect(host.run).toHaveBeenCalledTimes(1);
  });

  it('keeps work queued without a provider and rejects encrypted writes while storage is locked', async () => {
    const { service, accepted, provider, store, encryption, host, handle } = await runtime();
    const id = (await accepted({ action: 'pulse', ...commandId() }))!;
    provider(undefined);
    service.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.job(id)?.state).toBe('queued');
    expect(host.run).not.toHaveBeenCalled();
    encryption(false);
    expect(
      await handle({
        action: 'objective_create',
        ...commandId(),
        objective: { title: 'Objective', description: '' },
      }),
    ).toMatchObject({ kind: 'error', code: 'unavailable' });
  });
});

it.each([
  'before reservation',
  'after reservation',
  'after dispatch acknowledgement',
  'after result commit',
])('recovers safely across a restart %s', async (boundary) => {
  const { store, sqlite } = await runtime();
  const id = store.enqueue({ kind: 'pulse', occurrence: 'one-epoch', due: store.now() })!;
  const reserve = { input: 20, output: 10, cost: 12 };
  const claim = store.claim(id, 'old-worker', 'provider-one', reserve, defaultProactiveSettings)!;
  if (boundary !== 'before reservation') {
    expect(
      sqlite.reserveDispatch(id, id, claim.attempt, 'unique-effect', undefined, {
        id: 'browser.browser_submit',
        stepId: 'submitted',
        callId: 'call',
        revision: 'policy',
      }),
    ).toBe(true);
  }
  if (boundary === 'after dispatch acknowledgement' || boundary === 'after result commit')
    expect(sqlite.settleDispatch(id, id, claim.attempt, 'unique-effect', 'completed')).toBe(true);
  if (boundary === 'after result commit')
    expect(store.atomic(() => store.finish(claim, 'completed'))).toBe(true);
  sqlite.close();

  store.reconcile(undefined, true);
  store.atomic(() => store.requeueInterrupted());
  expect(store.finish(claim, 'completed')).toBe(false);
  if (boundary === 'before reservation') {
    expect(store.job(id)?.state).toBe('queued');
    expect(
      store.claim(id, 'new-worker', 'provider-one', reserve, defaultProactiveSettings)?.generation,
    ).toBe(2);
  } else {
    expect(store.job(id)?.state).toBe(
      boundary === 'after result commit' ? 'completed' : 'uncertain',
    );
    expect(
      store.claim(id, 'new-worker', 'provider-one', reserve, defaultProactiveSettings),
    ).toBeUndefined();
  }
});
