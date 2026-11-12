import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Check, Monitor, Moon, Sun, UserRound } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button, Field } from '../ui';
import { ModelSettings } from './ModelSettings';

export default function SettingsView() {
  const preferences = useWorkspaceStore((state) => state.data.preferences);
  const update = useWorkspaceStore((state) => state.preferences);
  const [name, setName] = useState(preferences.profileName);
  const navigate = useNavigate();
  const { hash } = useLocation();
  useEffect(() => {
    if (hash === '#ai-models') document.getElementById('ai-models')?.scrollIntoView?.();
  }, [hash]);
  const modifier = window.aria?.platform === 'darwin' ? '⌘' : 'Ctrl';
  return (
    <div className="page-scroll chat-settings">
      <div className="settings-page">
        <Button variant="ghost" size="sm" onClick={() => navigate('/chat')}>
          <ArrowLeft size={14} />
          Back to chat
        </Button>
        <div className="page-heading">
          <div>
            <h1>Make yourself at home.</h1>
            <p>A few preferences to make Aria yours.</p>
          </div>
        </div>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Appearance</h2>
            <p>A comfortable space, day or night.</p>
          </div>
          <div className="theme-options">
            {[
              { id: 'dark' as const, icon: Moon, label: 'Dark' },
              { id: 'light' as const, icon: Sun, label: 'Light' },
              { id: 'system' as const, icon: Monitor, label: 'System' },
            ].map((theme) => (
              <button
                key={theme.id}
                className={`theme-option ${preferences.theme === theme.id ? 'selected' : ''}`}
                onClick={() => update({ theme: theme.id })}
                aria-pressed={preferences.theme === theme.id}
              >
                <theme.icon size={20} />
                <span>{theme.label}</span>
                {preferences.theme === theme.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </section>
        <ModelSettings />
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>
              <UserRound size={17} /> Local profile
            </h2>
            <p>Your display name on this device. No account is required.</p>
          </div>
          <Field label="Display name">
            <input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                const value = name.trim() || 'You';
                setName(value);
                update({ profileName: value });
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </Field>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Keyboard shortcuts</h2>
          </div>
          {[
            ['New chat', `${modifier} Shift O`],
            ['Search conversations', `${modifier} K`],
            ['Focus message composer', `${modifier} L`],
            ['Send message', 'Enter'],
            ['Insert a new line', 'Shift Enter'],
            ['Close a dialog', 'Esc'],
          ].map(([label, shortcut]) => (
            <div className="shortcut-row" key={label}>
              <span>{label}</span>
              <kbd>{shortcut}</kbd>
            </div>
          ))}
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Advanced</h2>
            <p>
              Your previous projects, drafts, files, tasks, and sample workflows remain available in
              the legacy workspace.
            </p>
          </div>
          <Button onClick={() => navigate('/advanced/home')}>
            Open legacy workspace
            <ArrowUpRight size={14} />
          </Button>
        </section>
        <p className="muted settings-version">Aria Desktop · Conversations saved on this device</p>
      </div>
    </div>
  );
}
