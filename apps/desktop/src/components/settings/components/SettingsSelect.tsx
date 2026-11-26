import { useId, type ReactNode } from 'react';
import { SettingsRow } from './SettingsRow';

export function SettingsSelect({
  id,
  label,
  description,
  value,
  disabled = false,
  highlighted = false,
  onChange,
  children,
}: {
  id?: string;
  label: string;
  description?: string;
  value: string;
  disabled?: boolean;
  highlighted?: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  const selectId = useId();
  return (
    <SettingsRow
      id={id}
      label={label}
      htmlFor={selectId}
      description={description}
      highlighted={highlighted}
    >
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </SettingsRow>
  );
}
