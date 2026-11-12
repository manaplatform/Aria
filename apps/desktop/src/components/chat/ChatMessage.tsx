import { Link } from 'react-router-dom';
import { Activity, RotateCcw } from 'lucide-react';
import type { ChatMessage as Message } from '@aria/shared';
import { generating, regenerateChat, useChatStore } from '../../stores/chatStore';
import { AriaMark } from '../layout/AriaMark';
import { Button, CopyButton } from '../ui';
import { openExternal } from '../../services/desktop';
import MarkdownRenderer from './MarkdownRenderer';
import { MediaPreview } from './MediaPreview';

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
  const revision = useChatStore((state) => state.status.revision);
  const retry = message.retryConfirmed && message.run?.revision === revision;
  const sources = [
    ...new Map(
      message.activity?.flatMap((item) => item.sources ?? []).map((source) => [source.url, source]),
    ).values(),
  ];
  const activeStep = message.activity?.find((step) => step.status === 'running');

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
          <MarkdownRenderer content={message.content} sources={sources} />
        ) : busy ? (
          <div className="thinking-indicator" aria-label="Waiting for response">
            <i />
            <i />
            <i />
          </div>
        ) : null}
      </div>
      {message.activity?.length ? (
        <details className="conductor-activity">
          <summary>
            <Activity size={13} aria-hidden="true" /> {activeStep?.summary || 'Conductor activity'}{' '}
            · {message.activity.length}
          </summary>
          <ul>
            {message.activity.map((step) => (
              <li key={step.stepId}>
                <span>
                  {step.summary} · {step.status}
                </span>
                <small>
                  {step.target} · {step.capability}
                  {step.durationMs !== undefined
                    ? ` · ${(step.durationMs / 1000).toFixed(1)} s`
                    : ''}
                </small>
                {step.error && <small>{step.error}</small>}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {sources.length ? (
        <nav className="conductor-sources" aria-label="Research sources">
          <span>Sources</span>
          {sources.map((source) => (
            <Button
              key={source.url}
              variant="ghost"
              size="sm"
              onClick={() => void openExternal(source.url)}
            >
              {source.title}
            </Button>
          ))}
        </nav>
      ) : null}
      {message.attempts?.length ? (
        <details className="conductor-activity">
          <summary>Previous attempts</summary>
          <ul>
            {message.attempts.map((attempt) => (
              <li key={attempt.requestId}>
                {attempt.outcome} · {attempt.run.primaryName ?? attempt.run.primary}
                {attempt.activity.map((step) => (
                  <small key={step.stepId}>
                    {step.summary} · {step.status}
                  </small>
                ))}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {message.partial && (
        <p className="chat-response-note">Some requested steps could not complete.</p>
      )}
      {message.operation && (
        <p className="chat-response-note">
          {message.operation.mode === 'transcription'
            ? 'Transcription'
            : message.operation.mode === 'speech'
              ? 'AI-generated speech'
              : message.operation.mode === 'image'
                ? 'Image'
                : 'Chat'}{' '}
          · {message.operation.model}
        </p>
      )}
      {message.liveSessionId && (
        <p className="chat-response-note">
          Live voice{message.role === 'assistant' ? ' · AI-generated audio' : ''}
        </p>
      )}
      {message.assets?.map((asset) => (
        <MediaPreview
          key={asset.id}
          asset={asset}
          reusable={message.role === 'assistant' && canRegenerate && !busy}
        />
      ))}
      {(message.status === 'failed' || message.status === 'interrupted') && (
        <p className="chat-response-error" role="alert">
          {message.error || 'The response did not finish. Please retry.'}
        </p>
      )}
      {message.settingsHelp && (
        <Link to="/settings#ai-models" className="chat-response-note">
          Open AI Models
        </Link>
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
          {message.role === 'assistant' &&
            last &&
            !message.liveSessionId &&
            !message.delegatedFromVoice && (
              <Button
                variant="ghost"
                size="sm"
                disabled={!canRegenerate}
                onClick={() =>
                  void regenerateChat(message.conversationId, retry ? revision : undefined)
                }
              >
                <RotateCcw size={13} />
                {retry
                  ? 'Retry response'
                  : ['failed', 'interrupted', 'stopped'].includes(message.status)
                    ? 'Send again'
                    : 'Regenerate'}
              </Button>
            )}
        </div>
      )}
    </article>
  );
}
