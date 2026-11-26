import {
  githubConnector, type DeviceCode, type GithubArguments, type GithubOperation, type GithubRepository,
} from '@aria/shared';
import type { ConnectorAdapter } from '../adapter';
import { GithubAuthorization, type SavedTokens } from './authorization';
import type { GithubConfig } from './config';
import { GithubClient } from './client';
import { operateGithub } from './operations';

type Account = Awaited<ReturnType<GithubClient['user']>>;
type Result = Awaited<ReturnType<typeof operateGithub>>;

export class GithubAdapter implements ConnectorAdapter<SavedTokens, Account, GithubRepository,
  GithubOperation, GithubArguments<GithubOperation>, Result> {
  readonly descriptor = githubConnector;
  private readonly auth: GithubAuthorization;
  private readonly clients = new Map<string, GithubClient>();

  constructor(readonly config: GithubConfig, private readonly request: typeof fetch) {
    this.auth = new GithubAuthorization(config, request);
  }

  get registration() { return this.auth.registration; }
  get installUrl() { return this.auth.installUrl; }

  discoverCapabilities() { return this.descriptor.capabilities; }
  startAuthorization(present: (code: DeviceCode) => Promise<void>, signal: AbortSignal) {
    return this.auth.authorize(present, signal);
  }

  completeAuthorization(credentials: SavedTokens, signal: AbortSignal) {
    return new GithubClient(this.request).user(credentials.accessToken, signal);
  }

  validateConnection(connection: string, credentials: SavedTokens, signal: AbortSignal) {
    return this.getAccount(connection, credentials, signal);
  }

  refreshAuthorization(credentials: SavedTokens, signal: AbortSignal) {
    return this.auth.refresh(credentials, signal);
  }

  getAccount(connection: string, credentials: SavedTokens, signal: AbortSignal) {
    return this.client(connection).user(credentials.accessToken, signal);
  }

  listPermissions(connection: string, credentials: SavedTokens, signal: AbortSignal) {
    return this.client(connection).repositories(credentials.accessToken, this.config.slug, signal);
  }

  invokeCapability(connection: string, credentials: SavedTokens, repository: GithubRepository,
    operation: GithubOperation, args: GithubArguments<GithubOperation>, signal: AbortSignal, onWrite?: { dispatch(): void; accepted(): void }) {
    return operateGithub(this.client(connection), credentials.accessToken, repository, operation, args, signal, onWrite);
  }

  disconnect(connection: string) {
    this.clients.get(connection)?.invalidate();
    this.clients.delete(connection);
  }

  client(connection: string) {
    const existing = this.clients.get(connection);
    if (existing) return existing;
    const client = new GithubClient(this.request);
    this.clients.set(connection, client);
    return client;
  }
}
