import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, Mic, MicOff, Paperclip, PhoneOff, Square, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../hooks/useChat';
import { desktop, errorMessage } from '../../services/desktop';
import { sendChat, setChatDraft, stopChat, setChatAttachments } from '../../stores/chatStore';
import {
  endLiveVoice,
  muteLiveVoice,
  startLiveVoice,
  useLiveVoiceStore,
} from '../../stores/liveVoiceStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button } from '../ui';

export function ChatComposer() {
  const { conversation, draft, busy, status } = useChat();
  const saving = useWorkspaceStore((state) => state.saving);
  const newAttachments = useWorkspaceStore((state) => state.data.chat.newAttachments);
  const live = useLiveVoiceStore();
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const attachments = conversation ? (conversation.attachments ?? []) : (newAttachments ?? []);
  const voiceActive = live.phase !== 'idle';
  const canSend =
    status.state === 'ready' &&
    status.configured &&
    !busy &&
    !voiceActive &&
    !picking &&
    Boolean(draft.trim() || attachments.length);

  useEffect(() => {
    const input = textarea.current;
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(200, Math.max(52, input.scrollHeight))}px`;
    }
  }, [draft, conversation?.id]);

  useEffect(() => {
    const focus = () => textarea.current?.focus();
    window.addEventListener('aria:focus-chat', focus);
    return () => {
      window.removeEventListener('aria:focus-chat', focus);
      void endLiveVoice();
    };
  }, []);

  const choose = async () => {
    setError('');
    setPicking(true);
    const id = conversation?.id ?? null;
    try {
      const files = await desktop().chooseMedia('any');
      if (!files.length) return;
      const chat = useWorkspaceStore.getState().data.chat;
      const target = id ? chat.conversations.find((item) => item.id === id) : null;
      if (id && !target) return;
      const merged = [
        ...(id ? (target?.attachments ?? []) : (chat.newAttachments ?? [])),
        ...files,
      ];
      if (merged.length > 4 || merged.reduce((total, asset) => total + asset.size, 0) > 80_000_000)
        throw new Error('Attach up to four files totaling 80 MB.');
      setChatAttachments(merged, id);
      textarea.current?.focus();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPicking(false);
    }
  };

  const send = () => {
    if (canSend) void sendChat();
  };

  return (
    <div className="chat-composer-area">
      <form
        className={`chat-composer ${busy ? 'responding' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((asset) => (
              <span key={asset.id}>
                {asset.name}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${asset.name}`}
                  disabled={busy || voiceActive}
                  onClick={() =>
                    setChatAttachments(attachments.filter((item) => item.id !== asset.id))
                  }
                >
                  <X size={12} />
                </Button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textarea}
          autoFocus
          aria-label="Message Aria"
          aria-describedby="chat-input-hint"
          placeholder="Message Aria…"
          value={draft}
          disabled={voiceActive}
          maxLength={100000}
          rows={1}
          onChange={(event) => setChatDraft(event.target.value, conversation?.id ?? null)}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
        <div className="chat-composer-toolbar">
          <div className="composer-tools">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || voiceActive || picking || attachments.length >= 4}
              onClick={() => void choose()}
            >
              <Paperclip size={14} /> Attach files
            </Button>
            {voiceActive && (
              <span role="status">
                {live.phase === 'active'
                  ? live.muted
                    ? 'Microphone muted'
                    : 'Listening · AI voice'
                  : live.phase === 'connecting'
                    ? 'Connecting voice…'
                    : 'Ending voice…'}
              </span>
            )}
          </div>
          <div className="composer-tools">
            {voiceActive ? (
              <>
                <Button
                  type="button"
                  size="icon"
                  aria-label={live.muted ? 'Unmute microphone' : 'Mute microphone'}
                  disabled={live.phase !== 'active'}
                  onClick={() => void muteLiveVoice()}
                >
                  {live.muted ? <MicOff size={16} /> : <Mic size={16} />}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="danger"
                  aria-label="End voice conversation"
                  disabled={live.phase === 'ending'}
                  onClick={() => void endLiveVoice()}
                >
                  <PhoneOff size={16} />
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label="Start live voice conversation"
                title={status.voiceReady ? 'Start Live Voice' : 'Configure Live Voice in AI Models'}
                disabled={busy || !status.voiceReady}
                onClick={() => void startLiveVoice()}
              >
                <Mic size={17} />
              </Button>
            )}
            {busy && !voiceActive ? (
              <Button
                type="button"
                variant="primary"
                size="icon"
                aria-label="Stop response"
                onClick={() => {
                  if (conversation) void stopChat(conversation.id);
                }}
              >
                <Square size={14} fill="currentColor" />
              </Button>
            ) : (
              !voiceActive && (
                <Button
                  type="submit"
                  variant="primary"
                  size="icon"
                  aria-label="Send message"
                  disabled={!canSend}
                >
                  <ArrowUp size={20} />
                </Button>
              )
            )}
          </div>
        </div>
      </form>
      {(error || live.error) && (
        <p className="chat-response-error" role="alert">
          {error || live.error}
        </p>
      )}
      {status.state === 'starting' ? (
        <p className="chat-connection-hint" role="status">
          Starting Aria’s chat service…
        </p>
      ) : status.state === 'failed' || !status.configured ? (
        <div className="chat-connection-hint">
          <span>{status.error || 'Choose a primary model to start chatting.'}</span>
          <button onClick={() => navigate('/settings#ai-models')}>
            AI Models <ArrowUpRight size={12} />
          </button>
        </div>
      ) : null}
      <div id="chat-input-hint" className="chat-composer-hint">
        <span>
          Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line
        </span>
        <span>{saving ? 'Saving…' : 'Saved on this device'}</span>
      </div>
    </div>
  );
}
