import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { SkillPreview, ToolSettings as Settings } from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { Button } from '../ui';
import { KnowledgeSettings } from './KnowledgeSettings';
import { RuntimeSettings } from './RuntimeSettings';
import { ProgramSettings } from './ProgramSettings';

export function ToolSettings() {
  const [settings, setSettings] = useState<Settings>();
  const [preview, setPreview] = useState<SkillPreview | null>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => desktop().toolSettings())
      .then((value) => {
        if (active) setSettings(value);
      })
      .catch((failure) => {
        if (active) setError(errorMessage(failure));
      });
    return () => {
      active = false;
    };
  }, []);

  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <RuntimeSettings />
      <KnowledgeSettings />
      <section className="settings-section" id="tools">
        <div className="settings-section-heading">
          <h2>Tools</h2>
        </div>
        {error && <p role="alert">{error}</p>}
        {!settings && !error && <p className="muted">Loading tools and skills…</p>}
        {settings && (
          <>
            <ProgramSettings settings={settings} onSaved={setSettings} />
            <div className="shortcut-row">
              <label htmlFor="tool-discovery">Discovery backend</label>
              <select
                id="tool-discovery"
                value={settings.discovery}
                disabled={busy}
                onChange={(event) => {
                  const mode =
                    event.target.value === 'openai-responses' ? 'openai-responses' : 'aria';
                  void perform(async () => setSettings(await desktop().setToolDiscovery(mode)));
                }}
              >
                <option value="aria">Aria</option>
                <option value="openai-responses">OpenAI Responses</option>
              </select>
            </div>
            {settings.discovery === 'openai-responses' && (
              <div className="shortcut-row">
                <span>
                  {settings.nativeVerified
                    ? 'Verified for the current primary model'
                    : 'Verification required for the current primary model'}
                </span>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      setSettings(await desktop().setToolDiscovery('openai-responses')),
                    )
                  }
                >
                  Verify OpenAI Tool Search
                </Button>
              </div>
            )}
            {settings.tools.map((tool) => (
              <div className="shortcut-row" key={tool.id}>
                <div>
                  <strong>{tool.name}</strong>
                  <p className="muted">{tool.description}</p>
                  <small>{tool.permission}</small>
                  {tool.programmatic?.length ? (
                    <small>Program calling · {tool.programmatic.map((backend) =>
                      backend === 'managed' ? 'Aria' : 'OpenAI Responses').join(', ')}</small>
                  ) : null}
                  {tool.reason && <p className="muted">{tool.reason}</p>}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  aria-label={`${tool.reason?.startsWith('Disabled') ? 'Enable' : 'Disable'} ${tool.name}`}
                  onClick={() =>
                    void perform(async () =>
                      setSettings(
                        await desktop().setToolEnabled(
                          tool.id,
                          Boolean(tool.reason?.startsWith('Disabled')),
                        ),
                      ),
                    )
                  }
                >
                  {tool.reason?.startsWith('Disabled') ? 'Enable' : 'Disable'}
                </Button>
              </div>
            ))}
            <div className="shortcut-row">
              <Link to="/settings#ai-models">Configure models</Link>
              <Link to="/settings#web-browser">Configure AI Browser</Link>
            </div>
          </>
        )}
      </section>
      <section className="settings-section" id="skills">
        <div className="settings-section-heading">
          <h2>Skills</h2>
        </div>
        <div className="shortcut-row">
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void perform(async () => setPreview(await desktop().previewSkill('directory')))
            }
          >
            Choose skill folder
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void perform(async () => setPreview(await desktop().previewSkill('zip')))
            }
          >
            Choose skill ZIP
          </Button>
        </div>
        {preview && (
          <div className="settings-section" role="group" aria-label="Review skill bundle">
            <strong>{preview.skill.name}</strong>
            <p>{preview.skill.description}</p>
            <small>Local bundle · {preview.skill.version.slice(0, 12)}</small>
            {preview.skill.compatibility && <p className="muted">{preview.skill.compatibility}</p>}
            <details>
              <summary>Review instructions and resources</summary>
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {preview.instructions}
              </p>
              {preview.resources.length > 0 && (
                <ul>
                  {preview.resources.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              )}
            </details>
            <p className="muted">
              When used, this skill can send its instructions and approved text resources to your
              configured primary model.
            </p>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  setSettings(await desktop().approveSkill(preview.token));
                  setPreview(null);
                })
              }
            >
              Approve and install
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
        )}
        {settings?.skills.map((skill) => (
          <div className="shortcut-row" key={`${skill.id}/${skill.version}`}>
            <div>
              <strong>{skill.name}</strong>
              <p className="muted">{skill.description}</p>
              <small>
                {skill.provenance === 'builtin' ? 'Built in' : 'Approved local bundle'} ·{' '}
                {skill.version.slice(0, 12)}
              </small>
              {skill.dependencies.length > 0 && (
                <p className="muted">Dependencies {skill.dependencies.join(', ')}</p>
              )}
            </div>
            <div>
              <Button
                size="sm"
                disabled={busy}
                variant="ghost"
                aria-label={`${skill.enabled ? 'Disable' : 'Enable'} ${skill.name}`}
                onClick={() =>
                  void perform(async () =>
                    setSettings(
                      await desktop().manageSkill(
                        { id: skill.id, version: skill.version },
                        skill.enabled ? 'disable' : 'enable',
                      ),
                    ),
                  )
                }
              >
                {skill.enabled ? 'Disable' : 'Enable'}
              </Button>
              {skill.provenance === 'local' && (
                <Button
                  size="sm"
                  disabled={busy}
                  variant="ghost"
                  aria-label={`Remove ${skill.name}`}
                  onClick={() =>
                    void perform(async () =>
                      setSettings(
                        await desktop().manageSkill(
                          { id: skill.id, version: skill.version },
                          'remove',
                        ),
                      ),
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
