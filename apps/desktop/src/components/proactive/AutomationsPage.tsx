import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ProactiveAutomation } from '@aria/shared';
import { selectChat, setChatDraft } from '../../stores/chatStore';
import { Badge, Button, Modal } from '../ui';
import { RequestCard } from './AgendaPage';
import AutomationEditor from './AutomationEditor';
import { commandId, dateLabel, JobLink, ProactivePage, ref, useProactive } from './runtime';

function AutomationActions({
  row,
  act,
  edit,
}: {
  row: ProactiveAutomation;
  act: ReturnType<typeof useProactive<'snapshot'>>['act'];
  edit(): void;
}) {
  const [confirm, setConfirm] = useState(false);
  const control = (control: 'enable' | 'disable' | 'pause' | 'resume' | 'delete' | 'run_now') =>
    void act({ action: 'automation_control', ...ref(row), control });
  return (
    <div className="proactive-controls">
      <Button onClick={edit}>{row.permissionCurrent ? 'Edit' : 'Review permission'}</Button>
      {row.state === 'enabled' && (
        <>
          <Button onClick={() => control('run_now')}>Run now</Button>
          <Button onClick={() => control('pause')}>Pause</Button>
        </>
      )}
      {row.state === 'paused' && <Button onClick={() => control('resume')}>Resume</Button>}
      {['enabled', 'paused'].includes(row.state) && (
        <Button onClick={() => control('disable')}>Disable</Button>
      )}
      {row.state === 'disabled' && <Button onClick={() => control('enable')}>Enable</Button>}
      <Button variant="danger" onClick={() => setConfirm(true)}>
        Delete
      </Button>
      {confirm && (
        <Modal
          title="Delete automation?"
          description="Future runs will be stopped."
          open
          onOpenChange={setConfirm}
        >
          <p>{row.title}</p>
          <Button
            variant="danger"
            onClick={() => {
              control('delete');
              setConfirm(false);
            }}
          >
            Delete automation
          </Button>
        </Modal>
      )}
    </div>
  );
}

export default function AutomationsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const snapshot = useProactive({ action: 'snapshot', offset });
  const detail = useProactive({
    action: 'detail',
    id: id ?? '00000000-0000-0000-0000-000000000000',
  });
  const data = snapshot.result?.value;
  const row = id ? detail.result?.automation : undefined;
  const view = id ? detail : snapshot;
  return (
    <ProactivePage
      title={row?.title ?? 'Automations'}
      error={view.error}
      loading={!data || (!!id && !detail.result)}
      actions={
        id ? (
          <Link to="/automations">All automations</Link>
        ) : (
          <div className="proactive-controls">
            <Button
              onClick={() => {
                selectChat(null);
                setChatDraft('Create an automation to ', null);
                navigate('/chat');
              }}
            >
              Describe in chat
            </Button>
            <Button variant="primary" onClick={() => setEditing(true)}>
              New automation
            </Button>
          </div>
        )
      }
    >
      {data?.status && <p role="status">{data.status}</p>}
      {!id && data && (
        <>
          {data.requests
            .filter((request) => request.kind === 'automation')
            .map((request) => (
              <RequestCard key={request.id} request={request} act={snapshot.act} />
            ))}
          {data.automations.map((automation) => (
            <Link
              className="proactive-row"
              key={automation.id}
              to={'/automations/' + automation.id}
            >
              <strong>{automation.title}</strong>
              <span>
                {automation.state} · {automation.trigger.kind.replace('_', ' ')}
              </span>
              <small>
                Next {dateLabel(automation.nextDue)} · Last {dateLabel(automation.lastRun)}
              </small>
            </Link>
          ))}
          {!data.automations.length && <p>No automations on this page.</p>}
          <div className="proactive-controls">
            {offset > 0 && <Button onClick={() => setOffset(offset - 20)}>Previous</Button>}
            {data.automations.length === 20 && (
              <Button onClick={() => setOffset(offset + 20)}>Next</Button>
            )}
          </div>
        </>
      )}
      {row && (
        <>
          <section>
            <Badge>{row.state}</Badge>
            <p className="proactive-content">{row.instruction}</p>
            <p>
              Next run {dateLabel(row.nextDue)} · Last run {dateLabel(row.lastRun)}
            </p>
            <p>
              {row.permissionCurrent
                ? 'Permission matches the current primary.'
                : 'Review this automation with the current primary.'}
            </p>
            {row.condition && <p>Last verified condition {row.condition.replace('_', ' ')}</p>}
            <AutomationActions row={row} act={detail.act} edit={() => setEditing(true)} />
          </section>
          <section>
            <h2>Execution history</h2>
            {detail.result?.history.map((job) => (
              <JobLink key={job.id} job={job} />
            ))}
          </section>
        </>
      )}
      {id && detail.result && !row && <p>This automation is unavailable.</p>}
      {editing && data && (
        <Modal
          title={row ? 'Edit automation' : 'New automation'}
          description="Set the trigger, scope, and limits."
          open
          onOpenChange={setEditing}
        >
          <AutomationEditor
            value={row}
            tasks={data.tasks}
            preview={async (trigger) => {
              const result = await view.act({ action: 'automation_preview', trigger });
              return result?.kind === 'preview' ? result.times : undefined;
            }}
            save={async (automation) => {
              const result = await view.act(
                row
                  ? { action: 'automation_update', ...ref(row), automation }
                  : { action: 'automation_create', commandId: commandId(), automation },
              );
              if (result) setEditing(false);
            }}
          />
          {view.error && <p role="alert">{view.error}</p>}
        </Modal>
      )}
    </ProactivePage>
  );
}
