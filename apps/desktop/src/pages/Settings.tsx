import { useState } from 'react';
import { Check, Monitor, Moon, RefreshCw, Sun, Trash2 } from 'lucide-react';
import { useWorkspaceStore, flushPersistence } from '../stores/workspaceStore';
import { useConnectionStore } from '../stores/connectionStore';
import { Badge, Button, ErrorState, Field, Modal } from '../components/ui';
export default function Settings() {
  const preferences = useWorkspaceStore((state) => state.data.preferences);
  const setPreferences = useWorkspaceStore((state) => state.preferences);
  const saveError = useWorkspaceStore((state) => state.saveError);
  const health = useConnectionStore((state) => state.result);
  const checking = useConnectionStore((state) => state.checking);
  const check = useConnectionStore((state) => state.check);
  const [url, setUrl] = useState(preferences.apiUrl);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="page-scroll">
      <div className="settings-page">
        <div className="page-heading">
          <div>
            <span className="eyebrow">MAKE IT YOURS</span>
            <h1>Settings</h1>
            <p>A workspace that works the way you do.</p>
          </div>
        </div>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Appearance</h2>
            <p>Choose how Aria looks on this device.</p>
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
                onClick={() => setPreferences({ theme: theme.id })}
                aria-pressed={preferences.theme === theme.id}
              >
                <theme.icon size={21} />
                <span>{theme.label}</span>
                {preferences.theme === theme.id && <Check size={14} />}
              </button>
            ))}
          </div>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Workspace layout</h2>
            <p>Your panel sizes and visibility are saved automatically.</p>
          </div>
          <label className="settings-toggle">
            <span>Collapse navigation</span>
            <input
              type="checkbox"
              checked={preferences.sidebarCollapsed}
              onChange={(event) => setPreferences({ sidebarCollapsed: event.target.checked })}
            />
          </label>
          <label className="settings-toggle">
            <span>Show orchestration panel</span>
            <input
              type="checkbox"
              checked={preferences.rightOpen}
              onChange={(event) => setPreferences({ rightOpen: event.target.checked })}
            />
          </label>
          <Button
            size="sm"
            onClick={() =>
              setPreferences({
                sidebarCollapsed: false,
                rightOpen: true,
                rightWidth: 384,
                sectionHeights: {},
                collapsedSections: [],
              })
            }
          >
            Reset layout
          </Button>
        </section>
        <section className="settings-section">
          <div className="settings-section-heading row">
            <div>
              <h2>Backend connection</h2>
              <p>Health checks are available. AI services are not implemented.</p>
            </div>
            <Badge tone={health?.reachable ? 'success' : 'neutral'}>
              {health?.reachable ? 'API reachable' : 'Disconnected'}
            </Badge>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setPreferences({ apiUrl: url });
              void check(url);
            }}
          >
            <Field label="API address">
              <input
                type="url"
                required
                value={url}
                maxLength={2000}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="http://localhost:3000"
              />
            </Field>
            <div className="settings-connection-actions">
              <Button type="submit" disabled={checking}>
                <RefreshCw size={14} className={checking ? 'spin' : ''} />
                {checking ? 'Checking…' : 'Save & check connection'}
              </Button>
              <small className="muted">Only /health is requested.</small>
            </div>
          </form>
          {health && (
            <div className={health.reachable ? 'notice' : 'connection-detail'}>
              {health.message}
              <small>Checked {new Date(health.checkedAt).toLocaleTimeString()}</small>
            </div>
          )}
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Keyboard shortcuts</h2>
            <p>Keep your hands on the keyboard.</p>
          </div>
          {[
            ['Search and commands', '⌘ / Ctrl K'],
            ['Focus message composer', '⌘ / Ctrl L'],
            ['Send when supported', 'Enter'],
            ['Insert a new line', 'Shift Enter'],
            ['Close a dialog', 'Esc'],
          ].map(([label, key]) => (
            <div className="shortcut-row" key={label}>
              <span>{label}</span>
              <kbd>{key}</kbd>
            </div>
          ))}
        </section>
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Local data</h2>
            <p>
              Projects, drafts, manual tasks, and plans are stored in Aria’s application data
              directory. Sample content is never saved with your projects.
            </p>
          </div>
          {saveError && <ErrorState message={saveError} retry={() => void flushPersistence()} />}
          <Button variant="danger" onClick={() => setConfirm(true)}>
            <Trash2 size={14} />
            Clear drafts, tasks, and plans
          </Button>
        </section>
        <p className="muted settings-version">Aria Desktop · 0.1.0</p>
      </div>
      <Modal
        open={confirm}
        onOpenChange={setConfirm}
        title="Clear local work?"
        description="This deletes all saved drafts, manual tasks, and plans on this device. Project folders and their files are preserved."
      >
        <div className="dialog-actions">
          <Button onClick={() => setConfirm(false)}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              useWorkspaceStore.setState((state) => ({
                selectedConversationId: null,
                data: { ...state.data, conversations: [], tasks: [], plans: [] },
              }));
              void flushPersistence();
              setConfirm(false);
            }}
          >
            Clear local work
          </Button>
        </div>
      </Modal>
    </div>
  );
}
