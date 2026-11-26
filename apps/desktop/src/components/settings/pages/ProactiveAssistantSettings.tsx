import { useEffect, useState } from 'react';
import {
  proactiveSettingsSchema,
  type ProactiveSnapshot,
  type SystemBehaviorState,
} from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { Button, ErrorState, Skeleton } from '../../ui';
import {
  commandId,
  dateLabel,
  localZone,
  statusLabel,
  useProactive,
} from '../../proactive/runtime';
import { SettingsPage } from '../SettingsPage';

function Preferences({
  snapshot,
  act,
}: {
  snapshot: ProactiveSnapshot;
  act: ReturnType<typeof useProactive<'snapshot'>>['act'];
}) {
  const [quiet, setQuiet] = useState(Boolean(snapshot.settings.quietHours));
  const [error, setError] = useState('');
  const [login, setLogin] = useState<SystemBehaviorState>();
  useEffect(() => {
    if (!window.aria) return;
    void window.aria.systemBehavior().then(setLogin, (error) => setError(errorMessage(error)));
  }, []);
  const s = snapshot.settings;
  return (
    <form
      className="proactive-form proactive-preferences"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const value = proactiveSettingsSchema.safeParse({
          pulseEnabled: fields.has('pulse'),
          pulseMemory: fields.has('memory'),
          pulsePaused: fields.has('pause'),
          background: fields.has('background'),
          emergencyPaused: fields.has('emergency'),
          nativeNotifications: fields.has('native'),
          intervalMinutes: Number(fields.get('interval')),
          mode: fields.get('mode'),
          concurrency: Number(fields.get('concurrency')),
          dailyMicros: Math.round(Number(fields.get('cost')) * 1_000_000),
          dailyInputTokens: Number(fields.get('input')),
          dailyOutputTokens: Number(fields.get('output')),
          retentionDays: Number(fields.get('retention')),
          missed: fields.get('missed'),
          quietHours: quiet
            ? { zone: fields.get('zone'), start: fields.get('start'), end: fields.get('end') }
            : null,
        });
        if (!value.success) {
          setError(value.error.issues[0]?.message ?? 'Check the settings.');
          return;
        }
        setError('');
        void act({
          action: 'settings',
          commandId: commandId(),
          revision: snapshot.revision,
          value: value.data,
        });
      }}
    >
      <fieldset>
        <legend>Pulse</legend>
        <label>
          <input name="pulse" type="checkbox" defaultChecked={s.pulseEnabled} /> Enable Pulse
        </label>
        <label>
          <input name="pause" type="checkbox" defaultChecked={s.pulsePaused} /> Pause Pulse
        </label>
        <label>
          <input name="memory" type="checkbox" defaultChecked={s.pulseMemory} /> Allow selective
          profile recall with standing memory consent
        </label>
        <label>
          Heartbeat interval in minutes
          <input
            type="number"
            name="interval"
            min={1}
            max={525600}
            defaultValue={s.intervalMinutes}
            required
          />
        </label>
        <label>
          Evaluation mode
          <select name="mode" defaultValue={s.mode}>
            <option value="adaptive">Adaptive</option>
            <option value="always">Always invoke assistant</option>
            <option value="pending">Pending tasks only</option>
          </select>
        </label>
        <div className="proactive-controls">
          <span>Last {dateLabel(snapshot.pulse.last)}</span>
          <span>Next {dateLabel(snapshot.pulse.next)}</span>
          <Button
            type="button"
            onClick={() => void act({ action: 'pulse', commandId: commandId() })}
          >
            Run Pulse now
          </Button>
        </div>
      </fieldset>
      <fieldset>
        <legend>Background operation</legend>
        <label>
          <input name="background" type="checkbox" defaultChecked={s.background} /> Keep Aria
          running after the window closes
        </label>
        <label>
          <input
            type="checkbox"
            checked={login?.openAtLogin ?? false}
            disabled={!login?.loginSupported}
            onChange={(event) => {
              void desktop()
                .setSystemBehavior({ openAtLogin: event.target.checked })
                .then(setLogin, (error) => setError(errorMessage(error)));
            }}
          />{' '}
          Launch at system login
        </label>
        {login?.loginReason && <small>{login.loginReason}</small>}
        <label>
          <input name="native" type="checkbox" defaultChecked={s.nativeNotifications} /> Show
          generic desktop notifications
        </label>
        <label>
          <input
            type="checkbox"
            checked={quiet}
            onChange={(event) => setQuiet(event.target.checked)}
          />{' '}
          Quiet hours
        </label>
        {quiet && (
          <div className="proactive-controls">
            <label>
              Time zone
              <input name="zone" defaultValue={s.quietHours?.zone ?? localZone()} required />
            </label>
            <label>
              Start
              <input
                type="time"
                name="start"
                defaultValue={s.quietHours?.start ?? '22:00'}
                required
              />
            </label>
            <label>
              End
              <input type="time" name="end" defaultValue={s.quietHours?.end ?? '07:00'} required />
            </label>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>Execution limits</legend>
        <label>
          Concurrent jobs
          <input
            type="number"
            name="concurrency"
            min={1}
            max={2}
            defaultValue={s.concurrency}
            required
          />
        </label>
        <label>
          Daily spending limit in USD
          <input
            type="number"
            name="cost"
            min={0}
            step="0.001"
            defaultValue={s.dailyMicros / 1_000_000}
            required
          />
        </label>
        <label>
          Daily input tokens
          <input type="number" name="input" min={0} defaultValue={s.dailyInputTokens} required />
        </label>
        <label>
          Daily output tokens
          <input type="number" name="output" min={0} defaultValue={s.dailyOutputTokens} required />
        </label>
        <small>Daily limits reset at UTC midnight.</small>
        <label>
          History retention in days
          <input
            type="number"
            name="retention"
            min={1}
            max={365}
            defaultValue={s.retentionDays}
            required
          />
        </label>
        <label>
          Missed runs
          <select name="missed" defaultValue={s.missed}>
            <option value="skip">Skip</option>
            <option value="run_once">Run once</option>
            <option value="catch_up">Catch up to three</option>
          </select>
        </label>
        <label>
          <input name="emergency" type="checkbox" defaultChecked={s.emergencyPaused} /> Emergency
          pause for proactive work
        </label>
      </fieldset>
      {error && <ErrorState message={error} />}
      <Button variant="primary" type="submit">
        Save settings
      </Button>
      <section>
        <h3>Pulse history</h3>
        <p>
          {snapshot.metrics.pulseModelRequests} model requests and {snapshot.metrics.pulseSkips}{' '}
          skips in the past 24 hours
        </p>
        <p>
          {snapshot.metrics.queued} queued jobs · {snapshot.metrics.retries} retries in the past 24
          hours · {snapshot.metrics.recoveries} recoveries
        </p>
        <p>
          {snapshot.metrics.inputTokens.toLocaleString()} input tokens ·{' '}
          {snapshot.metrics.outputTokens.toLocaleString()} output tokens · $
          {(snapshot.metrics.cost / 1_000_000).toFixed(4)} accounted or reserved in the past 24
          hours
        </p>
        {snapshot.pulse.history.map((run, index) => (
          <div className="proactive-row" key={run.at + '-' + index}>
            <strong>{statusLabel(run.state)}</strong>
            <span>{dateLabel(run.at)}</span>
            {run.reason && <small>{run.reason}</small>}
          </div>
        ))}
      </section>
    </form>
  );
}

export default function ProactiveAssistantSettings() {
  const view = useProactive({ action: 'snapshot' });
  const snapshot = view.result?.value;
  return (
    <SettingsPage
      title="Proactive Assistant"
      description="Configure scheduled work and assistant evaluations on this desktop."
    >
      {view.error && <ErrorState message={view.error} />}
      {snapshot ? (
        <>
          <p role="status">{snapshot.status}</p>
          <Preferences snapshot={snapshot} key={snapshot.revision} act={view.act} />
        </>
      ) : (
        !view.error && <Skeleton />
      )}
    </SettingsPage>
  );
}
