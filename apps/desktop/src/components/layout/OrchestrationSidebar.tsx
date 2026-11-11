import { useState, type ReactNode } from 'react';
import { Bot, ChevronDown, GitPullRequest, Layers, ListChecks, ListTodo, X } from 'lucide-react';
import { usePlans, useTasks } from '../../hooks/useWorkspace';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useExecutionStore } from '../../stores/executionStore';
import { IconButton, ResizeHandle, Tabs } from '../ui';
import { TaskBoard, PlanViewer } from '../orchestration/Tasks';
import { AgentHierarchy } from '../orchestration/Agents';
import { ApprovalQueue } from '../orchestration/Approvals';
import { RepositoryContext } from '../orchestration/Context';
function Panel({
  id,
  title,
  icon,
  count,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  count?: ReactNode;
  children: ReactNode;
}) {
  const collapsed = useWorkspaceStore((state) =>
    state.data.preferences.collapsedSections.includes(id),
  );
  const height = useWorkspaceStore((state) => state.data.preferences.sectionHeights[id]);
  const prefs = useWorkspaceStore((state) => state.preferences);
  return (
    <section className="orchestration-card">
      <button
        className="panel-heading"
        aria-expanded={!collapsed}
        onClick={() => {
          const state = useWorkspaceStore.getState().data.preferences;
          prefs({
            collapsedSections: collapsed
              ? state.collapsedSections.filter((item) => item !== id)
              : [...state.collapsedSections, id],
          });
        }}
      >
        <span className="row">
          {icon}
          <strong>{title}</strong>
        </span>
        <span className="panel-count">
          {count}
          <ChevronDown size={12} className={collapsed ? 'chevron-collapsed' : ''} />
        </span>
      </button>
      {!collapsed && (
        <>
          <div className="panel-body" style={height ? { height } : undefined}>
            {children}
          </div>
          <ResizeHandle
            orientation="horizontal"
            value={height ?? 180}
            min={100}
            max={800}
            label={`Resize ${title}`}
            onChange={(value) =>
              prefs({
                sectionHeights: {
                  ...useWorkspaceStore.getState().data.preferences.sectionHeights,
                  [id]: value,
                },
              })
            }
          />
        </>
      )}
    </section>
  );
}
export default function OrchestrationSidebar({ close }: { close?: () => void }) {
  const [tab, setTab] = useState('orchestration');
  const tasks = useTasks();
  const plans = usePlans();
  const agents = useExecutionStore((state) => state.agents);
  const approvals = useExecutionStore((state) => state.approvals);
  const running = Object.values(agents).filter((agent) => agent.status === 'running').length;
  const pending = Object.values(approvals).filter(
    (approval) => approval.status === 'pending',
  ).length;
  return (
    <div className="orchestration-sidebar">
      <div className="orchestration-tabs">
        <Tabs
          label="Sidebar view"
          value={tab}
          onChange={setTab}
          items={[
            {
              id: 'orchestration',
              label: (
                <>
                  <WorkflowIcon />
                  Orchestration
                </>
              ),
            },
            {
              id: 'context',
              label: (
                <>
                  <Layers size={14} />
                  Workspace
                </>
              ),
            },
          ]}
        />
        {close && (
          <IconButton label="Close orchestration" onClick={close}>
            <X size={16} />
          </IconButton>
        )}
      </div>
      <div className="orchestration-scroll">
        {tab === 'orchestration' ? (
          <>
            <Panel
              id="tasks"
              title="Task Board"
              icon={<ListTodo size={15} />}
              count={`${tasks.length} tasks`}
            >
              <TaskBoard compact />
            </Panel>
            <Panel
              id="plan"
              title="Current Plan"
              icon={<ListChecks size={15} />}
              count={plans[0]?.source === 'sample' ? 'Sample' : 'Manual'}
            >
              <PlanViewer />
            </Panel>
            <Panel
              id="agents"
              title="Agent Hierarchy"
              icon={<Bot size={15} />}
              count={`${running} active`}
            >
              <AgentHierarchy />
            </Panel>
            <Panel id="context" title="Context" icon={<Layers size={15} />}>
              <RepositoryContext />
            </Panel>
            <Panel
              id="approvals"
              title="Approvals"
              icon={<GitPullRequest size={15} />}
              count={`${pending} pending`}
            >
              <ApprovalQueue />
            </Panel>
          </>
        ) : (
          <>
            <Panel id="repository" title="Repository Context" icon={<Layers size={15} />}>
              <RepositoryContext />
            </Panel>
            <div className="panel-note">
              File context is read-only. Browse the Knowledge page to inspect and attach project
              references.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function WorkflowIcon() {
  return <Bot size={14} />;
}
