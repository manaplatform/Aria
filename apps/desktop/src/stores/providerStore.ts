import { create } from 'zustand';
import type {
  GenerationMode,
  ModelSelections,
  ProviderModel,
  ProviderSettings,
} from '@aria/shared';
import { desktop, errorMessage } from '../services/desktop';
const defaults: ModelSelections = { chat: '', image: '', speech: '', transcription: '', live: '' };
interface ProviderState {
  settings: ProviderSettings | null;
  models: ProviderModel[];
  selections: ModelSelections;
  loading: boolean;
  error: string;
  select: (mode: GenerationMode, id: string) => void;
}
export const useProviderStore = create<ProviderState>((set) => ({
  settings: null,
  models: [],
  selections: defaults,
  loading: false,
  error: '',
  select: (mode, id) => set((state) => ({ selections: { ...state.selections, [mode]: id } })),
}));
let revision = 0;
export async function refreshProvider() {
  const current = ++revision;
  useProviderStore.setState({ loading: true, error: '', models: [] });
  try {
    const settings = await desktop().providerSettings();
    if (current !== revision) return;
    useProviderStore.setState({
      settings,
      selections: {
        ...defaults,
        ...settings.models,
        chat: settings.models?.chat || settings.model,
      },
    });
    const models = settings.keyConfigured ? await desktop().providerModels() : [];
    if (current === revision) useProviderStore.setState({ models, loading: false });
  } catch (error) {
    if (current === revision)
      useProviderStore.setState({ loading: false, error: errorMessage(error), models: [] });
  }
}
