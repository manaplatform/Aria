import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, ExternalLink, RotateCcw } from 'lucide-react';
import type { ChatMessage as Message, ConductorActivity, LoopCommand, MemoryRecord } from '@aria/shared';
import { generating, regenerateChat, selectChat, updateChat, useChatStore } from '../../stores/chatStore';
import { AriaMark } from '../layout/AriaMark';
import { Button, CopyButton, Modal } from '../ui';
import { desktop, errorMessage, openExternal } from '../../services/desktop';
import { notify } from '../../stores/uiStore';
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
        {step.summary} · {step.status === 'approval' ? 'Waiting for approval' :
          step.outcomeUnverified ? 'Submitted' : step.programStatus ?? step.status}
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

function ExecutionControls({ message }: { message: Message }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const execution = message.execution;
  if (!execution) return null;
  const { executionId, generation, question } = execution;
  const paused = execution.state === 'paused';
  const send = async (action: LoopCommand['action']) => {
    if (pending) return;
    const scope = { executionId, generation, requestId: message.requestId,
      conversationId: message.conversationId, assistantMessageId: message.id, commandId: crypto.randomUUID() };
    let command: LoopCommand;
    if (action === 'answer') {
      if (!question || !text.trim()) return;
      command = { ...scope, action, questionId: question.id, text };
    } else if (action === 'steer') {
      if (!text.trim()) return;
      command = { ...scope, action, text };
    } else command = { ...scope, action };
    setPending(true);
    setError('');
    try {
      await desktop().controlExecution(command);
      if (action === 'answer' || action === 'steer') {
        setText('');
        setEditing(false);
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="chat-execution-controls">
      {execution.durability === 'live' && <small>Available until this session closes</small>}
      <div className="chat-message-actions">
        <Button size="sm" variant="ghost" disabled={pending || execution.pausing || Boolean(question)}
          onClick={() => void send(paused ? 'resume' : 'pause')}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        {!question && <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>Steer</Button>}
      </div>
      {(question || editing) && (
        <form onSubmit={(event) => { event.preventDefault(); void send(question ? 'answer' : 'steer'); }}>
          <label htmlFor={`execution-input-${message.id}`}>{question?.text ?? 'Update instructions for this execution'}</label>
          <textarea id={`execution-input-${message.id}`} value={text} maxLength={2000} rows={2}
            onChange={(event) => setText(event.target.value)} />
          <Button size="sm" type="submit" disabled={pending || !text.trim()}>
            {question ? 'Send answer' : 'Send instructions'}
          </Button>
        </form>
      )}
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


function ActivityList({ steps, message, live }: {
  steps: ConductorActivity[];
  message: Message;
  live?: boolean;
}) {
  const ids = new Set(steps.map(({ stepId }) => stepId));
  const groups: ConductorActivity[][] = [];
  for (const step of steps) {
    if (step.parentStepId && ids.has(step.parentStepId)) continue;
    const previous = groups.at(-1);
    const head = previous?.[0];
    if (head && step.status === 'completed' && head.status === step.status &&
      (step.capability === 'conductor.discovery' || step.capability === 'conductor.skills') &&
      head.capability === step.capability && head.summary === step.summary) previous.push(step);
    else groups.push([step]);
  }
  const row = (step: ConductorActivity) => {
    const children = steps.filter(({ parentStepId }) => parentStepId === step.stepId);
    return (
      <ActivityRow key={step.stepId} step={step}>
        {live && step.capability === 'programs.run' && step.target === 'Aria isolated JavaScript' &&
          step.status === 'running' && <ProgramControls message={message} id={step.stepId} />}
        {step.programResultSaved && <SavedProgramResult conversation={message.conversationId} id={step.stepId} />}
        {children.length > 0 && (
          <details>
            <summary>{children.length} tool {children.length === 1 ? 'call' : 'calls'}</summary>
            <ul>{children.map((child) => <ActivityRow key={child.stepId} step={child} />)}</ul>
          </details>
        )}
      </ActivityRow>
    );
  };
  return (
    <ul>
      {groups.map(([first, ...rest]) => rest.length ? (
        <li key={first.stepId}>
          <details>
            <summary>{first.summary} · {rest.length + 1} calls</summary>
            <ul>{[first, ...rest].map(row)}</ul>
          </details>
        </li>
      ) : row(first))}
    </ul>
  );
}

export function ChatMessage({
  message,
  last,
  canRegenerate,
  name,
  canRemember = false,
}: {
  message: Message;
  last: boolean;
  canRegenerate: boolean;
  name: string;
  canRemember?: boolean;
}) {
  const [memorySource, setMemorySource] = useState<MemoryRecord | null>();
  const navigate = useNavigate();
  const [selectedEvidence, setSelectedEvidence] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ pending: boolean; error?: string }>({ pending: false });
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
  const execution = message.execution;
  const canResume = last && message.status === 'interrupted' && execution?.durability === 'saved' &&
    !['completed', 'partial', 'failed', 'cancelled'].includes(execution.state);
  const executionStatus = execution?.pausing ? 'Pausing' :
    execution?.state === 'paused' ? 'Paused' :
    execution?.state === 'waiting_for_user' ? 'Waiting for your answer' :
    execution?.state === 'waiting_for_permission' ? 'Waiting for approval' :
    execution?.state === 'recovering' ? 'Recovering execution' :
    execution?.state === 'waiting_for_tool' ? activeStep?.summary || 'Running tools' : undefined;

  return (
    <article
      id={`chat-message-${message.id}`}
      tabIndex={-1}
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
              {executionStatus ?? (message.status === 'pending' ? 'Preparing response' : 'Responding')}
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
            memoryIds={message.memoryReferences}
            onMemory={(id) => void desktop().memoryEvidence(message.conversationId, id)
              .then(setMemorySource).catch(() => setMemorySource(null))}
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
      {canRemember && message.role === 'user' && !message.liveSessionId &&
        message.content.length <= 1400 && (
          <Button size="sm" variant="ghost" onClick={() => {
            void desktop().rememberChatMessage(message.conversationId, message.id, 'episode')
              .then(() => notify('Message saved to Memory.'))
              .catch((error) => notify(errorMessage(error), true));
          }}>Save to Memory</Button>
        )}
      {memorySource !== undefined && (
        <Modal open onOpenChange={(open) => { if (!open) setMemorySource(undefined); }}
          title="Recalled memory" description={memorySource
            ? `${memorySource.confirmation} · ${new Date(memorySource.observedAt).toLocaleDateString()}`
            : 'This memory is unavailable.'}>
          {memorySource && <p>{memorySource.value.content}</p>}
          {memorySource?.sources.slice(-3).map((source) => (
            <Button key={source.messageId} variant="ghost" size="sm" onClick={() => {
              selectChat(source.conversationId);
              navigate('/chat', { state: { messageId: source.messageId } });
              setMemorySource(undefined);
            }}>Open source message</Button>
          ))}
        </Modal>
      )}
      {busy && execution && <ExecutionControls message={message} />}
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
          <ActivityList steps={message.activity} message={message} live={busy} />
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
                <ActivityList steps={attempt.activity} message={message} />
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
      {recovery.error && <p className="chat-response-error" role="alert">{recovery.error}</p>}
      {!busy && (
        <div className="chat-message-actions">
          {canResume && (
            <Button variant="ghost" size="sm" disabled={recovery.pending} onClick={async () => {
              setRecovery({ pending: true });
              try {
                await desktop().resumeExecution({ executionId: execution.executionId, generation: execution.generation,
                  conversationId: message.conversationId, assistantMessageId: message.id });
                setRecovery({ pending: false });
              } catch (error) {
                setRecovery({ pending: false, error: errorMessage(error) });
              }
            }}>Resume execution</Button>
          )}
          {message.status === 'interrupted' && message.run?.storedResponses && (
            <Button variant="ghost" size="sm" disabled={recovery.pending} onClick={async () => {
              setRecovery({ pending: true });
              try {
                const result = await desktop().recoverStoredResponse(message.conversationId, message.id, message.requestId);
                updateChat((current) => ({
                  ...current,
                  messages: current.messages.map((item) =>
                    item.id === message.id && item.requestId === message.requestId && item.status === 'interrupted'
                      ? {
                          ...item, content: result.content, status: 'completed', error: undefined,
                          retryConfirmed: false,
                          run: item.run && { ...item.run, privateContent: result.privateContent },
                        }
                      : item),
                }));
                setRecovery({ pending: false });
              } catch (error) {
                setRecovery({ pending: false, error: errorMessage(error) });
              }
            }}>
              {recovery.pending ? 'Checking stored response…' : 'Recover stored response'}
            </Button>
          )}
          {message.content && (
            <CopyButton
              text={message.content}
              label={`Copy ${message.role === 'user' ? 'message' : 'response'}`}
            />
          )}
          {message.role === 'assistant' &&
            last &&
            !canResume &&
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
