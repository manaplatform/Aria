import { useEffect, useRef, useState } from 'react';
import { Check, RefreshCw, Square } from 'lucide-react';
import type {
  GenerationMode,
  ModelSelections,
  ProviderModel,
  ProviderSettings,
} from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { generating, stopAllChats, useChatStore } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { refreshProvider } from '../../stores/providerStore';
import { useLiveVoiceStore } from '../../stores/liveVoiceStore';
import { Badge, Button, ErrorState, Field, Skeleton } from '../ui';
import { ModelSelect, modeLabels } from './ModelSelect';
const modes: GenerationMode[] = ['chat', 'image', 'speech', 'transcription', 'live'];
const empty: ModelSelections = { chat: '', image: '', speech: '', transcription: '', live: '' };
export function ModelSettings() {
  const status = useChatStore((state) => state.status);
  const active = useWorkspaceStore((state) => state.data.chat.messages.some(generating));
  const live = useLiveVoiceStore((state) => state.phase !== 'idle');
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [models, setModels] = useState<ModelSelections>(empty);
  const [catalog, setCatalog] = useState<ProviderModel[] | null>(null);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [verified, setVerified] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reload, setReload] = useState(0);
  const sequence = useRef(0);
  useEffect(() => {
    let alive = true;
    const request = ++sequence.current;
    setError('');
    void desktop()
      .providerSettings()
      .then(async (value) => {
        if (!alive) return;
        setSettings(value);
        setBaseUrl(value.baseUrl);
        setModels(value.models);
        setSystemPrompt(value.systemPrompt);
        if (value.keyConfigured) {
          setLoading(true);
          try {
            const result = await desktop().providerModels();
            if (alive && request === sequence.current) setCatalog(result);
          } catch (failure) {
            if (alive && request === sequence.current) setError(errorMessage(failure));
          } finally {
            if (alive && request === sequence.current) setLoading(false);
          }
        }
      })
      .catch((failure) => {
        if (alive) setError(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, [reload]);
  const locked = busy || active || live || status.state === 'starting';
  const managed = (field: keyof ProviderSettings['sources']) =>
    settings?.sources[field] === 'environment';
  const changed = () => {
    setVerified(false);
    setFeedback('');
    setDirty(true);
  };
  const invalidate = () => {
    ++sequence.current;
    setCatalog(null);
    setLoading(false);
    setError('');
    changed();
  };
  const operation = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setFeedback('');
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const load = async () => {
    const request = ++sequence.current;
    setLoading(true);
    setCatalog(null);
    setError('');
    try {
      const result = await desktop().providerModels({
        provider: 'openai',
        baseUrl,
        ...(key ? { apiKey: key } : {}),
        removeKey,
      });
      if (request === sequence.current) setCatalog(result);
    } catch (failure) {
      if (request === sequence.current) setError(errorMessage(failure));
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };
  return (
    <section className="settings-section" aria-label="Model settings">
      <div className="settings-section-heading spread">
        <div>
          <h2>Model connection</h2>
          <p>Connect OpenAI and choose models available to your account.</p>
        </div>
        <Badge tone={verified ? 'success' : 'neutral'}>
          {verified && status.state === 'ready'
            ? 'Connection tested'
            : status.state === 'starting'
              ? 'Starting…'
              : status.state === 'failed'
                ? 'Service unavailable'
                : status.configured ||
                    (settings?.keyConfigured && Object.values(settings.models).some(Boolean))
                  ? 'Configured'
                  : 'Setup needed'}
        </Badge>
      </div>
      {!settings && !error && <Skeleton />}
      {error && (
        <ErrorState message={error} retry={!settings ? () => setReload((v) => v + 1) : undefined} />
      )}
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (locked) return;
            void operation(async () => {
              try {
                const saved = await desktop().saveProviderSettings({
                  provider: 'openai',
                  baseUrl,
                  model: models.chat,
                  models,
                  systemPrompt,
                  ...(key ? { apiKey: key } : {}),
                  removeKey,
                });
                setSettings(saved);
                setModels(saved.models);
                setBaseUrl(saved.baseUrl);
                setSystemPrompt(saved.systemPrompt);
                setRemoveKey(false);
                setDirty(false);
                setVerified(false);
                setFeedback('Model settings saved.');
                await refreshProvider();
              } catch (failure) {
                setCatalog(null);
                ++sequence.current;
                throw failure;
              } finally {
                setKey('');
              }
            });
          }}
        >
          <Field label="Provider">
            <select aria-label="Provider" defaultValue="openai" disabled={locked}>
              <option value="openai">OpenAI</option>
            </select>
          </Field>
          <Field
            label={`Provider endpoint${managed('baseUrl') ? ' · managed by environment' : ''}`}
          >
            <input
              type="url"
              required
              value={baseUrl}
              maxLength={2000}
              disabled={locked || managed('baseUrl')}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                invalidate();
              }}
            />
          </Field>
          <Field label={`API key${managed('apiKey') ? ' · managed by environment' : ''}`}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              maxLength={16000}
              placeholder={
                settings.keyConfigured
                  ? 'A key is configured · enter a new key to replace it'
                  : 'Enter your OpenAI API key'
              }
              disabled={locked || managed('apiKey') || !settings.encryptionAvailable}
              onChange={(event) => {
                setKey(event.target.value);
                setRemoveKey(false);
                invalidate();
              }}
            />
          </Field>
          <p className="settings-help">
            Saved keys are encrypted using your operating system and never included in conversation
            data.
          </p>
          {!settings.encryptionAvailable && (
            <p className="chat-response-error">
              System encryption is unavailable. Unlock your credential store to save an API key, or
              configure OPENAI_API_KEY in the environment.
            </p>
          )}
          {settings.keyConfigured && !managed('apiKey') && (
            <label className="settings-toggle">
              <span>Remove saved API key when saving</span>
              <input
                type="checkbox"
                checked={removeKey}
                disabled={locked}
                onChange={(event) => {
                  setRemoveKey(event.target.checked);
                  setKey('');
                  invalidate();
                }}
              />
            </label>
          )}
          <Button
            type="button"
            disabled={locked || loading || removeKey || (!key.trim() && !settings.keyConfigured)}
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
            {loading ? 'Loading models…' : catalog ? 'Refresh models' : 'Load models'}
          </Button>
          {catalog && catalog.length === 0 && (
            <p className="settings-help" role="status">
              This endpoint returned no available models. Check API-key permissions and try again.
            </p>
          )}
          {!catalog && !loading && (
            <p className="settings-help">
              Load models after entering your endpoint and key. No model IDs need to be typed.
            </p>
          )}
          <div className="model-defaults">
            {modes.map((mode) => (
              <Field
                key={mode}
                label={`${modeLabels[mode]} model${mode === 'chat' && managed('model') ? ' · managed by environment' : ''}`}
              >
                <ModelSelect
                  mode={mode}
                  models={catalog || []}
                  value={models[mode]}
                  disabled={locked || !catalog || loading || (mode === 'chat' && managed('model'))}
                  onChange={(id) => {
                    setModels((current) => ({ ...current, [mode]: id }));
                    changed();
                  }}
                />
              </Field>
            ))}
          </div>
          <p className="settings-help">
            Only fetched models can be selected. Model groups are suggestions; custom endpoints must
            support the chosen operation. GPT-Live also requires a Chat model. Deprecated Speech API
            models retire January 6, 2027.
          </p>
          <Field
            label={`System instructions${managed('systemPrompt') ? ' · managed by environment' : ''}`}
          >
            <textarea
              rows={3}
              value={systemPrompt}
              maxLength={16000}
              placeholder="Leave blank to use Aria’s helpful assistant instructions."
              disabled={locked || managed('systemPrompt')}
              onChange={(event) => {
                setSystemPrompt(event.target.value);
                changed();
              }}
            />
          </Field>
          <div className="settings-provider-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={
                locked || loading || (!removeKey && Object.values(models).some(Boolean) && !catalog)
              }
            >
              {busy ? 'Working…' : 'Save & reconnect'}
            </Button>
            <Button
              type="button"
              disabled={locked || dirty || !status.configured || status.state !== 'ready'}
              onClick={() =>
                void operation(async () => {
                  await desktop().testProvider();
                  setVerified(true);
                  setFeedback('Your provider responded successfully.');
                })
              }
            >
              <Check size={14} />
              Test connection
            </Button>
          </div>
          <p className="settings-help">
            Testing sends a short message using your saved Chat model.
          </p>
        </form>
      )}
      {(active || live) && (
        <div className="notice">
          <span>Stop current responses and end voice before changing the connection.</span>
          <Button size="sm" onClick={() => void stopAllChats()}>
            <Square size={12} />
            Stop responses
          </Button>
        </div>
      )}
      {status.state === 'failed' && (
        <div className="connection-detail">
          <p>{status.error}</p>
          <Button
            size="sm"
            disabled={locked}
            onClick={() => void operation(() => desktop().restartChatService())}
          >
            <RefreshCw size={14} />
            Restart chat service
          </Button>
        </div>
      )}
      {feedback && (
        <p className="settings-feedback" role="status">
          <Check size={14} />
          {feedback}
        </p>
      )}
    </section>
  );
}
