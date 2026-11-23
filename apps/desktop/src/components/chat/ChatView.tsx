import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMemoryStatus } from '../../hooks/useMemoryStatus';
import { chooseChatProject, newTemporaryChat, sendChat } from '../../stores/chatStore';
import { errorMessage } from '../../services/desktop';
import { notify } from '../../stores/uiStore';
import { ArrowDown } from 'lucide-react';
import { useChat } from '../../hooks/useChat';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button } from '../ui';
import { ChatWelcome } from './ChatWelcome';
import { ChatMessage } from './ChatMessage';
import { ChatComposer } from './ChatComposer';

export default function ChatView() {
  const { conversation, messages, busy, status } = useChat();
  const memory = useMemoryStatus();
  const projects = useWorkspaceStore((state) => state.data.workspaces);
  const location = useLocation();
  const [openingTemporary, setOpeningTemporary] = useState(false);
  const suggested = messages.at(-1)?.suggestions;
  const name = useWorkspaceStore((state) => state.data.preferences.profileName);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const sourceLocation = useRef<string>();
  const [jump, setJump] = useState(false);
  useEffect(() => {
    nearBottom.current = true;
    setJump(false);
  }, [conversation?.id]);
  useEffect(() => {
    const messageId = typeof location.state?.messageId === 'string' ? location.state.messageId : undefined;
    if (messageId && sourceLocation.current !== location.key) {
      const source = document.getElementById('chat-message-' + messageId);
      if (source) {
        sourceLocation.current = location.key;
        const frame = requestAnimationFrame(() => {
          source.scrollIntoView({ block: 'center' });
          source.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
      }
    }
    if (!nearBottom.current) {
      setJump(true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, location.key, location.state]);
  return (
    <div className="chat-view">
      <div
        className="chat-scroll"
        ref={scroll}
        onScroll={() => {
          const node = scroll.current;
          if (node) {
            nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            setJump(!nearBottom.current);
          }
        }}
      >
        {messages.length ? (
          <div
            className="chat-reading-column"
            role="log"
            aria-label="Conversation messages"
            aria-live="off"
          >
            {messages.map((message, index) => (
              <ChatMessage
                key={message.id}
                message={message}
                last={index === messages.length - 1}
                canRegenerate={!busy && status.state === 'ready'}
                name={name}
                canRemember={Boolean(memory?.settings.enabled && !conversation?.temporary)}
              />
            ))}
          </div>
        ) : (
          <ChatWelcome />
        )}
      </div>
      {jump && (
        <Button
          className="chat-jump"
          size="sm"
          onClick={() => {
            nearBottom.current = true;
            setJump(false);
            if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
          }}
        >
          <ArrowDown size={14} />
          Jump to latest
        </Button>
      )}
      {conversation?.temporary && <p className="memory-chat-toolbar muted">
        Temporary chat · session only · persistent memory off
      </p>}
      {!messages.length && !conversation?.temporary && (memory?.settings.temporaryChats || projects.length > 0) && (
        <div className="memory-chat-toolbar">
          {memory?.settings.temporaryChats && (
            <Button size="sm" variant="ghost" disabled={openingTemporary} onClick={() => {
              setOpeningTemporary(true);
              void newTemporaryChat().catch((error) => notify(errorMessage(error), true))
                .finally(() => setOpeningTemporary(false));
            }}>Start temporary chat</Button>
          )}
          {projects.length > 0 && (
            <select aria-label="Chat project" value={conversation?.projectId ?? ''} onChange={(event) => {
              void chooseChatProject(event.target.value || null).catch((error) => notify(errorMessage(error), true));
            }}>
              <option value="">No project</option>
              {projects.map(({ id, name: title }) => <option key={id} value={id}>{title}</option>)}
            </select>
          )}
        </div>
      )}
      {memory?.settings.suggestions && !busy && Boolean(suggested?.length) &&
        <div className="memory-chat-toolbar suggestions" aria-label="Suggested follow-ups">
          {suggested?.map((item) => <Button size="sm" key={item} onClick={() => void sendChat(item)}>{item}</Button>)}
        </div>}
      <ChatComposer />
    </div>
  );
}
