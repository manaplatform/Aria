import { useEffect, useState } from 'react';
import {
  githubConnector, githubOperations,
  type ConnectorActivity, type ConnectorCommand, type ConnectorPolicy, type ConnectorSnapshot,
  type GithubAccount, type GithubOperation,
} from '@aria/shared';
import { desktop, errorMessage, openExternal } from '../../../services/desktop';
import { Button } from '../../ui';
import { SettingsSection } from '../components';
import { SettingsPage } from '../SettingsPage';

const stateLabels = {
  connected: 'Connected', needs_repositories: 'Repository access needed',
  reconnect: 'Reconnect required', offline: 'Temporarily unavailable',
};
const policyLabels = { read_only: 'Read only', ask: 'Ask before writing', scoped: 'Scoped authorization' };
const writeGrants = (Object.entries(githubOperations) as [GithubOperation, typeof githubOperations[GithubOperation]][])
  .filter(([, operation]) => operation.access === 'write' && !operation.confirm);
const date = (value: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value);

function GithubAccountPanel({ account, busy, submit }: {
  account: GithubAccount; busy: boolean; submit(command: ConnectorCommand): void;
}) {
  const [selected, setSelected] = useState(account.selected);
  const [policy, setPolicy] = useState(account.policy);
  const [grants, setGrants] = useState(account.grants);
  const [activity, setActivity] = useState<ConnectorActivity[]>();
  const [historyError, setHistoryError] = useState('');
  const authorized = account.repositories.filter((repo) => account.selected.includes(repo.id));

  return (
    <>
      <SettingsSection title={account.login} description="GitHub">
        <div className="aria-connector-account">
          {account.avatar && <img src={account.avatar} alt="" width={44} height={44} referrerPolicy="no-referrer" />}
          <div>
            <strong>{stateLabels[account.state]}</strong>
            {account.reconnectReason === 'device_flow' && <p>Reconnect this account using GitHub’s device verification code, then review your repository access.</p>}
            <p>Connected {date(account.connectedAt)} · Verified {date(account.verifiedAt)}</p>
          </div>
        </div>
        <div className="aria-connector-actions">
          <Button size="sm" disabled={busy || account.state === 'reconnect'} onClick={() => submit({ action: 'verify', id: account.id })}>Test connection</Button>
          <Button size="sm" disabled={busy} onClick={() => submit({ action: 'reconnect', id: account.id })}>Reconnect</Button>
          <Button size="sm" disabled={busy} onClick={() => submit({ action: 'manage', id: account.id })}>Manage repositories on GitHub</Button>
        </div>
      </SettingsSection>
      <SettingsSection title="Authorized repositories" description="Select which GitHub repositories Aria may use with your primary model.">
        {account.repositories.length === 0 && (
          <p>Install Aria Connect on GitHub, select repositories, then test the connection. An organization owner may need to approve the installation.</p>
        )}
        <div className="aria-connector-options">
          {account.repositories.map((repo) => (
            <label key={repo.id}>
              <input type="checkbox" checked={selected.includes(repo.id)} disabled={busy || account.state === 'reconnect'}
                onChange={(event) => setSelected(event.target.checked ?
                  [...selected, repo.id] : selected.filter((item) => item !== repo.id))} />
              <span><strong>{repo.name}</strong> · {repo.private ? 'Private' : 'Public'}
                <small>{Object.entries(repo.permissions).map(([kind, access]) => kind.replaceAll('_', ' ') + ' ' + access).join(' · ')}</small></span>
            </label>
          ))}
        </div>
        <Button size="sm" disabled={busy || account.state === 'reconnect'}
          onClick={() => submit({ action: 'repositories', id: account.id, repositories: selected })}>
          Review repository access
        </Button>
      </SettingsSection>
      <SettingsSection title="Aria permissions" description="GitHub grants are shown above. Aria starts with reads enabled after you review repository access.">
        <label className="aria-connector-select">
          Write policy
          <select value={policy} onChange={(event) => setPolicy(event.target.value as ConnectorPolicy)}>
            {Object.entries(policyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        {policy === 'scoped' && (
          <div className="aria-connector-options">
            {authorized.map((repo) => (
              <fieldset key={repo.id}>
                <legend>{repo.name}</legend>
                {writeGrants.filter(([, item]) => repo.permissions[item.permission] === 'write')
                  .map(([operation, item]) => (
                    <label key={operation}>
                      <input type="checkbox" checked={grants.some((entry) => entry.repository === repo.id && entry.operation === operation)}
                        onChange={(event) => setGrants(event.target.checked ?
                          [...grants, { repository: repo.id, operation }] :
                          grants.filter((entry) => entry.repository !== repo.id || entry.operation !== operation))} />
                      {item.description}
                    </label>
                  ))}
              </fieldset>
            ))}
          </div>
        )}
        <Button size="sm" disabled={busy || account.state !== 'connected'} onClick={() =>
          submit({ action: 'policy', id: account.id, policy, grants })}>Save permissions</Button>
      </SettingsSection>
      <SettingsSection title="Connection activity">
        <div className="aria-connector-actions">
          <Button size="sm" onClick={() => {
            setHistoryError('');
            void desktop().connectorActivity(account.id).then(setActivity, (error: unknown) => setHistoryError(errorMessage(error)));
          }}>View activity</Button>
          <Button size="sm" onClick={() => submit({ action: 'disconnect', id: account.id })} disabled={busy}>Disconnect this device</Button>
          <Button size="sm" variant="danger" onClick={() => submit({ action: 'revoke', id: account.id })} disabled={busy}>Revoke on GitHub</Button>
        </div>
        {historyError && <p role="alert">{historyError}</p>}
        {activity && (activity.length ? (
          <ul className="aria-connector-activity">
            {activity.map((entry, index) => (
              <li key={entry.occurred + '/' + index}>
                <span>{date(entry.occurred)} · {entry.operation.slice(7).replaceAll('_', ' ')} · {entry.state}</span>
                {entry.url && <Button size="sm" variant="ghost" onClick={() => void openExternal(entry.url!).catch((error: unknown) => setHistoryError(errorMessage(error)))}>
                  Open on GitHub
                </Button>}
              </li>
            ))}
          </ul>
        ) : <p>No recent GitHub activity.</p>)}
      </SettingsSection>
    </>
  );
}

export default function ConnectorsSettings() {
  const [state, setState] = useState<ConnectorSnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manage, setManage] = useState(false);
  useEffect(() => {
    if (!window.aria?.connectors) return;
    let live = true;
    const unsubscribe = desktop().onConnectorsChanged(setState);
    void desktop().connectors({ action: 'status' }).then((value) => {
      if (live) setState(value);
    }, (failure: unknown) => { if (live) setError(errorMessage(failure)); });
    return () => { live = false; unsubscribe(); };
  }, []);
  const submit = (command: ConnectorCommand) => {
    setError('');
    setBusy(true);
    void desktop().connectors(command).then((value) => {
      setState(value);
      if (command.action === 'connect' || command.action === 'switch') setManage(true);
    }, (failure: unknown) => setError(errorMessage(failure))).finally(() => setBusy(false));
  };
  const account = state?.accounts.find((account) => account.id === state.active);
  const attempt = state?.attempt;
  return (
    <SettingsPage title="Connectors" description="Give Aria access to the apps you choose.">
      <SettingsSection id="connector-github" title="Available apps">
        <div className="aria-connector-card">
          <img className="aria-github-mark" src={'./' + githubConnector.icon} height={24} width={24} alt="" />
          <div>
            <h3>{githubConnector.name}</h3>
            <p>{githubConnector.description}</p>
            <span role="status">
              {attempt ? attempt.verification ? 'Waiting for GitHub authorization' : 'Preparing or verifying GitHub authorization' :
                account ? stateLabels[account.state] : state?.available ? 'Available to connect' :
                  !state && window.aria?.connectors ? 'Loading GitHub status' : 'Unavailable in this build'}
            </span>
          </div>
          <div className="aria-connector-actions">
            {attempt ? <Button onClick={() => submit({ action: 'cancel', attemptId: attempt.id })}>Cancel</Button> : (
              <>
                <Button variant="primary" onClick={() => submit({ action: 'connect' })}
                  disabled={busy || !state?.available}>{state?.accounts.length ? 'Add account' : 'Connect'}</Button>
                {!!state?.accounts.length && <Button onClick={() => setManage(!manage)} aria-expanded={manage}>Manage</Button>}
              </>
            )}
          </div>
        </div>
        {attempt?.verification && (
          <div className="aria-connector-device" role="region" aria-label="GitHub device verification">
            <p>Enter this code at github.com/login/device in your browser. Use only the code shown here. Never authorize a code someone else sent you.</p>
            <div className="aria-connector-actions">
              <code>{attempt.verification.userCode}</code>
              <Button size="sm" onClick={() => submit({ action: 'copy_code', attemptId: attempt.id })}>Copy code</Button>
              <Button size="sm" onClick={() => submit({ action: 'open_device', attemptId: attempt.id })}>Open GitHub</Button>
            </div>
            <small>Code expires at {new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(attempt.verification.expiresAt)}.</small>
          </div>
        )}
        {(error || state?.error) && <p role="alert">{error || state?.error}</p>}
        {manage && !!state?.accounts.length && (
          <SettingsSection title="Connected accounts">
            <label className="aria-connector-select">
              Active GitHub account
              <select value={state.active ?? ''} onChange={(event) => submit({ action: 'switch', id: event.target.value })} disabled={busy}>
                <option value="" disabled>Select an account</option>
                {state.accounts.map((item) => <option value={item.id} key={item.id}>{item.login}</option>)}
              </select>
            </label>
          </SettingsSection>
        )}
        {manage && account && <GithubAccountPanel key={account.id + '/' + account.generation} account={account} busy={busy || Boolean(attempt)} submit={submit} />}
      </SettingsSection>
    </SettingsPage>
  );
}
