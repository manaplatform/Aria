import { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { defaultNotificationPreferences, type OsPermissionsStatus } from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { SettingsPage } from '../SettingsPage';
import { useSettingsNavigation } from '../SettingsContext';
import {
  SettingsAction,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggle,
} from '../components';

export default function NotificationSettings() {
  const notifications = useWorkspaceStore(
    (state) => state.data.preferences.notifications ?? defaultNotificationPreferences,
  );
  const update = useWorkspaceStore((state) => state.preferences);
  const { highlightedSettingId } = useSettingsNavigation();
  const [osStatus, setOsStatus] = useState<OsPermissionsStatus>();
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();

  useEffect(() => {
    if (!window.aria?.osPermissions) return;
    let active = true;
    void desktop()
      .osPermissions()
      .then((value) => {
        if (active) setOsStatus(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const patch = (next: Partial<typeof notifications>) => {
    update({ notifications: { ...notifications, ...next } });
    setFeedback(undefined);
  };

  const supported = osStatus?.notificationsSupported === true;

  return (
    <SettingsPage
      title="Notifications"
      description="Control desktop alerts when Aria finishes responses or needs approval in the background."
    >
      <SettingsSection title="Desktop Alerts">
        <SettingsGroup>
          <SettingsRow
            label="Operating system support"
            description="Native notifications only trigger while Aria’s window is unfocused or minimized."
          >
            <SettingsStatus tone={supported ? 'ready' : 'warning'}>
              {osStatus ? (supported ? 'Supported' : 'Unavailable') : 'Checking…'}
            </SettingsStatus>
          </SettingsRow>
          <SettingsToggle
            id="notifications-enabled"
            label="Desktop notifications"
            description="Allow Aria to send native OS notifications when working in the background."
            checked={notifications.enabled}
            disabled={!supported}
            highlighted={highlightedSettingId === 'notifications-enabled'}
            onChange={(enabled) => patch({ enabled })}
          />
          <SettingsToggle
            id="notifications-task"
            label="Task completion notifications"
            description="Notify when a response completes while Aria is unfocused."
            checked={notifications.taskCompletion}
            disabled={!supported || !notifications.enabled}
            highlighted={highlightedSettingId === 'notifications-task'}
            onChange={(taskCompletion) => patch({ taskCompletion })}
          />
          <SettingsToggle
            id="notifications-background"
            label="Background execution notifications"
            description="Notify when Conductor pauses for approval or encounters an error."
            checked={notifications.backgroundExecution}
            disabled={!supported || !notifications.enabled}
            highlighted={highlightedSettingId === 'notifications-background'}
            onChange={(backgroundExecution) => patch({ backgroundExecution })}
          />
          <SettingsToggle
            id="notifications-sound"
            label="Notification sounds"
            description="Play the system alert sound alongside desktop notifications."
            checked={notifications.sound}
            disabled={!supported || !notifications.enabled}
            highlighted={highlightedSettingId === 'notifications-sound'}
            onChange={(sound) => patch({ sound })}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Verification">
        <SettingsGroup>
          <SettingsAction
            label="Test desktop notification"
            description="Send a sample notification to confirm operating system permission."
            actionLabel="Send test notification"
            disabled={!supported}
            icon={<BellRing size={14} />}
            onClick={() => {
              setFeedback(undefined);
              void desktop()
                .testNotification()
                .then(() => setFeedback({ error: false, text: 'Test notification sent.' }))
                .catch((failure) => setFeedback({ error: true, text: errorMessage(failure) }));
            }}
          />
        </SettingsGroup>
        {feedback && (
          <p
            className={feedback.error ? 'chat-response-error' : 'settings-inline-note'}
            role={feedback.error ? 'alert' : 'status'}
          >
            {feedback.text}
          </p>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
