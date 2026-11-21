import { useEffect, useState } from 'react';
import type {
  ExecutionHistoryEntry,
  OpenAIRuntimeFeature,
  RegistrySettings,
  RuntimeSettings as Settings,
} from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { ensureChatDraft } from '../../stores/chatStore';
import { Button } from '../ui';
import { flushPersistence, useWorkspaceStore } from '../../stores/workspaceStore';

const nativeModes: { id: OpenAIRuntimeFeature; label: string }[] = [
  { id: 'hosted-shell', label: 'OpenAI-hosted Shell' },
  { id: 'local-shell', label: 'OpenAI Shell with managed execution' },
  { id: 'file-search', label: 'OpenAI File Search' },
  { id: 'computer', label: 'OpenAI native Computer Use' },
  { id: 'computer-image', label: 'Aria Computer Use image observations' },
];

export function RuntimeSettings() {
  const [value, setValue] = useState<Settings>();
  const [history, setHistory] = useState<ExecutionHistoryEntry[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [registry, setRegistry] = useState<RegistrySettings>();
  const [native, setNative] = useState<OpenAIRuntimeFeature[]>([]);
  const [busy, setBusy] = useState(false);
  const screenSupported = window.aria?.platform === 'darwin' || window.aria?.platform === 'win32';

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
    void Promise.resolve()
      .then(() => desktop().registrySettings())
      .then((value) => {
        if (mounted) setRegistry(value);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  async function save(probe: boolean | 'desktop') {
    if (!value) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      setValue(await desktop().saveRuntimeSettings(value));
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

  async function localDesktop(action: 'screen' | 'revoke') {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      if (action === 'revoke') {
        await desktop().revokeLocalComputer();
        setStatus('Local desktop access revoked.');
      } else {
        const conversationId = ensureChatDraft();
        await flushPersistence();
        if (useWorkspaceStore.getState().saveError)
          throw new Error(
            'The chat draft could not be saved. Resolve the storage error and retry.',
          );
        if (await desktop().selectLocalComputer(conversationId, 'screen'))
          setStatus('Start a local desktop session in this chat within two minutes.');
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
          <div className="shortcut-row">
            <label htmlFor="embedding-target">Embedding provider</label>
            <select
              id="embedding-target"
              disabled={busy}
              value={
                value.embeddingTarget
                  ? `${value.embeddingTarget.connectionId}:${value.embeddingTarget.model}`
                  : ''
              }
              onChange={(event) => {
                const target = event.target.value;
                setValue({
                  ...value,
                  embeddingTarget: target
                    ? { connectionId: target.slice(0, 36), model: target.slice(37) }
                    : undefined,
                });
              }}
            >
              <option value="">Local embedding pack</option>
              {registry?.connections
                .filter(
                  (connection) =>
                    connection.keyConfigured && connection.baseUrl.startsWith('https://'),
                )
                .flatMap((connection) =>
                  connection.models
                    .filter((model) => model.enabled)
                    .map((model) => (
                      <option
                        key={`${connection.id}:${model.id}`}
                        value={`${connection.id}:${model.id}`}
                      >
                        {connection.name} · {model.id}
                      </option>
                    )),
                )}
            </select>
          </div>
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
        </>
      )}
      {screenSupported && (
        <div className="shortcut-row">
          <span>Local desktop</span>
          <Button variant="secondary" disabled={busy} onClick={() => void localDesktop('screen')}>
            Select a full screen
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void localDesktop('revoke')}>
            Revoke
          </Button>
        </div>
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
