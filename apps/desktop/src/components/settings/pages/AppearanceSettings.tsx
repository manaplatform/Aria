import { Check, Monitor, Moon, Sun } from 'lucide-react';
import type { AccentColor, FontSize, InterfaceDensity, MotionPreference } from '@aria/shared';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { SettingsPage } from '../SettingsPage';
import { useSettingsNavigation } from '../SettingsContext';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from '../components';

const themes = [
  { id: 'light' as const, icon: Sun, label: 'Light' },
  { id: 'dark' as const, icon: Moon, label: 'Dark' },
  { id: 'system' as const, icon: Monitor, label: 'System' },
];

const accents: { id: AccentColor; label: string; color: string }[] = [
  { id: 'violet', label: 'Violet', color: '#7650d9' },
  { id: 'blue', label: 'Blue', color: '#2f6fe4' },
  { id: 'teal', label: 'Teal', color: '#0f8a75' },
  { id: 'emerald', label: 'Emerald', color: '#18834f' },
  { id: 'amber', label: 'Amber', color: '#b36b09' },
  { id: 'rose', label: 'Rose', color: '#c73c59' },
];

export default function AppearanceSettings() {
  const preferences = useWorkspaceStore((state) => state.data.preferences);
  const update = useWorkspaceStore((state) => state.preferences);
  const { highlightedSettingId } = useSettingsNavigation();
  const accent = preferences.accentColor ?? 'violet';

  return (
    <SettingsPage
      title="Appearance"
      description="Choose how Aria looks across light, dark, and system themes."
    >
      <SettingsSection
        id="appearance-theme"
        title="Theme"
        description="Switch immediately or follow your operating system preference."
      >
        <div
          className="settings-theme-cards"
          data-highlighted={highlightedSettingId === 'appearance-theme' ? 'true' : undefined}
        >
          {themes.map((theme) => {
            const selected = preferences.theme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                className={`settings-theme-card ${selected ? 'selected' : ''}`}
                aria-pressed={selected}
                onClick={() => update({ theme: theme.id })}
              >
                <theme.icon size={18} aria-hidden="true" />
                <span>{theme.label}</span>
                <span className="settings-radio-dot" aria-hidden="true">
                  {selected && <Check size={11} />}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title="Color & Typography">
        <SettingsGroup>
          <SettingsRow
            id="appearance-accent"
            label="Accent color"
            description="Used for active navigation items, switches, and focus indicators."
            stacked
            highlighted={highlightedSettingId === 'appearance-accent'}
          >
            <div className="settings-swatch-list" role="radiogroup" aria-label="Accent color">
              {accents.map((item) => {
                const selected = accent === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`settings-swatch ${selected ? 'selected' : ''}`}
                    onClick={() => update({ accentColor: item.id })}
                  >
                    <span
                      className="settings-swatch-dot"
                      style={{ background: item.color }}
                      aria-hidden="true"
                    />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </SettingsRow>
          <SettingsSelect
            id="appearance-font-size"
            label="Interface font size"
            description="Adjust interface text sizing across conversations and settings."
            value={preferences.fontSize ?? 'default'}
            highlighted={highlightedSettingId === 'appearance-font-size'}
            onChange={(value) => update({ fontSize: value as FontSize })}
          >
            <option value="small">Small</option>
            <option value="default">Default</option>
            <option value="large">Large</option>
          </SettingsSelect>
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Layout & Motion">
        <SettingsGroup>
          <SettingsSelect
            id="appearance-density"
            label="Interface density"
            description="Control vertical spacing inside settings lists and rows."
            value={preferences.density ?? 'comfortable'}
            highlighted={highlightedSettingId === 'appearance-density'}
            onChange={(value) => update({ density: value as InterfaceDensity })}
          >
            <option value="compact">Compact</option>
            <option value="comfortable">Comfortable</option>
            <option value="spacious">Spacious</option>
          </SettingsSelect>
          <SettingsSelect
            id="appearance-motion"
            label="Animation preferences"
            description="Follow system reduced-motion settings or explicitly minimize UI transitions."
            value={preferences.reducedMotion ?? 'system'}
            highlighted={highlightedSettingId === 'appearance-motion'}
            onChange={(value) => update({ reducedMotion: value as MotionPreference })}
          >
            <option value="system">Follow system</option>
            <option value="reduced">Reduced motion</option>
            <option value="full">Full animations</option>
          </SettingsSelect>
        </SettingsGroup>
      </SettingsSection>
    </SettingsPage>
  );
}
