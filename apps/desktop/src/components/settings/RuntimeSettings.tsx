import { useEffect, useState } from 'react';
import {
  defaultLoopLimits,
  modelReference,
  type LoopLimits,
  type ExecutionHistoryEntry,
  type LocalDesktopAccess,
  type OpenAIRuntimeFeature,
  type RuntimeSettings as Settings,
} from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { ensureChatDraft } from '../../stores/chatStore';
import { useProviderStore } from '../../stores/providerStore';
import { Button } from '../ui';
import { flushPersistence, useWorkspaceStore } from '../../stores/workspaceStore';

const nativeModes: { id: OpenAIRuntimeFeature; label: string }[] = [
  { id: 'hosted-shell', label: 'OpenAI-hosted Shell' },
  { id: 'local-shell', label: 'OpenAI Shell with managed execution' },
  { id: 'file-search', label: 'OpenAI File Search' },
  { id: 'computer', label: 'OpenAI native Computer Use' },
  { id: 'computer-image', label: 'Aria Computer Use image observations' },
];

const loopFields: { name: keyof LoopLimits; label: string; min: number; max: number; scale?: number }[] = [
  { name: 'iterations', label: 'Maximum model requests', min: 2, max: 48 },
  { name: 'steps', label: 'Maximum tool attempts', min: 4, max: 32 },
  { name: 'inputTokens', label: 'Maximum input tokens', min: 8192, max: 600_000 },
  { name: 'outputTokens', label: 'Maximum output tokens', min: 4096, max: 65_536 },
  { name: 'activeMs', label: 'Maximum active time (seconds)', min: 10, max: 1800, scale: 1000 },
  { name: 'concurrency', label: 'Concurrent operations', min: 1, max: 6 },
  { name: 'toolMs', label: 'Maximum tool time (seconds)', min: 1, max: 181, scale: 1000 },
  { name: 'readRetries', label: 'Retries for verified reads', min: 0, max: 4 },
  { name: 'stagnantRounds', label: 'Rounds without progress', min: 2, max: 8 },
];

const desktopAccessMessage: Record<LocalDesktopAccess['state'], string> = {
  off: '',
  ready: 'Mouse control is available in active chats with the approved primary.',
  'primary-changed': 'Switch to the approved primary or select a display for your current primary.',
  'screen-permission': 'Allow Aria in macOS Screen & System Audio Recording.',
  'pointer-permission': 'Mouse control is unavailable. On macOS, allow the Aria helper in Accessibility.',
  unavailable: 'Reconnect the approved display and make sure the desktop is unlocked.',
};

