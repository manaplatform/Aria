import { useEffect, useState } from 'react';
import { BookOpen, File, Folder, GitBranch, Layers, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../../hooks/useWorkspace';
import { activeConversation, useWorkspaceStore } from '../../stores/workspaceStore';
import { Button, CopyButton, EmptyState, ErrorState, IconButton } from '../ui';
import { desktop, errorMessage } from '../../services/desktop';
export function RepositoryContext() {
  const workspace = useWorkspace();
  const sample = useWorkspaceStore((state) => state.sample);
  const conversation = useWorkspaceStore(activeConversation);
  const [branch, setBranch] = useState(workspace?.branch);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    setBranch(workspace?.branch);
    setError('');
    if (workspace && !sample)
      void desktop()
        .repository(workspace.id)
        .then((info) => {
          if (active) {
            setBranch(info.branch);
            setError(info.error ?? '');
            if (workspace.branch !== info.branch)
              useWorkspaceStore.setState((state) => ({
                data: {
                  ...state.data,
                  workspaces: state.data.workspaces.map((item) =>
                    item.id === workspace.id ? { ...item, branch: info.branch } : item,
                  ),
                },
              }));
          }
        })
        .catch((error) => {
          if (active) setError(errorMessage(error));
        });
    return () => {
      active = false;
    };
  }, [workspace, sample, refresh]);
  if (!workspace)
    return (
      <EmptyState
        title="No project selected"
        description="Open a local folder to inspect repository and file context."
        action={
          <Button size="sm" onClick={() => void useWorkspaceStore.getState().chooseWorkspace()}>
            Open project
          </Button>
        }
      />
    );
  return (
    <div className="context-list">
      <div>
        <GitBranch size={15} />
        <span>Repository</span>
        <strong title={workspace.root}>
          {workspace.name} <small>({branch ?? 'no branch'})</small>
        </strong>
        <IconButton label="Refresh repository" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={12} />
        </IconButton>
      </div>
      <div>
        <File size={15} />
        <span>Files</span>
        <button onClick={() => navigate('/knowledge')}>
          {conversation?.attachments.length ?? 0} attached · Browse files
        </button>
      </div>
      <div>
        <BookOpen size={15} />
        <span>Docs</span>
        <button onClick={() => navigate('/knowledge')}>Project documents</button>
      </div>
      <div>
        <Layers size={15} />
        <span>Memory</span>
        <strong>Service unavailable</strong>
      </div>
      <div>
        <Folder size={15} />
        <code title={workspace.root}>{workspace.root}</code>
        <CopyButton text={workspace.root} label="Copy project path" />
      </div>
      {error && <ErrorState message={error} />}
    </div>
  );
}
