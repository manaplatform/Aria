import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LogLevel, ResetConfigurationScope } from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { flushPersistence, useWorkspaceStore } from '../../../stores/workspaceStore';
import { Button } from '../../ui';
import { RuntimeSettings } from '../RuntimeSettings';
import { SettingsPage } from '../SettingsPage';
import { SettingsGroup, SettingsSelect, SettingsSection } from '../components';

export default function AdvancedSettings() {
  const navigate = useNavigate();
  const level = useWorkspaceStore((state) => state.data.preferences.logLevel ?? 'info');
  const update = useWorkspaceStore((state) => state.preferences);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reset = async (scope: ResetConfigurationScope) => {
    setBusy(true); setError(''); setFeedback('');
    try {
      await flushPersistence();
      if (useWorkspaceStore.getState().saveError) throw new Error(useWorkspaceStore.getState().saveError!);
      if (await desktop().resetConfiguration(scope)) {
        if (scope === 'preferences') {
          const snapshot = await desktop().load();
          const current = useWorkspaceStore.getState();
          useWorkspaceStore.setState({ data: { ...current.data, preferences: snapshot.data.preferences } });
        }
        setFeedback('Settings reset.');
      }
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  return <SettingsPage title="Advanced" description="Configure execution, diagnostics, and the legacy workspace.">
    <RuntimeSettings />
    <SettingsSection title="Diagnostics">
      <SettingsGroup><SettingsSelect label="Diagnostic event level" value={level} onChange={(value) => update({ logLevel: value as LogLevel })}><option value="error">Errors</option><option value="warn">Warnings</option><option value="info">Information</option></SettingsSelect></SettingsGroup>
      <div className="row"><Button size="sm" onClick={() => { setError(''); setFeedback(''); void desktop().exportDiagnostics().then((saved) => { if (saved) setFeedback('Diagnostics exported.'); }).catch((failure) => setError(errorMessage(failure))); }}>Export diagnostics</Button><Button size="sm" variant="secondary" onClick={() => void desktop().openDevTools().catch((failure) => setError(errorMessage(failure)))}>Open developer tools</Button></div>
      {feedback && <p role="status">{feedback}</p>}{error && <p role="alert">{error}</p>}
    </SettingsSection>
    <SettingsSection title="Reset configuration" description="Reset UI preferences, web policy, or tool settings after confirmation. Provider credentials and conversations are preserved."><div className="row"><Button size="sm" variant="secondary" disabled={busy} onClick={() => void reset('preferences')}>Reset preferences</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void reset('web')}>Reset web settings</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void reset('tools')}>Reset tool settings</Button></div></SettingsSection>
    <SettingsSection title="Legacy workspace" description="Open previous projects, drafts, and workflows."><Button onClick={() => navigate('/advanced/home')}>Open legacy workspace</Button></SettingsSection>
  </SettingsPage>;
}