export function RuntimeSettings() {
  const [value, setValue] = useState<Settings>();
  const [history, setHistory] = useState<ExecutionHistoryEntry[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const registry = useProviderStore((state) => state.settings);
  const [embeddingChoice, setEmbeddingChoice] = useState<string>();
  const [embeddingFeedback, setEmbeddingFeedback] = useState<{ error: boolean; text: string }>();
  const [native, setNative] = useState<OpenAIRuntimeFeature[]>([]);
  const [busy, setBusy] = useState(false);
  const [standingDesktopAccess, setStandingDesktopAccess] = useState(true);
  const [desktopAccess, setDesktopAccess] = useState<LocalDesktopAccess>();
  const screenSupported = window.aria?.platform === 'darwin' || window.aria?.platform === 'win32';
  const savedEmbedding = value?.embeddingTarget;
  const embeddingSelection =
    embeddingChoice ?? (savedEmbedding ? modelReference(savedEmbedding.connectionId, savedEmbedding.model) : '');
  const embeddingOptions = (registry?.connections ?? [])
    .filter(
      (connection) =>
        connection.keyConfigured && !connection.locked && new URL(connection.baseUrl).protocol === 'https:',
    )
    .flatMap((connection) =>
      connection.models
        .filter((model) => model.enabled && model.declared.includes('embeddings'))
        .map((model) => ({
          id: modelReference(connection.id, model.id),
          label: `${connection.name} · ${model.id}`,
          target: { connectionId: connection.id, model: model.id },
        })),
    );
  const selectedEmbedding = embeddingOptions.find((option) => option.id === embeddingSelection);
  const unavailableEmbedding = Boolean(embeddingSelection && !selectedEmbedding);

  useEffect(() => {
    let mounted = true;
    void Promise.resolve()
      .then(() => desktop().runtimeSettings())
      .then((settings) => {
        if (mounted) setValue(settings);
      })
      .catch((failure) => {
        if (mounted) setError(errorMessage(failure));
      });
    void Promise.resolve()
      .then(() => desktop().nativeRuntimeModes())
      .then((features) => {
        if (mounted) setNative(features);
      })
      .catch(() => undefined);
    if (screenSupported) {
      void Promise.resolve()
        .then(() => desktop().localDesktopAccess())
        .then((value) => {
          if (mounted) setDesktopAccess(value);
        })
        .catch(() => undefined);
    }
    return () => {
      mounted = false;
    };
  }, [screenSupported]);

  async function save(probe: boolean | 'desktop') {
    if (!value) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const settings = { ...value };
      delete settings.embeddingTarget;
      setValue(await desktop().saveRuntimeSettings(settings));
      if (probe === 'desktop') {
        await desktop().probeVirtualComputer();
        setStatus('The isolated graphical desktop passed its capture and isolation checks.');
      } else if (probe) {
        const result = await desktop().probeRuntime();
        setStatus(`Connected to the managed Linux environment (${String(result.architecture)}).`);
      } else {
        setStatus('Runtime settings saved.');
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function saveEmbedding() {
    setBusy(true);
    setEmbeddingFeedback(undefined);
    try {
      const { embeddingTarget } = await desktop().saveEmbeddingTarget(selectedEmbedding?.target);
      setValue((current) => current && { ...current, embeddingTarget });
      setEmbeddingChoice(undefined);
      setEmbeddingFeedback({
        error: false,
        text: embeddingTarget
          ? 'Embedding model verified and saved.'
          : 'Local embedding pack selected.',
      });
    } catch (failure) {
      setEmbeddingFeedback({ error: true, text: errorMessage(failure) });
    } finally {
      setBusy(false);
    }
  }

  async function nativeMode(feature: OpenAIRuntimeFeature, enabled: boolean) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      setNative(await desktop().setNativeRuntime(feature, enabled));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function localDesktop(action: 'screen' | 'revoke' | 'recheck') {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      if (action === 'revoke') {
        await desktop().revokeLocalComputer();
        setDesktopAccess({ state: 'off' });
        setStatus('Local desktop access revoked.');
      } else if (action === 'recheck') {
        setDesktopAccess(await desktop().localDesktopAccess(true));
      } else {
        let conversationId: string | null = null;
        if (!standingDesktopAccess) {
          conversationId = ensureChatDraft();
          await flushPersistence();
          if (useWorkspaceStore.getState().saveError)
            throw new Error('The chat draft could not be saved. Resolve the storage error and retry.');
        }
        if (await desktop().selectLocalComputer(conversationId, 'screen', standingDesktopAccess)) {
          setDesktopAccess(await desktop().localDesktopAccess());
          if (!standingDesktopAccess) setStatus('Start a local desktop session in this chat within two minutes.');
        }
      }
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" id="execution-runtime">
      <h2>Execution and knowledge</h2>
      <p className="muted">
        Aria runs commands in an offline Linux workspace. Configure a local Docker Engine socket to
        enable it.
      </p>
      {value && (
        <>
          <div className="shortcut-row">
            <label htmlFor="execution-socket">Docker Engine socket</label>
            <input
              id="execution-socket"
              value={value.engineSocket}
              disabled={busy}
              placeholder="unix:///path/to/docker.sock"
              onChange={(event) => setValue({ ...value, engineSocket: event.target.value })}
            />
          </div>
          <div className="shortcut-row">
            <label htmlFor="virtual-desktop-image">Virtual desktop image ID</label>
            <input
              id="virtual-desktop-image"
              value={value.desktopImage ?? ''}
              disabled={busy}
              placeholder="sha256:…"
              onChange={(event) =>
                setValue({ ...value, desktopImage: event.target.value.trim() || undefined })
              }
            />
            <Button
              variant="secondary"
              disabled={busy || !value.desktopImage}
              onClick={() => void save('desktop')}
            >
              Verify desktop
            </Button>
          </div>
          {(
            [
              {
                name: 'computerIdleMinutes',
                label: 'Computer idle limit (minutes)',
                maximum: 20,
                fallback: 20,
              },
              {
                name: 'computerLifetimeMinutes',
                label: 'Computer session limit (minutes)',
                maximum: 45,
                fallback: 45,
              },
              {
                name: 'computerBatchLimit',
                label: 'Computer actions per batch',
                maximum: 8,
                fallback: 8,
              },
            ] as const
          ).map(({ name, label, maximum, fallback }) => (
            <div className="shortcut-row" key={name}>
              <label htmlFor={name}>{label}</label>
              <input
                id={name}
                type="number"
                min={name === 'computerLifetimeMinutes' ? 2 : 1}
                max={maximum}
                value={value[name] ?? fallback}
                disabled={busy}
                onChange={(event) =>
                  setValue({ ...value, [name]: event.target.valueAsNumber || undefined })
                }
              />
            </div>
          ))}
          <div className="shortcut-row">
            <label htmlFor="command-duration">Maximum command duration (seconds)</label>
            <input
              id="command-duration"
              type="number"
              min="1"
              max="60"
              value={value.commandMs / 1000}
              disabled={busy}
              onChange={(event) =>
                setValue({ ...value, commandMs: Number(event.target.value) * 1000 })
              }
            />
          </div>
          <div className="shortcut-row">
            <label htmlFor="artifact-retention">Generated file retention (days)</label>
            <input
              id="artifact-retention"
              type="number"
              min="1"
              max="365"
              value={value.artifactRetentionDays ?? ''}
              placeholder="Keep with chat"
              disabled={busy}
              onChange={(event) =>
                setValue({
                  ...value,
                  artifactRetentionDays: event.target.value
                    ? Number(event.target.value)
                    : undefined,
                })
              }
            />
          </div>
          <details>
            <summary>Execution limits</summary>
            {loopFields.map(({ name, label, min, max, scale = 1 }) => (
              <div className="shortcut-row" key={name}>
                <label htmlFor={`loop-${name}`}>{label}</label>
                <input id={`loop-${name}`} type="number" min={min} max={max} disabled={busy}
                  value={(value.loop ?? defaultLoopLimits)[name] / scale}
                  onChange={(event) => {
                    if (Number.isFinite(event.target.valueAsNumber))
                      setValue({ ...value, loop: { ...(value.loop ?? defaultLoopLimits), [name]: event.target.valueAsNumber * scale } });
                  }} />
              </div>
            ))}
          </details>
          <div className="shortcut-row">
            <Button size="sm" disabled={busy} onClick={() => void save(false)}>
              Save runtime settings
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !value.engineSocket}
              onClick={() => void save(true)}
            >
              Save and test environment
            </Button>
          </div>
          <div className="shortcut-row">
            <label htmlFor="embedding-target">Embedding model</label>
            <select
              id="embedding-target"
              disabled={busy}
              value={embeddingSelection}
              onChange={(event) => {
                setEmbeddingChoice(event.target.value);
                setEmbeddingFeedback(undefined);
              }}
            >
              <option value="">Local embedding pack</option>
              {unavailableEmbedding && (
                <option value={embeddingSelection} disabled>
                  {embeddingSelection.slice(embeddingSelection.indexOf(':') + 1)} (refresh AI Models)
                </option>
              )}
              {embeddingOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || unavailableEmbedding || (!embeddingSelection && !savedEmbedding)}
              onClick={() => void saveEmbedding()}
            >
              {embeddingSelection ? 'Verify and save embedding' : 'Use local embedding pack'}
            </Button>
          </div>
          {registry && !embeddingOptions.length && (
            <p className="muted">
              Enable a model with Embeddings in AI Models to use a remote provider.
            </p>
          )}
          {embeddingFeedback && (
            <p role={embeddingFeedback.error ? 'alert' : 'status'}>{embeddingFeedback.text}</p>
          )}
        </>
      )}
      {screenSupported && (
        <>
          <div className="shortcut-row">
            <span>Local desktop</span>
            <Button variant="secondary" disabled={busy} onClick={() => void localDesktop('screen')}>
              {desktopAccess?.display && standingDesktopAccess ? 'Change display' : 'Select a full screen'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void localDesktop('revoke')}>
              Revoke
            </Button>
          </div>
          <label className="settings-toggle">
            Allow access until revoked
            <input
              type="checkbox"
              checked={standingDesktopAccess}
              disabled={busy}
              onChange={(event) => setStandingDesktopAccess(event.target.checked)}
            />
          </label>
          {desktopAccess?.display && (
            <div className="shortcut-row">
              <p className="muted" role="status">
                <strong>{desktopAccess.display}</strong> · {desktopAccessMessage[desktopAccess.state]}
              </p>
              {desktopAccess.state !== 'ready' && desktopAccess.state !== 'primary-changed' && (
                <Button variant="ghost" disabled={busy} onClick={() => void localDesktop('recheck')}>
                  Check permissions
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {nativeModes.map(({ id, label }) => (
        <div className="shortcut-row" key={id}>
          <span>{label}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void nativeMode(id, !native.includes(id))}
          >
            {native.includes(id) ? 'Disable' : 'Verify and enable'}
          </Button>
        </div>
      ))}
      <details
        className="conductor-activity"
        onToggle={(event) => {
          if (event.currentTarget.open)
            void desktop()
              .executionHistory()
              .then(setHistory)
              .catch((failure) => setError(errorMessage(failure)));
        }}
      >
        <summary>Execution history</summary>
        {history.length ? (
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                {entry.operation} · {entry.state} · {new Date(entry.started).toLocaleString()}
                {entry.elapsed === null ? '' : ` · ${(entry.elapsed / 1000).toFixed(1)} s`}
                {entry.exitCode === null ? '' : ` · exit ${entry.exitCode}`}
              </li>
            ))}
          </ul>
        ) : (
          <p>No execution attempts recorded.</p>
        )}
      </details>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
