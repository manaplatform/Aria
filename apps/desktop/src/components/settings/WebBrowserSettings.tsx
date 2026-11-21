import { useEffect, useState } from 'react';
import { webPolicySchema, type WebSettings } from '@aria/shared';
import { Button, Field } from '../ui';
import { browserCommand, useBrowserStore } from '../../stores/browserStore';
import { errorMessage } from '../../services/desktop';

const toggles = [
  ['enabled', 'Web access'],
  ['aiBrowser', 'Allow Aria to search and browse'],
  ['addressSearch', 'Search Brave from the address bar'],
  ['persistentSiteData', 'Keep personal cookies and site data'],
  ['history', 'Save personal browsing history'],
  ['restoreTabs', 'Restore personal tabs at startup'],
] as const;

export function WebBrowserSettings() {
  const [settings, setSettings] = useState<WebSettings>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const permissions = useBrowserStore((state) => state.state.permissions);
  useEffect(() => {
    if (!window.aria?.webSettings) return;
    let current = true;
    void window.aria
      .webSettings()
      .then((value) => {
        if (current) setSettings(value);
      })
      .catch((error) => {
        if (current) setStatus(errorMessage(error));
      });
    return () => {
      current = false;
    };
  }, []);
  if (!settings) return status ? <p role="alert">{status}</p> : null;
  const save = async () => {
    setBusy(true);
    setStatus('');
    try {
      const policy = webPolicySchema.strip().parse(settings);
      setSettings(await window.aria!.saveWebSettings(policy));
      setStatus('Web & Browser settings saved.');
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section" id="web-browser">
      <div className="settings-section-heading">
        <h2>Web &amp; Browser</h2>
        <p>Configure search, AI browsing, and personal browsing data.</p>
      </div>
      {toggles.map(([name, label]) => (
        <label className="web-setting-toggle" key={name}>
          <input
            type="checkbox"
            checked={settings[name]}
            disabled={busy}
            onChange={(event) => setSettings({ ...settings, [name]: event.target.checked })}
          />
          {label}
        </label>
      ))}
      <p className="muted">
        Aria searches through the Brave website in its browser. Search queries are sent to Brave and
        no search API key is required.
      </p>
      <div className="web-settings-grid">
        {(
          [
            ['searches', 'Searches per turn', 2],
            ['fetches', 'Pages fetched per turn', 4],
            ['screenshots', 'Screenshots per turn', 2],
          ] as const
        ).map(([name, label, max]) => (
          <Field key={name} label={label}>
            <select
              value={settings[name]}
              onChange={(event) => setSettings({ ...settings, [name]: Number(event.target.value) })}
            >
              {Array.from({ length: max }, (_, index) => (
                <option key={index} value={index + 1}>
                  {index + 1}
                </option>
              ))}
            </select>
          </Field>
        ))}
      </div>
      <Button variant="primary" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save Web & Browser'}
      </Button>
      {settings.warning && <p role="alert">{settings.warning}</p>}
      {status && <p role="status">{status}</p>}
      <div className="web-settings-data">
        <Button size="sm" onClick={() => void browserCommand({ kind: 'clear-history' })}>
          Clear browser history
        </Button>
        <Button size="sm" onClick={() => void browserCommand({ kind: 'clear-site-data' })}>
          Clear personal site data
        </Button>
        <Button
          size="sm"
          disabled={!permissions.length}
          onClick={() => void browserCommand({ kind: 'revoke-permissions' })}
        >
          Revoke website permissions
        </Button>
      </div>
      {!!permissions.length && (
        <ul>
          {permissions.map(({ origin, permission }) => (
            <li key={`${origin} ${permission}`}>
              {origin} · {permission}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
