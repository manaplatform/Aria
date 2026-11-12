import type { GenerationMode, ProviderModel } from '@aria/shared';
export const modeLabels: Record<GenerationMode, string> = {
  chat: 'Chat',
  image: 'Image',
  speech: 'Speech',
  transcription: 'Transcribe',
  live: 'Live Voice',
};
export function ModelSelect({
  models,
  mode,
  value,
  onChange,
  disabled,
  label = `${modeLabels[mode]} model`,
}: {
  models: ProviderModel[];
  mode: GenerationMode;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const suggested = models.filter((m) => m.modes.includes(mode));
  const others = models.filter((m) => m.modes.length === 0);
  const option = (m: ProviderModel) => (
    <option key={m.id} value={m.id}>
      {m.id}
      {m.deprecated ? ' · deprecated' : ''}
      {m.shutdownDate ? ` · retires ${m.shutdownDate}` : ''}
    </option>
  );
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Select a model</option>
      {value && ![...suggested, ...others].some((m) => m.id === value) && (
        <option value={value} disabled>
          {value} · unavailable
        </option>
      )}
      {suggested.length > 0 && (
        <optgroup label={modeLabels[mode]}>{suggested.map(option)}</optgroup>
      )}
      {others.length > 0 && <optgroup label="Other models">{others.map(option)}</optgroup>}
    </select>
  );
}
