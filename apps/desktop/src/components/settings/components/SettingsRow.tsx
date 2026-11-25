import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export function SettingsRow({
  id,
  label,
  htmlFor,
  description,
  children,
  stacked = false,
  highlighted = false,
  className,
}: {
  id?: string;
  label: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  children: ReactNode;
  stacked?: boolean;
  highlighted?: boolean;
  className?: string;
}) {
  return (
    <div
      id={id}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn('settings-row', stacked && 'settings-row-stack', className)}
    >
      <div className="settings-row-info">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="settings-row-label">
            {label}
          </label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        {description && <p className="settings-row-description">{description}</p>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
