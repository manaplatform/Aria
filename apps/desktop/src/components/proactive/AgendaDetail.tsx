import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ProactiveJobState } from '@aria/shared';
import { Badge, Button, Modal, ProgressBar } from '../ui';
import { ObjectiveForm, RequestCard, TaskForm } from './AgendaPage';
import {
  commandId,
  dateLabel,
  JobLink,
  ProactivePage,
  ref,
  statusLabel,
  useProactive,
} from './runtime';

const controls: Partial<Record<ProactiveJobState, ('cancel' | 'pause' | 'resume' | 'retry')[]>> = {
  scheduled: ['pause', 'cancel'],
  queued: ['pause', 'cancel'],
  retry_scheduled: ['pause', 'cancel'],
  running: ['pause', 'cancel'],
  paused: ['resume', 'cancel'],
  blocked: ['retry', 'cancel'],
  interrupted: ['resume', 'cancel'],
  failed: ['retry'],
  waiting_approval: ['cancel'],
  waiting_user: ['cancel'],
};

export default function AgendaDetail() {
  const { id = '' } = useParams();
  const view = useProactive({ action: 'detail', id });
  const snapshot = useProactive({ action: 'snapshot' });
  const [editing, setEditing] = useState<'record' | 'run' | null>(null);
  const { task, objective, job, history, attempts, activity, artifacts } = view.result ?? {};
  const data = snapshot.result?.value;
  const taskLabels = new Map(data?.tasks.map((task) => [task.id, task.title]));
  const error = view.error || snapshot.error;
  const title = task?.title ?? objective?.title ?? (job ? 'Job details' : 'Agenda details');
  return (
    <ProactivePage
      title={title}
      error={error}
      loading={!view.result}
      actions={<Link to="/agenda">Back to Agenda</Link>}
    >
      {view.result && !task && !objective && !job && <p>This record is unavailable.</p>}
      {task && (
        <section>
          <p className="proactive-content">{task.description}</p>
          {task.blocker && <p>Blocker · {task.blocker}</p>}
          {task.completedBy && (
            <p>
              {task.completedBy === 'user' ? 'Completed by you' : 'Completed by a verified run'}
            </p>
          )}
          <div className="proactive-controls">
            <Badge>{statusLabel(task.state)}</Badge>
            <Badge>{task.priority}</Badge>
            {task.deadline !== null && <span>Due {dateLabel(task.deadline)}</span>}
          </div>
          <ProgressBar value={task.progress} label="Task progress" />
          {task.parentId && (
            <p>
              Parent{' '}
              <Link to={'/agenda/tasks/' + task.parentId}>
                {taskLabels.get(task.parentId) ?? 'View task'}
              </Link>
            </p>
          )}
          {task.objectiveId && (
            <p>
              <Link to={'/agenda/objectives/' + task.objectiveId}>View objective</Link>
            </p>
          )}
          {task.dependencies.length > 0 && (
            <>
              <h2>Prerequisites</h2>
              <ul>
                {task.dependencies.map((id) => (
                  <li key={id}>
                    <Link to={'/agenda/tasks/' + id}>{taskLabels.get(id) ?? 'View task'}</Link>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="proactive-controls">
            {!['completed', 'cancelled', 'in_progress'].includes(task.state) && (
              <Button onClick={() => setEditing('record')}>Edit task</Button>
            )}
            {['ready', 'blocked'].includes(task.state) && (
              <Button variant="primary" onClick={() => setEditing('run')}>
                Run task
              </Button>
            )}
            {!['completed', 'cancelled', 'in_progress'].includes(task.state) && (
              <>
                <Button
                  onClick={() =>
                    void view.act({ action: 'task_state', ...ref(task), state: 'completed' })
                  }
                >
                  Mark completed
                </Button>
                <Button
                  onClick={() =>
                    void view.act({ action: 'task_state', ...ref(task), state: 'cancelled' })
                  }
                >
                  Cancel task
                </Button>
              </>
            )}
          </div>
        </section>
      )}
      {objective && (
        <section>
          <p className="proactive-content">{objective.description}</p>
          <Badge>{objective.state}</Badge>
          <h2>Tasks</h2>
          {data?.tasks
            .filter((row) => row.objectiveId === objective.id)
            .map((row) => (
              <Link className="proactive-row" key={row.id} to={'/agenda/tasks/' + row.id}>
                {row.title}
              </Link>
            ))}
          {!['completed', 'cancelled'].includes(objective.state) && (
            <div className="proactive-controls">
              <Button onClick={() => setEditing('record')}>Edit objective</Button>
              <Button
                onClick={() =>
                  void view.act({
                    action: 'objective_state',
                    ...ref(objective),
                    state: 'completed',
                  })
                }
              >
                Mark completed
              </Button>
              <Button
                onClick={() =>
                  void view.act({
                    action: 'objective_state',
                    ...ref(objective),
                    state: 'cancelled',
                  })
                }
              >
                Cancel objective
              </Button>
            </div>
          )}
        </section>
      )}
      {job && (
        <>
          <section>
            <Badge>{statusLabel(job.state)}</Badge>
            <p>
              {job.kind} · {dateLabel(job.due)}
            </p>
            {job.reason && <p>{job.reason}</p>}
            {job.state === 'uncertain' && (
              <details>
                <summary>Review external effect</summary>
                <p>Inspect the actual outcome before confirming or closing this job.</p>
                <div className="proactive-controls">
                  <Button
                    onClick={() =>
                      void view.act({
                        action: 'job_reconcile',
                        ...ref(job),
                        status: 'effect_verified',
                      })
                    }
                  >
                    Confirm observed effect
                  </Button>
                  <Button
                    onClick={() =>
                      void view.act({
                        action: 'job_reconcile',
                        ...ref(job),
                        status: 'close_without_retry',
                      })
                    }
                  >
                    Close without retry
                  </Button>
                </div>
              </details>
            )}
            <div className="proactive-controls">
              {controls[job.state]?.map((control) => (
                <Button
                  key={control}
                  onClick={() =>
                    void view.act({
                      action: 'job_control',
                      ...ref(job),
                      control,
                    })
                  }
                >
                  {control[0].toUpperCase() + control.slice(1)}
                </Button>
              ))}
            </div>
          </section>
          {data?.requests
            .filter((row) => row.jobId === job.id)
            .map((row) => (
              <RequestCard key={row.id} request={row} act={view.act} />
            ))}
          {job.result && (
            <section>
              <h2>Result</h2>
              <p className="proactive-content">{job.result}</p>
              {job.state === 'completed' && (
                <Button
                  onClick={() =>
                    void view.act({ action: 'memory_save', jobId: job.id, revision: job.revision })
                  }
                >
                  Save finding to memory
                </Button>
              )}
            </section>
          )}
          {!!activity?.length && (
            <section>
              <h2>Activity</h2>
              {activity.map((row) => (
                <div className="proactive-row" key={row.stepId}>
                  <strong>{row.summary}</strong>
                  <Badge>{statusLabel(row.status)}</Badge>
                  {row.resultSummary && <small>{row.resultSummary}</small>}
                </div>
              ))}
            </section>
          )}
          {!!artifacts?.length && (
            <section>
              <h2>Artifacts</h2>
              {artifacts.map((asset) => (
                <div className="proactive-row" key={asset.id}>
                  <strong>{asset.name}</strong>
                  <Button
                    onClick={() =>
                      void view.act({ action: 'artifact_export', jobId: job.id, id: asset.id })
                    }
                  >
                    Save file
                  </Button>
                </div>
              ))}
            </section>
          )}
          <section>
            <h2>Execution attempts</h2>
            {attempts?.map((attempt) => (
              <div className="proactive-row" key={attempt.id}>
                <strong>{statusLabel(attempt.state)}</strong>
                <span>{dateLabel(attempt.started)}</span>
                <small>
                  {attempt.modelRequests} model requests · {attempt.inputTokens} input tokens ·{' '}
                  {attempt.outputTokens} output tokens · ${(attempt.cost / 1_000_000).toFixed(4)}
                </small>
              </div>
            ))}
          </section>
        </>
      )}
      {!!history?.length && (
        <section>
          <h2>Job history</h2>
          {history.map((row) => (
            <JobLink key={row.id} job={row} />
          ))}
        </section>
      )}
      {editing === 'record' && (
        <Modal
          title="Edit Agenda record"
          description="Update the selected responsibility."
          open
          onOpenChange={(open) => !open && setEditing(null)}
        >
          {task && data && (
            <TaskForm
              task={task}
              tasks={data.tasks}
              objectives={data.objectives}
              save={async (value) => {
                if (await view.act({ action: 'task_update', ...ref(task), task: value }))
                  setEditing(null);
              }}
            />
          )}
          {objective && (
            <ObjectiveForm
              objective={objective}
              save={(title, description) =>
                void view
                  .act({
                    action: 'objective_update',
                    ...ref(objective),
                    objective: { title, description },
                  })
                  .then((value) => value && setEditing(null))
              }
            />
          )}
          {error && <p role="alert">{error}</p>}
        </Modal>
      )}
      {editing === 'run' && task && (
        <Modal
          title="Authorize task execution"
          description="Review the capabilities available during this run."
          open
          onOpenChange={(open) => !open && setEditing(null)}
        >
          <form
            className="proactive-form"
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              const origins = String(fields.get('origins') || '')
                .split(/\s+/)
                .filter(Boolean);
              void view
                .act({
                  action: 'task_run',
                  id: task.id,
                  revision: task.revision,
                  commandId: commandId(),
                  scope: {
                    publicSearch: fields.has('search'),
                    publicOrigins: origins,
                    memory: fields.has('memory'),
                  },
                })
                .then((response) => response && setEditing(null));
            }}
          >
            <label>
              <input name="search" type="checkbox" /> Allow public web search and reads
            </label>
            <label>
              Specific site origins
              <input name="origins" placeholder="https://example.com" />
            </label>
            <label>
              <input name="memory" type="checkbox" /> Allow profile memory recall with standing
              consent
            </label>
            {error && <p role="alert">{error}</p>}
            <Button type="submit" variant="primary">
              Authorize and queue
            </Button>
          </form>
        </Modal>
      )}
    </ProactivePage>
  );
}
