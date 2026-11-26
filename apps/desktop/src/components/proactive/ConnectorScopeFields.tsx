import { useEffect, useState } from 'react';
import { connectorJobGrant, githubOperations, type ConnectorJobGrant, type ConnectorSnapshot, type GithubOperation } from '@aria/shared';
import { desktop } from '../../services/desktop';

export function connectorScopeFromForm(form: FormData): ConnectorJobGrant | undefined {
  const account = String(form.get('github-connection') ?? '');
  if (!account) return;
  return connectorJobGrant.parse({
    connection: account, generation: Number(form.get('github-generation')),
    repositories: form.getAll('github-repository').map(Number),
    operations: form.getAll('github-operation'),
  });
}

const operations = Object.keys(githubOperations) as GithubOperation[];

function useConnectorSnapshot() {
  const [state, setState] = useState<ConnectorSnapshot>();
  useEffect(() => {
    if (!window.aria?.connectors) return;
    let live = true;
    void desktop().connectors({ action: 'status' }).then((value) => { if (live) setState(value); }, () => {});
    return () => { live = false; };
  }, []);
  return state;
}

export function ConnectorScopeSummary({ value }: { value: ConnectorJobGrant }) {
  const account = useConnectorSnapshot()?.accounts.find((account) => account.id === value.connection);
  return (
    <div className="proactive-content">
      <strong>GitHub · {account?.login ?? 'Connection requires review'}</strong>
      <ul>
        {value.repositories.map((id) => <li key={id}>{account?.repositories.find((repo) => repo.id === id)?.name ?? 'Repository #' + id}</li>)}
        {value.operations.map((operation) => <li key={operation}>{githubOperations[operation].description}</li>)}
      </ul>
    </div>
  );
}

export function ConnectorScopeFields({ value, watchedRepository }: { value?: ConnectorJobGrant; watchedRepository?: number | null }) {
  const state = useConnectorSnapshot();
  const [selected, select] = useState(value?.connection ?? '');
  const connected = state?.accounts.filter((account) => account.state === 'connected' && account.selected.length) ?? [];
  const account = connected.find((account) => account.id === selected);
  if (!connected.length && !value) return null;
  return (
    <fieldset>
      <legend>GitHub scope</legend>
      <label>
        GitHub account
        <select name="github-connection" value={selected} onChange={(event) => select(event.target.value)}>
          <option value="">None</option>
          {connected.map((item) => <option key={item.id} value={item.id}>{item.login}</option>)}
          {selected && !account && <option value={selected}>Connection requires review</option>}
        </select>
      </label>
      {account && <div key={account.id}>
        <input name="github-generation" type="hidden" value={account.generation} />
        <details>
          <summary>Choose repositories</summary>
          {account.repositories.filter((repo) => account.selected.includes(repo.id)).map((repo) => (
            <label key={repo.id}>
              <input name="github-repository" type="checkbox" value={repo.id} defaultChecked={value?.repositories.includes(repo.id)} />
              {repo.name} (#{repo.id})
            </label>
          ))}
        </details>
        {watchedRepository !== undefined && <label>
          Watched repository
          <select name="watchRepository" defaultValue={watchedRepository ?? ''} required>
            <option value="" disabled>Select a repository</option>
            {account.repositories.filter((repo) => account.selected.includes(repo.id)).map((repo) =>
              <option key={repo.id} value={repo.id}>{repo.name}</option>)}
          </select>
        </label>}
        <details>
          <summary>Choose operations</summary>
          {operations.filter((operation) => githubOperations[operation].access === 'read' || account.policy !== 'read_only').map((operation) => (
            <label key={operation}>
              <input name="github-operation" type="checkbox" value={operation} defaultChecked={value?.operations.includes(operation)} />
              {githubOperations[operation].description}
            </label>
          ))}
        </details>
        <p>GitHub writes require approval at execution time.</p>
      </div>}
    </fieldset>
  );
}
