import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  memoryCategories,
  modelReference,
  type MemoryDiagnostics,
  type MemoryRecord,
  type MemorySearch,
  type MemorySearchResult,
  type MemorySettings as Settings,
  type MemoryStatus,
} from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { selectChat } from '../../../stores/chatStore';
import { refreshProvider, useProviderStore } from '../../../stores/providerStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { Button, Field } from '../../ui';
import { SettingsPage } from '../SettingsPage';
import { useSettingsNavigation } from '../SettingsContext';
import {
  SettingsDialog,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsStatus,
  SettingsToggle,
} from '../components';

const labels = {
  episode: 'Episodes',
  fact: 'Facts',
  preference: 'Preferences',
  procedure: 'Procedures',
  project: 'Project knowledge',
  task: 'Pending work',
};

export default function MemorySettings() {
  const [status, setStatus] = useState<MemoryStatus>();
  const [settings, setSettings] = useState<Settings>();
  const [filter, setFilter] = useState<MemorySearch>({});
  const [result, setResult] = useState<MemorySearchResult>();
  const [selected, setSelected] = useState<MemoryRecord>();
  const [feedback, setFeedback] = useState('');
  const [failure, setFailure] = useState('');
  const [diagnostics, setDiagnostics] = useState<MemoryDiagnostics>();
  const [busy, setBusy] = useState(false);
  const [allowAutoRecall, setAllowAutoRecall] = useState<boolean>();
  const [confirmDelete, setConfirmDelete] = useState<string>();
  const [confirmClearModal, setConfirmClearModal] = useState(false);

  const projects = useWorkspaceStore((state) => state.data.workspaces);
  const conversations = useWorkspaceStore((state) => state.data.chat.conversations);
  const registry = useProviderStore((state) => state.settings);
  const navigate = useNavigate();
  const { highlightedSettingId, navigateCategory } = useSettingsNavigation();

  useEffect(() => {
    void refreshProvider();
  }, []);

  const remote = (registry?.connections ?? [])
    .filter(
      (connection) =>
        connection.keyConfigured &&
        !connection.locked &&
        connection.baseUrl.startsWith('https://'),
    )
    .flatMap((connection) =>
      connection.models
        .filter((model) => model.enabled && model.declared.includes('embeddings'))
        .map((model) => ({
          key: modelReference(connection.id, model.id),
          label: `${connection.name} · ${model.id}`,
          target: { mode: 'remote' as const, connectionId: connection.id, model: model.id },
        })),
    );

  useEffect(() => {
    if (!window.aria?.memoryStatus) return;
    let active = true;
    void Promise.all([desktop().memoryStatus(), desktop().searchMemories({})])
      .then(([state, records]) => {
        if (!active) return;
        setStatus(state);
        setSettings(state.settings);
        setResult(records);
      })
      .catch((error) => {
        if (active) setFailure(errorMessage(error));
      });
    const timer = setInterval(() => {
      void desktop()
        .memoryStatus()
        .then((state) => {
          if (active) {
            setStatus(state);
            setSettings((current) => current ?? state.settings);
          }
        })
        .catch(() => undefined);
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  if (!window.aria?.memoryStatus) {
    return (
      <SettingsPage
        title="Memory"
        description="Saved memories help Aria carry confirmed preferences and context across chats."
      >
        <p className="settings-inline-note">
          Persistent memory requires the Aria desktop application.
        </p>
      </SettingsPage>
    );
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure('');
    setFeedback('');
    try {
      await action();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const refresh = async () => setResult(await desktop().searchMemories(filter));

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    void run(async () => {
      const next = await desktop().saveMemorySettings(settings, allowAutoRecall);
      setStatus(next);
      setSettings(next.settings);
      setAllowAutoRecall(Boolean(next.settings.recallConsent));
      window.dispatchEvent(new Event('aria:memory-settings'));
      setFeedback('Memory settings saved.');
    });
  };

  const embeddingId =
    settings?.embedding.mode === 'remote'
      ? modelReference(settings.embedding.connectionId, settings.embedding.model)
      : settings?.embedding.mode;

  const selectedSource = (record: MemoryRecord): ReactNode => {
    const source = record.sources.at(-1);
    if (source && 'kind' in source)
      return <Button variant="ghost" size="sm" onClick={() => navigate('/agenda/jobs/' + source.jobId)}>Open job</Button>;
    const conversation = source && conversations.find(({ id }) => id === source.conversationId);
    return conversation ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          selectChat(conversation.id);
          navigate('/chat', { state: { messageId: source?.messageId } });
        }}
      >
        {conversation.title}
      </Button>
    ) : (
      <span className="muted">Source unavailable</span>
    );
  };

  return (
    <SettingsPage
      title="Memory"
      description="Saved memories can help Aria carry decisions and preferences across chats. Chat history has separate controls."
      actions={
        status && (
          <SettingsStatus tone={status.state === 'unavailable' ? 'error' : 'ready'} role="status">
            {status.state === 'unavailable'
              ? 'Unavailable'
              : `${status.records} active · ${status.pending} queued · ${status.failures} failed`}
          </SettingsStatus>
        )
      }
    >
      {settings && (
        <SettingsSection id="memory-preferences" title="Memory Preferences">
          <form onSubmit={save}>
            <SettingsGroup>
              <SettingsToggle
                label="Enable persistent memory"
                description="Allow Aria to remember facts, preferences, and procedures across conversations."
                checked={settings.enabled}
                highlighted={highlightedSettingId === 'memory-preferences'}
                onChange={(enabled) => setSettings({ ...settings, enabled })}
              />
              {settings.enabled && (
                <SettingsToggle
                  label="Allow automatic memory recall with the configured primary model"
                  description="Surface low-latency confirmed context hints without prompting on each chat."
                  checked={allowAutoRecall ?? Boolean(settings.recallConsent)}
                  onChange={(checked) => setAllowAutoRecall(checked)}
                />
              )}
              <SettingsToggle
                label="Allow temporary chats"
                description="Allow opening ephemeral conversations that stay outside memory and saved history."
                checked={settings.temporaryChats}
                onChange={(temporaryChats) => setSettings({ ...settings, temporaryChats })}
              />
              <SettingsToggle
                label="Show follow-up suggestions"
                description="Display suggested follow-up prompts at the end of assistant replies."
                checked={settings.suggestions}
                onChange={(suggestions) => setSettings({ ...settings, suggestions })}
              />
              <SettingsSelect
                label="Memory retention"
                description="Automatically expire memories older than the selected window."
                value={settings.retentionDays ? String(settings.retentionDays) : ''}
                onChange={(value) =>
                  setSettings({
                    ...settings,
                    retentionDays: value ? Number(value) : null,
                  })
                }
              >
                <option value="">Until deleted</option>
                {[30, 90, 180, 365].map((days) => (
                  <option key={days} value={days}>
                    {days} days
                  </option>
                ))}
              </SettingsSelect>
              <SettingsSelect
                label="Memory embeddings"
                description="Install the local embedding pack under Files & Storage. Remote searches require approval before text is sent."
                value={embeddingId ?? 'lexical'}
                onChange={(value) => {
                  const embedding = remote.find(({ key }) => key === value)?.target ?? {
                    mode: value === 'local' ? ('local' as const) : ('lexical' as const),
                  };
                  setSettings({ ...settings, embedding });
                }}
              >
                <option value="lexical">Lexical search</option>
                <option value="local">Verified local embedding pack</option>
                {remote.map(({ key, label }) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
                {settings.embedding.mode === 'remote' &&
                  !remote.some(({ key }) => key === embeddingId) && (
                    <option value={embeddingId} disabled>
                      Saved remote model (unavailable)
                    </option>
                  )}
              </SettingsSelect>
            </SettingsGroup>
            <div className="settings-footer-bar">
              <Button variant="primary" size="sm" type="submit" disabled={busy}>
                Save memory settings
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => navigateCategory('storage', 'knowledge')}
              >
                Manage local embedding pack
              </Button>
            </div>
          </form>
        </SettingsSection>
      )}

      <SettingsSection
        id="memory-records"
        title="Stored Memories"
        description="Search, edit, export, or remove remembered items across profile, conversation, and project scopes."
      >
        <form
          className="memory-search"
          onSubmit={(event) => {
            event.preventDefault();
            void run(refresh);
          }}
        >
          <Field label="Search memories">
            <input
              type="search"
              maxLength={400}
              value={filter.query ?? ''}
              onChange={(event) => setFilter({ ...filter, query: event.target.value || undefined })}
            />
          </Field>
          <Field label="Category">
            <select
              value={filter.category ?? ''}
              onChange={(event) =>
                setFilter({
                  ...filter,
                  category: (event.target.value || undefined) as MemorySearch['category'],
                })
              }
            >
              <option value="">All categories</option>
              {memoryCategories.map((category) => (
                <option key={category} value={category}>
                  {labels[category]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scope">
            <select
              value={filter.projectId ?? filter.scope ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                setFilter({
                  ...filter,
                  scope: value === 'profile' || value === 'conversation' ? value : undefined,
                  projectId: projects.some(({ id }) => id === value) ? value : undefined,
                });
              }}
            >
              <option value="">All scopes</option>
              <option value="profile">Profile</option>
              <option value="conversation">Conversation</option>
              {projects.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Button size="sm" type="submit" disabled={busy}>
            Search
          </Button>
        </form>

        {result?.records.map((record) => (
          <article className="memory-entry" key={record.id}>
            <div className="memory-entry-meta">
              {labels[record.value.category]} · {record.scope.kind} · {record.confirmation} ·{' '}
              {new Date(record.observedAt).toLocaleDateString()}
            </div>
            {selected?.id === record.id ? (
              <form
                className="memory-settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const { id, revision, value } = selected;
                    await desktop().editMemory({ id, revision, value });
                    setSelected(undefined);
                    await refresh();
                    setFeedback('Memory updated.');
                  });
                }}
              >
                <Field label="Memory content">
                  <textarea
                    required
                    maxLength={1400}
                    value={selected.value.content}
                    onChange={(event) =>
                      setSelected({
                        ...selected,
                        value: { ...selected.value, content: event.target.value },
                      })
                    }
                  />
                </Field>
                {selected.value.category === 'task' && (
                  <Field label="Task state">
                    <select
                      value={selected.value.taskState ?? 'pending'}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          value: {
                            ...selected.value,
                            taskState: event.target.value as NonNullable<
                              MemoryRecord['value']['taskState']
                            >,
                          },
                        })
                      }
                    >
                      {[
                        'pending',
                        'in-progress',
                        'waiting',
                        'completed',
                        'cancelled',
                        'expired',
                      ].map((state) => (
                        <option key={state} value={state}>
                          {state.replace('-', ' ')}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <div className="row">
                  <Button size="sm" type="submit" disabled={busy}>
                    Save correction
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setSelected(undefined)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <p>{record.value.content}</p>
            )}
            <div className="row">
              {selectedSource(record)}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setSelected(record)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (confirmDelete !== record.id) {
                    setConfirmDelete(record.id);
                    return;
                  }
                  void run(async () => {
                    await desktop().deleteMemory({ id: record.id, revision: record.revision });
                    setConfirmDelete(undefined);
                    await refresh();
                    setFeedback('Memory deleted.');
                  });
                }}
              >
                {confirmDelete === record.id ? 'Confirm delete' : 'Delete'}
              </Button>
              {confirmDelete === record.id && (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(undefined)}>
                  Cancel
                </Button>
              )}
            </div>
          </article>
        ))}

        {result && !result.records.length && (
          <p className="settings-inline-note">No matching memories.</p>
        )}

        <div className="row memory-footer">
          {result?.cursor && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setResult(await desktop().searchMemories({ ...filter, cursor: result.cursor }));
                })
              }
            >
              Next page
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (await desktop().exportMemories()) setFeedback('Memory export saved.');
              })
            }
          >
            Export memories
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            onClick={() => setConfirmClearModal(true)}
          >
            {filter.category || filter.projectId
              ? 'Clear selected category or project'
              : 'Clear all memories'}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Storage Statistics & Diagnostics">
        <details
          onToggle={(event) => {
            if (event.currentTarget.open)
              void desktop()
                .memoryDiagnostics()
                .then(setDiagnostics)
                .catch((error) => setFailure(errorMessage(error)));
          }}
        >
          <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
            View memory diagnostics
          </summary>
          {diagnostics && (
            <SettingsGroup inset className="mt-3">
              <SettingsRow label="Retrieval cache">
                <span>
                  {diagnostics.hits} hits · {diagnostics.searches} searches
                </span>
              </SettingsRow>
              <SettingsRow label="Examined candidates">
                <span>{diagnostics.candidates}</span>
              </SettingsRow>
              <SettingsRow label="Index and journal">
                <span>
                  {Math.ceil((diagnostics.databaseBytes + diagnostics.walBytes) / 1024)} KiB
                </span>
              </SettingsRow>
              <SettingsRow label="Worker heap">
                <span>{Math.ceil(diagnostics.workerHeapBytes / 1024)} KiB</span>
              </SettingsRow>
              <SettingsRow label="Embedding requests">
                <span>{diagnostics.embeddingRequests}</span>
              </SettingsRow>
              <SettingsRow label="Duplicate records merged">
                <span>{diagnostics.duplicates}</span>
              </SettingsRow>
            </SettingsGroup>
          )}
        </details>
      </SettingsSection>

      {feedback && (
        <p className="settings-inline-note" role="status">
          {feedback}
        </p>
      )}
      {failure && (
        <p className="chat-response-error" role="alert">
          {failure}
        </p>
      )}

      <SettingsDialog
        open={confirmClearModal}
        onOpenChange={setConfirmClearModal}
        title={
          filter.category || filter.projectId
            ? 'Clear filtered memories?'
            : 'Clear all stored memories?'
        }
        description="Deleted memories cannot be rebuilt automatically from past chat history."
        confirmLabel="Continue"
        busy={busy}
        onConfirm={() => {
          setConfirmClearModal(false);
          void run(async () => {
            const count = await desktop().clearMemories({
              category: filter.category,
              projectId: filter.projectId,
            });
            if (count) {
              await refresh();
              setFeedback(`${count} memories deleted.`);
            }
          });
        }}
      />
    </SettingsPage>
  );
}
