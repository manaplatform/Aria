import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';
import { AlertCircle, Check, ChevronDown, Copy, Inbox, LoaderCircle, X } from 'lucide-react';
import type { Status } from '@aria/shared';
import { copyText, errorMessage } from '../../services/desktop';
import { notify, useUiStore } from '../../stores/uiStore';
export { cn } from '../../lib/utils';
const buttonStyles = cva(
  'button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        primary: 'button-primary',
        secondary: 'button-secondary',
        ghost: 'button-ghost',
        danger: 'button-danger',
      },
      size: { sm: 'button-sm', md: '', icon: 'button-icon' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonStyles>
>(({ variant, size, className, ...props }, ref) => (
  <button ref={ref} className={cn(buttonStyles({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }): ReactNode {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="tooltip-trigger">
          <Button variant="ghost" size="icon" aria-label={label} {...props}>
            {children}
          </Button>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6}>
          {label}
          <Tooltip.Arrow />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export const TooltipProvider = Tooltip.Provider;
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: string;
}): ReactNode {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function StatusIndicator({
  status,
  label = true,
}: {
  status: Status;
  label?: boolean;
}): ReactNode {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot">
        {status === 'running' && <LoaderCircle size={10} className="spin" />}
      </span>
      {label && <span>{status.charAt(0).toUpperCase() + status.slice(1)}</span>}
    </span>
  );
}
export function ProgressBar({ value, label }: { value: number; label: string }): ReactNode {
  return (
    <div
      className="progress-track"
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}): ReactNode {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <Inbox size={25} />}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }): ReactNode {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
      {retry && (
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
export function Skeleton(): ReactNode {
  return (
    <div className="skeleton" aria-label="Loading">
      <span />
      <span />
      <span />
    </div>
  );
}
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  className = '',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={cn('dialog-content', className)}>
          <div className="dialog-heading">
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Close dialog">
                <X size={17} />
              </Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Menu({
  label,
  trigger,
  children,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <Button variant="ghost" aria-label={label}>
          {trigger}
          <ChevronDown size={13} />
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="dropdown" sideOffset={8} align="start">
          {children}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
export function MenuItem({
  children,
  onSelect,
}: {
  children: ReactNode;
  onSelect: () => void;
}): ReactNode {
  return (
    <Dropdown.Item className="dropdown-item" onSelect={onSelect}>
      {children}
    </Dropdown.Item>
  );
}
export function Tabs({
  value,
  onChange,
  items,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  items: { id: string; label: ReactNode }[];
  label: string;
}): ReactNode {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onChange}>
      <TabsPrimitive.List className="tabs" aria-label={label}>
        {items.map((item) => (
          <TabsPrimitive.Trigger className="tab" value={item.id} key={item.id}>
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): ReactNode {
  return (
    <IconButton
      label={label}
      onClick={() => {
        void copyText(text)
          .then(() => notify('Copied to clipboard'))
          .catch((error) => notify(errorMessage(error), true));
      }}
    >
      <Copy size={14} />
    </IconButton>
  );
}
export function Toast(): ReactNode {
  const notification = useUiStore((state) => state.notification);
  const dismiss = useUiStore((state) => state.dismiss);
  useEffect(() => {
    if (notification && !notification.error) {
      const timer = setTimeout(dismiss, 4000);
      return () => clearTimeout(timer);
    }
  }, [notification, dismiss]);
  if (!notification) return null;
  return (
    <div
      className={cn('toast', notification.error && 'toast-error')}
      role={notification.error ? 'alert' : 'status'}
    >
      {notification.error ? <AlertCircle size={16} /> : <Check size={16} />}
      <span>{notification.message}</span>
      <Button variant="ghost" size="icon" aria-label="Dismiss notification" onClick={dismiss}>
        <X size={15} />
      </Button>
    </div>
  );
}
export function ResizeHandle({
  orientation = 'vertical',
  value,
  min,
  max,
  onChange,
  label,
}: {
  orientation?: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
}): ReactNode {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  const clamp = (next: number) => Math.max(min, Math.min(max, next));
  return (
    <div
      className={`resize-handle resize-${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={Math.round(max)}
      onDoubleClick={() => onChange(orientation === 'vertical' ? 384 : 240)}
      onPointerDown={(event) => {
        event.preventDefault();
        cleanup.current?.();
        const start = orientation === 'vertical' ? event.clientX : event.clientY;
        const move = (next: PointerEvent) =>
          onChange(
            clamp(
              value + (orientation === 'vertical' ? start - next.clientX : next.clientY - start),
            ),
          );
        const finish = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          cleanup.current = null;
        };
        cleanup.current = finish;
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
      }}
      onKeyDown={(event) => {
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          const positive =
            orientation === 'vertical' ? event.key === 'ArrowLeft' : event.key === 'ArrowDown';
          onChange(clamp(value + (positive ? 16 : -16)));
        }
      }}
    />
  );
}
export function Field({
  label,
  children,
  ...props
}: HTMLAttributes<HTMLLabelElement> & { label: string }): ReactNode {
  return (
    <label className="field" {...props}>
      <span>{label}</span>
      {children}
    </label>
  );
}
