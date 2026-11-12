import { create } from 'zustand';
import type { Conversation, LocalData, Plan, Preferences, Task, Workspace } from '@aria/shared';
import { desktop, emptyData, errorMessage } from '../services/desktop';
import { sampleConversation, sampleWorkspace } from '../services/sample';
import { connectWorkspace, useExecutionStore } from './executionStore';
import { notify } from './uiStore';

export function validateDependencies(task: Task, tasks: Task[]): void {
  const all = new Map(tasks.map((item) => [item.id, item]));
  all.set(task.id, task);
  const visit = (id: string, path: Set<string>): void => {
    if (path.has(id)) throw new Error('Task dependencies cannot contain a cycle.');
    const next = all.get(id);
    if (!next || next.workspaceId !== task.workspaceId)
      throw new Error('Dependency is not in this project.');
    next.dependencies.forEach((dependency) => visit(dependency, new Set([...path, id])));
  };
  visit(task.id, new Set());
}
interface WorkspaceState {
  data: LocalData;
  ready: boolean;
  loadError: string | null;
  saveError: string | null;
  saving: boolean;
  sample: boolean;
  sampleDraft: Conversation;
  selectedConversationId: string | null;
  preferences: (patch: Partial<Preferences>) => void;
  chooseWorkspace: () => Promise<void>;
  selectWorkspace: (id: string) => void;
  enterSample: () => void;
  exitSample: () => void;
  resetSample: () => void;
  newConversation: () => string | null;
  selectConversation: (id: string) => void;
  updateConversation: (patch: Partial<Conversation>) => void;
  saveTask: (task: Task) => void;
  deleteTask: (id: string) => void;
  savePlan: (plan: Plan) => void;
}
export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  data: emptyData(),
  ready: false,
  loadError: null,
  saveError: null,
  saving: false,
  sample: false,
  sampleDraft: { ...sampleConversation },
  selectedConversationId: null,
  preferences: (patch) =>
    set((state) => ({
      data: { ...state.data, preferences: { ...state.data.preferences, ...patch } },
    })),
  chooseWorkspace: async () => {
    try {
      await flushPersistence();
      const workspace = await desktop().chooseWorkspace();
      if (!workspace) return;
      set((state) => ({
        sample: false,
        selectedConversationId: null,
        data: {
          ...state.data,
          workspaces: [
            ...state.data.workspaces.filter((item) => item.id !== workspace.id),
            workspace,
          ],
          preferences: { ...state.data.preferences, activeWorkspaceId: workspace.id },
        },
      }));
      void connectWorkspace(workspace.id, false);
    } catch (error) {
      notify(errorMessage(error), true);
    }
  },
  selectWorkspace: (id) => {
    set((state) => ({
      sample: false,
      selectedConversationId: null,
      data: { ...state.data, preferences: { ...state.data.preferences, activeWorkspaceId: id } },
    }));
    void connectWorkspace(id, false);
  },
  enterSample: () => {
    set({ sample: true, sampleDraft: { ...sampleConversation }, selectedConversationId: null });
    void connectWorkspace('sample', true);
  },
  exitSample: () => {
    set({ sample: false, selectedConversationId: null });
    void connectWorkspace(get().data.preferences.activeWorkspaceId ?? '', false);
  },
  resetSample: () => {
    set({ sampleDraft: { ...sampleConversation } });
    void connectWorkspace('sample', true);
  },
  newConversation: () => {
    if (get().sample) {
      set({ sampleDraft: { ...sampleConversation, draft: '' } });
      return sampleConversation.id;
    }
    const workspaceId = get().data.preferences.activeWorkspaceId;
    if (!workspaceId) return null;
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      workspaceId,
      title: 'Untitled draft',
      draft: '',
      mode: 'chat',
      attachments: [],
      updatedAt: new Date().toISOString(),
    };
    set((state) => ({
      selectedConversationId: conversation.id,
      data: { ...state.data, conversations: [...state.data.conversations, conversation] },
    }));
    return conversation.id;
  },
  selectConversation: (id) => set({ selectedConversationId: id }),
  updateConversation: (patch) => {
    if (get().sample) {
      set((state) => ({ sampleDraft: { ...state.sampleDraft, ...patch } }));
      return;
    }
    let conversation = activeConversation(get());
    if (!conversation) {
      get().newConversation();
      conversation = activeConversation(get());
    }
    if (!conversation) return;
    const id = conversation.id;
    set((state) => ({
      data: {
        ...state.data,
        conversations: state.data.conversations.map((item) =>
          item.id === id
            ? {
                ...item,
                ...patch,
                title: patch.draft?.trim().slice(0, 70) || item.title,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      },
    }));
  },
  saveTask: (task) => {
    const tasks = get().sample
      ? Object.values(useExecutionStore.getState().tasks)
      : get().data.tasks;
    validateDependencies(task, tasks);
    if (get().sample)
      useExecutionStore.setState((state) => ({
        tasks: { ...state.tasks, [task.id]: { ...task, source: 'sample' } },
      }));
    else
      set((state) => ({
        data: {
          ...state.data,
          tasks: [
            ...state.data.tasks.filter((item) => item.id !== task.id),
            { ...task, source: 'local' },
          ],
        },
      }));
  },
  deleteTask: (id) => {
    if (get().sample) {
      const tasks = { ...useExecutionStore.getState().tasks };
      delete tasks[id];
      Object.values(tasks).forEach((task) => {
        tasks[task.id] = { ...task, dependencies: task.dependencies.filter((item) => item !== id) };
      });
      useExecutionStore.setState({ tasks });
    } else
      set((state) => ({
        data: {
          ...state.data,
          tasks: state.data.tasks
            .filter((task) => task.id !== id)
            .map((task) => ({
              ...task,
              dependencies: task.dependencies.filter((item) => item !== id),
            })),
        },
      }));
  },
  savePlan: (plan) => {
    if (get().sample)
      useExecutionStore.setState((state) => ({
        plans: { ...state.plans, [plan.id]: { ...plan, source: 'sample' } },
      }));
    else
      set((state) => ({
        data: {
          ...state.data,
          plans: [
            ...state.data.plans.filter((item) => item.id !== plan.id),
            { ...plan, source: 'local' },
          ],
        },
      }));
  },
}));
export function activeWorkspace(
  state: Pick<WorkspaceState, 'sample' | 'data'>,
): Workspace | undefined {
  return state.sample
    ? sampleWorkspace
    : state.data.workspaces.find((item) => item.id === state.data.preferences.activeWorkspaceId);
}
export function activeConversation(
  state: Pick<WorkspaceState, 'sample' | 'sampleDraft' | 'data' | 'selectedConversationId'>,
): Conversation | undefined {
  return state.sample
    ? state.sampleDraft
    : (state.data.conversations.find(
        (item) =>
          item.id === state.selectedConversationId &&
          item.workspaceId === state.data.preferences.activeWorkspaceId,
      ) ??
        [...state.data.conversations]
          .reverse()
          .find((item) => item.workspaceId === state.data.preferences.activeWorkspaceId));
}
let bootstrap: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let checkpointTimer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let persistenceQueue: Promise<void> = Promise.resolve();
export function flushPersistence(): Promise<void> {
  if (checkpointTimer) {
    clearTimeout(checkpointTimer);
    checkpointTimer = undefined;
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  persistenceQueue = persistenceQueue.then(async () => {
    if (!dirty || !window.aria) return;
    const data = useWorkspaceStore.getState().data;
    dirty = false;
    useWorkspaceStore.setState({ saving: true });
    try {
      await desktop().save(data);
      useWorkspaceStore.setState({ saving: false, saveError: null });
    } catch (error) {
      dirty = true;
      useWorkspaceStore.setState({ saving: false, saveError: errorMessage(error) });
    }
  });
  return persistenceQueue;
}
useWorkspaceStore.subscribe((state, previous) => {
  if (!state.ready || state.data === previous.data) return;
  dirty = true;
  // Continuous streaming must not postpone persistence until the response ends.
  checkpointTimer ??= setTimeout(() => {
    void flushPersistence();
  }, 2000);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void flushPersistence();
  }, 250);
});
export function initializeWorkspace(): Promise<void> {
  return (bootstrap ??= (async () => {
    try {
      const initial = window.aria
        ? await desktop().load()
        : {
            data: emptyData(),
            warning: 'Browser preview: open Aria Desktop for AI chat and local persistence.',
          };
      window.location.hash = '/chat';
      useWorkspaceStore.setState({ data: initial.data, ready: true });
      if (initial.warning) notify(initial.warning, true);
    } catch (error) {
      useWorkspaceStore.setState({ ready: true, loadError: errorMessage(error) });
    }
  })());
}
