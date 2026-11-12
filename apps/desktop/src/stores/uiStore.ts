import { create } from 'zustand';
export const useUiStore = create<{
  notification: { id: number; message: string; error: boolean } | null;
  notify: (message: string, error?: boolean) => void;
  dismiss: () => void;
}>((set) => ({
  notification: null,
  notify: (message, error = false) => set({ notification: { id: Date.now(), message, error } }),
  dismiss: () => set({ notification: null }),
}));
export const notify = (message: string, error = false): void =>
  useUiStore.getState().notify(message, error);
