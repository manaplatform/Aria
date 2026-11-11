import { useState } from 'react';
import { Check, GitPullRequest, ShieldAlert, X } from 'lucide-react';
import type { ApprovalRequest } from '@aria/shared';
import { useExecutionStore } from '../../stores/executionStore';
import { Badge, Button, EmptyState, ErrorState, IconButton, Modal } from '../ui';
import { notify } from '../../stores/uiStore';
import { errorMessage } from '../../services/desktop';
export function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const adapter = useExecutionStore((state) => state.adapter);
  const [inspect, setInspect] = useState(false);
  const busy = useExecutionStore((state) => !!state.pendingApprovals[approval.id]);
  const [error, setError] = useState('');
  const decide = async (decision: 'approved' | 'denied') => {
    if (useExecutionStore.getState().pendingApprovals[approval.id]) return;
    useExecutionStore.setState((state) => ({
      pendingApprovals: { ...state.pendingApprovals, [approval.id]: true },
    }));
    setError('');
    try {
      const acknowledgement = await adapter.decideApproval(approval.id, decision);
      if (useExecutionStore.getState().adapter !== adapter) return;
      useExecutionStore.getState().apply({
        workspaceId: approval.workspaceId,
        cursor: useExecutionStore.getState().cursor + 1,
        type: 'approval',
        approval: acknowledgement,
      });
      notify(
        adapter.source === 'sample'
          ? `Sample request ${decision}. No external operation occurred.`
          : `Request ${decision}.`,
      );
      setInspect(false);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      if (useExecutionStore.getState().adapter === adapter)
        useExecutionStore.setState((state) => ({
          pendingApprovals: { ...state.pendingApprovals, [approval.id]: false },
        }));
    }
  };
  return (
    <div className="approval-card">
      <GitPullRequest size={19} />
      <button className="approval-info" onClick={() => setInspect(true)}>
        <strong>{approval.operation}</strong>
        <small title={approval.target}>{approval.target}</small>
      </button>
      {approval.status === 'pending' ? (
        <div className="row">
          <IconButton
            label={`Deny ${approval.operation}`}
            disabled={busy || !adapter.capabilities.approvals}
            onClick={() => void decide('denied')}
          >
            <X size={15} />
          </IconButton>
          <Button
            size="icon"
            variant="primary"
            aria-label={`Approve ${approval.operation}`}
            disabled={busy || !adapter.capabilities.approvals}
            onClick={() => setInspect(true)}
          >
            <Check size={16} />
          </Button>
        </div>
      ) : (
        <Badge tone={approval.status === 'approved' ? 'success' : 'neutral'}>
          {approval.status}
        </Badge>
      )}
      {error && <ErrorState message={error} />}
      <Modal
        open={inspect}
        onOpenChange={setInspect}
        title={approval.operation}
        description={
          adapter.source === 'sample'
            ? 'Sample approval · no external operation will occur.'
            : 'Review the exact requested operation before deciding.'
        }
      >
        <div className="approval-details">
          <FieldRow label="Target">{approval.target}</FieldRow>
          <FieldRow label="Context">{approval.context}</FieldRow>
          <div className="risk">
            <ShieldAlert size={18} />
            <span>{approval.risk}</span>
          </div>
          {error && <ErrorState message={error} />}
          {approval.status === 'pending' && (
            <div className="dialog-actions">
              <Button disabled={busy} onClick={() => void decide('denied')}>
                Deny
              </Button>
              <Button
                variant="primary"
                disabled={busy || !adapter.capabilities.approvals}
                onClick={() => void decide('approved')}
              >
                {busy
                  ? 'Awaiting acknowledgement…'
                  : adapter.source === 'sample'
                    ? 'Approve sample request'
                    : 'Approve operation'}
              </Button>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <small className="muted">{label}</small>
      <p>{children}</p>
    </div>
  );
}
export function ApprovalQueue() {
  const approvals = useExecutionStore((state) => state.approvals);
  return Object.values(approvals).length ? (
    <div className="approval-queue">
      {Object.values(approvals).map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} />
      ))}
    </div>
  ) : (
    <EmptyState
      title="No pending approvals"
      description="Requests will appear here when a connected service needs your permission."
    />
  );
}
