import { create } from 'zustand';
import { endActivity, projectChatEvent, selectChatContext } from '@aria/shared';
import type {
  ChatData,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ChatServiceStatus,
  MediaAsset,
} from '@aria/shared';
import { desktop, errorMessage } from '../services/desktop';
import { flushPersistence, useWorkspaceStore } from './workspaceStore';
import { notify } from './uiStore';
import { applyLiveEvent, endLiveVoice, useLiveVoiceStore } from './liveVoiceStore';

export const useChatStore = create<{ status: ChatServiceStatus }>(() => ({
  status: { state: 'starting', configured: false, model: '' },
}));
export const generating = (message: ChatMessage) =>
  message.status === 'pending' || message.status === 'streaming';
export function updateChat(update: (chat: ChatData) => ChatData): void {
  useWorkspaceStore.setState((state) => ({
    data: { ...state.data, chat: update(state.data.chat) },
  }));
}
export function selectChat(id: string | null): void {
  if (useLiveVoiceStore.getState().phase !== 'idle') {
    void endLiveVoice().then(() => selectChat(id));
    return;
  }
  updateChat((chat) => ({
    ...chat,
    selectedId: id && chat.conversations.some((item) => item.id === id) ? id : null,
  }));
}

export function ensureChatDraft(): string {
  const chat = useWorkspaceStore.getState().data.chat;
  if (chat.selectedId) return chat.selectedId;
  if (chat.conversations.length >= 500)
    throw new Error('Delete a conversation before starting another.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  updateChat((current) => ({
    ...current,
    selectedId: id,
    newDraft: '',
    newAttachments: [],
    conversations: [
      ...current.conversations,
      {
        id,
        title: 'New chat',
        draft: current.newDraft,
        attachments: current.newAttachments,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  }));
  return id;
}
export async function newTemporaryChat() {
  await endLiveVoice();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await desktop().startTemporaryChat(id);
  updateChat((current) => ({
    ...current,
    selectedId: id,
    conversations: [...current.conversations, {
      id, title: 'Temporary chat', draft: '', pinned: false,
      createdAt: now, updatedAt: now, temporary: true,
    }],
  }));
  await flushPersistence();
}

export async function chooseChatProject(projectId: string | null) {
  const id = ensureChatDraft();
  await flushPersistence();
  await desktop().attachChatProject(id, projectId);
  updateChat((current) => ({
    ...current,
    conversations: current.conversations.map((item) => item.id === id
      ? { ...item, projectId: projectId ?? undefined } : item),
  }));
  await flushPersistence();
}

export function setChatDraft(
  draft: string,
  id = useWorkspaceStore.getState().data.chat.selectedId,
): void {
  updateChat((chat) =>
    id
      ? {
          ...chat,
          conversations: chat.conversations.map((item) =>
            item.id === id ? { ...item, draft } : item,
          ),
        }
      : { ...chat, newDraft: draft },
  );
}
export function setChatAttachments(
  assets: MediaAsset[],
  id = useWorkspaceStore.getState().data.chat.selectedId,
): void {
  updateChat((chat) =>
    id
      ? {
          ...chat,
          conversations: chat.conversations.map((item) =>
            item.id === id ? { ...item, attachments: assets } : item,
          ),
        }
      : { ...chat, newAttachments: assets },
  );
}
export function renameChat(id: string, title: string): void {
  const trimmed = title.trim().slice(0, 1000);
  if (trimmed)
    updateChat((chat) => ({
      ...chat,
      conversations: chat.conversations.map((item) =>
        item.id === id ? { ...item, title: trimmed } : item,
      ),
    }));
}
export function pinChat(id: string): void {
  updateChat((chat) => ({
    ...chat,
    conversations: chat.conversations.map((item) =>
      item.id === id ? { ...item, pinned: !item.pinned } : item,
    ),
  }));
}
export function applyChatEvent(event: ChatEvent): void {
  const item = useWorkspaceStore.getState().data.chat.messages.find(({ id }) => id === event.assistantMessageId);
  if (!item) return;
  const next = projectChatEvent(item, event);
  if (next === item) return;
  updateChat((current) => ({
    ...current,
    messages: current.messages.map((message) => message.id === item.id ? next : message),
  }));
}

