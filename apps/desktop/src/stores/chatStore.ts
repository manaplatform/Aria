import { create } from 'zustand';
import type {
  ChatData,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  ChatServiceStatus,
} from '@aria/shared';
import { desktop, errorMessage } from '../services/desktop';
import { flushPersistence, useWorkspaceStore } from './workspaceStore';
import { notify } from './uiStore';

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
  updateChat((chat) => ({
    ...chat,
    selectedId: id && chat.conversations.some((item) => item.id === id) ? id : null,
  }));
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
  const chat = useWorkspaceStore.getState().data.chat;
  const message = chat.messages.find((item) => item.id === event.assistantMessageId);
  if (
    !message ||
    message.conversationId !== event.conversationId ||
    message.requestId !== event.requestId ||
    event.sequence <= message.sequence ||
    !generating(message)
  )
    return;
  updateChat((current) => ({
    ...current,
    messages: current.messages.map((item) => {
      if (item.id !== message.id) return item;
      const next = { ...item, sequence: event.sequence };
      if (event.type === 'started') return { ...next, status: 'streaming' };
      if (event.type === 'delta')
        return {
          ...next,
          status: 'streaming',
          content: (next.content + event.text).slice(0, 100000),
        };
      if (event.type === 'completed') return { ...next, status: 'completed' };
      if (event.type === 'stopped') return { ...next, status: 'stopped' };
      return { ...next, status: event.interrupted ? 'interrupted' : 'failed', error: event.error };
    }),
  }));
}

/** Send only complete recent turns, and always retain the newest user message. */
export function buildChatContext(messages: ChatMessage[]): ChatRequest['messages'] {
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser].role !== 'user') lastUser--;
  if (lastUser < 0) return [];
  const latest = messages[lastUser];
  const pairs: ChatRequest['messages'][] = [];
  for (let index = 0; index < lastUser; index++) {
    const user = messages[index];
    const assistant = messages[index + 1];
    if (
      user.role === 'user' &&
      assistant?.role === 'assistant' &&
      assistant.status === 'completed' &&
      assistant.content
    )
      pairs.push([
        { role: 'user', content: user.content },
        { role: 'assistant', content: assistant.content },
      ]);
  }
  const recent = pairs.slice(-20);
  let size =
    latest.content.length + recent.flat().reduce((sum, item) => sum + item.content.length, 0);
  while (size > 100000 && recent.length)
    size -= recent.shift()!.reduce((sum, item) => sum + item.content.length, 0);
  return [...recent.flat(), { role: 'user', content: latest.content }];
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
export async function sendChat(): Promise<void> {
  const { status } = useChatStore.getState();
  if (status.state !== 'ready' || !status.configured) return;
  const chat = useWorkspaceStore.getState().data.chat;
  const selected = chat.conversations.find((item) => item.id === chat.selectedId);
  const text = (selected?.draft ?? chat.newDraft).trim();
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
  };
  const assistant: ChatMessage = {
    ...user,
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    status: 'pending',
  };
  const history = [
    ...chat.messages.filter((item) => item.conversationId === conversation.id),
    user,
  ];
  updateChat((current) => ({
    ...current,
    selectedId: conversation.id,
    newDraft: selected ? current.newDraft : '',
    conversations: selected
      ? current.conversations.map((item) =>
          item.id === conversation.id ? { ...item, draft: '', updatedAt: now } : item,
        )
      : [...current.conversations, conversation],
    messages: [...current.messages, user, assistant],
  }));
  await submitRequest({
    requestId,
    conversationId: conversation.id,
    assistantMessageId: assistant.id,
    messages: buildChatContext(history),
  });
}
export async function regenerateChat(id: string): Promise<void> {
  const { status } = useChatStore.getState();
  if (status.state !== 'ready' || !status.configured) return;
  const chat = useWorkspaceStore.getState().data.chat;
  const history = chat.messages.filter((item) => item.conversationId === id);
  const last = history.at(-1);
  if (!last || last.role !== 'assistant' || history.some(generating)) return;
  const requestId = crypto.randomUUID();
  updateChat((current) => ({
    ...current,
    messages: current.messages.map((item) =>
      item.id === last.id
        ? { ...item, requestId, content: '', error: undefined, sequence: 0, status: 'pending' }
        : item,
    ),
    conversations: current.conversations.map((item) =>
      item.id === id ? { ...item, updatedAt: new Date().toISOString() } : item,
    ),
  }));
  await submitRequest({
    requestId,
    conversationId: id,
    assistantMessageId: last.id,
    messages: buildChatContext(history.slice(0, -1)),
  });
}
export async function stopChat(id: string): Promise<void> {
  const message = useWorkspaceStore
    .getState()
    .data.chat.messages.find((item) => item.conversationId === id && generating(item));
  if (!message) return;
  updateChat((chat) => ({
    ...chat,
    messages: chat.messages.map((item) =>
      item.id === message.id ? { ...item, status: 'stopped' } : item,
    ),
  }));
  try {
    await desktop().cancelChat(message.requestId);
  } catch {
    notify('Could not confirm cancellation. The response has been marked stopped locally.', true);
  }
}
export async function stopAllChats(): Promise<void> {
  const ids = new Set(
    useWorkspaceStore
      .getState()
      .data.chat.messages.filter(generating)
      .map((item) => item.conversationId),
  );
  await Promise.all([...ids].map(stopChat));
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
  const status = window.aria.onChatStatus((value) => {
    updated = true;
    useChatStore.setState({ status: value });
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
    status();
  };
}
