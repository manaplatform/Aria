import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { automationDraftSchema, defaultProactiveSettings, type BrowserRequest } from '@aria/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { RuntimeStore } from '../electron/runtime/store';
import { ProactiveStore } from '../electron/proactive/store';
import { ProactiveService } from '../electron/proactive/service';
import type { ProactiveHost } from '../electron/proactive/host';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const origin = 'https://example.com';
const scope = { publicSearch: false, publicOrigins: [origin], memory: false };
const primary = { connectionId: 'fixture', model: 'fixture', endpoint: 'https://provider.example' };

async function setup(run: ProactiveHost['run'], connectorValid?: ProactiveHost['connectorValid']) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aria-proactive-boundary-'));
  const runtime = new RuntimeStore(directory);
  const store = new ProactiveStore(runtime, {
    available: async () => true,
    encrypt: async (text) => Buffer.from(text),
    decrypt: async (payload) => ({ result: payload.toString() }),
  });
  const service = new ProactiveService(store, {
    identity: () => ({ provider: 'primary', revision: 'policy' }),
    run,
    connectorValid,
    changed: () => undefined,
    notify: () => true,
  });
  cleanups.push(async () => {
    await service.close();
    runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, store };
}

function request(
  run: Parameters<ProactiveHost['run']>[0],
  op: BrowserRequest['op'],
  step = randomUUID(),
): BrowserRequest {
  return {
    v: 1,
    generation: randomUUID(),
    operationId: randomUUID(),
    requestId: run.attemptId,
    conversationId: run.jobId,
    stepId: step,
    deadline: Date.now() + 3000,
    op,
    args: { url: origin },
  };
}

it('records condition transitions from the verified origin only and deduplicates the notification', async () => {
  const outcomes = ['not_met', 'met', 'met'] as const;
  let index = 0;
  const fixture = await setup(async (run, signal, emit) => {
    const browser = request(run, 'web_fetch');
    const live = service.supervisor.live(run.attemptId, run.jobId)!;
    expect(service.authorizeBrowser(browser)).toBeTruthy();
    expect(
      service.authorizeBrowser({ ...browser, args: { url: 'https://outside.example' } }),
    ).toBeUndefined();
    const call = {
      type: 'runtime',
      operation: 'automation.report_condition',
      revision: 'policy',
      id: randomUUID(),
      requestId: run.attemptId,
      conversationId: run.jobId,
      assistantMessageId: run.jobId,
      stepId: randomUUID(),
      callId: randomUUID(),
      primary,
      input: { result: outcomes[index++], evidenceStepId: browser.stepId },
    } as const;
    service.observations(browser, { url: 'https://outside.example', ok: true });
    await expect(service.dispatch(call, signal, live)).rejects.toThrow(/verified observation/);
    service.observations(browser, { url: origin, ok: true });
    await service.dispatch(call, signal, live);
    emit({ ...call, sequence: 1, type: 'completed' });
  });
  const { service } = fixture;
  const configured = await service.handle({
    action: 'settings',
    commandId: randomUUID(),
    revision: 1,
    value: { ...defaultProactiveSettings, dailyOutputTokens: 65536 },
  });
  expect(configured.kind).toBe('accepted');
  const draft = automationDraftSchema.parse({
    title: 'Watch website',
    instruction: 'Check site',
    action: 'Observe availability.',
    trigger: { kind: 'condition', origin, minutes: 30, anchor: Date.now(), cooldownMinutes: 30 },
    scope,
  });
  const created = await service.handle({
    action: 'automation_create',
    commandId: randomUUID(),
    automation: draft,
  });
  expect(created.kind).toBe('accepted');
  const id = created.kind === 'accepted' ? created.id! : '';
  service.start();
  for (const result of outcomes) {
    const run = await service.handle({
      action: 'automation_control',
      commandId: randomUUID(),
      id,
      revision: 1,
      control: 'run_now',
    });
    expect(run.kind).toBe('accepted');
    const job = run.kind === 'accepted' ? run.id! : '';
    await vi.waitFor(() => expect(fixture.store.job(job)?.state).toBe('completed'));
    expect(service.automations.trigger(id)?.condition).toBe(result);
  }
  expect(
    (await service.notifications.list(0)).filter((row) => row.category === 'Condition changed'),
  ).toHaveLength(1);
});

