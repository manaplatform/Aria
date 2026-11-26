import { useEffect, useState } from 'react';
import type { OsPermissionsStatus } from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { flushPersistence, useWorkspaceStore } from '../../../stores/workspaceStore';
import { refreshProvider, useProviderStore } from '../../../stores/providerStore';
import { SettingsPage } from '../SettingsPage';
import { SettingsGroup, SettingsRow, SettingsSection, SettingsStatus } from '../components';
import { useSettingsNavigation } from '../SettingsContext';
import { Button } from '../../ui';

export default function PrivacySettings() {
  const { navigateCategory } = useSettingsNavigation();
  const registry = useProviderStore((state) => state.settings);
  const [permissions, setPermissions] = useState<OsPermissionsStatus>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const clearLegacy = async () => {
    setBusy(true); setError(''); setFeedback('');
    try {
      await flushPersistence();
      if (useWorkspaceStore.getState().saveError) throw new Error(useWorkspaceStore.getState().saveError!);
      if (await desktop().clearLegacyData()) {
        const state = useWorkspaceStore.getState();
        useWorkspaceStore.setState({ selectedConversationId: null, data: { ...state.data, conversations: [], tasks: [], plans: [] } });
        setFeedback('Local legacy data cleared.');
      }
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const clearChat = async () => {
    setBusy(true); setError(''); setFeedback('');
    try {
      await flushPersistence();
      if (useWorkspaceStore.getState().saveError) throw new Error(useWorkspaceStore.getState().saveError!);
      if (await desktop().clearChatHistory()) {
        const state = useWorkspaceStore.getState();
        useWorkspaceStore.setState({ data: { ...state.data, chat: { conversations: [], messages: [], selectedId: null, newDraft: '', newAttachments: [] } } });
        setFeedback('Chat history cleared.');
      }
    } catch (failure) {
      setError(errorMessage(failure));
      // A cleanup error may occur after history has already been saved as empty.
      const snapshot = await desktop().load().catch(() => null);
      if (snapshot) {
        const state = useWorkspaceStore.getState();
        useWorkspaceStore.setState({ data: { ...state.data, chat: snapshot.data.chat } });
      }
    } finally { setBusy(false); }
  };
  useEffect(() => {
    void refreshProvider();
    if (window.aria?.osPermissions) void desktop().osPermissions().then(setPermissions).catch((failure) => setError(errorMessage(failure)));
  }, []);
  return <SettingsPage title="Privacy & Security" description="Review Aria’s data and permission controls.">
    <SettingsSection id="privacy-security" title="Credentials and OS permissions"><SettingsGroup>
      <SettingsRow label="Credential storage" description="Provider keys are stored through the system credential store."><SettingsStatus tone={registry?.encryptionAvailable ? 'ready' : 'warning'}>{registry ? (registry.encryptionAvailable ? 'Available' : 'Unavailable') : 'Checking…'}</SettingsStatus></SettingsRow>
      <SettingsRow label="Microphone"><SettingsStatus>{permissions?.microphone ?? 'Unknown'}</SettingsStatus></SettingsRow>
      <SettingsRow label="Screen capture"><SettingsStatus>{permissions?.screen ?? 'Unknown'}</SettingsStatus></SettingsRow>
    </SettingsGroup></SettingsSection>
    <SettingsSection title="Approvals" description="Consequential actions and transfers require authorization through the trusted runtime."><p>Approvals can be declined, allowed once, or allowed for the current execution.</p></SettingsSection>
    <SettingsSection title="Data and permissions" description="Manage each source and its access in its settings page."><div className="row"><Button variant="secondary" onClick={() => navigateCategory('memory')}>Memory</Button><Button variant="secondary" onClick={() => navigateCategory('browser')}>Browser</Button><Button variant="secondary" onClick={() => navigateCategory('desktop')}>Desktop Control</Button></div></SettingsSection>
    <SettingsSection title="Chat history" description="Remove saved conversations and their local attachments. Memories and provider credentials are preserved."><Button variant="danger" disabled={busy} onClick={() => void clearChat()}>Clear chat history</Button></SettingsSection>
    <SettingsSection title="Local legacy workspace data" description="Remove local legacy drafts, tasks, and plans. Authorized folders, files, and external service data are preserved."><Button variant="danger" disabled={busy} onClick={() => void clearLegacy()}>Clear local legacy data</Button></SettingsSection>
    {feedback && <p role="status">{feedback}</p>}{error && <p role="alert">{error}</p>}
  </SettingsPage>;
}
