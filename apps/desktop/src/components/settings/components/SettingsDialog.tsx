import type { ReactNode } from 'react';
import { Button, Modal } from '../../ui';

export function SettingsDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  busy = false,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  onConfirm?: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description={description}>
      {children}
      <div className="dialog-actions">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </Button>
        {onConfirm && (
          <Button type="button" variant={variant} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        )}
      </div>
    </Modal>
  );
}
