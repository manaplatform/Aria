import { useState } from 'react';
import {
  defaultProgramSettings,
  type ProgramSettings as Settings,
  type ToolSettings,
} from '@aria/shared';
import { desktop, errorMessage } from '../../services/desktop';
import { Button } from '../ui';

export function ProgramSettings({
  settings,
  onSaved,
}: {
  settings: ToolSettings;
  onSaved: (value: ToolSettings) => void;
}) {
  const [value, setValue] = useState(settings.programming ?? defaultProgramSettings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setSaving(true);
    setError('');
    try {
      const result = await desktop().setProgramSettings(value);
      setValue(result.programming ?? defaultProgramSettings);
      onSaved(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset disabled={saving} className="settings-section" id="programmatic-tools">
      <legend>Programmatic tool calling</legend>
      <div className="shortcut-row">
        <label htmlFor="program-backend">Execution backend</label>
        <select
          id="program-backend"
          value={value.backend}
          onChange={(event) =>
            setValue({ ...value, backend: event.target.value as Settings['backend'] })
          }
        >
          <option value="off">Off</option>
          <option value="managed">Aria isolated JavaScript</option>
          <option value="openai-responses">OpenAI Responses</option>
        </select>
      </div>
      {value.backend === 'managed' && (
        <div className="shortcut-row">
          <label htmlFor="program-image">Program runner image ID</label>
          <input
            id="program-image"
            value={value.image ?? ''}
            placeholder="sha256:…"
            onChange={(event) =>
              setValue({ ...value, image: event.target.value.trim() || undefined })
            }
          />
        </div>
      )}
      {value.backend === 'openai-responses' && (
        <div className="shortcut-row">
          <label htmlFor="program-retention">OpenAI continuation</label>
          <select
            id="program-retention"
            value={value.continuation}
            onChange={(event) =>
              setValue({
                ...value,
                continuation: event.target.value === 'stored' ? 'stored' : 'stateless',
              })
            }
          >
            <option value="stateless">Stateless</option>
            <option value="stored">Allow OpenAI response storage</option>
          </select>
        </div>
      )}
      {value.backend !== 'off' && (
        <>
          <div className="shortcut-row">
            <label htmlFor="program-calls">Tool calls per program</label>
            <input
              id="program-calls"
              type="number"
              min={1}
              max={12}
              value={value.toolCalls}
              onChange={(event) => setValue({ ...value, toolCalls: event.target.valueAsNumber })}
            />
          </div>
          <div className="shortcut-row">
            <label htmlFor="program-parallel">Concurrent calls</label>
            <input
              id="program-parallel"
              type="number"
              min={1}
              max={3}
              value={value.parallel}
              onChange={(event) => setValue({ ...value, parallel: event.target.valueAsNumber })}
            />
          </div>
          <div className="shortcut-row">
            <label htmlFor="program-deadline">Program timeout (seconds)</label>
            <input
              id="program-deadline"
              type="number"
              min={5}
              max={120}
              value={value.milliseconds / 1000}
              onChange={(event) =>
                setValue({ ...value, milliseconds: event.target.valueAsNumber * 1000 })
              }
            />
          </div>
        </>
      )}
      {settings.programming?.backend === 'openai-responses' && (
        <p className="muted">
          {settings.nativeProgramVerified
            ? 'Verified for the current primary and discovery settings.'
            : 'Verify the current primary and discovery settings to enable programs.'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <Button size="sm" onClick={() => void save()}>
        {saving ? 'Checking backend…' : value.backend === 'off' ? 'Save' : 'Verify and save'}
      </Button>
    </fieldset>
  );
}
