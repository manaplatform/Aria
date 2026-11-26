import { createContext, useContext } from 'react';
import type { SettingsCategoryId } from '@aria/shared';

export interface SettingsContextValue {
  activeCategory: SettingsCategoryId;
  highlightedSettingId: string | null;
  navigateCategory: (category: SettingsCategoryId, settingId?: string) => void;
}

export const SettingsContext = createContext<SettingsContextValue>({
  activeCategory: 'general',
  highlightedSettingId: null,
  navigateCategory: () => undefined,
});

export function useSettingsNavigation() {
  return useContext(SettingsContext);
}
