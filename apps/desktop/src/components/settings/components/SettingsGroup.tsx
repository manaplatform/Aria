import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export function SettingsGroup({
  children,
  inset = false,
  className,
}: {
  children: ReactNode;
  inset?: boolean;
  className?: string;
}) {
  return (
    <div className={cn(inset ? 'settings-group' : 'settings-rows', className)}>
      {children}
    </div>
  );
}
