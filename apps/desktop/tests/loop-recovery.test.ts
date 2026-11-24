import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  defaultLoopLimits,
  projectChatEvent,
  type ChatMessage,
  type LoopCheckpoint,
} from '@aria/shared';
import { expect, it } from 'vitest';
import { LoopRecovery } from '../electron/loop-recovery';
import { RuntimeStore } from '../electron/runtime/store';

it('reconciles a dispatch across restart, fences old generations and retains budget reservations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aria-loop-recovery-'));
  const store = new RuntimeStore(directory);
  const signal = new AbortController().signal;
  let provider = 'original';
  const recovery = new LoopRecovery(
    store,
    {
      available: async () => true,
      encrypt: async (text) => Buffer.from(Buffer.from(text).toString('base64')),
      decrypt: async (bytes) => ({ result: Buffer.from(bytes.toString(), 'base64').toString() }),
    },
    () => provider,
  );
  const scope = { requestId: 'first', conversationId: 'conv', assistantMessageId: 'assistant' };
  const checkpoint: LoopCheckpoint = {
    executionId: randomUUID(),
    generation: 1,
    revision: 1,
    version: 1,
    userMessageId: 'user',
    state: 'waiting_for_tool',
    elapsedMs: 5000,
    iteration: 2,
    stagnant: 0,
    limits: defaultLoopLimits,
    budget: {
      steps: 1,
      inputReserved: 300,
      outputReserved: 100,
      cost: 53,
      providerRequests: 2,
      responseContinuations: 0,
      controlCalls: 0,
      nativeToolCalls: 0,
      memoryInputEstimate: 0,
      artifactBytes: 0,
      artifactIds: [],
      directToolCalls: 1,
      programChildCalls: 0,
      searches: 0,
      fetches: 0,
      screenshots: 0,
    },
    privateContent: false,
    memoryContent: false,
    pendingProviderWork: false,
    steering: ['Continue with the first result.'],
    receipts: [],
  };
  const request = {
    ...scope,
    type: 'checkpoint' as const,
    id: randomUUID(),
    revision: 'policy',
    checkpoint,
  };
  try {
    store.db.exec('DROP TABLE loop_checkpoints; PRAGMA user_version = 7');
    store.close();
    expect(await recovery.save(request, signal)).toBe(true);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(8);
    const effect = 'f'.repeat(64);
    expect(
      store.reserveDispatch('conv', 'assistant', 'first', effect, undefined, {
        id: 'browser.browser_submit',
        stepId: 'step',
        callId: 'call',
        revision: 'policy',
      }),
    ).toBe(true);
    const transport = 'c'.repeat(64);
    expect(store.reserveDispatch('conv', 'assistant', 'first', transport, undefined, {
      id: 'browser.browser_submit', stepId: 'step', callId: 'call', revision: 'policy',
    })).toBe(true);
    expect(store.settleDispatch('conv', 'assistant', 'first', transport, 'completed')).toBe(true);
    store.close();
    const ref = {
      ...scope,
      executionId: checkpoint.executionId,
      generation: checkpoint.generation,
    };
    provider = 'changed';
    await expect(recovery.restore(ref, 'user', 'wrong', () => true)).rejects.toThrow(
      'original primary',
    );
    provider = 'original';
    const resumed = await recovery.restore(ref, 'user', 'second', () => true);
    expect(resumed).toMatchObject({
      generation: 2,
      recovery: {
        budget: checkpoint.budget,
        receipts: [{ id: 'step', operation: 'browser.browser_submit', state: 'uncertain' }],
      },
    });
    expect(await recovery.save(request, signal)).toBe(false);
    expect(store.settleDispatch('conv', 'assistant', 'first', effect, 'completed')).toBe(false);
    expect(store.reserveDispatch('conv', 'assistant', 'second', effect)).toBe(false);
    expect(store.reserveDispatch('conv', 'assistant', 'first', 'a'.repeat(64))).toBe(false);
    await expect(recovery.restore(ref, 'user', 'stale', () => true)).rejects.toThrow(
      'no longer belongs',
    );
    store.cancelLoop('second');
    expect(recovery.snapshot('conv', 'assistant')).toBeUndefined();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('reattaches the chat projection while ignoring late events from the previous generation', () => {
  const executionId = randomUUID();
  const message: ChatMessage = {
    id: 'assistant',
    conversationId: 'conv',
    requestId: 'old',
    createdAt: '',
    role: 'assistant',
    content: 'Old draft',
    status: 'interrupted',
    sequence: 82,
    execution: {
      executionId,
      generation: 1,
      state: 'recovering',
      durability: 'saved',
      iteration: 2,
    },
  };
  const owner = {
    assistantMessageId: message.id,
    conversationId: message.conversationId,
    executionId,
  };
  const next = projectChatEvent(message, {
    ...owner,
    requestId: 'new',
    generation: 2,
    sequence: 1,
    type: 'execution',
    execution: { ...message.execution!, state: 'running', generation: 2 },
  });
  const late = projectChatEvent(next, {
    ...owner,
    requestId: 'old',
    generation: 1,
    sequence: 83,
    type: 'delta',
    text: 'Stale',
  });
  expect(late).toBe(next);
  expect(next).toMatchObject({ requestId: 'new', sequence: 1, status: 'streaming', content: '' });
  expect(
    projectChatEvent(next, {
      ...owner,
      requestId: 'new',
      generation: 2,
      sequence: 2,
      type: 'delta',
      text: 'Resumed reply',
    }).content,
  ).toBe('Resumed reply');
});
