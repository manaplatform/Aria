import type { ReactNode } from 'react';

export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="settings-page-card">
      <header className="settings-page-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {actions}
      </header>
      {children}
    </div>
  );
}
