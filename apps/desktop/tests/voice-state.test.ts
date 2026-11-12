import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import type { DesktopBridge } from '@aria/shared';
const capture = vi.hoisted(() => ({
  open: vi.fn<(callback: (audio: Uint8Array) => void) => Promise<void>>(),
  close: vi.fn(),
  play: vi.fn(),
  interrupt: vi.fn(),
  mute: vi.fn(),
}));
vi.mock('../src/audio/liveAudio', () => ({
  LiveAudio: class {
    open = capture.open;
    close = capture.close;
    play = capture.play;
    interrupt = capture.interrupt;
    mute = capture.mute;
  },
}));
import {
  startLiveVoice,
  endLiveVoice,
  applyLiveEvent,
  muteLiveVoice,
  useLiveVoiceStore,
} from '../src/stores/liveVoiceStore';
import { useProviderStore } from '../src/stores/providerStore';
import { useWorkspaceStore, flushPersistence } from '../src/stores/workspaceStore';
import { emptyData } from '../src/services/desktop';
beforeEach(() => {
  vi.clearAllMocks();
  capture.open.mockResolvedValue(undefined);
  useWorkspaceStore.setState({ data: emptyData(), ready: true, saveError: null });
  useProviderStore.setState({
    selections: {
      chat: 'gpt-chat-from-api',
      image: '',
      speech: '',
      transcription: '',
      live: 'gpt-live-from-api',
    },
    models: [
      { id: 'gpt-chat-from-api', modes: ['chat'] },
      { id: 'gpt-live-from-api', modes: ['live'] },
    ],
  });
  useLiveVoiceStore.setState({
    phase: 'idle',
    sessionId: null,
    conversationId: null,
    muted: false,
    error: '',
  });
  window.aria = {
    save: vi.fn().mockResolvedValue(undefined),
    startLive: vi.fn().mockResolvedValue(undefined),
    endLive: vi.fn().mockResolvedValue(undefined),
    muteLive: vi.fn().mockResolvedValue(undefined),
    sendLiveAudio: vi.fn(),
  } as unknown as DesktopBridge;
});
afterEach(async () => {
  await endLiveVoice();
  await flushPersistence();
  delete window.aria;
});
it('handles denied microphone access without starting a provider session or saving recordings', async () => {
  capture.open.mockRejectedValueOnce(new DOMException('Private device details', 'NotAllowedError'));
  await startLiveVoice();
  expect(useLiveVoiceStore.getState()).toMatchObject({
    phase: 'idle',
    error: expect.stringContaining('Microphone access was denied'),
  });
  expect(window.aria!.startLive).not.toHaveBeenCalled();
  expect(useWorkspaceStore.getState().data.chat.messages).toEqual([]);
  expect(capture.close).toHaveBeenCalled();
});
it('saves timestamped captions and assistant audio, mutes capture, and releases microphone resources', async () => {
  await startLiveVoice();
  const { sessionId, conversationId } = useLiveVoiceStore.getState();
  const envelope = { sessionId: sessionId!, conversationId: conversationId! };
  applyLiveEvent({ ...envelope, type: 'ready' });
  capture.open.mock.calls[0][0](new Uint8Array([0, 0]));
  expect(window.aria!.sendLiveAudio).toHaveBeenCalled();
  await muteLiveVoice();
  capture.open.mock.calls[0][0](new Uint8Array([0, 0]));
  expect(window.aria!.sendLiveAudio).toHaveBeenCalledTimes(1);
  expect(capture.mute).toHaveBeenCalledWith(true);
  applyLiveEvent({
    ...envelope,
    type: 'transcript',
    role: 'assistant',
    text: 'world',
    startMs: 100,
    endMs: 200,
  });
  applyLiveEvent({
    ...envelope,
    type: 'transcript',
    role: 'assistant',
    text: 'Hello ',
    startMs: 0,
    endMs: 100,
  });
  const asset = {
    id: 'e2379337-94ed-43b6-a951-14f1fbe34546',
    name: 'replies.wav',
    mimeType: 'audio/wav',
    size: 100,
  };
  window.aria!.endLive = vi.fn(async () => applyLiveEvent({ ...envelope, type: 'ended', asset }));
  await endLiveVoice();
  const messages = useWorkspaceStore.getState().data.chat.messages;
  expect(messages.find((m) => m.role === 'assistant')).toMatchObject({
    content: 'Hello world',
    status: 'completed',
    assets: [asset],
    liveConfig: { model: 'gpt-live-from-api', chatModel: 'gpt-chat-from-api', voice: 'marin' },
  });
  expect(messages.find((m) => m.role === 'user')?.assets).toBeUndefined();
  expect(capture.close).toHaveBeenCalled();
  expect(useLiveVoiceStore.getState().phase).toBe('idle');
});
it('cancels startup while persistence is pending without opening a late provider session or leaving pending messages', async () => {
  let finishSave!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  window.aria!.save = vi.fn(() => pending);
  const startup = startLiveVoice();
  await waitFor(() => expect(window.aria!.save).toHaveBeenCalled());
  const ending = endLiveVoice();
  finishSave();
  await Promise.all([startup, ending]);
  expect(window.aria!.startLive).not.toHaveBeenCalled();
  expect(useWorkspaceStore.getState().data.chat.messages.every((m) => m.status === 'stopped')).toBe(
    true,
  );
  expect(useLiveVoiceStore.getState().phase).toBe('idle');
});
