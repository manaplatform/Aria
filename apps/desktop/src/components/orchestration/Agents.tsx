import { useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Code2, Monitor, ShieldCheck } from 'lucide-react';
import type { Agent } from '@aria/shared';
import { useExecutionStore } from '../../stores/executionStore';
import { EmptyState, StatusIndicator } from '../ui';
export function AgentHierarchy({ filter = 'all' }: { filter?: string }) {
  const agents = useExecutionStore((state) => state.agents);
  const selected = useExecutionStore((state) => state.selectedAgentId);
  const select = useExecutionStore((state) => state.selectAgent);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const values = Object.values(agents);
  if (!values.length)
    return (
      <EmptyState
        icon={<Bot size={22} />}
        title="No agents connected"
        description="Agent identity, hierarchy, and live activity will appear when an orchestration service is available."
      />
    );
  const render = (agent: Agent, ancestors: string[], depth: number): React.ReactNode => {
    if (ancestors.includes(agent.id)) return null;
    const children = values.filter(
      (item) => item.parentId === agent.id && ![...ancestors, agent.id].includes(item.id),
    );
    const Icon =
      depth === 0
        ? Bot
        : agent.id.includes('qa')
          ? ShieldCheck
          : agent.id.includes('front')
            ? Monitor
            : Code2;
    const matches = filter === 'all' || agent.status === filter;
    return (
      <div key={agent.id} className={depth ? 'agent-branch' : 'agent-root'}>
        {matches && (
          <div className={`agent-row ${selected === agent.id ? 'selected' : ''}`}>
            <button
              className="agent-collapse"
              aria-label={`${collapsed.includes(agent.id) ? 'Expand' : 'Collapse'} ${agent.name}`}
              disabled={!children.length}
              onClick={() =>
                setCollapsed(
                  collapsed.includes(agent.id)
                    ? collapsed.filter((id) => id !== agent.id)
                    : [...collapsed, agent.id],
                )
              }
            >
              {children.length > 0 &&
                (collapsed.includes(agent.id) ? (
                  <ChevronRight size={11} />
                ) : (
                  <ChevronDown size={11} />
                ))}
            </button>
            <button
              className="agent-select"
              onClick={() => select(agent.id)}
              aria-pressed={selected === agent.id}
            >
              <span className="agent-avatar">
                <Icon size={19} />
              </span>
              <span className="agent-name">
                <strong>{agent.name}</strong>
                <small>{agent.role}</small>
              </span>
              <StatusIndicator status={agent.status} />
            </button>
          </div>
        )}
        {!collapsed.includes(agent.id) &&
          children.map((child) => render(child, [...ancestors, agent.id], depth + 1))}
      </div>
    );
  };
  const roots = values.filter((agent) => !agent.parentId || !agents[agent.parentId]);
  // A malformed cycle has no root; render each member once as an inspectable root.
  return (
    <div className="agent-tree">
      {(roots.length ? roots : values).map((agent) => render(agent, [], 0))}
      {!values.some((agent) => filter === 'all' || agent.status === filter) && (
        <p className="muted">No agents match this status.</p>
      )}
    </div>
  );
}
