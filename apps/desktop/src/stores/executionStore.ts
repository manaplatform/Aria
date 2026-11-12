import { create } from 'zustand';
import type {
  Agent,
  ApprovalRequest,
  ExecutionEvent,
  ExecutionSession,
  LiveUpdate,
  Message,
  Plan,
  Snapshot,
  Task,
  WorkspaceAdapter,
} from '@aria/shared';
import { BackendAdapter, emptySnapshot, SampleAdapter } from '../services/adapters';

const records = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((item) => [item.id, item]));
interface ExecutionState {
  session: ExecutionSession | undefined;
  workspaceId: string;
  cursor: number;
  loading: boolean;
  error: string | null;
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  plans: Record<string, Plan>;
  events: Record<string, ExecutionEvent>;
  messages: Record<string, Message>;
  approvals: Record<string, ApprovalRequest>;
  pendingApprovals: Record<string, boolean>;
  selectedAgentId: string | null;
  adapter: WorkspaceAdapter;
  reset: (workspaceId: string, adapter: WorkspaceAdapter) => void;
  snapshot: (snapshot: Snapshot) => void;
  apply: (update: LiveUpdate) => void;
  selectAgent: (id: string | null) => void;
}
export const useExecutionStore = create<ExecutionState>((set, get) => ({
  session: undefined,
  workspaceId: '',
  cursor: 0,
  loading: false,
  error: null,
  agents: {},
  tasks: {},
  plans: {},
  events: {},
  messages: {},
  approvals: {},
  pendingApprovals: {},
  selectedAgentId: null,
  adapter: new BackendAdapter(),
  reset: (workspaceId, adapter) =>
    set({
      session: undefined,
      workspaceId,
      adapter,
      cursor: 0,
      loading: true,
      error: null,
      agents: {},
      tasks: {},
      plans: {},
      events: {},
      messages: {},
      approvals: {},
      pendingApprovals: {},
      selectedAgentId: null,
    }),
  snapshot: (snapshot) => {
    if (snapshot.workspaceId === get().workspaceId)
      set({
        session: snapshot.session,
        cursor: snapshot.cursor,
        loading: false,
        agents: records(snapshot.agents),
        tasks: records(snapshot.tasks),
        plans: records(snapshot.plans),
        events: records(snapshot.events),
        messages: records(snapshot.messages),
        approvals: records(snapshot.approvals),
      });
  },
  apply: (update) => {
    const state = get();
    if (update.workspaceId !== state.workspaceId) return;
    if (update.type === 'snapshot') {
      if (update.cursor >= state.cursor) state.snapshot(update.snapshot);
      return;
    }
    if (update.type === 'event') {
      if (state.session && update.event.sessionId !== state.session.id) return;
      const previous = state.events[update.event.id];
      if (
        previous &&
        (previous.sessionId !== update.event.sessionId ||
          previous.revision >= update.event.revision)
      )
        return;
      const event = { ...update.event };
      if (event.command) {
        const chunks = records([...(previous?.command?.output ?? []), ...event.command.output]);
        event.command = {
          ...event.command,
          output: Object.values(chunks).sort((a, b) => a.sequence - b.sequence),
        };
      }
      set({
        events: { ...state.events, [event.id]: event },
        cursor: Math.max(state.cursor, update.cursor),
      });
    } else if (update.type === 'message') {
      if ((state.messages[update.message.id]?.revision ?? -1) >= update.message.revision) return;
      set({
        messages: { ...state.messages, [update.message.id]: update.message },
        cursor: Math.max(state.cursor, update.cursor),
      });
    } else {
      if ((state.approvals[update.approval.id]?.revision ?? -1) >= update.approval.revision) return;
      set({
        approvals: { ...state.approvals, [update.approval.id]: update.approval },
        cursor: Math.max(state.cursor, update.cursor),
      });
    }
  },
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
}));
let disconnect: (() => void) | undefined;
let generation = 0;
export async function connectWorkspace(workspaceId: string, sample: boolean): Promise<void> {
  disconnect?.();
  const version = ++generation;
  const adapter: WorkspaceAdapter = sample ? new SampleAdapter() : new BackendAdapter();
  useExecutionStore.getState().reset(workspaceId, adapter);
  try {
    const snapshot = workspaceId ? await adapter.getSnapshot(workspaceId) : emptySnapshot('');
    if (version !== generation) return;
    useExecutionStore.getState().snapshot(snapshot);
    let pending: LiveUpdate[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = adapter.subscribe(
      workspaceId,
      (update) => {
        pending.push(update);
        timer ??= setTimeout(() => {
          timer = undefined;
          if (version === generation)
            pending.forEach((item) => useExecutionStore.getState().apply(item));
          pending = [];
        }, 50);
      },
      snapshot.cursor,
    );
    disconnect = () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      pending = [];
    };
  } catch (error) {
    if (version === generation)
      useExecutionStore.setState({ loading: false, error: String(error) });
  }
}
export function disconnectWorkspace(): void {
  generation++;
  disconnect?.();
  disconnect = undefined;
}
