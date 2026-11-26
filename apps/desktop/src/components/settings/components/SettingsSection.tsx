import { useId, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';

export function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
  className,
}: {
  id?: string;
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      className={cn('settings-section', className)}
      aria-labelledby={title ? headingId : undefined}
    >
      {(title || description || actions) && (
        <div className="settings-section-heading">
          <div>
            {title && <h3 id={headingId}>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
