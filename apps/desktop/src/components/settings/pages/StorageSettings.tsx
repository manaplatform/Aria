import { useEffect, useState } from 'react';
import type { StorageInfo } from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { flushPersistence, useWorkspaceStore } from '../../../stores/workspaceStore';
import { connectWorkspace } from '../../../stores/executionStore';
import { Button } from '../../ui';
import { KnowledgeSettings } from '../KnowledgeSettings';
import { SettingsPage } from '../SettingsPage';
import { SettingsDialog, SettingsSection } from '../components';

export default function StorageSettings() {
  const workspaces = useWorkspaceStore((state) => state.data.workspaces);
  const choose = useWorkspaceStore((state) => state.chooseWorkspace);
  const [info, setInfo] = useState<StorageInfo>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cleanup, setCleanup] = useState<'media' | 'browser'>();
  const [feedback, setFeedback] = useState('');
  const clean = async () => {
    const operation = cleanup; setCleanup(undefined); setBusy(true); setError(''); setFeedback('');
    try {
      await flushPersistence();
      if (useWorkspaceStore.getState().saveError) throw new Error(useWorkspaceStore.getState().saveError!);
      if (operation === 'media') {
        const result = await desktop().pruneMediaCache();
        setFeedback(`Removed ${result.removed} unused media files.`);
      } else if (operation === 'browser') {
        await desktop().clearBrowserCache(); setFeedback('Browser HTTP cache cleared.');
      }
      setInfo(await desktop().storageInfo());
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true); setError('');
    try {
      await flushPersistence();
      if (useWorkspaceStore.getState().saveError) throw new Error(useWorkspaceStore.getState().saveError!);
      const removed = await desktop().removeWorkspace(id);
      if (!removed) return;
      const state = useWorkspaceStore.getState();
      const wasActive = state.data.preferences.activeWorkspaceId === id;
      useWorkspaceStore.setState({ data: { ...state.data, workspaces: state.data.workspaces.filter((item) => item.id !== id), preferences: { ...state.data.preferences, activeWorkspaceId: wasActive ? null : state.data.preferences.activeWorkspaceId } } });
      if (wasActive) void connectWorkspace('', false);
    } catch (failure) {
      setError(errorMessage(failure));
      // Revocation may have succeeded even if restarting the service failed.
      const snapshot = await desktop().load().catch(() => null);
      if (snapshot) {
        const state = useWorkspaceStore.getState();
        useWorkspaceStore.setState({ data: { ...state.data, workspaces: snapshot.data.workspaces, preferences: { ...state.data.preferences, activeWorkspaceId: snapshot.data.preferences.activeWorkspaceId } } });
      }
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (window.aria?.storageInfo) void desktop().storageInfo().then(setInfo).catch((failure) => setError(errorMessage(failure)));
  }, []);
  return <SettingsPage title="Files & Storage" description="Manage authorized folders, knowledge libraries, and local storage.">
    <SettingsSection id="storage-directories" title="Authorized directories">
      {workspaces.length ? workspaces.map((workspace) => <div className="shortcut-row" key={workspace.id}><span>{workspace.name} · {workspace.root}</span><Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(workspace.id)}>Remove</Button></div>) : <p>No authorized directories.</p>}
      <Button size="sm" onClick={() => void choose()}>Add folder</Button>
    </SettingsSection>
    <KnowledgeSettings />
    <SettingsSection id="storage-usage" title="Local storage">
      {info ? <><p>{info.dataDir}</p>{info.areas.map((area) => <div className="shortcut-row" key={area.id}><span>{area.label}</span><span>{(area.bytes / 1024 / 1024).toFixed(2)} MB</span></div>)}<div className="row"><Button size="sm" onClick={() => void desktop().openStorageFolder().catch((failure) => setError(errorMessage(failure)))}>Open storage folder</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => setCleanup('media')}>Prune unused media</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => setCleanup('browser')}>Clear browser HTTP cache</Button></div></> : <p>Storage information is unavailable.</p>}
    </SettingsSection>
    {feedback && <p role="status">{feedback}</p>}{error && <p role="alert">{error}</p>}
    <SettingsDialog open={Boolean(cleanup)} onOpenChange={(open) => { if (!open) setCleanup(undefined); }} title={cleanup === 'media' ? 'Prune unused media?' : 'Clear browser HTTP cache?'} description={cleanup === 'media' ? 'Remove unreferenced local media files. Files referenced by saved conversations and drafts are retained.' : 'Remove cached web responses from the personal browser. Site data and history remain.'} confirmLabel={cleanup === 'media' ? 'Prune media' : 'Clear cache'} onConfirm={() => void clean()} />
  </SettingsPage>;
}
