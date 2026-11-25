import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Menu, PanelLeftOpen } from 'lucide-react';
import type { SettingsCategoryId } from '@aria/shared';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { Button, IconButton, Modal, Skeleton } from '../ui';
import { SettingsContext } from './SettingsContext';
import { SettingsNavigation } from './SettingsNavigation';
import { SettingsSearch } from './SettingsSearch';
import { SettingsSidebar } from './SettingsSidebar';
import { getCategoryMeta } from './settingsRegistry';

export function SettingsLayout({
  activeCategory,
  highlightedSettingId,
  onSelectCategory,
  onBackToChat,
  children,
}: {
  activeCategory: SettingsCategoryId;
  highlightedSettingId: string | null;
  onSelectCategory: (category: SettingsCategoryId, settingId?: string) => void;
  onBackToChat: () => void;
  children: ReactNode;
}) {
  const sidebarCollapsed = useWorkspaceStore(
    (state) => Boolean(state.data.preferences.settingsSidebarCollapsed),
  );
  const appSidebarCollapsed = useWorkspaceStore(
    (state) => state.data.preferences.chatSidebarCollapsed,
  );
  const updatePreferences = useWorkspaceStore((state) => state.preferences);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [narrow, setNarrow] = useState(window.innerWidth < 900);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeMeta = getCategoryMeta(activeCategory);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    if (!highlightedSettingId) {
      container.scrollTo?.({ top: 0 });
      return;
    }
    let observer: MutationObserver | undefined;
    let targetElement: HTMLElement | null = null;
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    const focusTarget = () => {
      const target = document.getElementById(highlightedSettingId);
      if (!target || !container.contains(target)) return false;
      targetElement = target;
      target.classList.add('settings-search-highlight');
      highlightTimer = setTimeout(() => target.classList.remove('settings-search-highlight'), 2400);
      target.scrollIntoView?.({ block: 'center' });
      const control = target.querySelector<HTMLElement>('button, input, select, textarea, a[href]');
      control?.focus({ preventScroll: true });
      observer?.disconnect();
      return true;
    };
    if (!focusTarget()) {
      observer = new MutationObserver(focusTarget);
      observer.observe(container, { childList: true, subtree: true });
    }
    return () => {
      observer?.disconnect();
      if (highlightTimer) clearTimeout(highlightTimer);
      targetElement?.classList.remove('settings-search-highlight');
    };
  }, [activeCategory, highlightedSettingId]);

  return (
    <SettingsContext.Provider
      value={{
        activeCategory,
        highlightedSettingId,
        navigateCategory: (category, settingId) => {
          setMobileMenuOpen(false);
          onSelectCategory(category, settingId);
        },
      }}
    >
      <div className="settings-shell">
        <header className="settings-header">
          <div className="settings-header-title">
            {(narrow || appSidebarCollapsed) && (
              <IconButton
                label="Open sidebar"
                onClick={() => window.dispatchEvent(new Event('aria:open-sidebar'))}
              >
                <PanelLeftOpen size={18} />
              </IconButton>
            )}
            <div>
              <h1>Settings</h1>
              <p>Manage your Aria experience and preferences.</p>
            </div>
          </div>
          <div className="settings-header-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="settings-mobile-nav-trigger"
              onClick={() => setMobileMenuOpen(true)}
            >
              <Menu size={15} />
              {activeMeta.label}
            </Button>
            <SettingsSearch
              onSelect={(category, settingId) => onSelectCategory(category, settingId)}
            />
            <Button type="button" variant="ghost" size="sm" onClick={onBackToChat}>
              <ArrowLeft size={15} />
              Back to chat
            </Button>
          </div>
        </header>
        <div className="settings-body">
          <SettingsSidebar
            activeCategory={activeCategory}
            collapsed={sidebarCollapsed}
            onSelect={(category) => onSelectCategory(category)}
            onToggleCollapse={() =>
              updatePreferences({ settingsSidebarCollapsed: !sidebarCollapsed })
            }
          />
          <div ref={contentRef} className="settings-content-scroll">
            <Suspense
              fallback={
                <div className="settings-page-card">
                  <Skeleton />
                </div>
              }
            >
              {children}
            </Suspense>
          </div>
        </div>
        <Modal
          open={mobileMenuOpen}
          onOpenChange={setMobileMenuOpen}
          title="Settings categories"
          description="Select a settings section."
        >
          <SettingsNavigation
            activeCategory={activeCategory}
            onSelect={(category) => {
              setMobileMenuOpen(false);
              onSelectCategory(category);
            }}
          />
        </Modal>
      </div>
    </SettingsContext.Provider>
  );
}
