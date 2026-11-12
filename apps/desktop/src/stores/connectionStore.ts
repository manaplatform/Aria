import { create } from 'zustand';
import type { HealthResult } from '@aria/shared';
import { desktop, errorMessage } from '../services/desktop';
let generation = 0;
export const useConnectionStore = create<{
  result: HealthResult | null;
  checking: boolean;
  check: (url: string) => Promise<void>;
}>((set) => ({
  result: null,
  checking: false,
  check: async (url) => {
    const request = ++generation;
    set({ checking: true });
    try {
      const result = await desktop().health(url);
      if (request === generation) set({ result, checking: false });
    } catch (error) {
      if (request === generation)
        set({
          checking: false,
          result: {
            reachable: false,
            message: errorMessage(error),
            checkedAt: new Date().toISOString(),
          },
        });
    }
  },
}));
