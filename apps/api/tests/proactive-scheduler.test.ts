import { expect, it } from 'vitest';
import { ExecutionScheduler } from '../src/conductor/scheduler';

it('keeps a primary slot for chat while background requests share the existing scheduler', async () => {
  const scheduler = new ExecutionScheduler();
  const acquire = (turn: string, background: boolean, signal = new AbortController().signal) =>
    scheduler.acquire({
      turn,
      background,
      provider: 'fixture',
      tool: 'primary-model',
      toolLimit: 12,
      locks: [],
      limit: 3,
      signal,
    });
  const one = await acquire('job-one', true);
  const two = await acquire('job-two', true);
  const controller = new AbortController();
  let backgroundStarted = false;
  const waiting = acquire('job-three', true, controller.signal).then((lease) => {
    backgroundStarted = true;
    return lease;
  });
  const foreground = await acquire('chat', false);
  expect(backgroundStarted).toBe(false);
  foreground.release();
  expect(backgroundStarted).toBe(false);
  one.release();
  const three = await waiting;
  expect(backgroundStarted).toBe(true);
  two.release();
  three.release();
});
