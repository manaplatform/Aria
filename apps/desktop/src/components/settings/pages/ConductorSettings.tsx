import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  defaultLoopLimits,
  defaultProgramSettings,
  registryDraft,
  type ExecutionHistoryEntry,
  type LoopLimits,
  type ProgramSettings,
  type RegistryInput,
  type RuntimeSettings,
  type ToolSettings,
} from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { useChatStore } from '../../../stores/chatStore';
import {
  installRegistrySettings,
  refreshProvider,
  useProviderStore,
} from '../../../stores/providerStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { Button } from '../../ui';
import { SettingsPage } from '../SettingsPage';
import { useSettingsNavigation } from '../SettingsContext';
import {
  SettingsAction,
  SettingsGroup,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsStatus,
  SettingsToggle,
} from '../components';

const loopFields: {
  name: keyof LoopLimits;
  label: string;
  min: number;
  max: number;
  scale?: number;
}[] = [
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

export default function ConductorSettings() {
  const chatStatus = useChatStore((state) => state.status);
  const expandActivity = useWorkspaceStore(
    (state) => Boolean(state.data.preferences.expandActivityByDefault),
  );
  const updatePrefs = useWorkspaceStore((state) => state.preferences);
  const { settings: registry } = useProviderStore();
  const { highlightedSettingId, navigateCategory } = useSettingsNavigation();

  const [pref, setPref] = useState<RegistryInput['preference']>('balanced');
  const [spendingMicros, setSpendingMicros] = useState<number | undefined>();
  const [crossConnection, setCrossConnection] = useState(false);
  const [crossAttachments, setCrossAttachments] = useState(false);

  const [toolSettings, setToolSettings] = useState<ToolSettings>();
  const [program, setProgram] = useState<ProgramSettings>(defaultProgramSettings);
  const [runtime, setRuntime] = useState<RuntimeSettings>();
  const [history, setHistory] = useState<ExecutionHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string }>();

  useEffect(() => {
    void refreshProvider();
  }, []);

  useEffect(() => {
    if (!registry) return;
    setPref(registry.preference);
    setSpendingMicros(registry.spendingLimitUsdMicros);
    setCrossConnection(registry.crossConnection);
    setCrossAttachments(registry.crossConnectionAttachments);
  }, [registry]);

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      desktop().toolSettings(),
      desktop().runtimeSettings(),
      desktop().executionHistory(),
    ])
      .then(([tools, runtimeSnapshot, runs]) => {
        if (!mounted) return;
        setToolSettings(tools);
        setProgram(tools.programming ?? defaultProgramSettings);
        setRuntime(runtimeSnapshot);
        setHistory(runs);
      })
      .catch((failure) => {
        if (mounted) setFeedback({ error: true, text: errorMessage(failure) });
      });
    return () => {
      mounted = false;
    };
  }, []);

  const run = async (action: () => Promise<void>, success?: string) => {
    setBusy(true);
    setFeedback(undefined);
    try {
      await action();
      if (success) setFeedback({ error: false, text: success });
    } catch (failure) {
      setFeedback({ error: true, text: errorMessage(failure) });
    } finally {
      setBusy(false);
    }
  };

  const saveRegistryPrefs = () => {
    if (!registry) return;
    void run(async () => {
      const saved = await desktop().saveRegistry({
        ...registryDraft(registry),
        preference: pref,
        spendingLimitUsdMicros: spendingMicros,
        crossConnection,
        crossConnectionAttachments: crossConnection && crossAttachments,
      });
      installRegistrySettings(saved);
    }, 'Execution preferences saved.');
  };

  const saveRuntime = () => {
    if (!runtime) return;
    void run(async () => {
      const next = { ...runtime };
      delete next.embeddingTarget;
      setRuntime(await desktop().saveRuntimeSettings(next));
    }, 'Loop executor limits saved.');
  };

  const saveProgram = () => {
    void run(async () => {
      const next = await desktop().setProgramSettings(program);
      setToolSettings(next);
      setProgram(next.programming ?? defaultProgramSettings);
    }, 'Programmatic tool calling settings saved.');
  };

  return (
    <SettingsPage
      title="Conductor"
      description="Your primary chat model owns semantic routing and synthesis. Configure runtime limits, discovery, and activity visibility."
      actions={
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => navigateCategory('integrations')}
        >
          Manage tools
        </Button>
      }
    >
      <SettingsSection id="conductor-status" title="Runtime Status">
        <SettingsGroup>
          <SettingsRow
            label="Managed Chat API"
            description={
              chatStatus.configured
                ? `Primary: ${chatStatus.model}${chatStatus.error ? ` · ${chatStatus.error}` : ''}`
                : chatStatus.error ?? 'Select a primary model in Models to start chatting.'
            }
            highlighted={highlightedSettingId === 'conductor-status'}
          >
            <SettingsStatus
              tone={
                chatStatus.state === 'ready'
                  ? chatStatus.configured
                    ? 'ready'
                    : 'warning'
                  : chatStatus.state === 'failed'
                    ? 'error'
                    : 'neutral'
              }
            >
              {chatStatus.state}
            </SettingsStatus>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(() => desktop().restartChatService(), 'Chat service restarted.')
              }
            >
              <RefreshCw size={13} /> Restart service
            </Button>
          </SettingsRow>
          <SettingsRow
            label="Available capabilities"
            description="Registered tools and skills are discovered progressively by the primary model."
          >
            <SettingsStatus tone="accent">
              {toolSettings
                ? `${toolSettings.tools.filter((t) => t.available).length} / ${toolSettings.tools.length} tools ready`
                : 'Loading…'}
            </SettingsStatus>
          </SettingsRow>
          <SettingsToggle
            id="conductor-activity"
            label="Expand Conductor activity by default"
            description="Show tool execution steps expanded automatically on assistant replies."
            checked={expandActivity}
            highlighted={highlightedSettingId === 'conductor-activity'}
            onChange={(next) => updatePrefs({ expandActivityByDefault: next })}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        id="conductor-preferences"
        title="Execution Preferences"
        description="Control trade-offs, per-turn spending limits, and cross-connection delegation."
      >
        <SettingsGroup>
          <SettingsSelect
            label="Execution preference"
            description="Guidance hint provided to the primary model."
            value={pref}
            disabled={busy || !registry}
            highlighted={highlightedSettingId === 'conductor-preferences'}
            onChange={(value) => setPref(value as RegistryInput['preference'])}
          >
            <option value="balanced">Balanced</option>
            <option value="cost">Lower cost</option>
            <option value="latency">Lower latency</option>
            <option value="quality">Higher quality</option>
          </SettingsSelect>
          <SettingsInput
            label="Spending cap per chat turn (USD)"
            description="Leave blank to disable per-turn USD spend limits."
            type="number"
            min="0.01"
            max="1000"
            step="0.01"
            placeholder="Off"
            disabled={busy || !registry}
            value={spendingMicros === undefined ? '' : spendingMicros / 1_000_000}
            onChange={(event) =>
              setSpendingMicros(
                event.target.value ? Math.round(Number(event.target.value) * 1_000_000) : undefined,
              )
            }
          />
          <SettingsToggle
            label="Allow delegated requests across connections"
            description="Permit Conductor to delegate subtasks to enabled models on other connected providers."
            checked={crossConnection}
            disabled={busy || !registry}
            onChange={(checked) => {
              setCrossConnection(checked);
              if (!checked) setCrossAttachments(false);
            }}
          />
          <SettingsToggle
            label="Allow attachments across connections"
            description="Permit delegated requests on secondary connections to access chat attachments."
            checked={crossAttachments}
            disabled={busy || !registry || !crossConnection}
            onChange={setCrossAttachments}
          />
        </SettingsGroup>
        <div className="settings-footer-bar">
          <Button
            type="button"
            variant="primary"
            disabled={busy || !registry || chatStatus.state !== 'ready'}
            onClick={saveRegistryPrefs}
          >
            Save execution preferences
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="conductor-discovery"
        title="Tool Discovery & Programmatic Calling"
      >
        <SettingsGroup>
          <SettingsSelect
            label="Discovery backend"
            description="Aria discovery works across all models; OpenAI Responses requires a verified official primary model."
            value={toolSettings?.discovery ?? 'aria'}
            disabled={busy || !toolSettings}
            highlighted={highlightedSettingId === 'conductor-discovery'}
            onChange={(value) => {
              const mode = value === 'openai-responses' ? 'openai-responses' : 'aria';
              void run(async () => {
                setToolSettings(await desktop().setToolDiscovery(mode));
              }, 'Discovery backend updated.');
            }}
          >
            <option value="aria">Aria</option>
            <option value="openai-responses">OpenAI Responses</option>
          </SettingsSelect>
          {toolSettings?.discovery === 'openai-responses' && (
            <SettingsAction
              label="OpenAI Tool Search verification"
              description={
                toolSettings.nativeVerified
                  ? 'Verified for the current primary model.'
                  : 'Verification required for the current primary model.'
              }
              actionLabel="Verify OpenAI Tool Search"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setToolSettings(await desktop().setToolDiscovery('openai-responses'));
                }, 'OpenAI Tool Search verified.')
              }
            />
          )}
          <SettingsSelect
            label="Programmatic tool calling backend"
            description="Run bounded deterministic batches via isolated JavaScript or OpenAI Responses."
            value={program.backend}
            disabled={busy}
            onChange={(value) =>
              setProgram({ ...program, backend: value as ProgramSettings['backend'] })
            }
          >
            <option value="off">Off</option>
            <option value="managed">Aria isolated JavaScript</option>
            <option value="openai-responses">OpenAI Responses</option>
          </SettingsSelect>
          {program.backend === 'managed' && (
            <SettingsInput
              label="Program runner image ID"
              placeholder="sha256:…"
              value={program.image ?? ''}
              disabled={busy}
              onChange={(event) =>
                setProgram({ ...program, image: event.target.value.trim() || undefined })
              }
            />
          )}
          {program.backend === 'openai-responses' && (
            <SettingsSelect
              label="OpenAI continuation"
              value={program.continuation}
              disabled={busy}
              onChange={(value) =>
                setProgram({
                  ...program,
                  continuation: value === 'stored' ? 'stored' : 'stateless',
                })
              }
            >
              <option value="stateless">Stateless</option>
              <option value="stored">Allow OpenAI response storage</option>
            </SettingsSelect>
          )}
          {program.backend !== 'off' && (
            <>
              <SettingsInput
                label="Tool calls per program"
                type="number"
                min={1}
                max={12}
                value={program.toolCalls}
                disabled={busy}
                onChange={(event) =>
                  setProgram({ ...program, toolCalls: event.target.valueAsNumber || 1 })
                }
              />
              <SettingsInput
                label="Concurrent calls"
                type="number"
                min={1}
                max={3}
                value={program.parallel}
                disabled={busy}
                onChange={(event) =>
                  setProgram({ ...program, parallel: event.target.valueAsNumber || 1 })
                }
              />
              <SettingsInput
                label="Program timeout (seconds)"
                type="number"
                min={5}
                max={120}
                value={program.milliseconds / 1000}
                disabled={busy}
                onChange={(event) =>
                  setProgram({ ...program, milliseconds: (event.target.valueAsNumber || 5) * 1000 })
                }
              />
            </>
          )}
        </SettingsGroup>
        <div className="settings-footer-bar">
          <Button type="button" size="sm" disabled={busy || !toolSettings} onClick={saveProgram}>
            {program.backend === 'off' ? 'Save program settings' : 'Verify and save program settings'}
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection
        id="conductor-loop"
        title="Loop Executor & Execution Limits"
        description="Bounding controls enforced deterministically on every ConductorLoopExecutor run."
      >
        {runtime && (
          <>
            <SettingsGroup>
              {loopFields.map(({ name, label, min, max, scale = 1 }) => (
                <SettingsInput
                  key={name}
                  label={label}
                  type="number"
                  min={min}
                  max={max}
                  disabled={busy}
                  highlighted={highlightedSettingId === 'conductor-loop'}
                  value={(runtime.loop ?? defaultLoopLimits)[name] / scale}
                  onChange={(event) => {
                    if (Number.isFinite(event.target.valueAsNumber)) {
                      setRuntime({
                        ...runtime,
                        loop: {
                          ...(runtime.loop ?? defaultLoopLimits),
                          [name]: event.target.valueAsNumber * scale,
                        },
                      });
                    }
                  }}
                />
              ))}
            </SettingsGroup>
            <div className="settings-footer-bar">
              <Button type="button" variant="primary" disabled={busy} onClick={saveRuntime}>
                Save loop limits
              </Button>
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        id="conductor-history"
        title="Execution History"
        description="Recent tool, sandbox, and program attempts recorded in the local runtime journal."
        actions={
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void desktop()
                .executionHistory()
                .then(setHistory)
                .catch((failure) => setFeedback({ error: true, text: errorMessage(failure) }))
            }
          >
            <RefreshCw size={13} /> Refresh
          </Button>
        }
      >
        {history.length === 0 ? (
          <p className="settings-inline-note">No execution attempts recorded.</p>
        ) : (
          <SettingsGroup inset>
            <ul className="settings-list-reset">
              {history.slice(0, 20).map((entry) => (
                <li key={entry.id} className="settings-row" style={{ padding: '6px 0' }}>
                  <div className="settings-row-info">
                    <span className="settings-row-label">{entry.operation}</span>
                    <p className="settings-row-description">
                      {new Date(entry.started).toLocaleString()}
                      {entry.elapsed === null ? '' : ` · ${(entry.elapsed / 1000).toFixed(1)} s`}
                      {entry.exitCode === null ? '' : ` · exit ${entry.exitCode}`}
                    </p>
                  </div>
                  <SettingsStatus
                    tone={
                      entry.state === 'completed'
                        ? 'ready'
                        : entry.state === 'failed' || entry.state === 'uncertain'
                          ? 'error'
                          : 'neutral'
                    }
                  >
                    {entry.state}
                  </SettingsStatus>
                </li>
              ))}
            </ul>
          </SettingsGroup>
        )}
      </SettingsSection>

      {feedback && (
        <p
          className={feedback.error ? 'chat-response-error' : 'settings-inline-note'}
          role={feedback.error ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      )}
    </SettingsPage>
  );
}
