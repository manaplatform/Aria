import { lazy, Suspense, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Code2,
  FileCode2,
  Square,
  Terminal,
  Workflow,
  RotateCcw,
} from 'lucide-react';
import { useExecutionStore } from '../../stores/executionStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button, CopyButton, EmptyState, IconButton, Skeleton, StatusIndicator } from '../ui';
import { SampleAdapter } from '../../services/adapters';
import { notify } from '../../stores/uiStore';
import { errorMessage } from '../../services/desktop';
const TerminalOutput = lazy(() => import('./TerminalOutput'));
const DiffViewer = lazy(() => import('./DiffViewer'));
export function ExecutionEventCard({
  id,
  initiallyOpen = false,
}: {
  id: string;
  initiallyOpen?: boolean;
}) {
  const event = useExecutionStore((state) => state.events[id]);
  const agent = useExecutionStore((state) => (event ? state.agents[event.agentId] : undefined));
  const task = useExecutionStore((state) => (event ? state.tasks[event.taskId] : undefined));
  const [open, setOpen] = useState(initiallyOpen);
  if (!event) return null;
  const Icon = event.kind === 'command' ? Terminal : event.kind === 'file' ? FileCode2 : Code2;
  return (
    <article className={`execution-event event-${event.status}`}>
      <button className="event-heading" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="event-icon">
          <Icon size={18} />
        </span>
        <span className="event-text">
          <strong>{event.title}</strong>
          <span>{event.summary}</span>
        </span>
        <span className="event-state">
          <StatusIndicator status={event.status} />
          <span className="muted">
            {' '}
            ·{' '}
            {event.durationMs < 1000
              ? `${event.durationMs}ms`
              : `${Math.round(event.durationMs / 1000)}s`}
          </span>
        </span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="event-body">
          <div className="event-meta">
            <span>{agent?.name ?? event.agentId}</span>
            <span title={task?.title}>{task?.title ?? event.taskId}</span>
          </div>
          <Suspense fallback={<Skeleton />}>
            {event.command && (
              <>
                <div className="command-heading">
                  <span className="status-dot" />
                  <code>{event.command.display}</code>
                  <CopyButton text={event.command.display} label="Copy exact command" />
                </div>
                <div className="command-meta">
                  <span title={event.command.cwd}>cwd: {event.command.cwd}</span>
                  <span>Exit: {event.command.exitCode ?? '—'}</span>
                </div>
                <details className="command-arguments">
                  <summary>Executable and arguments</summary>
                  <pre>
                    {JSON.stringify(
                      { executable: event.command.executable, args: event.command.args },
                      null,
                      2,
                    )}
                  </pre>
                </details>
                <TerminalOutput output={event.command.output} />
              </>
            )}
            {event.file && <DiffViewer change={event.file} />}
            {event.tool && (
              <div className="tool-result">
                <strong>{event.tool.name}</strong>
                <pre>{JSON.stringify(event.tool.arguments, null, 2)}</pre>
                <p>{event.tool.result ?? 'Waiting for result…'}</p>
              </div>
            )}
          </Suspense>
        </div>
      )}
    </article>
  );
}
function LongTimeline({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: ids.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 85,
    overscan: 5,
  });
  return (
    <div ref={ref} className="long-timeline">
      <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
        {virtual.getVirtualItems().map((item) => (
          <div
            key={ids[item.index]}
            ref={virtual.measureElement}
            data-index={item.index}
            style={{
              position: 'absolute',
              width: '100%',
              transform: `translateY(${item.start}px)`,
            }}
          >
            <ExecutionEventCard id={ids[item.index]} />
          </div>
        ))}
      </div>
    </div>
  );
}
export default function ExecutionTimeline({
  agentId,
  commandsOnly = false,
}: {
  agentId?: string;
  commandsOnly?: boolean;
}) {
  const ids = useExecutionStore(
    useShallow((state) =>
      Object.values(state.events)
        .filter(
          (event) =>
            (!agentId || event.agentId === agentId) && (!commandsOnly || event.kind === 'command'),
        )
        .sort((a, b) => a.sequence - b.sequence)
        .map((event) => event.id),
    ),
  );
  const running = useExecutionStore((state) =>
    Object.values(state.events).some((event) => event.status === 'running'),
  );
  const adapter = useExecutionStore((state) => state.adapter);
  const session = useExecutionStore((state) => state.session);
  const sample = useWorkspaceStore((state) => state.sample);
  const [busy, setBusy] = useState(false);
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setBusy(false);
    }
  };
  if (!ids.length)
    return (
      <EmptyState
        icon={<Terminal size={25} />}
        title={commandsOnly ? 'No command output yet' : 'No execution activity'}
        description="Commands, tool results, and file changes will appear here when an execution service is connected."
      />
    );
  return (
    <section className="execution-panel">
      <header className="execution-header">
        <span className="row">
          <Workflow size={15} />
          <strong>Execution</strong>
          <span className="muted">{sample ? 'Sample workflow' : 'Agent workflow'}</span>
        </span>
        <span className="row">
          <StatusIndicator status={running ? 'running' : 'completed'} />
          {sample && adapter instanceof SampleAdapter && (
            <IconButton
              label="Play sample output"
              disabled={busy}
              onClick={() => void action(() => adapter.replay())}
            >
              <RotateCcw size={14} />
            </IconButton>
          )}
          {adapter.capabilities.cancellation && running && session && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void action(() => adapter.cancel(session.id))}
            >
              <Square size={11} />
              Stop
            </Button>
          )}
        </span>
      </header>
      <div className="timeline-items">
        {ids.length > 200 ? (
          <LongTimeline ids={ids} />
        ) : (
          ids.map((id) => (
            <ExecutionEventCard key={id} id={id} initiallyOpen={commandsOnly || id === 'test'} />
          ))
        )}
      </div>
    </section>
  );
}
