import { useEffect, useRef, useState } from 'react';
import { Check, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  officialOpenAI,
  registryDraft,
  type ConnectionInput,
  type DiscoveredModel,
  type RegistrySettings,
} from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { useChatStore } from '../../../stores/chatStore';
import {
  beginCatalogRequest,
  cancelCatalogRequest,
  isCurrentCatalogRequest,
  installRegistrySettings,
  refreshProvider,
  setConnectionCatalog,
  useProviderStore,
  type CatalogState,
} from '../../../stores/providerStore';
import { Button, Field } from '../../ui';
import { SettingsPage } from '../SettingsPage';
import { useSettingsNavigation } from '../SettingsContext';
import {
  SettingsDialog,
  SettingsSection,
  SettingsStatus,
} from '../components';

function includeDiscoveredEmbeddings(
  model: ConnectionInput['models'][number],
  descriptor?: DiscoveredModel,
): ConnectionInput['models'][number] {
  if (!descriptor?.capabilities.includes('embeddings') || model.declared.includes('embeddings'))
    return model;
  return { ...model, declared: [...model.declared, 'embeddings'] };
}

export default function ProviderSettings() {
  const { settings, loading, error, catalogs } = useProviderStore();
  const { highlightedSettingId, navigateCategory } = useSettingsNavigation();
  useEffect(() => {
    void refreshProvider();
  }, []);

  return (
    <SettingsPage
      title="AI Providers"
      description="Connect OpenAI or compatible API endpoints. API keys are encrypted by your system credential store."
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={() => navigateCategory('models')}>
          Configure models
        </Button>
      }
    >
      {settings ? (
        <ProvidersEditor
          key={settings.revision}
          settings={settings}
          catalogs={catalogs}
          highlighted={highlightedSettingId === 'providers-connections'}
          onSaved={installRegistrySettings}
        />
      ) : loading ? (
        <p role="status" className="settings-inline-note">
          Loading provider connections…
        </p>
      ) : (
        <Button size="sm" onClick={() => void refreshProvider(true)}>
          Load provider settings
        </Button>
      )}
      {error && (
        <p className="chat-response-error" role="alert">
          {error}
        </p>
      )}
    </SettingsPage>
  );
}

