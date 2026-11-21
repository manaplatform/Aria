import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ExternalLink, RotateCcw } from 'lucide-react';
import type { ChatMessage as Message, ConductorActivity } from '@aria/shared';
import { generating, regenerateChat, useChatStore } from '../../stores/chatStore';
import { AriaMark } from '../layout/AriaMark';
import { Button, CopyButton } from '../ui';
import { desktop, errorMessage, openExternal } from '../../services/desktop';
import { openResearchSource } from '../../stores/browserStore';
import MarkdownRenderer from './MarkdownRenderer';
import { ArtifactCard } from './ArtifactCard';
import { DocumentEvidence } from './DocumentEvidence';
import { MediaPreview } from './MediaPreview';

function ActivityRow({ step, children }: {
  step: ConductorActivity;
  children?: React.ReactNode;
}) {
  return (
    <li>
      <span>
        {step.summary} · {step.status === 'approval' ? 'Waiting for approval' : step.programStatus ?? step.status}
      </span>
      <small>
        {step.target}
        {step.durationMs !== undefined ? ` · ${(step.durationMs / 1000).toFixed(1)} s` : ''}
      </small>
      {step.inputSummary && <small>{step.inputSummary}</small>}
      {step.resultSummary && <small>{step.resultSummary}</small>}
      {step.executionDetails && (
        <details>
          <summary>{step.capability === 'programs.run' ? 'Program result' : 'Command output'}</summary>
          <pre>{step.executionDetails}</pre>
        </details>
      )}
      {step.error && <small>{step.error}</small>}
      {children}
    </li>
  );
}

function ProgramControls({ message, id }: { message: Message; id: string }) {
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return (
    <div>
      <Button size="sm" variant="ghost" disabled={pending} onClick={async () => {
        if (!message.requestId) return;
        setPending(true);
        setError('');
        try {
          await desktop().superviseProgram(message.requestId, message.conversationId, id, !paused);
          setPaused(!paused);
        } catch (failure) {
          setError(errorMessage(failure));
        } finally {
          setPending(false);
        }
      }}>
        {paused ? 'Resume program' : 'Pause program'}
      </Button>
      {error && <small role="alert">{error}</small>}
    </div>
  );
}

function SavedProgramResult({ conversation, id }: { conversation: string; id: string }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  return (
    <details onToggle={async (event) => {
      if (!event.currentTarget.open || value) return;
      setError('');
      try {
        setValue(await desktop().inspectProgramResult(conversation, id));
      } catch (failure) {
        setError(errorMessage(failure));
      }
    }}>
      <summary>Saved program result</summary>
      {error ? <small role="alert">{error}</small> : <pre>{value || 'Loading…'}</pre>}
    </details>
  );
}

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
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);
  const evidence = useMemo(
    () => [
      ...new Map(
        [...(message.activity?.flatMap((step) => step.evidence ?? []) ?? []),
          ...(message.citations?.evidence ?? [])].map((item) => [item.id, item]),
      ).values(),
    ],
    [message.activity, message.citations],
  );
  const busy = generating(message);
  const revision = useChatStore((state) => state.status.revision);
  const retry = message.retryConfirmed && message.run?.revision === revision;
  const sources = [
    ...new Map(
      [...(message.activity?.flatMap((item) => item.sources ?? []) ?? []),
        ...(message.citations?.sources ?? [])].map((source) => [source.url, source]),
    ).values(),
  ];
  const research =
    message.activity?.some(({ capability }) => /^web[-_]|^browser_/.test(capability)) ?? false;
  const activeStep = message.activity?.find((step) =>
    ['running', 'approval', 'processing'].includes(step.status),
  );

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
          <MarkdownRenderer
            content={message.content}
            sources={sources}
            research={research}
            evidenceIds={evidence.map((item) => item.id)}
            onEvidence={setSelectedEvidence}
            rich={!message.liveSessionId}
            streaming={busy}
          />
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
            <Activity size={13} aria-hidden="true" />{' '}
            {activeStep?.status === 'approval'
              ? 'Waiting for approval'
              : activeStep?.status === 'processing'
                ? 'Processing results'
                : activeStep?.summary || 'Conductor activity'}{' '}
            · {message.activity.length}
          </summary>
          <ul>
            {message.activity
              .filter((step) => !step.parentStepId || !message.activity?.some(({ stepId }) => stepId === step.parentStepId))
              .map((step) => {
                const child = message.activity?.filter(({ parentStepId }) => parentStepId === step.stepId) ?? [];
                return (
                  <ActivityRow key={step.stepId} step={step}>
                    {step.capability === 'programs.run' && step.target === 'Aria isolated JavaScript' &&
                      step.status === 'running' && busy && <ProgramControls message={message} id={step.stepId} />}
                    {step.programResultSaved && <SavedProgramResult conversation={message.conversationId} id={step.stepId} />}
                    {child.length > 0 && (
                      <details>
                        <summary>{child.length} tool {child.length === 1 ? 'call' : 'calls'}</summary>
                        <ul>{child.map((item) => <ActivityRow key={item.stepId} step={item} />)}</ul>
                      </details>
                    )}
                  </ActivityRow>
                );
              })}
          </ul>
        </details>
      ) : null}
      {evidence.length > 0 && (
        <DocumentEvidence
          conversation={message.conversationId}
          evidence={evidence}
          selected={selectedEvidence}
          onSelect={setSelectedEvidence}
        />
      )}
      {sources.length ? (
        <nav className="conductor-sources" aria-label="Research sources">
          <span>Sources</span>
          {sources.map((source) => (
            <span className="source-link-actions" key={source.url}>
              <Button
                variant="ghost"
                size="sm"
                title={source.domain || source.url}
                onClick={() => void openResearchSource(source.url)}
              >
                {source.title}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Open externally: ${source.title}`}
                onClick={() => void openExternal(source.url)}
              >
                <ExternalLink size={13} />
              </Button>
            </span>
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
                    {step.summary} ·{' '}
                    {step.status === 'approval' ? 'Waiting for approval' : step.status}
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
      {message.assets?.map((asset) =>
        asset.mimeType === 'text/plain' || asset.mimeType.startsWith('application/') ? (
          <ArtifactCard
            key={asset.id}
            asset={asset}
            conversation={message.conversationId}
            reusable={message.role === 'assistant' && canRegenerate && !busy}
          />
        ) : (
          <MediaPreview
            key={asset.id}
            asset={asset}
            reusable={message.role === 'assistant' && canRegenerate && !busy}
          />
        ),
      )}
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
