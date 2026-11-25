import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export function SettingsStatus({
  tone = 'neutral',
  children,
  role,
}: {
  tone?: 'neutral' | 'ready' | 'warning' | 'error' | 'accent';
  children: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <span className={cn('settings-status-pill', tone !== 'neutral' && tone)} role={role}>
      {children}
    </span>
  );
}
