import type { ReactNode } from 'react';
import { Button } from '../../ui';
import { SettingsRow } from './SettingsRow';

export function SettingsAction({
  id,
  label,
  description,
  actionLabel,
  variant = 'secondary',
  disabled = false,
  highlighted = false,
  icon,
  onClick,
  extra,
}: {
  id?: string;
  label: string;
  description?: string;
  actionLabel: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  highlighted?: boolean;
  icon?: ReactNode;
  onClick: () => void;
  extra?: ReactNode;
}) {
  return (
    <SettingsRow id={id} label={label} description={description} highlighted={highlighted}>
      {extra}
      <Button type="button" variant={variant} size="sm" disabled={disabled} onClick={onClick}>
        {icon}
        {actionLabel}
      </Button>
    </SettingsRow>
  );
}
