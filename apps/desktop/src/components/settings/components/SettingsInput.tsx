import { useId, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { SettingsRow } from './SettingsRow';

type BaseProps = {
  id?: string;
  label: string;
  description?: string;
  highlighted?: boolean;
};

export function SettingsInput({
  id,
  label,
  description,
  highlighted = false,
  ...inputProps
}: BaseProps & InputHTMLAttributes<HTMLInputElement>) {
  const inputId = useId();
  return (
    <SettingsRow
      id={id}
      label={label}
      htmlFor={inputId}
      description={description}
      highlighted={highlighted}
    >
      <input id={inputId} aria-label={label} {...inputProps} />
    </SettingsRow>
  );
}

export function SettingsTextarea({
  id,
  label,
  description,
  highlighted = false,
  maxLength,
  value,
  ...textareaProps
}: BaseProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const textareaId = useId();
  const length = typeof value === 'string' ? value.length : 0;
  return (
    <SettingsRow
      id={id}
      label={label}
      htmlFor={textareaId}
      description={description}
      stacked
      highlighted={highlighted}
    >
      <div style={{ width: '100%' }}>
        <textarea
          id={textareaId}
          aria-label={label}
          className="settings-textarea"
          maxLength={maxLength}
          value={value}
          {...textareaProps}
        />
        {maxLength !== undefined && (
          <div className="settings-char-count">
            {length} / {maxLength}
          </div>
        )}
      </div>
    </SettingsRow>
  );
}
