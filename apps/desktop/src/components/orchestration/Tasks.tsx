import { useState } from 'react';
import { Check, Circle, ListTodo, Plus, Trash2 } from 'lucide-react';
import type { Plan, Status, Task } from '@aria/shared';
import { useWorkspace, useTasks, usePlans } from '../../hooks/useWorkspace';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useExecutionStore } from '../../stores/executionStore';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Modal,
  ProgressBar,
  StatusIndicator,
} from '../ui';
import { errorMessage } from '../../services/desktop';
const statuses: Status[] = ['pending', 'running', 'blocked', 'completed', 'cancelled'];
export function TaskEditor({ task, onClose }: { task?: Task; onClose: () => void }) {
  const workspace = useWorkspace();
  const tasks = useTasks();
  const agents = useExecutionStore((state) => state.agents);
  const [draft, setDraft] = useState<Task>(
    () =>
      task ?? {
        id: crypto.randomUUID(),
        workspaceId: workspace!.id,
        title: '',
        description: '',
        status: 'pending',
        ownerId: null,
        dependencies: [],
        source: workspace?.id === 'sample' ? 'sample' : 'local',
        revision: 0,
      },
  );
  const [error, setError] = useState('');
  const save = useWorkspaceStore((state) => state.saveTask);
  const remove = useWorkspaceStore((state) => state.deleteTask);
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={task ? 'Task details' : 'Create task'}
      description={
        workspace?.id === 'sample'
          ? 'Changes apply only to this sample workspace.'
          : 'Manually managed and saved on this device.'
      }
    >
      <form
        className="form-stack"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            if (!draft.title.trim()) throw new Error('Enter a task title.');
            save({ ...draft, title: draft.title.trim(), revision: draft.revision + 1 });
            onClose();
          } catch (error) {
            setError(errorMessage(error));
          }
        }}
      >
        <Field label="Title">
          <input
            required
            maxLength={500}
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            autoFocus
          />
        </Field>
        <Field label="Description">
          <textarea
            rows={3}
            maxLength={100000}
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </Field>
        <div className="form-columns">
          <Field label="Status">
            <select
              value={draft.status}
              onChange={(event) => setDraft({ ...draft, status: event.target.value as Status })}
            >
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Owner">
            <select
              value={draft.ownerId ?? ''}
              onChange={(event) => setDraft({ ...draft, ownerId: event.target.value || null })}
            >
              <option value="">Unassigned</option>
              {Object.values(agents).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <fieldset>
          <legend>Dependencies</legend>
          <div className="dependency-list">
            {tasks
              .filter((item) => item.id !== draft.id)
              .map((item) => (
                <label key={item.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={draft.dependencies.includes(item.id)}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        dependencies: event.target.checked
                          ? [...draft.dependencies, item.id]
                          : draft.dependencies.filter((id) => id !== item.id),
                      })
                    }
                  />
                  {item.title}
                </label>
              ))}
            {tasks.filter((item) => item.id !== draft.id).length === 0 && (
              <p className="muted">No other tasks in this project.</p>
            )}
          </div>
        </fieldset>
        {error && <ErrorState message={error} />}
        <div className="dialog-actions">
          {task && (
            <Button
              variant="danger"
              type="button"
              onClick={() => {
                remove(task.id);
                onClose();
              }}
            >
              <Trash2 size={14} />
              Delete
            </Button>
          )}
          <span className="flex-spacer" />
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save task
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function TaskBoard({ compact = false }: { compact?: boolean }) {
  const tasks = useTasks();
  const workspace = useWorkspace();
  const [filter, setFilter] = useState('all');
  const [owner, setOwner] = useState('all');
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const agents = useExecutionStore((state) => state.agents);
  const complete = tasks.filter((task) => task.status === 'completed').length;
  const progress = tasks.length ? (complete / tasks.length) * 100 : 0;
  const filtered = tasks.filter(
    (task) =>
      (filter === 'all' || task.status === filter) &&
      (owner === 'all' || (task.ownerId ?? '') === owner),
  );
  return (
    <>
      <div className="task-board-summary">
        <div className="task-counts">
          {(['running', 'pending', 'completed', 'blocked'] as Status[]).map((status) => (
            <button
              key={status}
              onClick={() => setFilter(filter === status ? 'all' : status)}
              className={filter === status ? 'selected' : ''}
            >
              <StatusIndicator status={status} />
              <span>{tasks.filter((task) => task.status === status).length}</span>
            </button>
          ))}
        </div>
        <div
          className="progress-ring"
          style={{ '--progress': `${progress}%` } as React.CSSProperties}
        >
          <span>
            <strong>{Math.round(progress)}%</strong>
            <small>Complete</small>
          </span>
        </div>
      </div>
      {!compact && (
        <>
          <div className="list-toolbar">
            <select
              aria-label="Filter task status"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {statuses.map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
            <select
              aria-label="Filter task owner"
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
            >
              <option value="all">All owners</option>
              <option value="">Unassigned</option>
              {Object.values(agents).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <span className="flex-spacer" />
            <Button variant="primary" disabled={!workspace} onClick={() => setEditing('new')}>
              <Plus size={14} />
              New task
            </Button>
          </div>
          <div className="task-list">
            {filtered.map((task) => (
              <button key={task.id} className="task-card" onClick={() => setEditing(task)}>
                <StatusIndicator status={task.status} label={false} />
                <span>
                  <strong>{task.title}</strong>
                  <small>
                    {agents[task.ownerId ?? '']?.name ?? 'Unassigned'} · {task.dependencies.length}{' '}
                    dependencies
                  </small>
                </span>
                <Badge tone={task.source === 'local' ? 'neutral' : 'violet'}>
                  {task.source === 'local' ? 'Manual' : 'Sample'}
                </Badge>
                <StatusIndicator status={task.status} />
              </button>
            ))}
          </div>
          {!filtered.length && (
            <EmptyState
              icon={<ListTodo />}
              title="No tasks to show"
              description={
                tasks.length
                  ? 'Try a different status or owner.'
                  : 'Create a local task to organize your next piece of work.'
              }
            />
          )}
        </>
      )}
      {compact && !tasks.length && (
        <p className="panel-note">No tasks yet. Add manually managed tasks from the Tasks page.</p>
      )}
      {editing && (
        <TaskEditor
          task={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
export function PlanViewer({ editable = false }: { editable?: boolean }) {
  const plans = usePlans();
  const workspace = useWorkspace();
  const plan = plans[0];
  const savePlan = useWorkspaceStore((state) => state.savePlan);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const update = (patch: Partial<Plan>) => {
    if (plan) savePlan({ ...plan, ...patch, revision: plan.revision + 1 });
  };
  const completed = plan?.steps.filter((step) => step.completed).length ?? 0;
  if (!plan)
    return (
      <EmptyState
        title="Your next move starts here"
        description="Create a local checklist. Execution remains unavailable until a backend is connected."
        action={
          <Button
            size="sm"
            disabled={!workspace}
            onClick={() =>
              savePlan({
                id: crypto.randomUUID(),
                workspaceId: workspace!.id,
                title: 'Project plan',
                source: workspace?.id === 'sample' ? 'sample' : 'local',
                revision: 1,
                steps: [],
              })
            }
          >
            <Plus size={13} />
            Create plan
          </Button>
        }
      />
    );
  return (
    <div className="plan-viewer">
      {editable ? (
        <input
          aria-label="Plan title"
          maxLength={500}
          className="plan-title-input"
          value={plan.title}
          onChange={(event) => update({ title: event.target.value })}
        />
      ) : (
        <strong className="plan-title">{plan.title}</strong>
      )}
      <ProgressBar
        value={plan.steps.length ? (completed / plan.steps.length) * 100 : 0}
        label="Plan completion"
      />
      <p className="muted plan-caption">
        {completed} of {plan.steps.length} steps ·{' '}
        {plan.source === 'local' ? 'Manually managed' : 'Sample plan'}
      </p>
      <ol className="plan-steps">
        {plan.steps.map((step, index) => (
          <li key={step.id}>
            <button
              className={step.completed ? 'step-complete' : ''}
              onClick={() =>
                update({
                  steps: plan.steps.map((item) =>
                    item.id === step.id ? { ...item, completed: !item.completed } : item,
                  ),
                })
              }
              aria-label={`${step.completed ? 'Uncheck' : 'Complete'} ${step.title}`}
              aria-pressed={step.completed}
            >
              {step.completed ? <Check size={14} /> : <Circle size={14} />}
              <span>
                {index + 1}. {step.title}
              </span>
              {step.completed && <Check size={13} className="end-check" />}
            </button>
            {editable && (
              <IconButton
                label={`Remove ${step.title}`}
                onClick={() => update({ steps: plan.steps.filter((item) => item.id !== step.id) })}
              >
                <Trash2 size={12} />
              </IconButton>
            )}
          </li>
        ))}
      </ol>
      {editable &&
        (adding ? (
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              if (!title.trim()) return;
              update({
                steps: [
                  ...plan.steps,
                  { id: crypto.randomUUID(), title: title.trim(), completed: false },
                ],
              });
              setTitle('');
              setAdding(false);
            }}
          >
            <input
              autoFocus
              aria-label="New plan step"
              placeholder="What needs to happen?"
              maxLength={1000}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Button type="submit" size="sm">
              Add
            </Button>
            <IconButton label="Cancel adding step" type="button" onClick={() => setAdding(false)}>
              <Circle size={12} />
            </IconButton>
          </form>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <Plus size={13} />
            Add step
          </Button>
        ))}
    </div>
  );
}
