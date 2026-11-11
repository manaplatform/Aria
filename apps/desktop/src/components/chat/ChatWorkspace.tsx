import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  AtSign,
  Bot,
  Check,
  FileText,
  ListChecks,
  MessageSquare,
  Paperclip,
  Play,
  X,
} from 'lucide-react';
import type { Mode } from '@aria/shared';
import { useWorkspace } from '../../hooks/useWorkspace';
import { activeConversation, useWorkspaceStore } from '../../stores/workspaceStore';
import { useExecutionStore } from '../../stores/executionStore';
import { Button, EmptyState, IconButton, Skeleton, Tabs } from '../ui';
import MarkdownRenderer from './MarkdownRenderer';
import ExecutionTimeline from '../execution/ExecutionTimeline';
import { ApprovalQueue } from '../orchestration/Approvals';
import { PlanViewer } from '../orchestration/Tasks';
import { desktop, errorMessage } from '../../services/desktop';
import { notify } from '../../stores/uiStore';
export function MessageComposer() {
  const conversation = useWorkspaceStore(activeConversation);
  const workspace = useWorkspace();
  const sample = useWorkspaceStore((state) => state.sample);
  const update = useWorkspaceStore((state) => state.updateConversation);
  const saveError = useWorkspaceStore((state) => state.saveError);
  const saving = useWorkspaceStore((state) => state.saving);
  const adapter = useExecutionStore((state) => state.adapter);
  const [submitting, setSubmitting] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const editor = input.current;
    if (!editor) return;
    editor.style.height = 'auto';
    editor.style.height = `${Math.max(38, Math.min(170, editor.scrollHeight))}px`;
  }, [conversation?.draft]);
  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener('aria:focus-composer', focus);
    return () => window.removeEventListener('aria:focus-composer', focus);
  }, []);
  const submit = async () => {
    if (!conversation?.draft.trim() || submitting || !adapter.capabilities.chat) return;
    setSubmitting(true);
    try {
      await adapter.submitMessage(conversation);
      if (useExecutionStore.getState().adapter === adapter) {
        if (activeConversation(useWorkspaceStore.getState())?.draft === conversation.draft)
          update({ draft: '' });
        input.current?.focus();
      }
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="composer-area">
      <div className="composer">
        {!!conversation?.attachments.length && (
          <div className="attachment-list">
            {conversation.attachments.map((file) => (
              <span key={file.id} title={file.path}>
                <FileText size={13} />
                {file.name}
                <IconButton
                  label={`Remove ${file.name}`}
                  onClick={() =>
                    update({
                      attachments: conversation.attachments.filter((item) => item.id !== file.id),
                    })
                  }
                >
                  <X size={11} />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          aria-label="Message Aria"
          placeholder={workspace ? 'Message Aria…' : 'Open a project to start a draft…'}
          disabled={!workspace}
          value={conversation?.draft ?? ''}
          maxLength={100000}
          rows={1}
          onChange={(event) => update({ draft: event.target.value })}
          onKeyDown={(event) => {
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="row">
            <IconButton
              label="Attach project files"
              disabled={!workspace || sample}
              onClick={() => {
                if (workspace)
                  void desktop()
                    .chooseFiles(workspace.id)
                    .then((files) =>
                      update({
                        attachments: [...(conversation?.attachments ?? []), ...files].slice(0, 100),
                      }),
                    )
                    .catch((error) => notify(errorMessage(error), true));
              }}
            >
              <Paperclip size={17} />
            </IconButton>
            <IconButton
              label="Browse project context"
              disabled={!workspace}
              onClick={() => window.dispatchEvent(new Event('aria:browse-context'))}
            >
              <AtSign size={17} />
            </IconButton>
            <span className="composer-agent">
              <Bot size={13} />
              {sample ? 'Aria · sample adapter' : 'Agent unavailable'}
            </span>
          </div>
          <Button
            variant="primary"
            size="icon"
            aria-label="Send message"
            disabled={!conversation?.draft.trim() || submitting || !adapter.capabilities.chat}
            onClick={() => void submit()}
          >
            <ArrowUp size={18} />
          </Button>
        </div>
      </div>
      <div className="composer-caption">
        <span>
          {sample
            ? 'Sample workspace · no real AI or execution'
            : 'AI service unavailable · drafts stay on this device'}
        </span>
        <span>
          {sample
            ? 'Shift + Enter for a new line'
            : saveError
              ? 'Could not save'
              : saving
                ? 'Saving…'
                : 'Drafts autosaved'}
        </span>
      </div>
    </div>
  );
}
export default function ChatWorkspace() {
  const conversation = useWorkspaceStore(activeConversation);
  const workspace = useWorkspace();
  const update = useWorkspaceStore((state) => state.updateConversation);
  const messages = useExecutionStore((state) => state.messages);
  const loading = useExecutionStore((state) => state.loading);
  const hasEvents = useExecutionStore((state) => Object.keys(state.events).length > 0);
  const sample = useWorkspaceStore((state) => state.sample);
  const scroll = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previousMessageCount = useRef(0);
  const [jump, setJump] = useState(false);
  const mode = conversation?.mode ?? 'chat';
  const timeline = Object.values(messages)
    .filter((message) => message.conversationId === conversation?.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  useEffect(() => {
    nearBottom.current = true;
    previousMessageCount.current = 0;
    setJump(false);
    scroll.current?.scrollTo({ top: 0 });
  }, [workspace?.id, conversation?.id]);
  useEffect(() => {
    if (!Object.keys(messages).length) {
      previousMessageCount.current = 0;
      setJump(false);
      return;
    }
    const initial = previousMessageCount.current === 0;
    previousMessageCount.current = Object.keys(messages).length;
    if (initial) {
      const frame = requestAnimationFrame(() => {
        const node = scroll.current;
        if (node) nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      });
      return () => cancelAnimationFrame(frame);
    }
    if (nearBottom.current) {
      const frame = requestAnimationFrame(() => end.current?.scrollIntoView({ block: 'end' }));
      return () => cancelAnimationFrame(frame);
    }
    setJump(true);
  }, [messages]);
  return (
    <div className="chat-workspace">
      <div className="workspace-modebar">
        <Tabs
          label="Workspace mode"
          value={mode}
          onChange={(value) => update({ mode: value as Mode })}
          items={[
            {
              id: 'chat',
              label: (
                <>
                  <MessageSquare size={15} />
                  Chat
                </>
              ),
            },
            {
              id: 'plan',
              label: (
                <>
                  <ListChecks size={15} />
                  Plan
                </>
              ),
            },
            {
              id: 'execute',
              label: (
                <>
                  <Play size={14} />
                  Execute
                </>
              ),
            },
          ]}
        />
        <span className="muted mode-hint">
          {sample ? 'Activity feed implementation' : (workspace?.name ?? 'Your workspace')}
        </span>
      </div>
      <div
        ref={scroll}
        className="conversation-scroll"
        onScroll={() => {
          const node = scroll.current;
          if (!node) return;
          nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          if (nearBottom.current) setJump(false);
        }}
      >
        {loading ? (
          <Skeleton />
        ) : mode === 'plan' ? (
          <section className="workspace-plan">
            <div className="section-intro">
              <span className="eyebrow">PLAN YOUR WORK</span>
              <h2>A clear path forward.</h2>
              <p>Break your goal into focused, manageable steps.</p>
            </div>
            <PlanViewer editable />
          </section>
        ) : mode === 'execute' ? (
          <>
            <div className="section-intro compact">
              <h2>Execution activity</h2>
              <p>
                {sample
                  ? 'Inspect sample commands, output, file changes, and ownership.'
                  : 'No execution service is connected. Local plans do not run commands.'}
              </p>
            </div>
            <ExecutionTimeline />
          </>
        ) : (
          <>
            {timeline.length ? (
              timeline.map((message) => (
                <article key={message.id} className={`chat-message message-${message.role}`}>
                  <div
                    className={`message-avatar ${message.role === 'assistant' ? 'aria-avatar' : ''}`}
                  >
                    {message.role === 'assistant' ? <Bot size={20} /> : 'A'}
                  </div>
                  <div className="message-main">
                    <header>
                      <strong>{message.role === 'user' ? 'You' : 'Aria'}</strong>
                      <time>
                        {new Date(message.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                      {message.status === 'streaming' && (
                        <span className="streaming-label">Sample streaming…</span>
                      )}
                    </header>
                    <MarkdownRenderer content={message.content} />
                    {message.status === 'failed' && (
                      <p className="message-failure">
                        {sample ? 'Sample playback stopped.' : 'The response did not complete.'}
                      </p>
                    )}
                    {message.id === 'message-assistant' && (
                      <div className="message-actions">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => update({ mode: 'execute' })}
                        >
                          <Play size={13} />
                          View execution
                        </Button>
                        <Button size="sm" onClick={() => update({ mode: 'plan' })}>
                          <ListChecks size={14} />
                          View plan
                        </Button>
                      </div>
                    )}
                  </div>
                </article>
              ))
            ) : (
              <EmptyState
                icon={<Bot size={30} />}
                title={
                  workspace
                    ? 'A little clarity. A lot of possibility.'
                    : 'Make room for your next idea.'
                }
                description={
                  workspace
                    ? 'Write a draft, organize a plan, or add local tasks. AI chat will be available when a backend is connected.'
                    : 'Open a project folder or explore the sample workspace to see Aria in action.'
                }
                action={
                  <div className="row">
                    <Button onClick={() => void useWorkspaceStore.getState().chooseWorkspace()}>
                      Open project
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => useWorkspaceStore.getState().enterSample()}
                    >
                      Explore sample
                    </Button>
                  </div>
                }
              />
            )}
            {hasEvents && <ExecutionTimeline />}
            {hasEvents && (
              <div className="inline-approvals">
                <div className="row">
                  <Check size={15} />
                  <strong>Approval requests</strong>
                </div>
                <ApprovalQueue />
              </div>
            )}
          </>
        )}
        <div ref={end} />
      </div>
      {jump && (
        <Button
          className="jump-to-latest"
          size="sm"
          onClick={() => {
            nearBottom.current = true;
            setJump(false);
            end.current?.scrollIntoView({ block: 'end' });
          }}
        >
          <ArrowDown size={13} />
          Jump to latest
        </Button>
      )}
      <MessageComposer />
    </div>
  );
}
