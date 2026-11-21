import { useEffect, useState } from 'react';
import type {
  ExecutionHistoryEntry,
  OpenAIRuntimeFeature,
  RegistrySettings,
  RuntimeSettings as Settings,
} from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { Button } from '../ui';

const nativeModes: { id: OpenAIRuntimeFeature; label: string }[] = [
  { id: 'hosted-shell', label: 'OpenAI-hosted Shell' },
  { id: 'local-shell', label: 'OpenAI Shell with managed execution' },
  { id: 'file-search', label: 'OpenAI File Search' },
];

export function RuntimeSettings() {
  const [value, setValue] = useState<Settings>();
  const [history, setHistory] = useState<ExecutionHistoryEntry[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [registry, setRegistry] = useState<RegistrySettings>();
  const [native, setNative] = useState<OpenAIRuntimeFeature[]>([]);
  const [busy, setBusy] = useState(false);

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

  async function save(probe: boolean) {
    if (!value) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      setValue(await desktop().saveRuntimeSettings(value));
      if (probe) {
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
