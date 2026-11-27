import { useState } from 'react';
import { personaModes, resolvePersona, type PersonaSettings } from '@aria/shared';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { Button } from '../../ui';
import {
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsTextarea,
  SettingsToggle,
} from '../components';
import { useSettingsNavigation } from '../SettingsContext';
import CommunicationMemory from './CommunicationMemory';

const scales = [
  ['warmth', 'Warmth'],
  ['humor', 'Humor'],
  ['detail', 'Response detail'],
] as const;
const toggles = [
  ['emoji', 'Emoji', 'Use emoji when it fits the conversation.'],
  ['symbols', 'Symbols', 'Use symbols or icons to clarify a reply.'],
  [
    'adaptiveVisuals',
    'Adaptive visuals',
    'Choose charts, diagrams, or interactive controls when they help.',
  ],
  [
    'learnPreferences',
    'Learn preferences',
    'Suggest durable communication preferences for review and use accepted preferences when relevant.',
  ],
] as const;

export default function PersonaControls() {
  const overrides = useWorkspaceStore((state) => state.data.preferences.persona);
  const legacyStyle = useWorkspaceStore((state) => state.data.preferences.responseStyle);
  const update = useWorkspaceStore((state) => state.preferences);
  const { highlightedSettingId } = useSettingsNavigation();
  const [preview, setPreview] = useState(false);
  const persona = resolvePersona(overrides, legacyStyle);

  function set<K extends keyof PersonaSettings>(key: K, value: PersonaSettings[K]) {
    update({ persona: { ...useWorkspaceStore.getState().data.preferences.persona, [key]: value } });
  }
  return (
    <>
      <SettingsSection
        id="persona-modes"
        title="Personality"
        description="Guide how Aria communicates in new chats and replies."
      >
        <SettingsGroup>
          <SettingsSelect
            label="Personality mode"
            value={persona.personality}
            onChange={(value) => {
              const mode = personaModes.find((mode) => mode === value);
              if (mode) set('personality', mode);
            }}
            highlighted={highlightedSettingId === 'persona-modes'}
          >
            {personaModes.map((mode) => (
              <option key={mode}>{mode}</option>
            ))}
          </SettingsSelect>
          {persona.personality === 'Custom' && (
            <SettingsTextarea
              label="Custom personality instructions"
              value={persona.customInstructions}
              maxLength={2000}
              onChange={(event) => set('customInstructions', event.target.value)}
            />
          )}
          {scales.map(([key, label]) => (
            <SettingsRow
              key={key}
              id={key === 'detail' ? 'personalization-style' : 'persona-' + key}
              label={label}
              htmlFor={'persona-range-' + key}
              highlighted={highlightedSettingId === 'personalization-style' && key === 'detail'}
            >
              <span className="persona-controls">
                <input
                  id={'persona-range-' + key}
                  type="range"
                  min={0}
                  max={100}
                  value={persona[key]}
                  onChange={(event) => set(key, event.target.valueAsNumber)}
                />
                <output htmlFor={'persona-range-' + key}>{persona[key]}</output>
              </span>
            </SettingsRow>
          ))}
          {toggles.map(([key, label, description]) => (
            <SettingsToggle
              key={key}
              id={'persona-' + key}
              label={label}
              description={description}
              checked={persona[key]}
              onChange={(value) => set(key, value)}
              highlighted={highlightedSettingId === 'persona-' + key}
            />
          ))}
        </SettingsGroup>
        <div className="settings-footer-bar">
          <Button size="sm" aria-expanded={preview} onClick={() => setPreview(!preview)}>
            {preview ? 'Hide preview' : 'Show preview'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => update({ persona: {}, responseStyle: 'balanced' })}
          >
            Reset Persona defaults
          </Button>
        </div>
        {preview && (
          <div className="persona-card" aria-label="Interactive preference preview">
            <p>
              {persona.emoji && <span aria-hidden="true">👋 </span>}
              {persona.personality}
              {persona.symbols && ' · '}
              {!persona.symbols && ' '}
              {persona.detail}% detail
            </p>
            <label className="persona-field">
              Try response detail
              <input
                type="range"
                min={0}
                max={100}
                value={persona.detail}
                onChange={(event) => set('detail', event.target.valueAsNumber)}
              />
            </label>
            {persona.adaptiveVisuals && (
              <div className="persona-metric">
                <label htmlFor="persona-preview-warmth">Warmth</label>
                <progress id="persona-preview-warmth" value={persona.warmth} max={100} />
              </div>
            )}
            {persona.detail >= 50 && (
              <p>
                Aria uses your settings and the context of each request to choose how to respond.
              </p>
            )}
          </div>
        )}
      </SettingsSection>
      <CommunicationMemory learning={persona.learnPreferences} />
    </>
  );
}
