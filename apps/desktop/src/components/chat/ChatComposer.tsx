import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Square,
  ArrowUpRight,
  Paperclip,
  X,
  Mic,
  MicOff,
  PhoneOff,
  RefreshCw,
} from 'lucide-react';
import type { OperationInput } from '@aria/shared';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../hooks/useChat';
import { sendChat, setChatDraft, stopChat, setChatAttachments } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { refreshProvider, useProviderStore } from '../../stores/providerStore';
import {
  endLiveVoice,
  muteLiveVoice,
  startLiveVoice,
  useLiveVoiceStore,
} from '../../stores/liveVoiceStore';
import { desktop, errorMessage } from '../../services/desktop';
import { speechVoices } from '../../services/model-voices';
import { ModelSelect } from '../settings/ModelSelect';
import { Button } from '../ui';
export function ChatComposer() {
  const { conversation, draft, busy, status } = useChat();
  const saving = useWorkspaceStore((state) => state.saving);
  const newAttachments = useWorkspaceStore((state) => state.data.chat.newAttachments);
  const provider = useProviderStore();
  const live = useLiveVoiceStore();
  const [liveVoice, setLiveVoice] = useState('marin');
  const [mode, setMode] = useState<OperationInput['mode']>('chat');
  const [voice, setVoice] = useState('marin');
  const [error, setError] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
  const attachments = conversation?.attachments ?? newAttachments ?? [];
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
  useEffect(() => {
    const edit = () => setMode('image');
    window.addEventListener('aria:edit-image', edit);
    return () => window.removeEventListener('aria:edit-image', edit);
  }, []);
  const selected = provider.selections[mode];
  const available = provider.models.some(
    (m) => m.id === selected && (m.modes.length === 0 || m.modes.includes(mode)),
  );
  const voices = speechVoices(provider.selections.speech);
  useEffect(() => {
    const available = speechVoices(provider.selections.speech);
    setVoice((current) => (available.includes(current) ? current : available[0]));
  }, [provider.selections.speech]);
  const voiceActive = live.phase !== 'idle';
  const validAttachments =
    mode === 'image'
      ? attachments.length <= 4 && attachments.every((a) => a.mimeType.startsWith('image/'))
      : mode === 'transcription'
        ? attachments.length === 1 && attachments.every((a) => !a.mimeType.startsWith('image/'))
        : attachments.length === 0;
  const canSend =
    status.state === 'ready' &&
    available &&
    !provider.loading &&
    validAttachments &&
    Boolean(draft.trim() || mode === 'transcription') &&
    !busy &&
    !voiceActive;
  const send = () => {
    if (canSend)
      void sendChat({
        mode,
        model: selected,
        assetIds: attachments.map((a) => a.id),
        ...(mode === 'speech' ? { voice } : {}),
      });
  };
  const choose = async () => {
    setError('');
    try {
      const selectedId = conversation?.id ?? null;
      const files = await desktop().chooseMedia(mode === 'image' ? 'image' : 'audio');
      const merged = [...attachments, ...files];
      if (merged.length > (mode === 'image' ? 4 : 1))
        throw new Error('Choose up to four images or one audio file.');
      setChatAttachments(merged, selectedId);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const placeholder =
    mode === 'image'
      ? 'Describe an image, or attach images to edit…'
      : mode === 'speech'
        ? 'Enter the text to read aloud…'
        : mode === 'transcription'
          ? 'Attach an audio file to transcribe…'
          : 'Message Aria…';
  return (
    <div className="chat-composer-area">
      <div className="generation-controls">
        <select
          aria-label="Creation mode"
          value={mode}
          disabled={busy || voiceActive}
          onChange={(event) => {
            setMode(event.target.value as OperationInput['mode']);
            setError('');
          }}
        >
          <option value="chat">Chat</option>
          <option value="image">Image</option>
          <option value="speech">Speech</option>
          <option value="transcription">Transcribe</option>
        </select>
        <ModelSelect
          mode={mode}
          value={selected}
          models={provider.models}
          disabled={busy || voiceActive || provider.loading}
          onChange={(id) => provider.select(mode, id)}
        />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Refresh available models"
          disabled={provider.loading || voiceActive}
          onClick={() => void refreshProvider()}
        >
          <RefreshCw size={14} />
        </Button>
        {mode === 'speech' && (
          <select
            aria-label="Speech voice"
            value={voice}
            disabled={busy || voiceActive}
            onChange={(event) => setVoice(event.target.value)}
          >
            {voices.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        )}
      </div>
      <details className="voice-options">
        <summary>Live voice options</summary>
        <div className="generation-controls">
          <ModelSelect
            mode="live"
            value={provider.selections.live}
            models={provider.models}
            disabled={busy || voiceActive || provider.loading}
            onChange={(id) => provider.select('live', id)}
          />
          <ModelSelect
            mode="chat"
            label="Voice backend model"
            value={provider.selections.chat}
            models={provider.models}
            disabled={busy || voiceActive || provider.loading}
            onChange={(id) => provider.select('chat', id)}
          />
          <select
            aria-label="Live voice"
            value={liveVoice}
            disabled={voiceActive}
            onChange={(event) => setLiveVoice(event.target.value)}
          >
            {[
              'marin',
              'cedar',
              'alloy',
              'ash',
              'ballad',
              'coral',
              'echo',
              'sage',
              'shimmer',
              'verse',
            ].map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </div>
      </details>
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
                  onClick={() => setChatAttachments(attachments.filter((a) => a.id !== asset.id))}
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
          placeholder={placeholder}
          value={draft}
          disabled={voiceActive}
          maxLength={mode === 'speech' ? 4096 : mode === 'image' ? 32000 : 100000}
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
            {(mode === 'image' || mode === 'transcription') && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy || voiceActive}
                onClick={() => void choose()}
              >
                <Paperclip size={14} />
                {mode === 'image' ? 'Reference images' : 'Audio file'}
              </Button>
            )}
            <span>
              {voiceActive
                ? live.phase === 'active'
                  ? live.muted
                    ? 'Microphone muted'
                    : 'Listening · AI voice'
                  : live.phase === 'connecting'
                    ? 'Connecting voice…'
                    : 'Ending voice…'
                : busy
                  ? 'Aria is responding'
                  : mode === 'speech'
                    ? 'AI-generated speech'
                    : 'A little curiosity goes a long way.'}
            </span>
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
                disabled={
                  busy ||
                  provider.loading ||
                  status.state !== 'ready' ||
                  ![provider.selections.live, provider.selections.chat].every(
                    (id) => id && provider.models.some((m) => m.id === id),
                  )
                }
                onClick={() => void startLiveVoice(liveVoice)}
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
      {(error || live.error || provider.error) && (
        <p className="chat-response-error" role="alert">
          {error || live.error || provider.error}
        </p>
      )}
      {!validAttachments && (
        <p className="chat-response-error">
          {mode === 'chat' || mode === 'speech'
            ? 'Remove attachments to use this mode.'
            : mode === 'image'
              ? 'Attach up to four images for image editing.'
              : 'Attach one supported audio file.'}
        </p>
      )}
      {status.state === 'starting' ? (
        <p className="chat-connection-hint" role="status">
          Starting Aria’s chat service…
        </p>
      ) : !available || status.state === 'failed' ? (
        <div className="chat-connection-hint">
          <span>
            {status.error ||
              (provider.loading
                ? 'Loading available models…'
                : 'Select an available model to continue.')}
          </span>
          <button onClick={() => navigate('/settings')}>
            Model settings <ArrowUpRight size={12} />
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
