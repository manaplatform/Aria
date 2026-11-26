import type { ConnectorDescriptor, DeviceCode } from '@aria/shared';

export interface ConnectorAdapter<Credentials, Account, Repository, Operation, Arguments, Result> {
  readonly descriptor: ConnectorDescriptor;
  readonly registration: string;
  discoverCapabilities(): ConnectorDescriptor['capabilities'];
  startAuthorization(present: (code: DeviceCode) => Promise<void>, signal: AbortSignal): Promise<Credentials>;
  completeAuthorization(credentials: Credentials, signal: AbortSignal): Promise<Account>;
  validateConnection(connection: string, credentials: Credentials, signal: AbortSignal): Promise<Account>;
  refreshAuthorization(credentials: Credentials, signal: AbortSignal): Promise<Credentials>;
  getAccount(connection: string, credentials: Credentials, signal: AbortSignal): Promise<Account>;
  listPermissions(connection: string, credentials: Credentials, signal: AbortSignal): Promise<Repository[]>;
  invokeCapability(connection: string, credentials: Credentials, repository: Repository, operation: Operation, args: Arguments,
    signal: AbortSignal, onWrite?: { dispatch(): void; accepted(): void }): Promise<Result>;
  disconnect(connection: string): void;
}
