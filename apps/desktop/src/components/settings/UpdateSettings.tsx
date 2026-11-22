import { useEffect, useState } from 'react';
import type { UpdateCommand, UpdateState } from '@aria/shared';
import { Button, Field } from '../ui';

export function UpdateSettings() {
  const [state, setState] = useState<UpdateState>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const bridge = window.aria;
    if (!bridge?.updateState) return;
    let active = true;
    const unsubscribe = bridge.onUpdateState(setState);
    void bridge.updateState().then((snapshot) => {
      if (active) setState(snapshot);
    }).catch(() => {
      if (active) setError('Could not load update settings.');
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  if (!state && !error) return null;

  const perform = (command: UpdateCommand) => {
    setError(undefined);
    void window.aria?.updateCommand(command).catch(() => setError('Could not complete the update action.'));
  };
  const busy = state && ['checking', 'downloading', 'installing'].includes(state.status);
  return (
    <section className="settings-section" id="updates">
      <div className="settings-section-heading">
        <h2>Updates</h2>
        {state && <p>Aria {state.version}</p>}
      </div>
      {state?.status === 'unsupported' ? (
        <p>In-app updates are unavailable in this build.</p>
      ) : state && <>
        <Field label="Release channel">
          <select value={state.channel} disabled={busy} onChange={(event) =>
            perform({ action: 'channel', channel: event.target.value === 'beta' ? 'beta' : 'stable' })}>
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </select>
        </Field>
        <div className="shortcut-row" role="status">
          {state.status === 'current' && 'Aria is up to date.'}
          {state.status === 'checking' && 'Checking for updates…'}
          {state.status === 'available' && `Aria ${state.available} is available.`}
          {state.status === 'downloading' && <progress aria-label="Downloading update" max={100} value={state.progress ?? 0} />}
          {state.status === 'ready' && (state.mode === 'disk-image'
            ? 'Disk image verified. Open it, quit Aria, then drag the new Aria into Applications and choose Replace.'
            : 'The update is ready to install.')}
          {state.status === 'installing' && 'Saving your work and preparing to restart…'}
          {(state.status === 'idle' || state.status === 'current' || state.status === 'error') &&
            <Button onClick={() => perform({ action: 'check' })}>Check for updates</Button>}
          {state.status === 'available' && state.mode !== 'manual' &&
            <Button onClick={() => perform({ action: 'download' })}>Download update</Button>}
          {((state.status === 'available' && state.mode === 'manual') ||
            (state.status === 'error' && state.mode === 'disk-image')) &&
            <Button onClick={() => perform({ action: 'open-release' })}>Open release</Button>}
          {state.status === 'ready' && state.mode === 'install' &&
            <Button onClick={() => perform({ action: 'install' })}>Install and restart</Button>}
          {state.status === 'ready' && state.mode === 'disk-image' &&
            <Button onClick={() => perform({ action: 'open-installer' })}>Open disk image</Button>}
        </div>
        {state.mode === 'disk-image' && <p>macOS releases are ad hoc signed and unnotarized. macOS may ask you to approve the new copy in Privacy &amp; Security.</p>}
      </>}
      {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
    </section>
  );
}
