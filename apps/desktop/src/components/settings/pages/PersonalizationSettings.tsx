import { useEffect, useState } from 'react';
import { registryDraft } from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { useChatStore } from '../../../stores/chatStore';
import {
  installRegistrySettings,
  refreshProvider,
  useProviderStore,
} from '../../../stores/providerStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { Button } from '../../ui';
import PersonaControls from './PersonaControls';
import { SettingsPage } from '../SettingsPage';
import { useSettingsNavigation } from '../SettingsContext';
import {
  SettingsGroup,
  SettingsSection,
  SettingsSelect,
  SettingsStatus,
  SettingsTextarea,
  SettingsInput,
} from '../components';

export default function PersonalizationSettings() {
  const preferences = useWorkspaceStore((state) => state.data.preferences);
  const update = useWorkspaceStore((state) => state.preferences);
  const { settings, loading } = useProviderStore();
  const chatStatus = useChatStore((state) => state.status);
  const { highlightedSettingId } = useSettingsNavigation();

  const [name, setName] = useState(preferences.profileName);
  const [bio, setBio] = useState(preferences.profileBio ?? '');
  const [instructions, setInstructions] = useState(settings?.systemPrompt ?? '');
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();

  useEffect(() => {
    void refreshProvider();
  }, []);

  useEffect(() => {
    setName(preferences.profileName);
  }, [preferences.profileName]);

  useEffect(() => {
    setBio(preferences.profileBio ?? '');
  }, [preferences.profileBio]);

  useEffect(() => {
    if (settings) setInstructions(settings.systemPrompt);
  }, [settings]);

  const saveInstructions = async () => {
    if (!settings) return;
    setSaving(true);
    setFeedback(undefined);
    try {
      const next = await desktop().saveRegistry({
        ...registryDraft(settings),
        systemPrompt: instructions,
      });
      installRegistrySettings(next);
      setFeedback({ error: false, text: 'Custom instructions saved.' });
    } catch (failure) {
      setFeedback({ error: true, text: errorMessage(failure) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsPage
      title="Persona & Communication"
      description="Tailor how Aria communicates and remembers your personal context."
    >
      <PersonaControls />
      <SettingsSection
        id="personalization-profile"
        title="Personal profile"
        description="Shared with Aria’s primary model as non-privileged user context when chatting."
      >
        <SettingsGroup>
          <SettingsInput
            label="Display name"
            description="How Aria refers to you in conversation."
            value={name}
            maxLength={80}
            highlighted={highlightedSettingId === 'personalization-profile'}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => {
              const next = name.trim() || 'You';
              setName(next);
              update({ profileName: next });
            }}
          />
          <SettingsTextarea
            label="Personal bio (optional)"
            description="A short description of your background, role, or interests."
            placeholder="A little about you…"
            maxLength={160}
            value={bio}
            onChange={(event) => setBio(event.target.value)}
            onBlur={() => update({ profileBio: bio.trim() })}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Response Preferences"
        description="Applied directly on new ordinary chat turns."
      >
        <SettingsGroup>
          <SettingsSelect
            id="personalization-language"
            label="Preferred communication language"
            description="Choose a preferred response language or follow each message automatically."
            value={preferences.communicationLanguage ?? 'auto'}
            highlighted={highlightedSettingId === 'personalization-language'}
            onChange={(value) => update({ communicationLanguage: value })}
          >
            <option value="auto">Match conversation language (Auto)</option>
            <option value="English">English</option>
            <option value="Spanish">Spanish</option>
            <option value="French">French</option>
            <option value="German">German</option>
            <option value="Japanese">Japanese</option>
            <option value="Persian">Persian</option>
            <option value="Chinese">Chinese</option>
          </SettingsSelect>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="personalization-instructions"
        title="Custom Instructions"
        description="Persistent system instructions stored in your provider registry and sent to your primary model."
      >
        <SettingsGroup>
          <SettingsTextarea
            label="Instructions"
            placeholder="Add persistent guidelines, formatting preferences, or tone instructions…"
            maxLength={16000}
            value={instructions}
            disabled={!settings || saving}
            highlighted={highlightedSettingId === 'personalization-instructions'}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </SettingsGroup>
        <div className="settings-footer-bar">
          <Button
            type="button"
            variant="primary"
            disabled={!settings || loading || saving || chatStatus.state !== 'ready'}
            onClick={() => void saveInstructions()}
          >
            {saving ? 'Saving…' : 'Save instructions'}
          </Button>
          {settings && instructions === settings.systemPrompt && !feedback && (
            <SettingsStatus>Synced with primary configuration</SettingsStatus>
          )}
          {feedback && (
            <SettingsStatus
              tone={feedback.error ? 'error' : 'ready'}
              role={feedback.error ? 'alert' : 'status'}
            >
              {feedback.text}
            </SettingsStatus>
          )}
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}
