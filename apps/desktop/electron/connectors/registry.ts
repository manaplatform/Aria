import { randomUUID } from 'node:crypto';
import {
  githubOperation, githubOperations, githubResult,
  type CapabilityHostRequest, type ConnectorCommand, type ConnectorInventory, type ConnectorJobGrant,
  type ConnectorSnapshot, type GithubAccount, type GithubRepository, type RuntimeResult,
} from '@aria/shared';
import type { SecretCipher } from '../provider-storage';
import { digest, RuntimeError, type RuntimeStore } from '../runtime/store';
import { GithubAdapter } from './github/adapter';
import { githubVerificationUrl, type SavedTokens } from './github/authorization';
import { githubConfig } from './github/config';
import { GithubError, sanitizeGithubText, segment } from './github/client';
import { ConnectorStore } from './store';

type Scope = Extract<CapabilityHostRequest, { type: 'runtime' }>;
type Artifact = NonNullable<RuntimeResult['artifact']>;
type RegistryHost = {
  open(url: string): Promise<void>;
  copy(code: string): void;
  identity(): { key: string; model: string; endpoint: string } | undefined;
  approve(message: string, detail: string, signal: AbortSignal): Promise<boolean>;
  artifact(scope: Scope, bytes: Buffer, name: string, signal: AbortSignal): Promise<Artifact>;
  changed(): void;
};
type OperationHost = {
  job?: ConnectorJobGrant;
  live(): boolean;
  approval(): void;
  network(): void;
  approve?(fingerprint: string, message: string): Promise<boolean>;
};
const changed = () => new RuntimeError('PERMISSION_DENIED', 'The GitHub connection or execution scope changed. Review access and try again.');
const unavailable = () => new RuntimeError('CAPABILITY_UNAVAILABLE', 'GitHub is unavailable. Check Settings → Connectors.');
const bracket = (text: string) => sanitizeGithubText(text).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
const connectionChanged = (first: GithubAccount, second: GithubAccount | undefined) =>
  !second || first.generation !== second.generation;

export class ConnectorRegistry {
  private readonly github?: GithubAdapter;
  private readonly store?: ConnectorStore;
  private readonly refreshes = new Map<string, Promise<SavedTokens>>();
  private readonly epochs = new Map<string, AbortController>();
  private readonly verified = new Map<string, number>();
  private readonly writes = new Set<string>();
  private readonly listeners = new Set<(inventory: ConnectorInventory) => void>();
  private attempt?: { view: NonNullable<ConnectorSnapshot['attempt']>; controller: AbortController };
  private lastError: string | null = null;

  constructor(
    config: unknown, runtime: RuntimeStore, cipher: SecretCipher, private readonly host: RegistryHost,
    request: typeof fetch = (url, options) => fetch(url, options),
  ) {
    const parsed = githubConfig.safeParse(config);
    if (parsed.success) {
      this.github = new GithubAdapter(parsed.data, request);
      this.store = new ConnectorStore(runtime, cipher, this.github.registration);
    }
    this.runtime = runtime;
  }

  private readonly runtime: RuntimeStore;
  private get enabled() {
    if (!this.github || !this.store) throw unavailable();
    return { github: this.github, store: this.store };
  }

  private epoch(id: string) {
    const existing = this.epochs.get(id);
    if (existing) return existing.signal;
    const epoch = new AbortController();
    this.epochs.set(id, epoch);
    return epoch.signal;
  }

  private fence(id: string) {
    this.epochs.get(id)?.abort();
    this.epochs.delete(id);
    this.verified.delete(id);
    this.github?.disconnect(id);
  }

  private account(id?: string) {
    const { store } = this.enabled;
    const selected = id ?? store.active();
    const account = selected && store.account(selected);
    if (!account) throw unavailable();
    return account;
  }

  snapshot(): ConnectorSnapshot {
    const accounts = this.store?.accounts() ?? [];
    const active = this.store?.active() ?? null;
    return { available: Boolean(this.store), active, accounts, error: this.lastError,
      attempt: this.attempt?.view ?? null };
  }

  inventory(): ConnectorInventory {
    const active = this.store?.active() ?? null;
    const account = active && this.store?.account(active);
    const primary = this.host.identity()?.key;
    const readable = Boolean(account && primary && account.state === 'connected' && account.selected.length &&
      this.store?.approvedPrimary(account.id) === primary);
    return { active, readable, writable: Boolean(readable && account && account.policy !== 'read_only') };
  }

