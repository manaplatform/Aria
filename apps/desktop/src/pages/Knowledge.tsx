import { useEffect, useState } from 'react';
import { ArrowLeft, File, Folder, Paperclip } from 'lucide-react';
import type { DirectoryEntry, FilePreview } from '@aria/shared';
import { useWorkspace } from '../hooks/useWorkspace';
import { activeConversation, useWorkspaceStore } from '../stores/workspaceStore';
import { desktop, errorMessage } from '../services/desktop';
import { Button, CopyButton, EmptyState, ErrorState, Skeleton } from '../components/ui';
export default function Knowledge() {
  const workspace = useWorkspace();
  const workspaceId = workspace?.id;
  const sample = useWorkspaceStore((state) => state.sample);
  const [directory, setDirectory] = useState('');
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setDirectory('');
    setSelection('');
    setPreview(null);
  }, [workspace?.id]);
  useEffect(() => {
    let active = true;
    setError('');
    setEntries([]);
    if (!workspaceId) return;
    if (sample) {
      setEntries([
        { name: 'activity.ts', path: 'src/services/activity.ts', kind: 'file', size: 189 },
      ]);
      return;
    }
    setLoading(true);
    void desktop()
      .listFiles(workspaceId, directory)
      .then((value) => {
        if (active) setEntries(value);
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, directory, sample, refresh]);
  useEffect(() => {
    let active = true;
    if (!selection || !workspaceId) {
      setPreview(null);
      return;
    }
    setReading(true);
    const request = sample
      ? Promise.resolve({
          path: selection,
          content:
            'export interface Activity {\n  id: string;\n  message: string;\n}\n\n// Sample file — no project file was read.\n',
          truncated: false,
          binary: false,
        })
      : desktop().readFile(workspaceId, selection);
    void request
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((error) => {
        if (active) setError(errorMessage(error));
      })
      .finally(() => {
        if (active) setReading(false);
      });
    return () => {
      active = false;
    };
  }, [selection, workspaceId, sample]);
  if (!workspace)
    return (
      <EmptyState
        icon={<Folder />}
        title="Open your project context"
        description="Select a local folder to browse files and attach references to a draft."
        action={
          <Button onClick={() => void useWorkspaceStore.getState().chooseWorkspace()}>
            Open project
          </Button>
        }
      />
    );
  return (
    <div className="knowledge-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">PROJECT CONTEXT</span>
          <h1>Knowledge</h1>
          <p>Read-only files and references. No files are uploaded.</p>
        </div>
      </div>
      {error && <ErrorState message={error} retry={() => setRefresh((value) => value + 1)} />}
      <div className="file-browser">
        <div className="file-list">
          <div className="file-list-tools">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Parent folder"
              disabled={!directory}
              onClick={() => setDirectory(directory.split(/[\\/]/).slice(0, -1).join('/'))}
            >
              <ArrowLeft size={15} />
            </Button>
            <code title={directory || workspace.root}>{directory || workspace.name}</code>
          </div>
          <input
            aria-label="Filter files"
            placeholder="Filter this folder…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {loading ? (
            <Skeleton />
          ) : (
            entries
              .filter((entry) => entry.name.toLowerCase().includes(search.toLowerCase()))
              .map((entry) => (
                <button
                  key={entry.path}
                  className={selection === entry.path ? 'file-entry selected' : 'file-entry'}
                  onClick={() => {
                    if (entry.kind === 'directory') {
                      setDirectory(entry.path);
                      setSearch('');
                    } else setSelection(entry.path);
                  }}
                >
                  {entry.kind === 'directory' ? <Folder size={15} /> : <File size={15} />}
                  <span>{entry.name}</span>
                </button>
              ))
          )}
          {!loading && !entries.length && <p className="muted">No visible files in this folder.</p>}
        </div>
        <div className="file-preview">
          {reading ? (
            <Skeleton />
          ) : preview ? (
            <>
              <div className="code-toolbar">
                <code title={preview.path}>{preview.path}</code>
                <CopyButton text={preview.path} label="Copy file path" />
                {!preview.binary && <CopyButton text={preview.content} label="Copy file content" />}
                <Button
                  size="sm"
                  disabled={sample}
                  onClick={() => {
                    const conversation = activeConversation(useWorkspaceStore.getState());
                    if (conversation?.attachments.some((item) => item.path === preview.path))
                      return;
                    useWorkspaceStore.getState().updateConversation({
                      attachments: [
                        ...(conversation?.attachments ?? []),
                        {
                          id: crypto.randomUUID(),
                          name: preview.path.split(/[\\/]/).pop()!,
                          path: preview.path,
                          size: new TextEncoder().encode(preview.content).length,
                        },
                      ],
                    });
                  }}
                >
                  <Paperclip size={12} />
                  Attach
                </Button>
              </div>
              {preview.truncated && (
                <div className="notice">Preview limited to the first 1 MiB.</div>
              )}
              {preview.binary ? (
                <EmptyState
                  title="Binary file"
                  description="A text preview is not available for this file."
                />
              ) : (
                <pre>{preview.content}</pre>
              )}
            </>
          ) : (
            <EmptyState
              icon={<File size={25} />}
              title="A closer look at your project"
              description="Select a file to preview its contents. Attach references to keep a draft in context."
            />
          )}
        </div>
      </div>
    </div>
  );
}
