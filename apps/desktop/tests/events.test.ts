import { beforeEach, describe, expect, it } from 'vitest';
import { BackendAdapter } from '../src/services/adapters';
import { createSampleSnapshot } from '../src/services/sample';
import { useExecutionStore } from '../src/stores/executionStore';
import { validateDependencies } from '../src/stores/workspaceStore';
beforeEach(() => {
  useExecutionStore.getState().reset('sample', new BackendAdapter());
  useExecutionStore.getState().snapshot(createSampleSnapshot());
});
describe('event projection', () => {
  it('rejects stale revisions and events from another workspace', () => {
    const original = useExecutionStore.getState().events.test;
    useExecutionStore.getState().apply({
      type: 'event',
      workspaceId: 'other',
      cursor: 50,
      event: { ...original, revision: 100, title: 'Wrong project' },
    });
    useExecutionStore.getState().apply({
      type: 'event',
      workspaceId: 'sample',
      cursor: 51,
      event: { ...original, revision: 0, title: 'Stale' },
    });
    expect(useExecutionStore.getState().events.test.title).toBe('Run regression suite');
  });
  it('merges incremental output by stable chunk id and sequence', () => {
    const event = useExecutionStore.getState().events.test;
    const chunk = { id: 'new', sequence: 0, stream: 'stderr' as const, text: 'first\n' };
    const next = { ...event, revision: 2, command: { ...event.command!, output: [chunk, chunk] } };
    useExecutionStore
      .getState()
      .apply({ type: 'event', workspaceId: 'sample', cursor: 9, event: next });
    useExecutionStore
      .getState()
      .apply({ type: 'event', workspaceId: 'sample', cursor: 9, event: next });
    expect(useExecutionStore.getState().events.test.command!.output.map((item) => item.id)).toEqual(
      ['new', 'out-1', 'err-1'],
    );
  });
  it('accepts an out-of-order update for a different entity without regressing the cursor', () => {
    const state = useExecutionStore.getState();
    state.apply({
      type: 'event',
      workspaceId: 'sample',
      cursor: 20,
      event: { ...state.events.test, revision: 2 },
    });
    state.apply({
      type: 'event',
      workspaceId: 'sample',
      cursor: 10,
      event: { ...state.events.edit, revision: 2, summary: 'Updated' },
    });
    expect(useExecutionStore.getState().events.edit.summary).toBe('Updated');
    expect(useExecutionStore.getState().cursor).toBe(20);
  });
});
describe('manual task dependencies', () => {
  it('rejects cycles, self dependencies, and cross-project dependencies', () => {
    const tasks = createSampleSnapshot().tasks;
    expect(() => validateDependencies({ ...tasks[0], dependencies: [tasks[2].id] }, tasks)).toThrow(
      'cycle',
    );
    expect(() => validateDependencies({ ...tasks[0], dependencies: [tasks[0].id] }, tasks)).toThrow(
      'cycle',
    );
    expect(() =>
      validateDependencies(
        { ...tasks[0], workspaceId: 'other', dependencies: [tasks[1].id] },
        tasks,
      ),
    ).toThrow('project');
  });
  it('accepts a valid dependency graph', () => {
    const tasks = createSampleSnapshot().tasks;
    expect(() => validateDependencies(tasks[7], tasks)).not.toThrow();
  });
});
it('ignores a late snapshot after switching workspaces', async () => {
  const { vi } = await import('vitest');
  const { connectWorkspace, disconnectWorkspace } = await import('../src/stores/executionStore');
  const { emptySnapshot } = await import('../src/services/adapters');
  let resolve!: (value: ReturnType<typeof emptySnapshot>) => void;
  vi.spyOn(BackendAdapter.prototype, 'getSnapshot').mockImplementation((id) =>
    id === 'old'
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve(emptySnapshot(id)),
  );
  const earlier = connectWorkspace('old', false);
  await connectWorkspace('new', false);
  resolve(emptySnapshot('old'));
  await earlier;
  expect(useExecutionStore.getState().workspaceId).toBe('new');
  expect(useExecutionStore.getState().loading).toBe(false);
  disconnectWorkspace();
});
it('rejects events from an earlier execution session', () => {
  const event = useExecutionStore.getState().events.test;
  useExecutionStore.getState().apply({
    type: 'event',
    workspaceId: 'sample',
    cursor: 90,
    event: { ...event, id: 'old-session-event', sessionId: 'old-session', revision: 100 },
  });
  expect(useExecutionStore.getState().events['old-session-event']).toBeUndefined();
});
