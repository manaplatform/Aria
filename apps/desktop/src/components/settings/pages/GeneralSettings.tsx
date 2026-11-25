import { useEffect, useState } from 'react';
import { Laptop, Power, UserRound } from 'lucide-react';
import type { StartupBehavior, SystemBehaviorState } from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { SettingsPage } from '../SettingsPage';
import { useSettingsNavigation } from '../SettingsContext';
import {
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsStatus,
  SettingsToggle,
} from '../components';

export default function GeneralSettings() {
  const preferences = useWorkspaceStore((state) => state.data.preferences);
  const update = useWorkspaceStore((state) => state.preferences);
  const { highlightedSettingId } = useSettingsNavigation();
  const [name, setName] = useState(preferences.profileName);
  const [behavior, setBehavior] = useState<SystemBehaviorState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedNote, setSavedNote] = useState('');

  useEffect(() => {
    setName(preferences.profileName);
  }, [preferences.profileName]);

  useEffect(() => {
    if (!window.aria?.systemBehavior) return;
    let active = true;
    void desktop()
      .systemBehavior()
      .then((value) => {
        if (active) setBehavior(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const updateSystemBehavior = async (patch: { openAtLogin?: boolean; minimizeToTray?: boolean }) => {
    if (!window.aria?.setSystemBehavior) return;
    setBusy(true);
    setError('');
    setSavedNote('');
    try {
      const next = await desktop().setSystemBehavior(patch);
      setBehavior(next);
      if (patch.minimizeToTray !== undefined) {
        update({ minimizeToTray: next.minimizeToTray });
      }
      setSavedNote('Updated');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const commitName = () => {
    const value = name.trim() || 'You';
    setName(value);
    if (value !== preferences.profileName) {
      update({ profileName: value });
      setSavedNote('Updated');
    }
  };

  const initial = (name.trim() || preferences.profileName || 'A').charAt(0).toUpperCase();

  return (
    <SettingsPage
      title="General"
      description="Basic settings for your Aria experience on this device."
      actions={
        savedNote ? (
          <SettingsStatus tone="ready" role="status">
            {savedNote}
          </SettingsStatus>
        ) : undefined
      }
    >
      <SettingsSection title="Profile">
        <div className="settings-profile-card">
          <div className="settings-avatar-circle" aria-hidden="true">
            {initial || <UserRound size={22} />}
          </div>
          <div className="settings-profile-fields">
            <SettingsInput
              id="general-display-name"
              label="Display name"
              description="Your local display name shown in the sidebar and conversation labels. No account is required."
              value={name}
              maxLength={80}
              highlighted={highlightedSettingId === 'general-display-name'}
              onChange={(event) => {
                setName(event.target.value);
                setSavedNote('');
              }}
              onBlur={commitName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Language & Startup">
        <SettingsGroup>
          <SettingsRow
            id="general-language"
            label="Application language"
            description="Aria currently supports English (US). Additional interface translations are not yet bundled."
            highlighted={highlightedSettingId === 'general-language'}
          >
            <SettingsStatus tone="neutral">English (US)</SettingsStatus>
          </SettingsRow>
          <SettingsSelect
            id="general-startup"
            label="Startup behavior"
            description="Choose what opens when you launch Aria."
            value={preferences.startupBehavior ?? 'restore-last'}
            highlighted={highlightedSettingId === 'general-startup'}
            onChange={(value) => {
              update({ startupBehavior: value as StartupBehavior });
              setSavedNote('Updated');
            }}
          >
            <option value="restore-last">Restore last conversation</option>
            <option value="new-chat">Start with a new chat</option>
          </SettingsSelect>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Desktop Integration"
        description="System startup and background window behavior."
      >
        <SettingsGroup>
          <SettingsToggle
            id="general-open-at-login"
            label="Launch at system startup"
            description={
              behavior?.loginReason ??
              'Automatically launch Aria when you sign in to your computer.'
            }
            checked={Boolean(behavior?.openAtLogin)}
            disabled={busy || !behavior?.loginSupported}
            highlighted={highlightedSettingId === 'general-open-at-login'}
            onChange={(openAtLogin) => void updateSystemBehavior({ openAtLogin })}
          />
          <SettingsToggle
            id="general-tray"
            label="Minimize to system tray"
            description={
              behavior?.traySupported
                ? 'Keep Aria accessible from the system tray instead of quitting when closing the window.'
                : 'Tray support requires the Aria desktop application.'
            }
            checked={Boolean(behavior?.minimizeToTray ?? preferences.minimizeToTray)}
            disabled={busy || !behavior?.traySupported}
            highlighted={highlightedSettingId === 'general-tray'}
            onChange={(minimizeToTray) => void updateSystemBehavior({ minimizeToTray })}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Default Application Behavior">
        <SettingsGroup>
          <SettingsRow
            label="Message sending"
            description="Enter sends your message; Shift + Enter inserts a new line."
          >
            <SettingsStatus>
              <Laptop size={12} /> Desktop default
            </SettingsStatus>
          </SettingsRow>
          <SettingsRow
            label="Local data ownership"
            description="Conversations, drafts, and preferences are saved locally on this device."
          >
            <SettingsStatus tone="ready">
              <Power size={12} /> Local-first
            </SettingsStatus>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      {error && (
        <p className="chat-response-error" role="alert">
          {error}
        </p>
      )}
    </SettingsPage>
  );
}
