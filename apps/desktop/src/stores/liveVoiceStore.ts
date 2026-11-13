import { create } from 'zustand';
import { endActivity, type ChatMessage, type LiveEvent } from '@aria/shared';
import { desktop, errorMessage } from '../services/desktop';
import { LiveAudio } from '../audio/liveAudio';
import { flushPersistence, useWorkspaceStore } from './workspaceStore';
import { applyChatEvent, generating, updateChat, useChatStore } from './chatStore';
import { notify } from './uiStore';
interface LiveState {
  phase: 'idle' | 'connecting' | 'active' | 'ending';
  sessionId: string | null;
  conversationId: string | null;
  muted: boolean;
  error: string;
}
export const useLiveVoiceStore = create<LiveState>(() => ({
  phase: 'idle',
  sessionId: null,
  conversationId: null,
  muted: false,
  error: '',
}));
let audio: LiveAudio | undefined;
let generation = 0;
export function applyLiveEvent(event: LiveEvent) {
  const state = useLiveVoiceStore.getState();
  if (event.sessionId !== state.sessionId || event.conversationId !== state.conversationId) return;
  if (event.type === 'conductor') {
    const messages = useWorkspaceStore.getState().data.chat.messages;
    const record = messages.find(
      (item) => item.id === event.requestId && item.conversationId === event.conversationId,
    );
    if (!record) {
      updateChat((chat) => ({
        ...chat,
        messages: [
          ...chat.messages,
          {
            id: event.requestId,
            requestId: event.requestId,
            conversationId: event.conversationId,
            role: 'assistant',
            content: '',
            status: 'pending',
            sequence: 0,
            delegatedFromVoice: true,
            createdAt: new Date().toISOString(),
          },
        ],
      }));
    }
    applyChatEvent({
      ...event.event,
      requestId: event.requestId,
      conversationId: event.conversationId,
      assistantMessageId: event.requestId,
      sequence: (record?.sequence ?? 0) + 1,
    });
    return;
  }
  if (event.type === 'ready') {
    if (state.phase === 'connecting') useLiveVoiceStore.setState({ phase: 'active' });
    return;
  }
  if (event.type === 'audio') {
    try {
      audio?.play(event.audio);
    } catch {
      void endLiveVoice();
      notify('Voice playback could not keep up. The session has ended.', true);
    }
    return;
  }
  if (event.type === 'transcript') {
    if (event.role === 'user' && !state.muted) audio?.interrupt();
    updateChat((chat) => ({
      ...chat,
      messages: chat.messages.map((message) => {
        if (message.liveSessionId !== event.sessionId || message.role !== event.role)
          return message;
        const fragments = [
          ...(message.fragments || []),
          { text: event.text, startMs: event.startMs, endMs: event.endMs },
        ].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
        return {
          ...message,
          status: 'streaming',
          content: fragments.map((fragment) => fragment.text).join(''),
          fragments,
        };
      }),
    }));
    return;
  }
  audio?.close();
  audio = undefined;
  updateChat((chat) => ({
    ...chat,
    messages: chat.messages.map((message) =>
      message.liveSessionId === event.sessionId
        ? {
            ...message,
            status:
              event.type === 'failed'
                ? 'interrupted'
                : message.content || (message.role === 'assistant' && event.asset)
                  ? 'completed'
                  : 'stopped',
            ...(message.role === 'assistant' && event.asset ? { assets: [event.asset] } : {}),
            ...(event.type === 'failed' ? { error: event.error } : {}),
          }
        : message.delegatedFromVoice &&
            message.conversationId === event.conversationId &&
            generating(message)
          ? {
              ...message,
              status: event.type === 'failed' ? 'interrupted' : 'stopped',
              activity: endActivity(message.activity),
              retryConfirmed: false,
            }
          : message,
    ),
  }));
  useLiveVoiceStore.setState({
    phase: 'idle',
    sessionId: null,
    conversationId: null,
    muted: false,
    error: event.type === 'failed' ? event.error : '',
  });
}
export async function startLiveVoice() {
  if (useLiveVoiceStore.getState().phase !== 'idle') return;
  if (!useChatStore.getState().status.voiceReady) {
    notify('Configure the Live Voice profile in Settings → AI Models.', true);
    return;
  }
  if (useWorkspaceStore.getState().data.chat.messages.some(generating)) {
    notify('Stop current responses before starting voice.', true);
    return;
  }
  const current = ++generation;
  useLiveVoiceStore.setState({ phase: 'connecting', error: '' });
  const engine = new LiveAudio();
  audio = engine;
  let microphoneReady = false;
  try {
    await engine.open((bytes) => {
      const state = useLiveVoiceStore.getState();
      if (state.phase === 'active' && !state.muted && state.sessionId)
        desktop().sendLiveAudio(state.sessionId, bytes);
    });
    microphoneReady = true;
    if (current !== generation) {
      engine.close();
      return;
    }
    const chat = useWorkspaceStore.getState().data.chat;
    if (!chat.selectedId && chat.conversations.length >= 500)
      throw new Error('Delete a conversation before starting another.');
    const now = new Date().toISOString();
    const conversationId = chat.selectedId || crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const messages: ChatMessage[] = (['user', 'assistant'] as const).map((role) => ({
      id: crypto.randomUUID(),
      requestId: sessionId,
      conversationId,
      liveSessionId: sessionId,
      role,
      content: '',
      createdAt: now,
      status: 'pending',
      sequence: 0,
      fragments: [],
    }));
    useLiveVoiceStore.setState({ sessionId, conversationId });
    updateChat((data) => ({
      ...data,
      selectedId: conversationId,
      conversations: data.selectedId
        ? data.conversations
        : [
            ...data.conversations,
            {
              id: conversationId,
              title: 'Voice conversation',
              draft: '',
              pinned: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
      messages: [...data.messages, ...messages],
    }));
    await flushPersistence();
    if (useWorkspaceStore.getState().saveError)
      throw new Error('Resolve the conversation storage error before starting voice.');
    if (current !== generation) {
      engine.close();
      return;
    }
    const history = chat.messages
      .filter(
        (m) =>
          m.conversationId === conversationId &&
          m.status === 'completed' &&
          m.content &&
          (!m.operation || m.operation.mode === 'chat'),
      )
      .slice(-40);
    const bounded = [];
    let size = 0;
    for (const message of [...history].reverse()) {
      if (size + message.content.length > 100000) break;
      size += message.content.length;
      bounded.unshift({ role: message.role, content: message.content });
    }
    await desktop().startLive({
      sessionId,
      conversationId,
      assistantMessageId: messages[1].id,
      messages: bounded,
    });
  } catch (error) {
    engine.close();
    if (audio === engine) audio = undefined;
    const message = !microphoneReady
      ? error instanceof DOMException &&
        ['NotAllowedError', 'PermissionDeniedError'].includes(error.name)
        ? 'Microphone access was denied. Enable microphone access in system settings and try again.'
        : 'Voice audio could not start. Check your microphone and restart Aria.'
      : errorMessage(error);
    const state = useLiveVoiceStore.getState();
    if (state.sessionId)
      applyLiveEvent({
        sessionId: state.sessionId,
        conversationId: state.conversationId!,
        type: 'failed',
        error: message,
      });
    else if (current === generation) useLiveVoiceStore.setState({ phase: 'idle', error: message });
  }
}
export async function endLiveVoice() {
  ++generation;
  const state = useLiveVoiceStore.getState();
  if (state.phase === 'idle') return;
  audio?.close();
  audio = undefined;
  useLiveVoiceStore.setState({ phase: 'ending' });
  try {
    await desktop().endLive();
  } catch {
    if (state.sessionId)
      applyLiveEvent({
        sessionId: state.sessionId,
        conversationId: state.conversationId!,
        type: 'failed',
        error: 'The voice session was interrupted.',
      });
  }
  if (useLiveVoiceStore.getState().phase === 'ending' && state.sessionId)
    applyLiveEvent({
      type: 'ended',
      sessionId: state.sessionId,
      conversationId: state.conversationId!,
    });
  if (useLiveVoiceStore.getState().phase === 'ending')
    useLiveVoiceStore.setState({
      phase: 'idle',
      sessionId: null,
      conversationId: null,
      muted: false,
    });
  await flushPersistence();
}
export async function muteLiveVoice() {
  const state = useLiveVoiceStore.getState();
  if (state.phase !== 'active' || !state.sessionId) return;
  const muted = !state.muted;
  audio?.mute(muted);
  useLiveVoiceStore.setState({ muted });
  try {
    await desktop().muteLive(state.sessionId, muted);
  } catch {
    await endLiveVoice();
  }
}
