import { useState } from 'react';
import { ArrowRight, Bot, Clock3, FileText, ListChecks, Terminal } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace, useTasks } from '../hooks/useWorkspace';
import { activeConversation, useWorkspaceStore } from '../stores/workspaceStore';
import { useExecutionStore } from '../stores/executionStore';
import { Badge, Button, EmptyState } from '../components/ui';
import { TaskBoard, PlanViewer } from '../components/orchestration/Tasks';
import { AgentHierarchy } from '../components/orchestration/Agents';
import ExecutionTimeline from '../components/execution/ExecutionTimeline';
export function TasksPage() {
  const workspace = useWorkspace();
  const tasks = useTasks();
  return (
    <div className="page-scroll">
      <div className="work-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">ONE STEP AT A TIME</span>
            <h1>Tasks</h1>
            <p>
              {workspace?.id === 'sample'
                ? 'Sample workflow tasks'
                : 'Manually managed work for your project.'}
            </p>
          </div>
          <Badge>{tasks.length} tasks</Badge>
        </div>
        {workspace ? (
          <>
            <TaskBoard />
            <section className="page-plan">
              <h2>
                <ListChecks size={18} />
                Current plan
              </h2>
              <PlanViewer editable />
            </section>
          </>
        ) : (
          <EmptyState
            title="Give your next project a home"
            description="Open a project folder before creating local tasks and plans."
            action={
              <Button onClick={() => void useWorkspaceStore.getState().chooseWorkspace()}>
                Open project
              </Button>
            }
          />
        )}
      </div>
    </div>
  );
}
export function AgentsPage() {
  const [filter, setFilter] = useState('all');
  const agents = useExecutionStore((state) => state.agents);
  const selected = useExecutionStore((state) => state.selectedAgentId);
  const agent = selected ? agents[selected] : undefined;
  return (
    <div className="page-scroll">
      <div className="work-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">ORCHESTRATION</span>
            <h1>Agents</h1>
            <p>A clear view of ownership, relationships, and activity.</p>
          </div>
          <select
            aria-label="Filter agent status"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            {['all', 'running', 'idle', 'blocked', 'failed', 'completed', 'pending'].map(
              (status) => (
                <option key={status} value={status}>
                  {status === 'all' ? 'All statuses' : status}
                </option>
              ),
            )}
          </select>
        </div>
        <div className="agent-directory">
          <AgentHierarchy filter={filter} />
        </div>
        {agent ? (
          <section className="agent-detail">
            <div className="section-intro compact">
              <h2>{agent.name}</h2>
              <p>{agent.role}</p>
              <Badge>{agent.id}</Badge>
            </div>
            <ExecutionTimeline agentId={agent.id} />
          </section>
        ) : (
          !!Object.keys(agents).length && (
            <EmptyState
              icon={<Bot />}
              title="Follow an agent’s work"
              description="Select an agent to inspect its attributed activity."
            />
          )
        )}
      </div>
    </div>
  );
}
export function TerminalPage() {
  return (
    <div className="page-scroll">
      <div className="work-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">EXECUTION OUTPUT</span>
            <h1>Terminal</h1>
            <p>Exact commands and results, with ownership and working directory.</p>
          </div>
          <Badge>Read-only viewer</Badge>
        </div>
        <div className="notice">
          <Terminal size={14} />
          Interactive command execution is unavailable. This view displays supplied execution
          events.
        </div>
        <ExecutionTimeline commandsOnly />
      </div>
    </div>
  );
}
export function HistoryPage() {
  const workspace = useWorkspace();
  const data = useWorkspaceStore((state) => state.data);
  const sample = useWorkspaceStore((state) => state.sample);
  const sampleDraft = useWorkspaceStore(activeConversation);
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const conversations =
    sample && sampleDraft
      ? [sampleDraft]
      : data.conversations.filter((item) => item.workspaceId === workspace?.id);
  const filtered = [...conversations]
    .reverse()
    .filter((item) => `${item.title} ${item.draft}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="page-scroll">
      <div className="work-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">PICK UP WHERE YOU LEFT OFF</span>
            <h1>History</h1>
            <p>
              {workspace
                ? `Drafts and conversations in ${workspace.name}.`
                : 'Select a project to see its saved drafts.'}
            </p>
          </div>
          <Clock3 size={24} className="muted" />
        </div>
        <input
          className="history-search"
          aria-label="Search history"
          placeholder="Search drafts and conversations…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="history-list">
          {filtered.map((conversation) => (
            <button
              className="history-row"
              key={conversation.id}
              onClick={() => {
                useWorkspaceStore.getState().selectConversation(conversation.id);
                navigate('/workspace');
              }}
            >
              <FileText size={18} />
              <span>
                <strong>{conversation.title}</strong>
                <small>
                  {sample ? 'Sample conversation' : 'Local draft · not sent'} ·{' '}
                  {new Date(conversation.updatedAt).toLocaleString()}
                </small>
                <p>{conversation.draft || 'Empty draft'}</p>
              </span>
              <Badge>{conversation.mode}</Badge>
              <ArrowRight size={16} />
            </button>
          ))}
        </div>
        {!filtered.length && (
          <EmptyState
            icon={<Clock3 />}
            title="A fresh chapter"
            description={
              search
                ? 'No drafts match your search.'
                : 'Your saved drafts will appear here as you work.'
            }
            action={
              workspace && <Button onClick={() => navigate('/workspace')}>Open workspace</Button>
            }
          />
        )}
      </div>
    </div>
  );
}
