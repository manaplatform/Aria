import type { ConnectorJobGrant, MemoryJobSource, ChatEvent, ProactiveEvent, ProactiveRequest } from '@aria/shared';

export interface ProactiveHost {
  identity(): { provider: string; revision: string } | undefined;
  run(
    request: ProactiveRequest,
    signal: AbortSignal,
    event: (event: ChatEvent) => void,
  ): Promise<void>;
  changed(event: ProactiveEvent): void;
  notify(category: string, target: NonNullable<ProactiveEvent['target']>): boolean;
  saveMemory?(
    source: MemoryJobSource,
    content: string,
    observedAt: number,
    authorize: () => boolean,
  ): Promise<unknown>;
  removeArtifact?(id: string): Promise<void>;
  exportArtifact?(id: string): Promise<boolean>;
  verifyConnector?(grant: ConnectorJobGrant, provider: string): Promise<void>;
  connectorValid?(grant: ConnectorJobGrant, provider: string): boolean;
  closeJob?(id: string): void;
}
