import { useEffect, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useChat } from '../../hooks/useChat';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button } from '../ui';
import { ChatWelcome } from './ChatWelcome';
import { ChatMessage } from './ChatMessage';
import { ChatComposer } from './ChatComposer';

export default function ChatView() {
  const { conversation, messages, busy, status } = useChat();
  const name = useWorkspaceStore((state) => state.data.preferences.profileName);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [jump, setJump] = useState(false);
  useEffect(() => {
    nearBottom.current = true;
    setJump(false);
  }, [conversation?.id]);
  useEffect(() => {
    if (!nearBottom.current) {
      setJump(true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages]);
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
                canRegenerate={!busy && status.state === 'ready' && status.configured}
                name={name}
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
      <ChatComposer />
    </div>
  );
}