  subscribe(listener: (inventory: ConnectorInventory) => void) {
    this.listeners.add(listener);
    listener(this.inventory());
    return () => { this.listeners.delete(listener); };
  }

  private emit() {
    const inventory = this.inventory();
    for (const listener of this.listeners) listener(inventory);
    this.host.changed();
  }

  private message(error: unknown) {
    return error instanceof RuntimeError ? error.message : 'Aria could not verify GitHub access. Try again from Settings.';
  }

  async command(command: ConnectorCommand): Promise<ConnectorSnapshot> {
    if (command.action === 'status') return this.snapshot();
    this.lastError = null;
    try {
      const { github, store } = this.enabled;
      if ('attemptId' in command) {
        const attempt = this.attempt?.view;
        if (!attempt || attempt.id !== command.attemptId) return this.snapshot();
        if (command.action === 'cancel') this.cancelAuthorization();
        else if (attempt.phase === 'waiting' && attempt.verification.expiresAt > Date.now()) {
          if (command.action === 'copy_code') this.host.copy(attempt.verification.userCode);
          else await this.host.open(githubVerificationUrl);
        }
      } else if (command.action === 'connect' || command.action === 'reconnect') {
        this.start(command.action === 'reconnect' ? this.account(command.id) : undefined);
      } else if ('id' in command) {
        const account = this.account(command.id);
        if (command.action === 'switch') {
          const previous = store.active();
          if (previous && previous !== account.id) this.fence(previous);
          store.select(account.id);
        } else if (command.action === 'disconnect' || command.action === 'revoke') {
          if (command.action === 'revoke') {
            const approved = await this.host.approve('Disconnect and open GitHub settings?',
              'Aria will disconnect ' + account.login +
              ' on this device. In GitHub, sign in as this account and revoke Aria Connect to remove access across devices.',
              AbortSignal.timeout(120_000));
            if (!approved) return this.snapshot();
            if (connectionChanged(account, store.account(account.id))) throw changed();
          }
          this.cancelAuthorization();
          this.fence(account.id);
          store.remove(account.id);
          if (command.action === 'revoke') {
            this.emit();
            await this.host.open('https://github.com/settings/apps/authorizations').catch(() => {
              this.lastError = 'Aria disconnected this device. Open GitHub Settings → Applications → Authorized GitHub Apps to revoke access.';
            });
          }
        } else if (command.action === 'manage') {
          await this.host.open(account.repositories.length ? 'https://github.com/settings/installations' : github.installUrl);
        } else if (command.action === 'verify') {
          const signal = AbortSignal.any([this.epoch(account.id), AbortSignal.timeout(30_000)]);
          await this.verify(account, signal, true);
        } else if (command.action === 'repositories') {
          const signal = AbortSignal.any([this.epoch(account.id), AbortSignal.timeout(120_000)]);
          const current = await this.verify(account, signal, true);
          const selected = [...new Set(command.repositories)];
          const repositories = selected.map((id) => current.repositories.find((item) => item.id === id));
          if (repositories.some((repository) => !repository)) throw changed();
          const primary = this.host.identity();
          if (selected.length && !primary)
            throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'Configure an Aria primary model before authorizing GitHub repositories.');
          if (selected.length && primary && !await this.host.approve(
            'Allow the selected primary to use GitHub?',
            'GitHub account: ' + current.login + '\nModel: ' + bracket(primary.model) + '\nEndpoint: ' +
              bracket(primary.endpoint) + '\nRepositories:\n' + repositories.map((repository) => repository?.name).join('\n'),
            signal,
          )) return this.snapshot();
          signal.throwIfAborted();
          if (this.host.identity()?.key !== primary?.key || connectionChanged(current, store.account(current.id))) throw changed();
          this.runtime.transaction(() => {
            store.update({ ...current, selected, state: selected.length ? 'connected' : 'needs_repositories',
              generation: current.generation + 1, grants: current.grants.filter((grant) => selected.includes(grant.repository)) });
            if (primary) store.setApprovedPrimary(account.id, primary.key);
          });
          this.fence(account.id);
        } else if (command.action === 'policy') {
          const primary = this.host.identity();
          if (command.policy !== 'read_only' && (!primary || store.approvedPrimary(account.id) !== primary.key))
            throw new RuntimeError('PERMISSION_DENIED', 'Review the selected repositories for this primary model first.');
          const grants = command.policy === 'scoped' ? command.grants : [];
          if (grants.some((grant) => !account.selected.includes(grant.repository) ||
            githubOperations[grant.operation].confirm || githubOperations[grant.operation].access !== 'write'))
            throw new RuntimeError('INVALID_ARGUMENT', 'Persistent grants require an authorized repository and an eligible write.');
          if (command.policy !== 'read_only') {
            const permissions = command.policy === 'ask' ? 'Review each write before sending.' :
              grants.map((grant) => (account.repositories.find((item) => item.id === grant.repository)?.name ?? '') +
                ' · ' + githubOperations[grant.operation].description).join('\n');
            const signal = AbortSignal.any([this.epoch(account.id), AbortSignal.timeout(120_000)]);
            if (!await this.host.approve('Change GitHub write permissions?', account.login + '\n' + permissions, signal))
              return this.snapshot();
            signal.throwIfAborted();
          }
          if (connectionChanged(account, store.account(account.id)) || this.host.identity()?.key !== primary?.key) throw changed();
          this.runtime.transaction(() => {
            store.update({ ...account, policy: command.policy, grants, generation: account.generation + 1 });
            if (primary) store.setGrantsPrimary(account.id, primary.key);
          });
          this.fence(account.id);
        }
      }
    } catch (error) {
      this.lastError = this.message(error);
    }
    this.emit();
    return this.snapshot();
  }

  history(id: string) { return this.store?.history(id) ?? []; }

  cancelAuthorization() {
    this.attempt?.controller.abort();
    this.attempt = undefined;
  }

  private start(expected?: GithubAccount) {
    const { github, store } = this.enabled;
    this.cancelAuthorization();
    const controller = new AbortController();
    const attemptId = randomUUID();
    const attempt: NonNullable<ConnectorRegistry['attempt']> = { view: { id: attemptId, phase: 'starting' }, controller };
    const signal = controller.signal;
    this.attempt = attempt;
    void (async () => {
      if (!await store.available())
        throw new RuntimeError('PERMISSION_DENIED', 'Unlock the OS-backed credential store before connecting GitHub.');
      signal.throwIfAborted();
      const pair = await github.startAuthorization(async (code) => {
        signal.throwIfAborted();
        attempt.view = { id: attemptId, phase: 'waiting', verification: code };
        this.emit();
        await this.host.open(githubVerificationUrl).catch(() => {
          if (this.attempt !== attempt || signal.aborted) return;
          this.lastError = 'Aria could not open your browser. Open GitHub from this panel or visit github.com/login/device.';
          this.emit();
        });
      }, signal);
      signal.throwIfAborted();
      attempt.view = { id: attemptId, phase: 'verifying' };
      this.lastError = null;
      this.emit();
      const verification = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const user = await github.completeAuthorization(pair, verification);
      const existing = store.accounts().find((item) => item.userId === user.id);
      if (expected && (user.id !== expected.userId || existing?.id !== expected.id))
        throw new RuntimeError('PERMISSION_DENIED', 'GitHub selected a different account. Reconnect using the original account, or choose Connect to add another.');
      if (expected && connectionChanged(expected, existing)) throw changed();
      if (!existing && store.accounts().length >= 12)
        throw new RuntimeError('BUDGET_EXCEEDED', 'Disconnect an existing GitHub account before adding another.');
      const id = existing?.id ?? randomUUID();
      github.client(id).invalidate();
      const repositories = await github.listPermissions(id, pair, verification);
      const sealed = await store.seal(pair);
      if (this.attempt !== attempt || verification.aborted ||
          (existing && connectionChanged(existing, store.account(existing.id)))) throw changed();
      const previous = store.active();
      if (previous) this.fence(previous);
      if (existing && existing.id !== previous) this.fence(existing.id);
      store.put({
        id, userId: user.id, login: user.login, avatar: user.avatar,
        connectedAt: existing?.connectedAt ?? Date.now(), verifiedAt: Date.now(),
        generation: (existing?.generation ?? 0) + 1, state: 'needs_repositories',
        selected: existing?.selected.filter((id) => repositories.some((repo) => repo.id === id)) ?? [],
        repositories, policy: 'read_only', grants: [],
      }, sealed);
    })().catch((error: unknown) => {
      if (this.attempt === attempt && !signal.aborted) this.lastError = this.message(error);
    }).finally(() => {
      if (this.attempt === attempt) {
        this.attempt = undefined;
        this.emit();
      }
    });
  }

  private revokeLocal(account: GithubAccount) {
    const { store } = this.enabled;
    const current = store.account(account.id);
    if (!current || current.generation !== account.generation || current.state === 'reconnect') return;
    this.fence(account.id);
    store.remove(account.id, { ...current, generation: current.generation + 1, state: 'reconnect', repositories: [], selected: [], grants: [] });
    this.emit();
  }

  private async credentials(account: GithubAccount, signal: AbortSignal, force = false) {
    const { github, store } = this.enabled;
    signal.throwIfAborted();
    if (account.state === 'reconnect') throw new GithubError('PERMISSION_DENIED', 'Reconnect this GitHub account from Settings.', 'AUTH_EXPIRED');
    const pair = await store.tokens(account.id);
    signal.throwIfAborted();
    if (!pair || connectionChanged(account, store.account(account.id))) throw changed();
    if (!force && pair.expiresAt > Date.now() + 60_000) return pair;
    if (pair.refreshExpiresAt <= Date.now()) {
      this.revokeLocal(account);
      throw new GithubError('PERMISSION_DENIED', 'GitHub authorization expired. Reconnect from Settings.', 'AUTH_EXPIRED');
    }
    const pending = this.refreshes.get(account.id);
    if (pending) return pending;
    const refresh = (async () => {
      const refreshSignal = AbortSignal.any([this.epoch(account.id), AbortSignal.timeout(15_000)]);
      try {
        const latest = await store.tokens(account.id);
        if (!latest || connectionChanged(account, store.account(account.id))) throw changed();
        if (latest.refreshToken !== pair.refreshToken) return latest;
        const updated = await github.refreshAuthorization(latest, refreshSignal);
        const sealed = await store.seal(updated);
        refreshSignal.throwIfAborted();
        if (!store.rotate(account, sealed)) throw changed();
        github.client(account.id).invalidate();
        return updated;
      } catch (error) {
        if (error instanceof GithubError && error.category === 'AUTH_EXPIRED') this.revokeLocal(account);
        throw error;
      }
    })();
    this.refreshes.set(account.id, refresh);
    return refresh.finally(() => { if (this.refreshes.get(account.id) === refresh) this.refreshes.delete(account.id); });
  }

  private async verify(account: GithubAccount, signal: AbortSignal, fresh: boolean) {
    const { github, store } = this.enabled;
    if (!fresh && (this.verified.get(account.id) ?? 0) > Date.now() - 60_000) return account;
    const client = github.client(account.id);
    let pair = await this.credentials(account, signal);
    const user = await github.validateConnection(account.id, pair, signal).catch(async (error: unknown) => {
      if (!(error instanceof GithubError) || error.category !== 'AUTH_REJECTED') throw error;
      pair = await this.credentials(account, signal, true);
      client.invalidate();
      return github.validateConnection(account.id, pair, signal);
    }).catch((error: unknown) => {
      if (error instanceof GithubError && error.category === 'AUTH_REJECTED') this.revokeLocal(account);
      throw error;
    });
    if (user.id !== account.userId) { this.revokeLocal(account); throw changed(); }
    const repositories = await github.listPermissions(account.id, pair, signal);
    signal.throwIfAborted();
    const current = store.account(account.id);
    if (connectionChanged(account, current) || !current) throw changed();
    const selected = current.selected.filter((id) => repositories.some((repo) => repo.id === id));
    const changedPermissions = current.selected.some((id) => {
      const previous = current.repositories.find((item) => item.id === id);
      const next = repositories.find((item) => item.id === id);
      return !previous || !next || previous.installation !== next.installation || previous.name !== next.name ||
        previous.private !== next.private || previous.writeAccess !== next.writeAccess ||
        JSON.stringify(previous.permissions) !== JSON.stringify(next.permissions);
    });
    const updated = { ...current, login: user.login, avatar: user.avatar, verifiedAt: Date.now(), repositories, selected,
      state: selected.length && current.state === 'connected' ? 'connected' as const : 'needs_repositories' as const,
      ...(changedPermissions && { generation: current.generation + 1,
        grants: current.grants.filter((grant) => selected.includes(grant.repository)) }),
    };
    store.update(updated);
    if (changedPermissions) {
      this.fence(account.id);
      this.emit();
    } else this.verified.set(account.id, Date.now());
    return updated;
  }

  jobValid(grant: ConnectorJobGrant, primary: string) {
    const account = this.store?.account(grant.connection);
    return Boolean(account?.state === 'connected' && account.generation === grant.generation &&
      this.store?.approvedPrimary(grant.connection) === primary &&
      grant.repositories.every((repo) => account.selected.includes(repo)) &&
      grant.operations.every((operation) => githubOperations[operation].access === 'read' || account.policy !== 'read_only'));
  }

  async verifyJob(grant: ConnectorJobGrant, primary: string) {
    if (!this.jobValid(grant, primary)) throw changed();
    const account = this.account(grant.connection);
    await this.verify(account, AbortSignal.any([this.epoch(account.id), AbortSignal.timeout(25_000)]), false);
    if (!this.jobValid(grant, primary)) throw changed();
  }

  release(request: string) { this.turns.delete(request); }
  private readonly turns = new Map<string, { connection: string; repository?: number; privateInventory?: boolean }>();

  async dispatch(scope: Scope, parent: AbortSignal, host: OperationHost): Promise<RuntimeResult> {
    const operation = githubOperation.parse(scope.operation);
    const { github, store } = this.enabled;
    const descriptor = github.discoverCapabilities()[operation];
    const input = descriptor.input.safeParse(scope.input);
    if (!input.success || scope.programId || scope.voiceSessionId) throw new RuntimeError('INVALID_ARGUMENT', 'GitHub requires a valid direct operation.');
    const account = this.account(host.job?.connection);
    const primary = this.host.identity()?.key;
    const previous = this.turns.get(scope.requestId);
    if (account.state !== 'connected' || previous && previous.connection !== account.id || !primary || store.approvedPrimary(account.id) !== primary) throw changed();
    const signal = AbortSignal.any([parent, this.epoch(account.id)]);
    const assertLive = () => {
      signal.throwIfAborted();
      if (!host.live() || this.host.identity()?.key !== primary || connectionChanged(account, store.account(account.id)) ||
          (host.job ? !this.jobValid(host.job, primary) || !host.job.operations.includes(operation) : store.active() !== account.id))
        throw changed();
    };
    assertLive();
    const current = await this.verify(account, signal, descriptor.access === 'write');
    assertLive();
    const selected = current.repositories.filter((item) => current.selected.includes(item.id) &&
      (!host.job || host.job.repositories.includes(item.id)) &&
      (!previous?.repository || item.id === previous.repository));
    const repositoryRef = 'repository' in input.data ? input.data.repository : undefined;
    const repository = selected.find((item) => typeof repositoryRef === 'number' ?
      item.id === repositoryRef : item.name.toLowerCase() === repositoryRef?.toLowerCase());
    if (repositoryRef && !repository) throw new RuntimeError('PERMISSION_DENIED', 'This repository is outside the approved GitHub scope. Check Settings → Connectors.');
    this.turns.set(scope.requestId, { connection: account.id,
      repository: previous?.repository ?? (repository?.private ? repository.id : undefined),
      privateInventory: previous?.privateInventory || !repository && selected.some((item) => item.private) });
    if (!repository) {
      const page = 'page' in input.data ? input.data.page ?? 1 : 1;
      const query = 'query' in input.data && typeof input.data.query === 'string' ? input.data.query.toLowerCase() : '';
      const matches = selected.filter((item) => (item.name + ' ' + (item.description ?? '')).toLowerCase().includes(query));
      const items = matches.slice((page - 1) * 15, page * 15).map(({ id, name, private: restricted, defaultBranch }) =>
        ({ id, name, private: restricted, defaultBranch }));
      return { privateContent: items.some((item) => item.private), data: githubResult.parse({
        account: current.login, connection: current.id, content: JSON.stringify(items), verified: true,
        nextPage: page * 15 < matches.length ? page + 1 : undefined,
      }) };
    }

    const level = repository.permissions[descriptor.permission];
    if (!level || descriptor.access === 'write' && (level !== 'write' || account.policy === 'read_only'))
      throw new RuntimeError('PERMISSION_DENIED', 'The GitHub App, repository role, or Aria policy does not allow this operation.');
    const client = github.client(account.id);
    const repoUrl = 'https://github.com/' + repository.name.split('/').map(segment).join('/');
    const handle = async (target: GithubRepository) => {
      const credentials = await this.credentials(current, signal);
      let dispatched = false;
      let accepted = false;
      const args = { ...input.data };
      Reflect.deleteProperty(args, 'repository');
      const fingerprint = digest(JSON.stringify([account.id, target.id, operation, args]));
      const record = (state: 'completed' | 'failed' | 'uncertain', url?: string) => {
        if (dispatched) this.runtime.settleDispatch(scope.conversationId, scope.assistantMessageId, scope.requestId, fingerprint, state);
        store.activity(account.id, target.id, operation, state, url);
      };
      try {
        assertLive();
        const providerRepo = await client.json(credentials.accessToken, '/repos/' + target.name.split('/').map(segment).join('/'), signal);
        if (!providerRepo.value || typeof providerRepo.value !== 'object' || !('id' in providerRepo.value) || providerRepo.value.id !== target.id)
          throw new RuntimeError('INVALID_REFERENCE', 'The GitHub repository identity changed. Review repository access.');
        assertLive();
        const result = await github.invokeCapability(account.id, credentials, target, operation, input.data, signal,
          descriptor.access === 'write' ? {
            dispatch: () => {
              assertLive();
              if (!this.runtime.reserveDispatch(scope.conversationId, scope.assistantMessageId, scope.requestId, fingerprint,
                undefined, { id: operation, stepId: scope.stepId, callId: scope.callId, revision: scope.revision }))
                throw new RuntimeError('DUPLICATE_DISPATCH', 'Check the earlier GitHub operation before trying again.');
              dispatched = true;
              host.network();
            },
            accepted: () => { accepted = true; },
          } : undefined,
        );
        assertLive();
        const url = repoUrl + (result.suffix ?? '');
        const artifact = result.asset && await this.host.artifact(scope, result.asset.bytes, result.asset.name, signal);
        const text = result.text ?? (result.value === undefined ? undefined : JSON.stringify(result.value));
        const data = githubResult.parse({
          account: current.login, connection: current.id, repository: target.name, repositoryId: target.id, url,
          content: text === undefined ? undefined : sanitizeGithubText(text).slice(0, 8000),
          observation: result.observation,
          nextPage: result.nextPage, nextOffset: result.nextOffset, partial: result.partial || Boolean(text && text.length > 8000),
          verified: result.verified !== false,
        });
        record(data.verified ? 'completed' : 'uncertain', url);
        return { data, privateContent: target.private, artifact,
          ...(!data.verified && { commandProblem: { code: 'OUTCOME_UNCERTAIN' as const, message: 'GitHub accepted the request but the effect is not yet verified. Inspect the target before retrying.' } }) };
      } catch (error) {
        if (dispatched) {
          const rejected = !accepted && error instanceof GithubError && ['PROVIDER_VALIDATION', 'PROVIDER_PERMISSION', 'PROVIDER_REJECTED', 'NOT_FOUND', 'RATE_LIMIT', 'AUTH_REJECTED', 'ORGANIZATION_SSO'].includes(error.category);
          record(rejected ? 'failed' : 'uncertain', repoUrl);
          if (!rejected) throw new GithubError('OUTCOME_UNCERTAIN', 'Verify the GitHub target before attempting another write.', 'OUTCOME_UNCERTAIN');
        }
        if (error instanceof GithubError && error.category === 'AUTH_REJECTED') this.revokeLocal(account);
        if (error instanceof RuntimeError) throw error;
        signal.throwIfAborted();
        throw new RuntimeError('EXECUTION_FAILED', 'Aria could not verify this GitHub operation.');
      }
    };
    if (descriptor.access === 'read') return handle(repository);

    const key = account.id + '/' + repository.id;
    if (this.writes.has(key)) throw new RuntimeError('DUPLICATE_DISPATCH', 'Another GitHub write is active for this repository.');
    this.writes.add(key);
    try {
      const persistent = !host.job && !descriptor.confirm && !previous?.privateInventory && !previous?.repository && account.policy === 'scoped' &&
        store.grantsPrimary(account.id) === primary && account.grants.some((grant) =>
          grant.repository === repository.id && grant.operation === operation);
      if (!persistent) {
        host.approval();
        const detail = 'GitHub account: ' + current.login + '\nRepository: ' + repository.name + '\n' +
          bracket(JSON.stringify(input.data, null, 2));
        const fingerprint = digest(JSON.stringify([current.id, current.generation, primary, repository.id, operation, input.data]));
        const approved = host.approve ? await host.approve(fingerprint, descriptor.description + '\n' + detail)
          : await this.host.approve(descriptor.description, detail, signal);
        if (!approved) throw new RuntimeError('CANCELLED', 'The GitHub write requires approval.');
      }
      assertLive();
      if (!persistent) {
        const refreshed = await this.verify(current, signal, true);
        assertLive();
        if (!refreshed.repositories.some((item) => item.id === repository.id)) throw changed();
      }
      return await handle(repository);
    } finally { this.writes.delete(key); }
  }
}
