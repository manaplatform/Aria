import { useEffect, useState } from 'react';
import { Check, RefreshCw, Square } from 'lucide-react';
import type { ProviderSettings } from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { generating, stopAllChats, useChatStore } from '../../stores/chatStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Badge, Button, ErrorState, Field, Skeleton } from '../ui';

export function ModelSettings() {
  const status = useChatStore((state) => state.status);
  const active = useWorkspaceStore((state) => state.data.chat.messages.some(generating));
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [verified, setVerified] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setError('');
    void desktop()
      .providerSettings()
      .then((value) => {
        if (alive) {
          setSettings(value);
          setBaseUrl(value.baseUrl);
          setModel(value.model);
          setSystemPrompt(value.systemPrompt);
        }
      })
      .catch((failure) => {
        if (alive) setError(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, [reload]);
  useEffect(() => {
    if (status.state !== 'ready') setVerified(false);
  }, [status.state]);
  const locked = busy || active || status.state === 'starting';
  const fromEnvironment = (field: keyof ProviderSettings['sources']) =>
    settings?.sources[field] === 'environment';
  const changed = () => {
    setVerified(false);
    setFeedback('');
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
  return (
    <section className="settings-section" aria-label="Model settings">
      <div className="settings-section-heading spread">
        <div>
          <h2>Model connection</h2>
          <p>Bring your own OpenAI-compatible provider.</p>
        </div>
        <Badge tone={verified ? 'success' : 'neutral'}>
          {verified
            ? 'Connection tested'
            : status.state === 'starting'
              ? 'Starting…'
              : status.state === 'failed'
                ? 'Service unavailable'
                : status.configured
                  ? 'Configured'
                  : 'Setup needed'}
        </Badge>
      </div>
      {!settings && !error && <Skeleton />}
      {error && (
        <ErrorState
          message={error}
          retry={!settings ? () => setReload((value) => value + 1) : undefined}
        />
      )}
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (locked) return;
            void operation(async () => {
              try {
                const saved = await desktop().saveProviderSettings({
                  baseUrl,
                  model,
                  systemPrompt,
                  ...(key ? { apiKey: key } : {}),
                  removeKey,
                });
                setSettings(saved);
                setRemoveKey(false);
                setVerified(false);
                setFeedback('Model settings saved.');
              } finally {
                setKey('');
              }
            });
          }}
        >
          <Field
            label={`Provider endpoint${fromEnvironment('baseUrl') ? ' · managed by environment' : ''}`}
          >
            <input
              type="url"
              required
              value={baseUrl}
              maxLength={2000}
              disabled={locked || fromEnvironment('baseUrl')}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                changed();
              }}
            />
          </Field>
          <Field label={`Model${fromEnvironment('model') ? ' · managed by environment' : ''}`}>
            <input
              required
              value={model}
              maxLength={200}
              placeholder="Enter your provider’s model ID"
              disabled={locked || fromEnvironment('model')}
              onChange={(event) => {
                setModel(event.target.value);
                changed();
              }}
            />
          </Field>
          <Field label={`API key${fromEnvironment('apiKey') ? ' · managed by environment' : ''}`}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              maxLength={16000}
              placeholder={
                settings.keyConfigured
                  ? 'A key is configured · enter a new key to replace it'
                  : 'Enter your provider API key'
              }
              disabled={locked || fromEnvironment('apiKey') || !settings.encryptionAvailable}
              onChange={(event) => {
                setKey(event.target.value);
                setRemoveKey(false);
                changed();
              }}
            />
          </Field>
          <p className="settings-help">
            The saved key is encrypted using your operating system. It is never included in
            conversation data.
          </p>
          {!settings.encryptionAvailable && (
            <p className="chat-response-error">
              System encryption is unavailable. Unlock your credential store to save an API key, or
              configure OPENAI_API_KEY in the environment.
            </p>
          )}
          {settings.keyConfigured && !fromEnvironment('apiKey') && (
            <label className="settings-toggle">
              <span>Remove saved API key when saving</span>
              <input
                type="checkbox"
                checked={removeKey}
                disabled={locked}
                onChange={(event) => {
                  setRemoveKey(event.target.checked);
                  setKey('');
                  changed();
                }}
              />
            </label>
          )}
          <Field
            label={`System instructions${fromEnvironment('systemPrompt') ? ' · managed by environment' : ''}`}
          >
            <textarea
              rows={3}
              value={systemPrompt}
              maxLength={16000}
              placeholder="Leave blank to use Aria’s helpful assistant instructions."
              disabled={locked || fromEnvironment('systemPrompt')}
              onChange={(event) => {
                setSystemPrompt(event.target.value);
                changed();
              }}
            />
          </Field>
          <div className="settings-provider-actions">
            <Button type="submit" variant="primary" disabled={locked}>
              {busy ? 'Working…' : 'Save & reconnect'}
            </Button>
            <Button
              type="button"
              disabled={locked || !status.configured || status.state !== 'ready'}
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
            Testing sends a short message to your configured provider.
          </p>
        </form>
      )}
      {active && (
        <div className="notice">
          <span>Stop current responses before changing the connection.</span>
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
