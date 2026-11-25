import { useId } from 'react';
import { SettingsRow } from './SettingsRow';

export function SettingsToggle({
  id,
  label,
  description,
  checked,
  disabled = false,
  highlighted = false,
  onChange,
}: {
  id?: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  highlighted?: boolean;
  onChange: (next: boolean) => void;
}) {
  const controlId = useId();
  return (
    <SettingsRow id={id} label={label} description={description} highlighted={highlighted}>
      <button
        id={controlId}
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={checked}
        disabled={disabled}
        className="settings-switch"
        onClick={() => onChange(!checked)}
      >
        <span className="settings-switch-thumb" aria-hidden="true" />
      </button>
    </SettingsRow>
  );
}
