import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { SettingsCategoryId } from '@aria/shared';
import { IconButton } from '../ui';
import { SettingsNavigation } from './SettingsNavigation';
import { cn } from '../../lib/utils';

export function SettingsSidebar({
  activeCategory,
  collapsed,
  onSelect,
  onToggleCollapse,
}: {
  activeCategory: SettingsCategoryId;
  collapsed: boolean;
  onSelect: (category: SettingsCategoryId) => void;
  onToggleCollapse: () => void;
}) {
  return (
    <aside
      className={cn('settings-sidebar', collapsed && 'collapsed')}
      aria-label="Settings navigation"
    >
      <div className="settings-sidebar-top">
        {!collapsed && <span>Categories</span>}
        <IconButton
          label={collapsed ? 'Expand settings sidebar' : 'Collapse settings sidebar'}
          onClick={onToggleCollapse}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </IconButton>
      </div>
      <SettingsNavigation activeCategory={activeCategory} collapsed={collapsed} onSelect={onSelect} />
    </aside>
  );
}
