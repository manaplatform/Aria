import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import {
  modelCapabilities,
  modelReference,
  registryDraft,
  registryPolicySchema,
  type ConnectionInput,
  type DiscoveredModel,
  type ModelCapability,
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
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsStatus,
} from '../components';

const labels: Record<ModelCapability, string> = {
  chat: 'Text streaming',
  tools: 'Function calling',
  vision: 'Vision',
  embeddings: 'Embeddings',
  image: 'Image generation',
  'image-edit': 'Image editing',
  speech: 'Speech',
  transcription: 'Transcription',
  live: 'Live Voice',
  'web-search': 'Web Search',
};
const voices = registryPolicySchema.shape.live.unwrap().shape.voice.options;

function includeDiscoveredEmbeddings(
  model: ConnectionInput['models'][number],
  descriptor?: DiscoveredModel,
): ConnectionInput['models'][number] {
  if (!descriptor?.capabilities.includes('embeddings') || model.declared.includes('embeddings'))
    return model;
  return { ...model, declared: [...model.declared, 'embeddings'] };
}

export default function ModelSettings() {
  const { settings, loading, error, catalogs } = useProviderStore();
  const { navigateCategory } = useSettingsNavigation();
  useEffect(() => {
    void refreshProvider();
  }, []);

  return (
    <SettingsPage
      title="Models"
      description="The selected primary model handles chat, task routing, and synthesis. No separate routing or fallback model is used."
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={() => navigateCategory('providers')}>
          Manage providers
        </Button>
      }
    >
      {settings ? (
        <ModelsEditor key={settings.revision} settings={settings} catalogs={catalogs} />
      ) : loading ? (
        <p role="status" className="settings-inline-note">
          Loading model settings…
        </p>
      ) : (
        <Button size="sm" onClick={() => void refreshProvider(true)}>
          Load model settings
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

function ModelsEditor({
  settings,
  catalogs,
}: {
  settings: RegistrySettings;
  catalogs: Record<string, CatalogState>;
}) {
  const [draft, setDraft] = useState(() => registryDraft(settings));
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const revisions = useRef(new Map<string, number>());
  const status = useChatStore((state) => state.status);
  const { highlightedSettingId, navigateCategory } = useSettingsNavigation();

  useEffect(() => {
    const owned = revisions.current;
    return () => { for (const [id, revision] of owned) cancelCatalogRequest(id, revision); };
  }, []);
  const savedFor = (id: string) => settings.connections.find((item) => item.id === id);

  const editConnection = (connection: ConnectionInput) => {
    const enabled = new Set(
      connection.models
        .filter((model) => model.enabled)
        .map((model) => modelReference(connection.id, model.id)),
    );
    setDraft((current) => ({
      ...current,
      connections: current.connections.map((item) =>
        item.id === connection.id ? connection : item,
      ),
      primary:
        current.primary?.startsWith(`${connection.id}:`) && !enabled.has(current.primary)
          ? null
          : current.primary,
      live:
        current.live?.model.startsWith(`${connection.id}:`) && !enabled.has(current.live.model)
          ? null
          : current.live,
    }));
  };

  const discover = async (connection: ConnectionInput) => {
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
      if (isCurrentCatalogRequest(connection.id, revision))
        setConnectionCatalog(connection.id, { busy: false, error: errorMessage(failure) });
    }
  };

  const verify = async (connection: ConnectionInput, id: string) => {
    const revision = beginCatalogRequest(connection.id);
    revisions.current.set(connection.id, revision);
    setConnectionCatalog(connection.id, { busy: true, error: undefined });
    try {
      await desktop().verifyModel(connection, id);
      if (isCurrentCatalogRequest(connection.id, revision)) {
        const existing = catalogs[connection.id]?.verified ?? [];
        setConnectionCatalog(connection.id, {
          busy: false,
          verified: [...existing, id],
        });
      }
    } catch (failure) {
      if (isCurrentCatalogRequest(connection.id, revision))
        setConnectionCatalog(connection.id, { busy: false, error: errorMessage(failure) });
    }
  };

  const isVerified = (connection: ConnectionInput, id: string) =>
    Boolean(
      catalogs[connection.id]?.verified?.includes(id) ||
        (!connection.apiKey &&
          !connection.removeKey &&
          savedFor(connection.id)?.baseUrl === connection.baseUrl &&
          savedFor(connection.id)?.verified.includes(id)),
    );

  const enabled = draft.connections.flatMap((connection) =>
    connection.models
      .filter((model) => model.enabled)
      .map((model) => {
        const descriptor = catalogs[connection.id]?.models?.find((item) => item.id === model.id);
        const capabilities =
          descriptor?.source === 'provider' ? descriptor.capabilities : model.declared;
        return {
          value: modelReference(connection.id, model.id),
          label: `${connection.name} · ${model.id}`,
          primary:
            (descriptor?.source === 'provider' &&
              capabilities.includes('chat') &&
              capabilities.includes('tools')) ||
            isVerified(connection, model.id),
          voice: capabilities.includes('live'),
        };
      }),
  );

  const disabled = busy || Object.values(catalogs).some((catalog) => catalog.busy);

  const save = async () => {
    setBusy(true);
    setFeedback(undefined);
    try {
      installRegistrySettings(await desktop().saveRegistry(draft));
      setFeedback({ error: false, text: 'Model settings saved.' });
    } catch (failure) {
      setFeedback({ error: true, text: errorMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsSection title="Active Models">
        <SettingsGroup>
          <SettingsSelect
            id="models-primary"
            label="Primary model"
            description="Selected exclusively in Settings for all chat responses and Conductor decisions."
            value={draft.primary ?? ''}
            disabled={busy}
            highlighted={highlightedSettingId === 'models-primary'}
            onChange={(value) => setDraft({ ...draft, primary: value || null })}
          >
            <option value="">Select a primary model</option>
            {enabled
              .filter((model) => model.primary || model.value === draft.primary)
              .map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
          </SettingsSelect>
          <SettingsSelect
            id="models-live"
            label="Live Voice model"
            description="Optional realtime speech model used for voice conversations."
            value={draft.live?.model ?? ''}
            disabled={busy}
            highlighted={highlightedSettingId === 'models-live'}
            onChange={(value) =>
              setDraft({
                ...draft,
                live: value ? { model: value, voice: draft.live?.voice ?? 'marin' } : null,
              })
            }
          >
            <option value="">Off</option>
            {enabled
              .filter((model) => model.voice || model.value === draft.live?.model)
              .map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
          </SettingsSelect>
          {draft.live && (
            <SettingsSelect
              label="Voice"
              description="Voice persona for Live Voice sessions."
              value={draft.live.voice}
              disabled={busy}
              onChange={(value) =>
                setDraft({
                  ...draft,
                  live: {
                    model: draft.live!.model,
                    voice: value as (typeof voices)[number],
                  },
                })
              }
            >
              {voices.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </SettingsSelect>
          )}
          <SettingsRow
            label="Reasoning configuration"
            description="Per-model reasoning effort levels are not yet exposed by the provider adapter; official OpenAI Responses endpoints request encrypted reasoning state automatically."
          >
            <SettingsStatus tone="neutral">Adapter-managed</SettingsStatus>
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="models-catalog"
        title="Available Models & Capabilities"
        description="Discover models per provider, enable operations, verify function calling for primary use, and assign delegation permissions."
      >
        {draft.connections.length === 0 ? (
          <div className="settings-group">
            <p className="settings-inline-note" style={{ marginTop: 0 }}>
              No AI providers are connected yet. Add an API connection first.
            </p>
            <div>
              <Button size="sm" onClick={() => navigateCategory('providers')}>
                Go to AI Providers
              </Button>
            </div>
          </div>
        ) : (
          <div className="registry-editor">
            {draft.connections.map((connection) => (
              <ConnectionModels
                key={connection.id}
                connection={connection}
                catalog={catalogs[connection.id] ?? {}}
                saved={savedFor(connection.id)}
                disabled={busy}
                update={editConnection}
                discover={() => void discover(connection)}
                verify={(id) => void verify(connection, id)}
                verified={(id) => isVerified(connection, id)}
              />
            ))}
          </div>
        )}

        <div className="settings-footer-bar">
          <Button
            type="button"
            variant="primary"
            disabled={disabled || status.state !== 'ready'}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : 'Save AI Models'}
          </Button>
          {status.state === 'failed' && (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                void desktop()
                  .restartChatService()
                  .catch((failure) => setFeedback({ error: true, text: errorMessage(failure) }))
              }
            >
              Restart service
            </Button>
          )}
          {status.state === 'ready' &&
            status.configured &&
            draft.revision === (status.registryRevision ?? status.revision) && (
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
      </SettingsSection>
    </>
  );
}

function ConnectionModels({
  connection,
  catalog,
  saved,
  disabled,
  update,
  discover,
  verify,
  verified,
}: {
  connection: ConnectionInput;
  catalog: CatalogState;
  saved?: RegistrySettings['connections'][number];
  disabled: boolean;
  update: (next: ConnectionInput) => void;
  discover: () => void;
  verify: (id: string) => void;
  verified: (id: string) => boolean;
}) {
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(25);
  const [expanded, setExpanded] = useState<string>();
  const { highlightedSettingId } = useSettingsNavigation();
  const descriptors = new Map(catalog.models?.map((model) => [model.id, model]));
  const allIds = [...new Set([...connection.models.map((model) => model.id), ...descriptors.keys()])];
  const ids = allIds.filter((id) => id.toLowerCase().includes(filter.toLowerCase()));
  const targetId = allIds.find((id) => highlightedSettingId === `settings-model-${connection.id}-${id}`);
  const visibleIds = ids.slice(0, limit);
  if (targetId && !visibleIds.includes(targetId)) visibleIds.push(targetId);

  const setModel = (model: ConnectionInput['models'][number]) =>
    update({
      ...connection,
      models: [...connection.models.filter((row) => row.id !== model.id), model],
    });

  return (
    <div className="registry-connection">
      <div className="registry-connection-heading">
        <strong>{connection.name || 'Connection'}</strong>
        <SettingsStatus
          tone={
            catalog.models
              ? 'ready'
              : catalog.error
                ? 'error'
                : saved?.keyConfigured
                  ? 'accent'
                  : 'neutral'
          }
          role="status"
        >
          {catalog.models
            ? 'Connected'
            : catalog.error
              ? 'Connection error'
              : saved?.locked
                ? 'Credential locked'
                : saved?.keyConfigured
                  ? 'Key saved'
                  : 'Set up connection'}
        </SettingsStatus>
        <Button
          type="button"
          size="sm"
          disabled={disabled || catalog.busy || (!saved?.keyConfigured && !connection.apiKey)}
          onClick={discover}
        >
          <RefreshCw size={14} className={catalog.busy ? 'spin' : ''} />{' '}
          {catalog.busy ? 'Contacting provider…' : 'Discover models'}
        </Button>
      </div>

      {catalog.error && (
        <p className="chat-response-error" role="alert">
          {catalog.error}
        </p>
      )}

      {(ids.length > 0 || filter) && (
        <Field label="Filter models">
          <input
            type="search"
            placeholder="Filter by model ID…"
            value={filter}
            onChange={(event) => {
              setLimit(25);
              setFilter(event.target.value);
            }}
          />
        </Field>
      )}

      {visibleIds.length === 0 ? (
        <p className="settings-inline-note">
          Click Discover models to inspect available models from this endpoint.
        </p>
      ) : (
        <ul className="registry-models">
          {visibleIds.map((id) => {
            const model = connection.models.find((item) => item.id === id) ?? {
              id,
              enabled: false,
              delegate: false,
              declared: [],
            };
            const discovered = descriptors.get(id);
            const unknown = discovered && discovered.source !== 'provider';
            const unsupported =
              discovered &&
              discovered.source !== 'unknown' &&
              !discovered.capabilities.length;
            const missing = Boolean(catalog.models && !discovered);
            const capabilities =
              model.declared.length && unknown
                ? model.declared
                : (discovered?.capabilities ?? []);

            return (
              <li key={id} id={`settings-model-${connection.id}-${id}`}>
                <div className="registry-model-row">
                  <div>
                    <strong>{id}</strong>
                    <small>
                      {missing
                        ? 'Unavailable'
                        : !discovered
                          ? 'Refresh to check availability'
                          : capabilities.length
                            ? capabilities.map((capability) => labels[capability]).join(' · ')
                            : unsupported
                              ? 'No supported Aria operations'
                              : 'Unknown capabilities'}
                    </small>
                    {discovered?.textPricing && (
                      <small>Text pricing · ${(discovered.textPricing.input / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} input / ${(discovered.textPricing.output / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} output per million tokens</small>
                    )}
                    {discovered && (
                      <small>
                        {discovered.source === 'provider'
                          ? 'Provider metadata'
                          : discovered.source === 'documentation'
                            ? 'OpenAI documentation'
                            : capabilities.length
                              ? 'Declared in Settings'
                              : 'Provider catalog lists only the ID'}
                        {discovered.contextTokens
                          ? ` · ${discovered.contextTokens.toLocaleString()} context tokens`
                          : ''}
                      </small>
                    )}
                  </div>
                  <label className="registry-checkbox">
                    <input
                      type="checkbox"
                      aria-label={`Enable ${id}`}
                      checked={model.enabled}
                      disabled={disabled || (!model.enabled && !discovered)}
                      onChange={(event) =>
                        setModel(
                          includeDiscoveredEmbeddings(
                            {
                              ...model,
                              enabled: event.target.checked,
                              delegate: event.target.checked,
                            },
                            discovered,
                          ),
                        )
                      }
                    />{' '}
                    Enabled
                  </label>
                  <label className="registry-checkbox">
                    <input
                      type="checkbox"
                      aria-label={`Delegate to ${id}`}
                      checked={model.delegate}
                      disabled={disabled || !model.enabled}
                      onChange={(event) => setModel({ ...model, delegate: event.target.checked })}
                    />{' '}
                    Delegation
                  </label>
                  {unknown && !unsupported && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setExpanded(expanded === id ? undefined : id)}
                      aria-expanded={expanded === id}
                    >
                      Capabilities
                    </Button>
                  )}
                </div>

                {expanded === id && unknown && !unsupported && (
                  <div className="registry-declarations">
                    {modelCapabilities
                      .filter((capability) => capability !== 'web-search')
                      .map((capability) => (
                        <label key={capability} className="registry-checkbox">
                          <input
                            type="checkbox"
                            disabled={disabled}
                            checked={model.declared.includes(capability)}
                            onChange={(event) =>
                              setModel({
                                ...model,
                                declared: event.target.checked
                                  ? [...model.declared, capability]
                                  : model.declared.filter((item) => item !== capability),
                              })
                            }
                          />
                          {labels[capability]}
                        </label>
                      ))}
                    {((model.declared.includes('chat') && model.declared.includes('tools')) ||
                      (discovered?.source === 'documentation' &&
                        discovered.capabilities.includes('chat'))) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={disabled || catalog.busy}
                        onClick={() => verify(id)}
                      >
                        {verified(id) ? 'Verify again' : 'Verify for primary'}
                      </Button>
                    )}
                    {model.declared.some((capability) =>
                      ['speech', 'image', 'image-edit'].includes(capability),
                    ) && (
                      <Field label="Media API transport">
                        <select
                          value={model.transport ?? ''}
                          disabled={disabled}
                          onChange={(event) =>
                            setModel({
                              ...model,
                              transport: event.target.value
                                ? (event.target.value as typeof model.transport)
                                : undefined,
                            })
                          }
                        >
                          <option value="">Standard API</option>
                          {model.declared.includes('speech') && (
                            <option value="realtime">Realtime speech</option>
                          )}
                          {model.declared.some(
                            (capability) => capability === 'image' || capability === 'image-edit',
                          ) && <option value="inline-png">Inline PNG images</option>}
                        </select>
                      </Field>
                    )}
                    {verified(id) && <span className="muted">Function calling verified</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {ids.length > limit && (
        <Button type="button" size="sm" variant="ghost" onClick={() => setLimit(limit + 25)}>
          Show more models
        </Button>
      )}
    </div>
  );
}
