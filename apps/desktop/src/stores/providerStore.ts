import { create } from 'zustand';
import type { DiscoveredModel, RegistrySettings } from '@aria/shared';
import { desktop, errorMessage } from '../services/desktop';

export type CatalogState = {
  models?: DiscoveredModel[];
  busy?: boolean;
  error?: string;
  verified?: string[];
};

export const useProviderStore = create<{
  settings: RegistrySettings | null;
  loading: boolean;
  error: string;
  catalogs: Record<string, CatalogState>;
}>(() => ({ settings: null, loading: false, error: '', catalogs: {} }));

let generation = 0;
const catalogRevisions = new Map<string, number>();
export function beginCatalogRequest(id: string): number {
  const revision = (catalogRevisions.get(id) ?? 0) + 1;
  catalogRevisions.set(id, revision);
  return revision;
}
export function isCurrentCatalogRequest(id: string, revision: number): boolean {
  return catalogRevisions.get(id) === revision;
}
export function cancelCatalogRequest(id: string, revision: number): void {
  if (!isCurrentCatalogRequest(id, revision)) return;
  beginCatalogRequest(id);
  setConnectionCatalog(id, { busy: false });
}
export function cancelPendingCatalogRequests(): void {
  for (const [id, catalog] of Object.entries(useProviderStore.getState().catalogs)) {
    const revision = catalogRevisions.get(id);
    if (catalog.busy && revision !== undefined) cancelCatalogRequest(id, revision);
  }
}

export function installRegistrySettings(settings: RegistrySettings) {
  generation++;
  useProviderStore.setState({ settings, loading: false, error: '' });
}

export function setConnectionCatalog(connectionId: string, patch: Partial<CatalogState> | null) {
  if (patch === null) beginCatalogRequest(connectionId);
  useProviderStore.setState((state) => ({
    catalogs:
      patch === null
        ? { ...state.catalogs, [connectionId]: {} }
        : { ...state.catalogs, [connectionId]: { ...state.catalogs[connectionId], ...patch } },
  }));
}

export async function refreshProvider(force = false) {
  const existing = useProviderStore.getState();
  if (!force && (existing.settings || existing.loading)) return;
  const current = ++generation;
  useProviderStore.setState({ loading: true, error: '' });
  try {
    const settings = await desktop().registrySettings();
    if (current === generation) installRegistrySettings(settings);
  } catch (error) {
    if (current === generation)
      useProviderStore.setState({ loading: false, error: errorMessage(error) });
  }
}
