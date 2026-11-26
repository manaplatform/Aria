import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  customizableShortcutIds,
  detectShortcutConflict,
  eventToShortcutChord,
  formatShortcutChord,
  resolveShortcuts,
  type CustomizableShortcutId,
} from '@aria/shared';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { Button } from '../../ui';
import { SettingsPage } from '../SettingsPage';
import { useSettingsNavigation } from '../SettingsContext';
import {
  SettingsDialog,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from '../components';

const shortcutDescriptions: Record<CustomizableShortcutId, { label: string; description: string }> = {
  newChat: { label: 'New chat', description: 'Start a fresh conversation' },
  searchConversations: { label: 'Search conversations', description: 'Open the conversation search panel' },
  focusComposer: { label: 'Focus composer', description: 'Move focus to the message input' },
  openSettings: { label: 'Open settings', description: 'Navigate to the Settings page' },
  toggleSidebar: { label: 'Toggle sidebar', description: 'Show or hide the main navigation sidebar' },
  toggleBrowser: { label: 'Toggle browser', description: 'Show or hide the integrated browser panel' },
};

const FIXED_SHORTCUTS: { label: string; chord: string }[] = [
  { label: 'Send message', chord: 'Enter' },
  { label: 'Insert new line', chord: 'Shift+Enter' },
  { label: 'Close dialog', chord: 'Escape' },
  { label: 'Copy', chord: 'Mod+C' },
  { label: 'Paste', chord: 'Mod+V' },
  { label: 'Cut', chord: 'Mod+X' },
  { label: 'Select all', chord: 'Mod+A' },
];

export default function ShortcutSettings() {
  const { highlightedSettingId } = useSettingsNavigation();
  const preferences = useWorkspaceStore((state) => state.data.preferences);
  const update = useWorkspaceStore((state) => state.preferences);

  const shortcuts = useMemo(() => preferences.shortcuts ?? {}, [preferences.shortcuts]);
  const resolved = resolveShortcuts(shortcuts);

  const [recording, setRecording] = useState<CustomizableShortcutId | null>(null);
  const [recordedChord, setRecordedChord] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const recordRef = useRef<HTMLButtonElement | null>(null);

  const startRecording = useCallback((id: CustomizableShortcutId) => {
    setRecording(id);
    setRecordedChord(null);
    setConflict(null);
  }, []);

  const cancelRecording = useCallback(() => {
    setRecording(null);
    setRecordedChord(null);
    setConflict(null);
  }, []);

  const saveRecorded = useCallback(() => {
    if (!recording || !recordedChord) return;
    update({ shortcuts: { ...shortcuts, [recording]: recordedChord } });
    setRecording(null);
    setRecordedChord(null);
    setConflict(null);
  }, [recording, recordedChord, shortcuts, update]);

  const clearShortcut = useCallback(
    (id: CustomizableShortcutId) => {
      const next = { ...shortcuts };
      delete next[id];
      update({ shortcuts: next });
    },
    [shortcuts, update],
  );

  useEffect(() => {
    if (!recording) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelRecording();
        return;
      }
      // Don't record modifier-only presses
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const chord = eventToShortcutChord(event, window.aria?.platform);
      if (!chord) return;
      setRecordedChord(chord);
      const { conflictWith } = detectShortcutConflict(recording, chord, resolved);
      setConflict(conflictWith ? `Conflicts with "${conflictWith}"` : null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recording, resolved, cancelRecording]);

  return (
    <SettingsPage title="Keyboard Shortcuts" description="Customize keyboard shortcuts for common Aria actions.">
      <SettingsSection
        title="Customizable Shortcuts"
        description="Press a key combination to record a new shortcut. Press Escape to cancel."
      >
        <SettingsGroup>
          {customizableShortcutIds.map((id) => {
            const { label, description } = shortcutDescriptions[id];
            const current = resolved[id];
            const isRecording = recording === id;

            return (
              <SettingsRow
                key={id}
                id={`shortcut-${id}`}
                label={label}
                description={description}
                highlighted={highlightedSettingId === `shortcut-${id}`}
              >
                <div className="flex items-center gap-2">
                  {isRecording ? (
                    <>
                      <div className="flex min-w-[120px] items-center justify-center rounded-md border border-primary bg-primary/5 px-3 py-1 text-sm">
                        {recordedChord ? (
                          <kbd className="font-mono text-primary">{formatShortcutChord(recordedChord)}</kbd>
                        ) : (
                          <span className="animate-pulse text-muted-foreground">Press keys…</span>
                        )}
                      </div>
                      {conflict && (
                        <span className="text-xs text-destructive">{conflict}</span>
                      )}
                      {recordedChord && !conflict && (
                        <Button size="sm" onClick={saveRecorded}>
                          Save
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={cancelRecording}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      {current ? (
                        <kbd className="rounded bg-muted px-2 py-0.5 text-sm font-mono">
                          {formatShortcutChord(current)}
                        </kbd>
                      ) : (
                        <span className="text-sm text-muted-foreground">Not set</span>
                      )}
                      <Button
                        ref={id === recording ? recordRef : undefined}
                        variant="ghost"
                        size="sm"
                        onClick={() => startRecording(id)}
                      >
                        {current ? 'Change' : 'Set'}
                      </Button>
                      {current && shortcuts[id] && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => clearShortcut(id)}
                        >
                          Reset
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </SettingsRow>
            );
          })}
        </SettingsGroup>

        <div className="flex justify-end pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRestoreOpen(true)}
          >
            <RotateCcw size={14} />
            Restore defaults
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Fixed Shortcuts"
        description="These shortcuts are built into Aria and cannot be changed."
      >
        <SettingsGroup>
          {FIXED_SHORTCUTS.map(({ label, chord }) => (
            <SettingsRow key={label} label={label}>
              <kbd className="rounded bg-muted px-2 py-0.5 text-sm font-mono">
                {chord}
              </kbd>
            </SettingsRow>
          ))}
        </SettingsGroup>
      </SettingsSection>

      {restoreOpen && (
        <SettingsDialog
          title="Restore default shortcuts?"
          description="All custom key bindings will be removed and default shortcuts will be restored."
          confirmLabel="Restore defaults"
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          variant="primary"
          onConfirm={() => {
            setRestoreOpen(false);
            update({ shortcuts: {} });
          }}
        />
      )}
    </SettingsPage>
  );
}
