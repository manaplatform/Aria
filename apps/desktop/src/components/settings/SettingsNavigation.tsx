import type { KeyboardEvent } from 'react';
import type { SettingsCategoryId } from '@aria/shared';
import { settingsCategories, settingsGroups } from './settingsRegistry';
import { cn } from '../../lib/utils';

export function SettingsNavigation({
  activeCategory,
  collapsed = false,
  onSelect,
}: {
  activeCategory: SettingsCategoryId;
  collapsed?: boolean;
  onSelect: (category: SettingsCategoryId) => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-settings-nav-item="true"]'),
    );
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') {
      buttons[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      buttons[buttons.length - 1]?.focus();
      return;
    }
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = current < 0 ? 0 : (current + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <nav className="settings-nav" aria-label="Settings categories" onKeyDown={handleKeyDown}>
      {settingsGroups.map((group) => (
        <div key={group.id} className="settings-nav-group">
          <div className="settings-nav-group-label">{group.label}</div>
          {settingsCategories
            .filter((item) => item.group === group.id)
            .map((item) => {
              const active = activeCategory === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-settings-nav-item="true"
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? item.label : undefined}
                  className={cn('settings-nav-item', active && 'active')}
                  onClick={() => onSelect(item.id)}
                >
                  <item.icon size={18} aria-hidden="true" />
                  <span>{item.label}</span>
                </button>
              );
            })}
        </div>
      ))}
    </nav>
  );
}