it('parks an exact browser approval, then consumes it only on the matching resumed action', async () => {
  let approved = false;
  let callCount = 0;
  const fingerprint = 'e'.repeat(64);
  const fixture = await setup(async (run, signal, emit) => {
    const browser = request(run, 'browser_submit');
    callCount++;
    approved = await service.approveBrowser(browser, fingerprint, 'Submit form\n' + origin, signal);
    if (approved)
      emit({
        requestId: run.attemptId,
        conversationId: run.jobId,
        assistantMessageId: run.jobId,
        sequence: 1,
        type: 'completed',
      });
  });
  const { service } = fixture;
  const draft = automationDraftSchema.parse({
    title: 'Approved form',
    instruction: 'Review the form.',
    action: 'Submit after user approval.',
    trigger: { kind: 'manual' },
    scope,
  });
  const stored = await service.handle({
    action: 'automation_create',
    commandId: randomUUID(),
    automation: draft,
  });
  const id = stored.kind === 'accepted' ? stored.id! : '';
  const queued = await service.handle({
    action: 'automation_control',
    commandId: randomUUID(),
    id,
    revision: 1,
    control: 'run_now',
  });
  const job = queued.kind === 'accepted' ? queued.id! : '';
  service.start();
  await vi.waitFor(() => expect(fixture.store.job(job)?.state).toBe('waiting_approval'));
  expect(approved).toBe(false);
  const view = await service.handle({ action: 'snapshot' });
  const approval = view.kind === 'snapshot' ? view.value.requests[0] : undefined;
  expect(approval?.message).toContain(origin);
  expect(
    await service.handle({
      action: 'request_resolve',
      commandId: randomUUID(),
      id: approval!.id,
      revision: approval!.revision,
      decision: 'approve',
    }),
  ).toMatchObject({ kind: 'accepted' });
  await vi.waitFor(() => expect(fixture.store.job(job)?.state).toBe('completed'));
  expect(approved).toBe(true);
  expect(callCount).toBe(2);
  expect(
    fixture.store.one('SELECT state FROM proactive_requests WHERE id=?', approval!.id),
  ).toMatchObject({ state: 'consumed' });
});

it('fences a suspended worker and resumes safe work under the next generation', async () => {
  let starts = 0;
  const { service, store } = await setup(async (run, signal, emit) => {
    starts++;
    if (starts === 1) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }
    emit({
      requestId: run.attemptId,
      conversationId: run.jobId,
      assistantMessageId: run.jobId,
      sequence: 1,
      type: 'completed',
    });
  });
  const queued = await service.handle({ action: 'pulse', commandId: randomUUID() });
  const id = queued.kind === 'accepted' ? queued.id! : '';
  service.start();
  await vi.waitFor(() => expect(starts).toBe(1));
  service.suspend();
  service.resume();
  await vi.waitFor(() =>
    expect(store.job(id)).toMatchObject({ state: 'completed', generation: 2 }),
  );
  expect(store.attempts(id).map(({ state }) => state)).toEqual(['completed', 'interrupted']);
});

it('establishes a verified GitHub watch baseline and parks a revoked connection', async () => {
  const grant = { connection: randomUUID(), generation: 1, repositories: [21],
    operations: ['github.list_workflow_runs' as const] };
  const observations = ['none', '501/1', '501/1'];
  let valid = true;
  let dispatched = 0;
  const fixture = await setup(async (run, _signal, emit) => {
    expect(run.scope.connector).toEqual(grant);
    const call = {
      type: 'runtime', operation: 'github.list_workflow_runs', revision: 'policy', id: randomUUID(),
      requestId: run.attemptId, conversationId: run.jobId, assistantMessageId: run.jobId,
      stepId: randomUUID(), callId: randomUUID(), primary, input: { repository: 21, page: 1, status: 'failure' },
    } as const;
    const result = {
      connection: grant.connection, account: 'fixture', repositoryId: 21,
      observation: observations[dispatched++], verified: true,
    };
    await fixture.service.observeGithub(call, { ...result, repositoryId: 99 });
    await fixture.service.observeGithub(call, result);
    emit({ ...call, sequence: 1, type: 'completed' });
  }, (scope) => valid && scope.connection === grant.connection);
  const { service, store } = fixture;
  expect((await service.handle({
    action: 'settings', commandId: randomUUID(), revision: 1,
    value: { ...defaultProactiveSettings, dailyOutputTokens: 65536 },
  })).kind).toBe('accepted');
  const automation = automationDraftSchema.parse({
    title: 'Watch GitHub CI', instruction: 'Check failed GitHub runs.', action: 'Check the authorized repository.',
    trigger: { kind: 'github_watch', watch: 'workflow_failure', repository: 21, anchor: Date.now(), minutes: 10 },
    scope: { ...scope, connector: grant },
  });
  const stored = await service.handle({ action: 'automation_create', commandId: randomUUID(), automation });
  expect(stored.kind).toBe('accepted');
  const id = stored.kind === 'accepted' ? stored.id! : '';
  const run = async (expected: 'completed' | 'blocked') => {
    const queued = await service.handle({
      action: 'automation_control', commandId: randomUUID(), id, revision: 1, control: 'run_now',
    });
    expect(queued.kind).toBe('accepted');
    const job = queued.kind === 'accepted' ? queued.id! : '';
    await vi.waitFor(() => expect(store.job(job)?.state).toBe(expected));
  };
  service.start();
  for (const observation of observations) {
    await run('completed');
    expect(store.one('SELECT evidence FROM connector_watch_baseline WHERE automation=?', id)?.evidence).toBe(observation);
  }
  expect((await service.notifications.list(0)).filter((row) => row.category === 'GitHub workflow failed')).toHaveLength(1);
  valid = false;
  await run('blocked');
  expect(service.automations.row(id)?.state).toBe('paused');
  expect(dispatched).toBe(3);
});
