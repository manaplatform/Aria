import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { communicationDimension, type CommunicationProposal, type MemoryRecord, type MemorySource } from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { selectChat } from '../../../stores/chatStore';
import { Button } from '../../ui';
import {
  SettingsDialog,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsTextarea,
} from '../components';

export default function CommunicationMemory({ learning }: { learning: boolean }) {
  const [memory, setMemory] = useState<{
    proposals: CommunicationProposal[];
    records: MemoryRecord[];
  }>();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<MemoryRecord>();
  const [deleting, setDeleting] = useState<MemoryRecord>();
  const [value, setValue] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    if (!window.aria?.communicationPreferences) return;
    let active = true;
    async function refresh() {
      try {
        const [memory, status] = await Promise.all([
          desktop().communicationPreferences(),
          desktop().memoryStatus(),
        ]);
        if (active) {
          setMemory(memory);
          setEnabled(status.settings.enabled);
        }
      } catch (error) {
        if (active) setError(errorMessage(error));
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      setMemory(await desktop().communicationPreferences());
      setEditing(undefined);
      setDeleting(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function openSource(source: CommunicationProposal['source']) {
    selectChat(source.conversationId);
    navigate('/chat', { state: { messageId: source.messageId } });
  }

  return (
    <SettingsSection
      id="persona-communication-memory"
      title="Communication memory"
      description="Review suggestions before Aria applies them across chats. Saved preferences use your Memory recall permissions."
    >
      <SettingsGroup>
        {!enabled && (
          <SettingsRow label="Persistent memory is off">
            <Button size="sm" onClick={() => navigate('/settings#memory')}>
              Memory settings
            </Button>
          </SettingsRow>
        )}
        {memory?.proposals.map((proposal) => (
          <SettingsRow
            key={proposal.id}
            label={proposal.dimension}
            description={<span dir="auto">{proposal.quote}</span>}
          >
            <div className="persona-controls">
              <Button size="sm" variant="ghost" onClick={() => openSource(proposal.source)}>
                Source
              </Button>
              <Button
                size="sm"
                disabled={busy || !learning || !enabled}
                onClick={() =>
                  void change(() => desktop().reviewCommunicationPreference(proposal.id, true))
                }
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void change(() => desktop().reviewCommunicationPreference(proposal.id, false))
                }
              >
                Dismiss
              </Button>
            </div>
          </SettingsRow>
        ))}
        {memory?.records.map((record) => {
          const source = record.sources.find((item): item is MemorySource => !('kind' in item));
          return (
            <SettingsRow
              key={record.id}
              label={communicationDimension(record.value.factKey) ?? 'Saved preference'}
              description={<span dir="auto">{record.value.content}</span>}
            >
              <div className="persona-controls">
                {source && (
                  <Button size="sm" variant="ghost" onClick={() => openSource(source)}>
                    Source
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setValue(record.value.content);
                    setEditing(record);
                  }}
                >
                  Correct
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDeleting(record)}
                >
                  Delete
                </Button>
              </div>
            </SettingsRow>
          );
        })}
        {memory && enabled && !memory.proposals.length && !memory.records.length && (
          <SettingsRow label="No communication preferences to review">{null}</SettingsRow>
        )}
      </SettingsGroup>
      {error && (
        <SettingsStatus tone="error" role="alert">
          {error}
        </SettingsStatus>
      )}
      {editing && (
        <SettingsDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
          title="Correct communication preference"
          description="The corrected wording is saved to Memory."
        >
          <SettingsTextarea
            label="Preference"
            value={value}
            maxLength={240}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button
            type="button"
            disabled={busy || !value.trim()}
            onClick={() =>
              void change(() =>
                desktop().editMemory({
                  id: editing.id,
                  revision: editing.revision,
                  value: { ...editing.value, content: value.trim() },
                }),
              )
            }
          >
            Save correction
          </Button>
        </SettingsDialog>
      )}
      {deleting && (
        <SettingsDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(undefined);
          }}
          title="Delete communication preference"
          description="This removes the saved preference from Memory."
        >
          <p dir="auto">{deleting.value.content}</p>
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={() =>
              void change(() =>
                desktop().deleteMemory({ id: deleting.id, revision: deleting.revision }),
              )
            }
          >
            Delete preference
          </Button>
        </SettingsDialog>
      )}
    </SettingsSection>
  );
}