function ProvidersEditor({
  settings,
  catalogs,
  highlighted,
  onSaved,
}: {
  settings: RegistrySettings;
  catalogs: Record<string, CatalogState>;
  highlighted: boolean;
  onSaved: (next: RegistrySettings) => void;
}) {
  const [draft, setDraft] = useState(() => registryDraft(settings));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const revisions = useRef(new Map<string, number>());
  const chatStatus = useChatStore((state) => state.status);
  useEffect(() => {
    const owned = revisions.current;
    return () => { for (const [id, revision] of owned) cancelCatalogRequest(id, revision); };
  }, []);

  const editConnection = (connection: ConnectionInput, invalidate = false) => {
    if (invalidate) {
      setConnectionCatalog(connection.id, null);
    }
    setDraft((current) => ({
      ...current,
      connections: current.connections.map((item) =>
        item.id === connection.id ? connection : item,
      ),
    }));
  };

  const testConnection = async (connection: ConnectionInput) => {
    const revision = beginCatalogRequest(connection.id);
    revisions.current.set(connection.id, revision);
    setConnectionCatalog(connection.id, { busy: true, error: undefined });
    try {
      const models = await desktop().discoverModels(connection);
      if (isCurrentCatalogRequest(connection.id, revision)) {
        const descriptors = new Map(models.map((item) => [item.id, item]));
        setDraft((current) => ({
          ...current,
          connections: current.connections.map((item) =>
            item.id === connection.id
              ? {
                  ...item,
                  models: item.models.map((model) =>
                    includeDiscoveredEmbeddings(model, descriptors.get(model.id)),
                  ),
                }
              : item,
          ),
        }));
        setConnectionCatalog(connection.id, { models, busy: false, error: undefined });
      }
    } catch (failure) {
      if (isCurrentCatalogRequest(connection.id, revision)) {
        setConnectionCatalog(connection.id, {
          models: undefined,
          busy: false,
          error: errorMessage(failure),
        });
      }
    }
  };

  const apply = async (action: () => Promise<RegistrySettings>, message?: string) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      onSaved(await action());
      if (message) setFeedback({ error: false, text: message });
    } catch (failure) {
      setFeedback({ error: true, text: errorMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  const savedFor = (id: string) => settings.connections.find((item) => item.id === id);
  const anyCatalogBusy = Object.values(catalogs).some((catalog) => catalog.busy);
  const removingConnection = draft.connections.find((c) => c.id === removingId);

  return (
    <SettingsSection
      id="providers-connections"
      title="Connected Providers"
      description="Add an OpenAI or OpenAI-compatible HTTP endpoint, test connectivity, and save encrypted credentials."
    >
      <div
        className="registry-actions"
        data-highlighted={highlighted ? 'true' : undefined}
        style={{ marginBottom: 14 }}
      >
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || draft.connections.length >= 12}
          onClick={() =>
            setDraft((current) => ({
              ...current,
              connections: [
                ...current.connections,
                {
                  id: crypto.randomUUID(),
                  name: current.connections.length ? 'Compatible endpoint' : 'OpenAI',
                  baseUrl: officialOpenAI,
                  webSearch: false,
                  models: [],
                },
              ],
            }))
          }
        >
          <Plus size={15} /> Add connection
        </Button>
        {settings.environmentImportAvailable && (
          <Button
            id="providers-actions"
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy || anyCatalogBusy}
            onClick={() =>
              void apply(
                () => desktop().importRegistryEnvironment(),
                'Environment settings imported.',
              )
            }
          >
            Import environment settings
          </Button>
        )}
      </div>

      {!settings.encryptionAvailable && (
        <p className="settings-inline-note" role="status">
          Unlock the system credential store to save new API keys.
        </p>
      )}

      {draft.connections.length === 0 ? (
        <p className="settings-inline-note">
          No AI providers configured yet. Add a connection above to discover and enable models.
        </p>
      ) : (
        <div className="registry-editor">
          {draft.connections.map((connection) => {
            const catalog = catalogs[connection.id] ?? {};
            const saved = savedFor(connection.id);
            const statusText = catalog.models
              ? 'Connected'
              : catalog.error
                ? 'Connection error'
                : saved?.locked
                  ? 'Credential locked'
                  : saved?.keyConfigured
                    ? 'Key saved'
                    : 'Set up connection';
            const statusTone = catalog.models
              ? 'ready'
              : catalog.error || saved?.locked
                ? 'error'
                : saved?.keyConfigured
                  ? 'accent'
                  : 'neutral';

            return (
              <div key={connection.id} id={`settings-provider-${connection.id}`} className="registry-connection">
                <div className="registry-connection-heading">
                  <strong>{connection.name || 'Connection'}</strong>
                  <SettingsStatus tone={statusTone} role="status">
                    {statusText}
                  </SettingsStatus>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${connection.name}`}
                    disabled={busy}
                    onClick={() => setRemovingId(connection.id)}
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>

                <div className="registry-settings-grid">
                  <Field label="Connection name">
                    <input
                      value={connection.name}
                      maxLength={100}
                      disabled={busy}
                      onChange={(event) =>
                        editConnection({ ...connection, name: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Provider endpoint">
                    <input
                      value={connection.baseUrl}
                      maxLength={2000}
                      disabled={busy}
                      onChange={(event) =>
                        editConnection(
                          { ...connection, baseUrl: event.target.value, webSearch: false },
                          true,
                        )
                      }
                    />
                  </Field>
                  <Field label="API key">
                    <input
                      type="password"
                      autoComplete="off"
                      value={connection.apiKey ?? ''}
                      maxLength={16000}
                      disabled={busy}
                      placeholder={
                        saved?.keyConfigured
                          ? 'Saved in system credential store'
                          : 'Enter an API key'
                      }
                      onChange={(event) =>
                        editConnection(
                          { ...connection, apiKey: event.target.value, removeKey: false },
                          true,
                        )
                      }
                    />
                  </Field>
                </div>

                <div className="registry-actions">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || catalog.busy}
                    onClick={() => void testConnection(connection)}
                  >
                    <RefreshCw size={14} className={catalog.busy ? 'spin' : ''} />{' '}
                    {catalog.busy ? 'Contacting provider…' : 'Discover models'}
                  </Button>
                  {catalog.models && (
                    <span className="settings-inline-note" style={{ marginTop: 0 }}>
                      {catalog.models.length} model{catalog.models.length === 1 ? '' : 's'} discovered
                    </span>
                  )}
                  {saved?.keyConfigured && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        editConnection(
                          { ...connection, apiKey: '', removeKey: !connection.removeKey },
                          true,
                        )
                      }
                    >
                      {connection.removeKey ? 'Keep saved key' : 'Remove saved key'}
                    </Button>
                  )}
                </div>

                {catalog.error && (
                  <p className="chat-response-error" role="alert">
                    {catalog.error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="settings-footer-bar">
        <Button
          type="button"
          variant="primary"
          disabled={busy || anyCatalogBusy || chatStatus.state !== 'ready'}
          onClick={() =>
            void apply(() => desktop().saveRegistry(draft), 'Provider connections saved.')
          }
        >
          {busy ? 'Saving…' : 'Save providers'}
        </Button>
        {chatStatus.state === 'ready' &&
          chatStatus.configured &&
          draft.revision === (chatStatus.registryRevision ?? chatStatus.revision) && (
            <SettingsStatus tone="ready">
              <Check size={12} /> Primary configured
            </SettingsStatus>
          )}
      </div>

      {feedback && (
        <p
          className={feedback.error ? 'chat-response-error' : 'settings-inline-note'}
          role={feedback.error ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}

      <SettingsDialog
        open={Boolean(removingConnection)}
        onOpenChange={(open) => {
          if (!open) setRemovingId(null);
        }}
        title={`Remove “${removingConnection?.name ?? 'Connection'}”?`}
        description="This removes the endpoint and its saved API key once you save your provider settings."
        confirmLabel="Remove connection"
        onConfirm={() => {
          if (!removingConnection) return;
          setConnectionCatalog(removingConnection.id, null);
          setDraft((current) => ({
            ...current,
            connections: current.connections.filter((item) => item.id !== removingConnection.id),
            primary: current.primary?.startsWith(`${removingConnection.id}:`)
              ? null
              : current.primary,
            live: current.live?.model.startsWith(`${removingConnection.id}:`)
              ? null
              : current.live,
          }));
          setRemovingId(null);
        }}
      />
    </SettingsSection>
  );
}
