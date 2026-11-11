import { afterEach, expect, it, vi } from 'vitest';
import { BackendAdapter, SampleAdapter } from '../src/services/adapters';
import { sampleConversation } from '../src/services/sample';
afterEach(() => vi.useRealTimers());
it('never fabricates a backend acknowledgement', async () => {
  const adapter = new BackendAdapter();
  expect(adapter.capabilities.chat).toBe(false);
  await expect(adapter.submitMessage()).rejects.toThrow('not implemented');
  await expect(adapter.decideApproval()).rejects.toThrow('not implemented');
});
it('sample approvals stay pending until the simulated acknowledgement arrives', async () => {
  vi.useFakeTimers();
  const adapter = new SampleAdapter();
  const listener = vi.fn();
  const unsubscribe = adapter.subscribe('sample', listener);
  const acknowledgement = adapter.decideApproval('approval-pr', 'approved');
  expect(listener).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(350);
  expect((await acknowledgement).status).toBe('approved');
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
});
it('unsubscribing stops sample streaming updates and pending work settles', async () => {
  vi.useFakeTimers();
  const adapter = new SampleAdapter();
  const listener = vi.fn();
  const unsubscribe = adapter.subscribe('sample', listener);
  const submit = adapter.submitMessage({ ...sampleConversation, draft: 'Hello' });
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  await vi.runAllTimersAsync();
  await submit;
  expect(listener).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
