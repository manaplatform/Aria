import { lazy, useEffect } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { settingsCategorySchema, type SettingsCategoryId } from '@aria/shared';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { cancelPendingCatalogRequests } from '../../stores/providerStore';
import { SettingsLayout } from './SettingsLayout';
import { resolveSettingsHash } from './settingsRegistry';

const pages = {
  general: lazy(() => import('./pages/GeneralSettings')),
  appearance: lazy(() => import('./pages/AppearanceSettings')),
  personalization: lazy(() => import('./pages/PersonalizationSettings')),
  notifications: lazy(() => import('./pages/NotificationSettings')),
  providers: lazy(() => import('./pages/ProviderSettings')),
  models: lazy(() => import('./pages/ModelSettings')),
  proactive: lazy(() => import('./pages/ProactiveAssistantSettings')),
  conductor: lazy(() => import('./pages/ConductorSettings')),
  memory: lazy(() => import('./pages/MemorySettings')),
  integrations: lazy(() => import('./pages/IntegrationSettings')),
  browser: lazy(() => import('./pages/BrowserSettings')),
  desktop: lazy(() => import('./pages/DesktopSettings')),
  storage: lazy(() => import('./pages/StorageSettings')),
  privacy: lazy(() => import('./pages/PrivacySettings')),
  shortcuts: lazy(() => import('./pages/ShortcutSettings')),
  advanced: lazy(() => import('./pages/AdvancedSettings')),
  about: lazy(() => import('./pages/AboutSettings')),
};

export default function SettingsView() {
  const navigate = useNavigate();
  const location = useLocation();
  const { category } = useParams();
  const savedCategory = useWorkspaceStore((state) => state.data.preferences.settingsCategory);
  const update = useWorkspaceStore((state) => state.preferences);
  const legacy = resolveSettingsHash(location.hash);
  const parsed = settingsCategorySchema.safeParse(category);
  const active = legacy?.category ?? (parsed.success ? parsed.data : savedCategory ?? 'general');
  const target = legacy?.settingId ?? (location.state as { settingId?: string } | null)?.settingId ?? null;
  const Page = pages[active];
  useEffect(() => {
    if (savedCategory !== active) update({ settingsCategory: active });
  }, [active, savedCategory, update]);
  const select = (next: SettingsCategoryId, settingId?: string) => {
    if (next !== active) cancelPendingCatalogRequests();
    if (savedCategory !== next) update({ settingsCategory: next });
    navigate(`/settings/${next}`, { state: settingId ? { settingId } : null });
  };
  return <SettingsLayout activeCategory={active} highlightedSettingId={target} onSelectCategory={select} onBackToChat={() => navigate('/chat')}><Page /></SettingsLayout>;
}
