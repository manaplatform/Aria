import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '@aria/shared';
import { emptyData } from '../src/services/desktop';
import { flushPersistence, useWorkspaceStore } from '../src/stores/workspaceStore';

beforeEach(() => {
  vi.useFakeTimers();
  useWorkspaceStore.setState({ data: emptyData(), ready: true, saveError: null, saving: false });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await flushPersistence();
  delete window.aria;
  vi.useRealTimers();
});

it('keeps browser-preview changes in memory without scheduling desktop saves', async () => {
  useWorkspaceStore.getState().preferences({ profileName: 'Preview user' });

  expect(vi.getTimerCount()).toBe(0);
  await expect(flushPersistence()).resolves.toBeUndefined();
  expect(useWorkspaceStore.getState().data.preferences.profileName).toBe('Preview user');
});

it('settles a scheduled save after the browser disappears and can save again afterward', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const browserWindow = window;
  browserWindow.aria = { save } as unknown as DesktopBridge;
  useWorkspaceStore.getState().preferences({ profileName: 'Pending user' });
  vi.stubGlobal('window', undefined);

  try {
    await vi.advanceTimersByTimeAsync(2000);
    await expect(flushPersistence()).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }

  await flushPersistence();
  expect(save).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      preferences: expect.objectContaining({ profileName: 'Pending user' }),
    }),
  );
});

it('flushes the latest change after an in-flight save and clears both persistence timers', async () => {
  let finishSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  const save = vi.fn().mockReturnValueOnce(pendingSave).mockResolvedValue(undefined);
  window.aria = { save } as unknown as DesktopBridge;
  useWorkspaceStore.getState().preferences({ profileName: 'First user' });
  const firstFlush = flushPersistence();
  await Promise.resolve();
  expect(save).toHaveBeenCalledOnce();

  useWorkspaceStore.getState().preferences({ profileName: 'Latest user' });
  let flushed = false;
  const finalFlush = flushPersistence().then(() => {
    flushed = true;
  });
  expect(flushed).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  finishSave();
  await Promise.all([firstFlush, finalFlush]);

  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith(
    expect.objectContaining({
      preferences: expect.objectContaining({ profileName: 'Latest user' }),
    }),
  );
  expect(useWorkspaceStore.getState()).toMatchObject({ saving: false, saveError: null });
  expect(vi.getTimerCount()).toBe(0);
});