export function buildChatContext(messages: ChatMessage[]): ChatRequest['messages'] {
  return selectChatContext(messages).messages;
}
async function submitRequest(request: ChatRequest): Promise<void> {
  try {
    await flushPersistence();
    const state = useWorkspaceStore.getState();
    if (state.saveError)
      throw new Error('Your message could not be saved. Resolve the storage error and retry.');
    if (
      !state.data.chat.messages.some(
        (item) =>
          item.id === request.assistantMessageId &&
          item.requestId === request.requestId &&
          generating(item),
      )
    )
      return;
    await desktop().submitChat(request);
  } catch (error) {
    applyChatEvent({
      ...request,
      sequence: 1,
      type: 'failed',
      error: errorMessage(error).slice(0, 2000),
      interrupted: false,
    });
  }
}
export async function sendChat(suggestion?: string): Promise<void> {
  const { status } = useChatStore.getState();
  if (
    status.state !== 'ready' ||
    !status.configured ||
    useLiveVoiceStore.getState().phase !== 'idle'
  )
    return;
  const chat = useWorkspaceStore.getState().data.chat;
  const selected = chat.conversations.find((item) => item.id === chat.selectedId);
  const prompt = (suggestion ?? (selected?.draft ?? chat.newDraft)).trim();
  const attachments = suggestion ? [] : selected?.attachments ?? chat.newAttachments ?? [];
  const text = prompt || (attachments.length ? 'See attached files.' : '');
  if (
    !text ||
    chat.messages.some((item) => item.conversationId === selected?.id && generating(item))
  )
    return;
  if (!selected && chat.conversations.length >= 500) {
    notify(
      'You have reached the limit of 500 conversations. Delete a conversation to start another.',
      true,
    );
    return;
  }
  const now = new Date().toISOString();
  const conversation = selected ?? {
    id: crypto.randomUUID(),
    title: text.split('\n')[0].slice(0, 70),
    draft: '',
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  const requestId = crypto.randomUUID();
  const user: ChatMessage = {
    id: crypto.randomUUID(),
    conversationId: conversation.id,
    requestId,
    role: 'user',
    content: text,
    createdAt: now,
    status: 'completed',
    sequence: 0,
    ...(attachments.length ? { assets: attachments } : {}),
  };
  const assistant: ChatMessage = {
    ...user,
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    assets: undefined,
    status: 'pending',
  };
  const history = [
    ...chat.messages.filter((item) => item.conversationId === conversation.id),
    user,
  ];
  const firstTitle =
    history.length === 1 && conversation.title === 'New chat'
      ? text.split('\n')[0].slice(0, 70)
      : conversation.title;
  updateChat((current) => ({
    ...current,
    selectedId: conversation.id,
    newDraft: selected ? current.newDraft : '',
    newAttachments: selected ? current.newAttachments : [],
    conversations: selected
      ? current.conversations.map((item) =>
          item.id === conversation.id
            ? { ...item, title: firstTitle, draft: suggestion ? item.draft : '',
                attachments: suggestion ? item.attachments : [], updatedAt: now }
            : item,
        )
      : [...current.conversations, conversation],
    messages: [...current.messages, user, assistant],
  }));
  await submitRequest({
    requestId,
    conversationId: conversation.id,
    assistantMessageId: assistant.id,
    messages: buildChatContext(history),
    attachmentIds: attachments.map((asset) => asset.id),
  });
}
export async function regenerateChat(id: string, expectedRevision?: string): Promise<void> {
  const { status } = useChatStore.getState();
  if (
    status.state !== 'ready' ||
    !status.configured ||
    useLiveVoiceStore.getState().phase !== 'idle'
  )
    return;
  const chat = useWorkspaceStore.getState().data.chat;
  const history = chat.messages.filter((item) => item.conversationId === id);
  const last = history.at(-1);
  if (
    !last ||
    last.role !== 'assistant' ||
    last.liveSessionId ||
    last.delegatedFromVoice ||
    history.some(generating)
  )
    return;
  if (
    expectedRevision &&
    (!last.retryConfirmed ||
      last.run?.revision !== expectedRevision ||
      status.revision !== expectedRevision)
  )
    return;
  const attempts = [...(last.attempts ?? [])];
  if (last.run)
    attempts.push({
      requestId: last.requestId,
      run: last.run,
      activity: last.activity ?? [],
      outcome:
        last.status === 'pending' || last.status === 'streaming' ? 'interrupted' : last.status,
    });
  const requestId = crypto.randomUUID();
  updateChat((current) => ({
    ...current,
    messages: current.messages.map((item) =>
      item.id === last.id
        ? {
            ...item,
            requestId,
            content: '',
            assets: undefined,
            operation: undefined,
            run: undefined,
            execution: undefined,
            activity: undefined,
            citations: undefined,
            suggestions: undefined,
            memoryReferences: undefined,
            attempts: attempts.slice(-2),
            partial: undefined,
            retryConfirmed: undefined,
            settingsHelp: undefined,
            error: undefined,
            sequence: 0,
            status: 'pending',
          }
        : item,
    ),
    conversations: current.conversations.map((item) =>
      item.id === id ? { ...item, updatedAt: new Date().toISOString() } : item,
    ),
  }));
  const user = history.at(-2);
  await submitRequest({
    requestId,
    conversationId: id,
    assistantMessageId: last.id,
    expectedRevision,
    messages: buildChatContext(history.slice(0, -1)),
    attachmentIds: user?.assets?.map((asset) => asset.id) ?? user?.operation?.assetIds ?? [],
  });
}
export async function stopChat(id: string): Promise<void> {
  if (useLiveVoiceStore.getState().conversationId === id) {
    await endLiveVoice();
    return;
  }
  const message = useWorkspaceStore
    .getState()
    .data.chat.messages.find((item) => item.conversationId === id && generating(item));
  if (!message) return;
  updateChat((chat) => ({
    ...chat,
    messages: chat.messages.map((item) =>
      item.id === message.id
        ? {
            ...item,
            status: 'stopped',
            activity: endActivity(item.activity),
            retryConfirmed: false,
          }
        : item,
    ),
  }));
  try {
    await desktop().cancelChat(message.requestId);
  } catch {
    notify('Could not confirm cancellation. The response has been marked stopped locally.', true);
  }
}
export async function deleteChat(id: string): Promise<void> {
  await stopChat(id);
  updateChat((chat) => ({
    ...chat,
    selectedId: chat.selectedId === id ? null : chat.selectedId,
    conversations: chat.conversations.filter((item) => item.id !== id),
    messages: chat.messages.filter((item) => item.conversationId !== id),
  }));
  await flushPersistence();
}
export function bindChatBridge(): () => void {
  if (!window.aria) {
    useChatStore.setState({
      status: {
        state: 'failed',
        configured: false,
        model: '',
        error:
          'Open Aria Desktop to connect your AI provider. Browser preview does not send messages.',
      },
    });
    return () => undefined;
  }
  let active = true;
  let updated = false;
  const events = window.aria.onChatEvent(applyChatEvent);
  void window.aria.activeChatMessages?.().then((items) => {
    if (!active || !items.length) return;
    const snapshots = new Map(items.map((item) => [item.id, item]));
    updateChat((chat) => ({ ...chat, messages: chat.messages.map((item) => {
      const snapshot = snapshots.get(item.id);
      if (!snapshot || item.conversationId !== snapshot.conversationId) return item;
      if (snapshot.requestId === item.requestId && snapshot.sequence > item.sequence && item.status !== 'stopped')
        return snapshot;
      if (snapshot.execution && item.execution?.executionId === snapshot.execution.executionId &&
          snapshot.execution.generation > item.execution.generation) return snapshot;
      return item;
    }) }));
  }).catch(() => undefined);
  const liveEvents = window.aria.onLiveEvent?.(applyLiveEvent);
  const status = window.aria.onChatStatus((value) => {
    updated = true;
    useChatStore.setState({ status: value });
    if (value.state === 'failed') void endLiveVoice();
  });
  void window.aria
    .chatStatus()
    .then((value) => {
      if (active && !updated) useChatStore.setState({ status: value });
    })
    .catch(() => {
      if (active && !updated)
        useChatStore.setState({
          status: {
            state: 'failed',
            configured: false,
            model: '',
            error: 'The chat service is unavailable. Restart it in Settings.',
          },
        });
    });
  return () => {
    active = false;
    events();
    liveEvents?.();
    status();
    void endLiveVoice();
  };
}
