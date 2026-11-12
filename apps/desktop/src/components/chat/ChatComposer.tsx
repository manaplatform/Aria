import { useEffect, useRef } from 'react';
import { ArrowUp, Square, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../hooks/useChat';
import { sendChat, setChatDraft, stopChat } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button } from '../ui';

export function ChatComposer() {
  const { conversation, draft, busy, status } = useChat();
  const saving = useWorkspaceStore((state) => state.saving);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const navigate = useNavigate();
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
    return () => window.removeEventListener('aria:focus-chat', focus);
  }, []);
  const canSend = status.state === 'ready' && status.configured && Boolean(draft.trim()) && !busy;
  return (
    <div className="chat-composer-area">
      <form
        className={`chat-composer ${busy ? 'responding' : ''}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) void sendChat();
        }}
      >
        <textarea
          ref={textarea}
          autoFocus
          aria-label="Message Aria"
          aria-describedby="chat-input-hint"
          placeholder="Message Aria…"
          value={draft}
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
              if (canSend) void sendChat();
            }
          }}
        />
        <div className="chat-composer-toolbar">
          <span>{busy ? 'Aria is responding' : 'A little curiosity goes a long way.'}</span>
          {busy ? (
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
            <Button
              type="submit"
              variant="primary"
              size="icon"
              aria-label="Send message"
              disabled={!canSend}
            >
              <ArrowUp size={20} />
            </Button>
          )}
        </div>
      </form>
      {status.state === 'starting' ? (
        <p className="chat-connection-hint" role="status">
          Starting Aria’s chat service…
        </p>
      ) : !status.configured || status.state === 'failed' ? (
        <div className="chat-connection-hint">
          <span>{status.error || 'Connect your AI provider to start chatting.'}</span>
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
