import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { CapabilityHostRequest, ComputerObservation } from '@aria/shared';
import { ComputerRuntime, type ComputerDriver } from '../electron/runtime/computer';
import { RuntimeStore } from '../electron/runtime/store';
import { browserInputPoint } from '../electron/browser/computer-input';

it('converts screenshot pixels to bounded browser coordinates', () => {
  expect(browserInputPoint(799, 399, 800, 400, 1600, 800)).toEqual({ x: 1598, y: 798 });
  expect(() => browserInputPoint(800, 0, 800, 400, 1600, 800)).toThrow('outside');
});

it('fences pending approvals during takeover and rejects stale and cross-conversation input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aria-computer-runtime-'));
  const storage = new RuntimeStore(directory);
  const targetId = randomUUID();
  const revision = randomUUID();
  let inputCount = 0;
  let waitForApproval!: () => void;
  const approvalOpened = new Promise<void>((resolve) => {
    waitForApproval = resolve;
  });
  const model = {
    connectionId: randomUUID(),
    endpoint: 'https://api.openai.com/v1',
    model: 'fixture',
  };
  let foreground = 'owner';
  const driver: ComputerDriver = {
    environment: 'managed-browser',
    ready: () => true,
    open: async () => targetId,
    observe: async (_owner, target, sessionId) => ({
      observation: {
        id: randomUUID(),
        sessionId,
        targetId: target,
        revision,
        at: Date.now(),
        environment: 'managed-browser',
        width: 800,
        height: 600,
        devicePixelRatio: 2,
        state: { editable: true },
      },
    }),
    input: async () => {
      inputCount++;
    },
    owner: () => undefined,
    close: () => undefined,
  };
  const runtime = new ComputerRuntime(
    storage,
    [driver],
    () => 'provider',
    (conversation) => foreground === conversation,
    (_title, _detail, signal) =>
      new Promise((resolve) => {
        waitForApproval();
        signal.addEventListener('abort', () => resolve(true), { once: true });
      }),
    () => undefined,
    {
      read: async () => {
        throw new Error('Unexpected file read');
      },
      adopt: async () => {
        throw new Error('Unexpected publish');
      },
      script: async () => {
        throw new Error('Unexpected script');
      },
    },
  );
  const signal = AbortSignal.timeout(2000);
  const call = (
    operation: Extract<CapabilityHostRequest, { type: 'runtime' }>['operation'],
    input: Record<string, unknown>,
    conversationId = 'owner',
  ) =>
    runtime.dispatch(
      {
        id: randomUUID(),
        requestId: 'request',
        conversationId,
        assistantMessageId: 'turn',
        revision: 'fixture',
        type: 'runtime',
        stepId: randomUUID(),
        callId: randomUUID(),
        primary: model,
        operation,
        input,
      },
      signal,
    );
  try {
    const opened = await call('computer.open', {
      environment: 'managed-browser',
      mode: 'aria',
      tabId: targetId,
    });
    const sessionId = String(opened.data?.sessionId);
    foreground = 'intruder';
    await expect(
      call('computer.observe', { sessionId, format: 'structured' }, 'intruder'),
    ).rejects.toThrow('authorized computer session');
    foreground = 'owner';
    const inspected = await call('computer.observe', { sessionId, format: 'structured' });
    const observation = inspected.data?.observation as ComputerObservation;
    const actions = {
      sessionId,
      observationId: observation.id,
      actions: [{ type: 'keypress', keys: ['Enter'] }],
    };
    const executing = call('computer.act', actions).catch((error: unknown) => error);
    await approvalOpened;
    await runtime.supervise('owner', { sessionId, action: 'take-control' });
    expect(await executing).toMatchObject({ name: 'AbortError' });
    expect(inputCount).toBe(0);
    expect(runtime.states('owner')[0]?.status).toBe('waiting-for-user');
    await runtime.supervise('owner', { sessionId, action: 'return-control' });
    await expect(call('computer.act', actions)).rejects.toThrow('latest observation');
    expect(inputCount).toBe(0);
    expect(storage.db.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
  } finally {
    await runtime.shutdown();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
