import { create } from 'zustand';
import type { RegistrySettings } from '@aria/shared';
import { desktop, errorMessage } from '../services/desktop';

export const useProviderStore = create<{
  settings: RegistrySettings | null;
  loading: boolean;
  error: string;
}>(() => ({ settings: null, loading: false, error: '' }));

let generation = 0;
export function installRegistrySettings(settings: RegistrySettings) {
  generation++;
  useProviderStore.setState({ settings, loading: false, error: '' });
}
export async function refreshProvider() {
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
