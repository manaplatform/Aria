import { useEffect, useRef, useState } from 'react';
import { Check, Cpu, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  modelCapabilities,
  modelReference,
  officialOpenAI,
  registryDraft,
  registryPolicySchema,
  type ConnectionInput,
  type DiscoveredModel,
  type ModelCapability,
  type RegistryInput,
  type RegistrySettings,
} from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { useChatStore } from '../../stores/chatStore';
import {
  installRegistrySettings,
  refreshProvider,
  useProviderStore,
} from '../../stores/providerStore';
import { Button, Field } from '../ui';

const labels: Record<ModelCapability, string> = {
  chat: 'Text streaming',
  tools: 'Function calling',
  vision: 'Vision',
  image: 'Image generation',
  'image-edit': 'Image editing',
  speech: 'Speech',
  transcription: 'Transcription',
  live: 'Live Voice',
  'web-search': 'Web Search',
};
const voices = registryPolicySchema.shape.live.unwrap().shape.voice.options;

export function ModelSettings() {
  const { settings, loading, error } = useProviderStore();
  useEffect(() => {
    void refreshProvider();
  }, []);
  return (
    <section id="ai-models" className="settings-section" aria-labelledby="ai-models-heading">
      <div className="settings-section-heading">
        <h2 id="ai-models-heading">
          <Cpu size={17} /> AI Models
        </h2>
        <p>The primary model answers in chat and chooses when to use an enabled model or tool.</p>
      </div>
      {settings ? (
        <RegistryEditor key={settings.revision} settings={settings} />
      ) : loading ? (
        <p role="status">Loading model settings…</p>
      ) : (
        <Button size="sm" onClick={() => void refreshProvider()}>
          Load model settings
        </Button>
      )}
      {error && (
        <p className="chat-response-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

type CatalogState = {
  models?: DiscoveredModel[];
  busy?: boolean;
  error?: string;
  verified?: string[];
};

function RegistryEditor({ settings }: { settings: RegistrySettings }) {
  const [draft, setDraft] = useState(() => registryDraft(settings));
  const [catalogs, setCatalogs] = useState<Record<string, CatalogState>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();
  const catalogRevisions = useRef(new Map<string, number>());
  const status = useChatStore((state) => state.status);

  const editConnection = (connection: ConnectionInput, invalidate = false) => {
    if (invalidate) {
      catalogRevisions.current.set(
        connection.id,
        (catalogRevisions.current.get(connection.id) ?? 0) + 1,
      );
      setCatalogs((current) => ({ ...current, [connection.id]: {} }));
    }
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
    const revision = (catalogRevisions.current.get(connection.id) ?? 0) + 1;
    catalogRevisions.current.set(connection.id, revision);
    setCatalogs((current) => ({
      ...current,
      [connection.id]: { ...current[connection.id], busy: true, error: undefined },
    }));
    try {
      const models = await desktop().discoverModels(connection);
      if (catalogRevisions.current.get(connection.id) === revision)
        setCatalogs((current) => ({
          ...current,
          [connection.id]: { ...current[connection.id], models, busy: false },
        }));
    } catch (error) {
      if (catalogRevisions.current.get(connection.id) === revision)
        setCatalogs((current) => ({ ...current, [connection.id]: { error: errorMessage(error) } }));
    }
  };

  const verify = async (connection: ConnectionInput, id: string) => {
    const revision = catalogRevisions.current.get(connection.id);
    setCatalogs((current) => ({
      ...current,
      [connection.id]: { ...current[connection.id], busy: true, error: undefined },
    }));
    try {
      await desktop().verifyModel(connection, id);
      if (revision === catalogRevisions.current.get(connection.id))
        setCatalogs((current) => ({
          ...current,
          [connection.id]: {
            ...current[connection.id],
            busy: false,
            verified: [...(current[connection.id]?.verified ?? []), id],
          },
        }));
    } catch (error) {
      if (revision === catalogRevisions.current.get(connection.id))
        setCatalogs((current) => ({
          ...current,
          [connection.id]: {
            ...current[connection.id],
            busy: false,
            error: errorMessage(error),
          },
        }));
    }
  };

  const apply = async (action: () => Promise<RegistrySettings>) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      installRegistrySettings(await action());
    } catch (error) {
      setFeedback({ error: true, text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const savedFor = (id: string) => settings.connections.find((item) => item.id === id);
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
          descriptor?.source === 'unknown' ? model.declared : (descriptor?.capabilities ?? []);
        return {
          value: modelReference(connection.id, model.id),
          label: `${connection.name} · ${model.id}`,
          primary:
            capabilities.includes('chat') &&
            capabilities.includes('tools') &&
            (descriptor?.source !== 'unknown' || isVerified(connection, model.id)),
          voice: capabilities.includes('live'),
        };
      }),
  );
  const disabled = busy || Object.values(catalogs).some((catalog) => catalog.busy);

  return (
    <div className="registry-editor">
      <div className="registry-actions">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || draft.connections.length >= 12}
          onClick={() =>
            setDraft((current) => ({
              ...current,
              connections: [
                ...current.connections,
                {
                  id: crypto.randomUUID(),
                  name: current.connections.length ? 'New connection' : 'OpenAI',
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
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => void apply(() => desktop().importRegistryEnvironment())}
          >
            Import environment settings
          </Button>
        )}
      </div>
      {!settings.encryptionAvailable && (
        <p role="status">Unlock the system credential store to save new API keys.</p>
      )}
      {draft.connections.map((connection) => (
        <ConnectionCard
          key={connection.id}
          connection={connection}
          catalog={catalogs[connection.id] ?? {}}
          saved={savedFor(connection.id)}
          disabled={busy}
          update={(next, invalidate) => editConnection(next, invalidate)}
          discover={() => void discover(connection)}
          verify={(id) => void verify(connection, id)}
          verified={(id) => isVerified(connection, id)}
          remove={() => {
            catalogRevisions.current.set(
              connection.id,
              (catalogRevisions.current.get(connection.id) ?? 0) + 1,
            );
            setCatalogs((current) => ({ ...current, [connection.id]: {} }));
            setDraft((current) => ({
              ...current,
              connections: current.connections.filter((item) => item.id !== connection.id),
              primary: current.primary?.startsWith(`${connection.id}:`) ? null : current.primary,
              live: current.live?.model.startsWith(`${connection.id}:`) ? null : current.live,
            }));
          }}
        />
      ))}
      <div className="registry-settings-grid">
        <Field label="Primary model">
          <select
            value={draft.primary ?? ''}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, primary: event.target.value || null })}
          >
            <option value="">Select a primary model</option>
            {enabled
              .filter((model) => model.primary || model.value === draft.primary)
              .map((model) => (
                <option key={model.value} value={model.value}>
                  {model.label}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Live Voice model">
          <select
            value={draft.live?.model ?? ''}
            disabled={busy}
            onChange={(event) =>
              setDraft({
                ...draft,
                live: event.target.value
                  ? { model: event.target.value, voice: draft.live?.voice ?? 'marin' }
                  : null,
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
          </select>
        </Field>
        {draft.live && (
          <Field label="Voice">
            <select
              value={draft.live.voice}
              disabled={busy}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  live: {
                    model: draft.live!.model,
                    voice: event.target.value as (typeof voices)[number],
                  },
                })
              }
            >
              {voices.map((voice) => (
                <option key={voice}>{voice}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Execution preference">
          <select
            value={draft.preference}
            disabled={busy}
            onChange={(event) =>
              setDraft({
                ...draft,
                preference: event.target.value as RegistryInput['preference'],
              })
            }
          >
            <option value="balanced">Balanced</option>
            <option value="cost">Lower cost</option>
            <option value="latency">Lower latency</option>
            <option value="quality">Higher quality</option>
          </select>
        </Field>
      </div>
      <label className="registry-checkbox">
        <input
          type="checkbox"
          checked={draft.crossConnection}
          disabled={busy}
          onChange={(event) =>
            setDraft({
              ...draft,
              crossConnection: event.target.checked,
              crossConnectionAttachments: event.target.checked && draft.crossConnectionAttachments,
            })
          }
        />
        Allow delegated requests across connections
      </label>
      <label className="registry-checkbox">
        <input
          type="checkbox"
          checked={draft.crossConnectionAttachments}
          disabled={busy || !draft.crossConnection}
          onChange={(event) =>
            setDraft({ ...draft, crossConnectionAttachments: event.target.checked })
          }
        />
        Allow attachments and their results across connections
      </label>
      <details className="registry-instructions">
        <summary>System instructions</summary>
        <Field label="Instructions">
          <textarea
            maxLength={16000}
            value={draft.systemPrompt}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
          />
        </Field>
      </details>
      <div className="registry-actions">
        <Button
          type="button"
          variant="primary"
          disabled={disabled || status.state !== 'ready'}
          onClick={() => void apply(() => desktop().saveRegistry(draft))}
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
                .catch((error) => setFeedback({ error: true, text: errorMessage(error) }))
            }
          >
            Restart service
          </Button>
        )}
        {status.state === 'ready' && status.configured && draft.revision === status.revision && (
          <span className="muted">
            <Check size={14} /> Primary configured
          </span>
        )}
      </div>
      {feedback && (
        <p
          className={feedback.error ? 'chat-response-error' : 'muted'}
          role={feedback.error ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
}

function ConnectionCard({
  connection,
  catalog,
  saved,
  disabled,
  update,
  discover,
  verify,
  verified,
  remove,
}: {
  connection: ConnectionInput;
  catalog: CatalogState;
  saved?: RegistrySettings['connections'][number];
  disabled: boolean;
  update: (next: ConnectionInput, invalidate?: boolean) => void;
  discover: () => void;
  verify: (id: string) => void;
  verified: (id: string) => boolean;
  remove: () => void;
}) {
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(25);
  const [expanded, setExpanded] = useState<string>();
  const descriptors = new Map(catalog.models?.map((model) => [model.id, model]));
  const ids = [
    ...new Set([...connection.models.map((model) => model.id), ...descriptors.keys()]),
  ].filter((id) => id.toLowerCase().includes(filter.toLowerCase()));
  const setModel = (model: ConnectionInput['models'][number]) =>
    update({
      ...connection,
      models: [...connection.models.filter((row) => row.id !== model.id), model],
    });
  const official = connection.baseUrl.replace(/\/+$/, '') === officialOpenAI;
  return (
    <div className="registry-connection">
      <div className="registry-connection-heading">
        <strong>{connection.name || 'Connection'}</strong>
        <span className="muted" role="status">
          {catalog.models
            ? 'Connected'
            : catalog.error
              ? 'Connection error'
              : saved?.locked
                ? 'Credential locked'
                : saved?.keyConfigured
                  ? 'Key saved'
                  : 'Set up connection'}
        </span>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label={`Remove ${connection.name}`}
          disabled={disabled}
          onClick={remove}
        >
          <Trash2 size={15} />
        </Button>
      </div>
      <div className="registry-settings-grid">
        <Field label="Connection name">
          <input
            value={connection.name}
            maxLength={100}
            disabled={disabled}
            onChange={(event) => update({ ...connection, name: event.target.value })}
          />
        </Field>
        <Field label="Provider endpoint">
          <input
            value={connection.baseUrl}
            maxLength={2000}
            disabled={disabled}
            onChange={(event) =>
              update({ ...connection, baseUrl: event.target.value, webSearch: false }, true)
            }
          />
        </Field>
        <Field label="API key">
          <input
            type="password"
            autoComplete="off"
            value={connection.apiKey ?? ''}
            maxLength={16000}
            disabled={disabled}
            placeholder={
              saved?.keyConfigured ? 'Saved in system credential store' : 'Enter an API key'
            }
            onChange={(event) =>
              update({ ...connection, apiKey: event.target.value, removeKey: false }, true)
            }
          />
        </Field>
      </div>
      <div className="registry-actions">
        <Button type="button" size="sm" disabled={disabled || catalog.busy} onClick={discover}>
          <RefreshCw size={14} /> {catalog.busy ? 'Contacting provider…' : 'Discover models'}
        </Button>
        {saved?.keyConfigured && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() =>
              update({ ...connection, apiKey: '', removeKey: !connection.removeKey }, true)
            }
          >
            {connection.removeKey ? 'Keep saved key' : 'Remove saved key'}
          </Button>
        )}
      </div>
      {official && (
        <label className="registry-checkbox">
          <input
            type="checkbox"
            checked={connection.webSearch}
            disabled={disabled}
            onChange={(event) => update({ ...connection, webSearch: event.target.checked })}
          />
          Allow OpenAI Web Search on this connection
        </label>
      )}
      {catalog.error && (
        <p className="chat-response-error" role="alert">
          {catalog.error}
        </p>
      )}
      {ids.length > 0 || filter ? (
        <Field label="Filter models">
          <input
            type="search"
            value={filter}
            onChange={(event) => {
              setLimit(25);
              setFilter(event.target.value);
            }}
          />
        </Field>
      ) : null}
      <ul className="registry-models">
        {ids.slice(0, limit).map((id) => {
          const model = connection.models.find((item) => item.id === id) ?? {
            id,
            enabled: false,
            delegate: false,
            declared: [],
          };
          const discovered = descriptors.get(id);
          const unknown = discovered?.source === 'unknown';
          const unsupported = discovered && !unknown && !discovered.capabilities.length;
          const missing = Boolean(catalog.models && !discovered);
          const capabilities = unknown ? model.declared : (discovered?.capabilities ?? []);
          return (
            <li key={id}>
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
                  {discovered && (
                    <small>
                      {discovered.source === 'provider'
                        ? 'Provider metadata'
                        : discovered.source === 'documentation'
                          ? 'OpenAI documentation'
                          : capabilities.length
                            ? 'Declared in Settings'
                            : 'Provider catalog lists only the ID'}
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
                      setModel({
                        ...model,
                        enabled: event.target.checked,
                        delegate: event.target.checked,
                      })
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
                {unknown && (
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
              {expanded === id && unknown && (
                <div className="registry-declarations">
                  {modelCapabilities
                    .filter(
                      (capability) =>
                        capability !== 'web-search' && (!official || capability !== 'live'),
                    )
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
                  {model.declared.includes('chat') && model.declared.includes('tools') && (
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
                  {verified(id) && <span className="muted">Function calling verified</span>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {ids.length > limit && (
        <Button type="button" size="sm" variant="ghost" onClick={() => setLimit(limit + 25)}>
          Show more models
        </Button>
      )}
    </div>
  );
}
