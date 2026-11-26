import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  agendaTaskDraft,
  taskPriority,
  taskState,
  type AgendaTask,
  type ProactiveCommand,
  type ProactivePending,
} from '@aria/shared';
import { Badge, Button, Modal } from '../ui';
import {
  commandId,
  dateLabel,
  JobLink,
  ProactivePage,
  ref,
  statusLabel,
  useProactive,
} from './runtime';

type Act = (command: ProactiveCommand) => Promise<unknown>;

export function TaskForm({
  task,
  objectives,
  tasks,
  save,
}: {
  task?: AgendaTask;
  objectives: { id: string; title: string }[];
  tasks: AgendaTask[];
  save(value: ReturnType<typeof agendaTaskDraft.parse>): Promise<unknown>;
}) {
  const [error, setError] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const date = String(data.get('deadline') || '');
    const parsed = agendaTaskDraft.safeParse({
      title: data.get('title'),
      description: data.get('description'),
      blocker: data.get('blocker'),
      priority: data.get('priority'),
      objectiveId: data.get('objective') || null,
      parentId: data.get('parent') || null,
      deadline: date ? new Date(date).getTime() : null,
      dependencies: [
        ...data.getAll('dependency'),
        ...(task?.dependencies.filter((id) => !tasks.some((row) => row.id === id)) ?? []),
      ],
    });
    if (parsed.success) void save(parsed.data);
    else setError(parsed.error.issues[0]?.message ?? 'Check the task fields.');
  };
  const deadline = task?.deadline
    ? new Date(task.deadline - new Date(task.deadline).getTimezoneOffset() * 60_000)
        .toISOString()
        .slice(0, 16)
    : undefined;
  return (
    <form className="proactive-form" onSubmit={submit}>
      <label>
        Task title
        <input name="title" defaultValue={task?.title} maxLength={200} required />
      </label>
      <label>
        Description
        <textarea name="description" defaultValue={task?.description} maxLength={4000} />
      </label>
      <label>
        Blocker
        <input name="blocker" defaultValue={task?.blocker} maxLength={400} />
      </label>
      <div className="proactive-controls">
        <label>
          Priority
          <select name="priority" defaultValue={task?.priority ?? 'normal'}>
            {taskPriority.options.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Deadline
          <input name="deadline" type="datetime-local" defaultValue={deadline} />
        </label>
      </div>
      <label>
        Objective
        <select name="objective" defaultValue={task?.objectiveId ?? ''}>
          <option value="">None</option>
          {objectives.map((row) => (
            <option key={row.id} value={row.id}>
              {row.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        Parent task
        <select name="parent" defaultValue={task?.parentId ?? ''}>
          <option value="">None</option>
          {tasks
            .filter((row) => row.id !== task?.id)
            .map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
        </select>
      </label>
      {!!tasks.filter((row) => row.id !== task?.id).length && (
        <fieldset>
          <legend>Prerequisites</legend>
          {tasks
            .filter((row) => row.id !== task?.id)
            .map((row) => (
              <label key={row.id}>
                <input
                  type="checkbox"
                  name="dependency"
                  value={row.id}
                  defaultChecked={task?.dependencies.includes(row.id)}
                />{' '}
                {row.title}
              </label>
            ))}
        </fieldset>
      )}
      {error && <span role="alert">{error}</span>}
      <Button type="submit" variant="primary">
        Save task
      </Button>
    </form>
  );
}

export function ObjectiveForm({
  save,
  objective,
}: {
  save(title: string, description: string): void;
  objective?: { title: string; description: string };
}) {
  return (
    <form
      className="proactive-form"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        save(String(data.get('title')), String(data.get('description')));
      }}
    >
      <label>
        Objective title
        <input name="title" maxLength={200} defaultValue={objective?.title} required />
      </label>
      <label>
        Description
        <textarea name="description" maxLength={4000} defaultValue={objective?.description} />
      </label>
      <Button type="submit" variant="primary">
        Save objective
      </Button>
    </form>
  );
}

export function RequestCard({ request, act }: { request: ProactivePending; act: Act }) {
  const [text, setText] = useState('');
  const automation = request.automation;
  return (
    <article className="proactive-card">
      <strong>
        {request.kind === 'clarification' ? 'Clarification needed' : 'Approval needed'}
      </strong>
      <p className="proactive-content">{request.message}</p>
      {automation && (
        <dl className="proactive-definition">
          <dt>Title</dt>
          <dd>{automation.title}</dd>
          <dt>Original instruction</dt>
          <dd>{automation.instruction}</dd>
          <dt>Execution action</dt>
          <dd>{automation.action}</dd>
          <dt>Trigger</dt>
          <dd>
            {automation.trigger.kind} · {JSON.stringify(automation.trigger)}
          </dd>
          <dt>Public web scope</dt>
          <dd>
            {automation.scope.publicSearch
              ? 'Search and public web reads'
              : automation.scope.publicOrigins.join(', ') || 'None'}
          </dd>
          <dt>Memory</dt>
          <dd>{automation.scope.memory ? 'Profile recall with standing consent' : 'Off'}</dd>
          <dt>Run limit</dt>
          <dd>
            ${(automation.maxMicros / 1_000_000).toFixed(3)} · {automation.maxAttempts} attempts ·{' '}
            {automation.limits.activeMs / 1000} seconds
          </dd>
        </dl>
      )}
      {request.kind === 'clarification' && (
        <label>
          Answer
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={2000}
          />
        </label>
      )}
      <div className="proactive-controls">
        <Button
          variant="primary"
          disabled={request.kind === 'clarification' && !text.trim()}
          onClick={() =>
            void act({
              action: 'request_resolve',
              ...ref(request),
              decision: request.kind === 'clarification' ? 'answer' : 'approve',
              ...(request.kind === 'clarification' && { text }),
            })
          }
        >
          {request.kind === 'clarification'
            ? 'Send answer'
            : automation
              ? 'Authorize automation'
              : 'Approve exact action'}
        </Button>
        <Button
          onClick={() =>
            void act({ action: 'request_resolve', ...ref(request), decision: 'decline' })
          }
        >
          Decline
        </Button>
        {request.jobId && <Link to={'/agenda/jobs/' + request.jobId}>View job</Link>}
      </div>
    </article>
  );
}

export default function AgendaPage() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [priority, setPriority] = useState('');
  const [offset, setOffset] = useState(0);
  const [editor, setEditor] = useState<'task' | 'objective' | null>(null);
  const state = taskState.safeParse(filter);
  const selectedPriority = taskPriority.safeParse(priority);
  const view = useProactive({
    action: 'snapshot',
    query,
    taskState: state.data,
    priority: selectedPriority.data,
    offset,
  });
  const data = view.result?.value;
  return (
    <ProactivePage
      title="Agenda"
      error={view.error}
      loading={!data}
      actions={
        <div className="proactive-controls">
          <Button onClick={() => setEditor('objective')}>New objective</Button>
          <Button variant="primary" onClick={() => setEditor('task')}>
            New task
          </Button>
        </div>
      }
    >
      {data?.status && <p role="status">{data.status}</p>}
      {data && (
        <>
          <div className="proactive-controls">
            <Badge>{data.counts.open} open tasks</Badge>
            <Badge>{data.counts.running} running</Badge>
            <Badge>{data.counts.blocked} need attention</Badge>
            <Badge>{data.counts.objectives} open objectives</Badge>
          </div>
          {data.requests.length > 0 && (
            <section>
              <h2>Needs your review</h2>
              {data.requests.map((request) => (
                <RequestCard key={request.id} request={request} act={view.act} />
              ))}
            </section>
          )}
          <section>
            <h2>Tasks</h2>
            <div className="proactive-controls">
              <input
                type="search"
                aria-label="Search tasks"
                placeholder="Search tasks"
                value={query}
                onChange={(e) => {
                  setOffset(0);
                  setQuery(e.target.value);
                }}
              />
              <select
                aria-label="Task status"
                value={filter}
                onChange={(e) => {
                  setOffset(0);
                  setFilter(e.target.value);
                }}
              >
                <option value="">All statuses</option>
                {taskState.options.map((status) => (
                  <option key={status} value={status}>
                    {statusLabel(status)}
                  </option>
                ))}
              </select>
              <select
                aria-label="Task priority"
                value={priority}
                onChange={(e) => {
                  setOffset(0);
                  setPriority(e.target.value);
                }}
              >
                <option value="">All priorities</option>
                {taskPriority.options.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </div>
            {data.tasks.map((task) => (
              <Link className="proactive-row" key={task.id} to={'/agenda/tasks/' + task.id}>
                <strong>{task.title}</strong>
                <span>
                  {statusLabel(task.state)} · {task.priority}
                </span>
                <small>{task.deadline === null ? 'No deadline' : dateLabel(task.deadline)}</small>
              </Link>
            ))}
            {!data.tasks.length && <p>No matching tasks.</p>}
            <div className="proactive-controls">
              {offset > 0 && (
                <Button onClick={() => setOffset(Math.max(0, offset - (query ? 60 : 20)))}>
                  Previous
                </Button>
              )}
              {data.nextOffset !== null && (
                <Button onClick={() => setOffset(data.nextOffset!)}>Next</Button>
              )}
            </div>
          </section>
          <section>
            <h2>Objectives</h2>
            {data.objectives.map((objective) => (
              <Link
                className="proactive-row"
                key={objective.id}
                to={'/agenda/objectives/' + objective.id}
              >
                <strong>{objective.title}</strong>
                <span>{objective.state}</span>
              </Link>
            ))}
            {!data.objectives.length && <p>No objectives yet.</p>}
          </section>
          <section>
            <h2>Recent jobs</h2>
            {data.jobs.slice(0, 10).map((job) => (
              <JobLink key={job.id} job={job} />
            ))}
            {!data.jobs.length && <p>No jobs yet.</p>}
          </section>
        </>
      )}
      {editor && data && (
        <Modal
          title={editor === 'task' ? 'New task' : 'New objective'}
          description="Add a responsibility to Agenda."
          open
          onOpenChange={(open) => !open && setEditor(null)}
        >
          {editor === 'task' ? (
            <TaskForm
              objectives={data.objectives}
              tasks={data.tasks}
              save={async (task) => {
                if (await view.act({ action: 'task_create', commandId: commandId(), task }))
                  setEditor(null);
              }}
            />
          ) : (
            <ObjectiveForm
              save={(title, description) =>
                void view
                  .act({
                    action: 'objective_create',
                    commandId: commandId(),
                    objective: { title, description },
                  })
                  .then((response) => {
                    if (response) setEditor(null);
                  })
              }
            />
          )}
          {view.error && <p role="alert">{view.error}</p>}
        </Modal>
      )}
    </ProactivePage>
  );
}
