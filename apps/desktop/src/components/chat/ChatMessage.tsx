import { RotateCcw } from 'lucide-react';
import type { ChatMessage as Message } from '@aria/shared';
import { generating, regenerateChat } from '../../stores/chatStore';
import { AriaMark } from '../layout/AriaMark';
import { Button, CopyButton } from '../ui';
import MarkdownRenderer from './MarkdownRenderer';

export function ChatMessage({
  message,
  last,
  canRegenerate,
  name,
}: {
  message: Message;
  last: boolean;
  canRegenerate: boolean;
  name: string;
}) {
  const busy = generating(message);
  return (
    <article
      className={`conversation-message from-${message.role}`}
      aria-label={`${message.role === 'user' ? name : 'Aria'} message`}
      data-status={message.status}
    >
      {message.role === 'assistant' && (
        <div className="assistant-label">
          <AriaMark small />
          <strong>Aria</strong>
          {busy && (
            <span role="status">
              {message.status === 'pending' ? 'Preparing response' : 'Responding'}
            </span>
          )}
        </div>
      )}
      <div className="conversation-message-content">
        {message.role === 'user' ? (
          <div className="user-message-text">{message.content}</div>
        ) : message.content ? (
          <MarkdownRenderer content={message.content} />
        ) : busy ? (
          <div className="thinking-indicator" aria-label="Waiting for response">
            <i />
            <i />
            <i />
          </div>
        ) : null}
      </div>
      {(message.status === 'failed' || message.status === 'interrupted') && (
        <p className="chat-response-error" role="alert">
          {message.error || 'The response did not finish. Please retry.'}
        </p>
      )}
      {message.status === 'stopped' && <p className="chat-response-note">Response stopped</p>}
      {!busy && (
        <div className="chat-message-actions">
          {message.content && (
            <CopyButton
              text={message.content}
              label={`Copy ${message.role === 'user' ? 'message' : 'response'}`}
            />
          )}
          {message.role === 'assistant' && last && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!canRegenerate}
              onClick={() => void regenerateChat(message.conversationId)}
            >
              <RotateCcw size={13} />
              {['failed', 'interrupted'].includes(message.status) ? 'Retry response' : 'Regenerate'}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
