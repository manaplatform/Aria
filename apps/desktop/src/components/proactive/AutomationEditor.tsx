import { useState, type FormEvent } from 'react';
import {
  defaultProactiveLimits,
  automationDraftSchema,
  proactiveTriggerSchema,
  type AutomationDraft,
  type ConnectorJobGrant,
  type ProactiveTrigger,
} from '@aria/shared';
import { Button } from '../ui';
import { ConnectorScopeFields, ConnectorScopeSummary, connectorScopeFromForm } from './ConnectorScopeFields';
import { dateLabel, localZone } from './runtime';

const kinds = [
  'once',
  'interval',
  'daily',
  'weekly',
  'monthly',
  'cron',
  'condition',
  'github_watch',
  'event',
  'task_event',
  'manual',
] as const;

export default function AutomationEditor({
  value,
  tasks,
  preview,
  save,
}: {
  value?: AutomationDraft;
  tasks: { id: string; title: string }[];
  preview(trigger: ProactiveTrigger): Promise<number[] | undefined>;
  save(value: AutomationDraft): Promise<unknown>;
}) {
  const [kind, setKind] = useState<ProactiveTrigger['kind']>(value?.trigger.kind ?? 'daily');
  const [draft, setDraft] = useState(value);
  const [checked, setChecked] = useState<AutomationDraft>();
  const [times, setTimes] = useState<number[]>();
  const [error, setError] = useState('');
  const previous = draft?.trigger;
  const calendar = ['daily', 'weekly', 'monthly', 'cron'].includes(kind);
  const validLocal = (input: number) =>
    new Date(input - new Date(input).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (name: string) => String(form.get(name) ?? '');
    const at = get('at');
    const zone = get('zone') || localZone();
    const followSystem = form.has('follow');
    const anchor =
      previous && 'anchor' in previous && previous.kind === kind ? previous.anchor : Date.now();
    const minutes = Number(get('minutes'));
    const origin = get('origin').trim();
    const trigger: Record<string, unknown> = { kind };
    if (kind === 'once') Object.assign(trigger, { at, zone });
    if (kind === 'interval' || kind === 'condition' || kind === 'github_watch') Object.assign(trigger, { anchor, minutes });
    if (kind === 'condition')
      Object.assign(trigger, { origin, cooldownMinutes: Number(get('cooldown')) });
    if (kind === 'github_watch') Object.assign(trigger, { repository: Number(get('watchRepository')), watch: get('githubWatch') });
    if (calendar) {
      Object.assign(trigger, { zone, followSystem });
      if (kind === 'cron') trigger.expression = get('cron');
      else trigger.at = at;
      if (kind === 'weekly') trigger.weekday = Number(get('weekday'));
      if (kind === 'monthly') trigger.day = Number(get('day'));
    }
    if (kind === 'event' || kind === 'task_event') trigger.event = get('event');
    if (kind === 'task_event') trigger.taskId = get('task');
    const parsedTrigger = proactiveTriggerSchema.safeParse(trigger);
    const origins = get('origins').split(/\s+/).filter(Boolean);
    const expiration = get('expiration');
    let connector: ConnectorJobGrant | undefined;
    try { connector = connectorScopeFromForm(form); }
    catch { setError('Select GitHub repositories and operations for this automation.'); return; }
    const parsed =
      parsedTrigger.success &&
      automationDraftSchema.safeParse({
        title: get('title'),
        instruction: get('instruction'),
        action: get('action'),
        trigger: parsedTrigger.data,
        scope: {
          publicSearch: form.has('search'),
          memory: form.has('memory'),
          connector,
          publicOrigins: [
            ...new Set(origin && kind === 'condition' ? [...origins, origin] : origins),
          ],
        },
        expiresAt: expiration ? new Date(expiration).getTime() : null,
        missed: get('missed') || undefined,
        notifications: get('notifications'),
        maxAttempts: Number(get('attempts')),
        maxMicros: Math.round(Number(get('cost')) * 1_000_000),
        limits: {
          ...(draft?.limits ?? defaultProactiveLimits),
          iterations: Number(get('requests')),
          steps: Number(get('tools')),
          activeMs: Number(get('seconds')) * 1000,
          inputTokens: Number(get('input')),
          outputTokens: Number(get('output')),
        },
      });
    if (!parsed || !parsed.success) {
      setError(
        parsed
          ? (parsed.error.issues[0]?.message ?? 'Check the automation fields.')
          : 'Check the trigger and its required fields.',
      );
      return;
    }
    setError('');
    const result = await preview(parsed.data.trigger);
    if (result) {
      setTimes(result);
      setDraft(parsed.data);
      setChecked(parsed.data);
    }
  };
  if (checked)
    return (
      <div className="proactive-form">
        <h3>Review and authorize</h3>
        <p className="proactive-content">{checked.action}</p>
        <p>
          {checked.trigger.kind} ·{' '}
          {checked.scope.publicSearch
            ? 'Public search and reads'
            : checked.scope.publicOrigins.join(', ') || 'Local operations'}
          {checked.scope.memory ? ' · Profile memory recall' : ''}
        </p>
        <p>
          Up to ${(checked.maxMicros / 1_000_000).toFixed(3)} per run · {checked.maxAttempts}{' '}
          attempts
        </p>
        {!!times?.length && (
          <ul>
            {times.map((at) => (
              <li key={at}>{dateLabel(at)}</li>
            ))}
          </ul>
        )}
        {checked.scope.connector && <ConnectorScopeSummary value={checked.scope.connector} />}
        <div className="proactive-controls">
          <Button onClick={() => setChecked(undefined)}>Back</Button>
          <Button variant="primary" onClick={() => void save(checked)}>
            Authorize automation
          </Button>
        </div>
      </div>
    );
  return (
    <form className="proactive-form" onSubmit={(event) => void submit(event)}>
      <label>
        Title
        <input name="title" defaultValue={draft?.title} maxLength={200} required />
      </label>
      <label>
        Original instruction
        <textarea name="instruction" defaultValue={draft?.instruction} maxLength={4000} required />
      </label>
      <label>
        Execution action
        <textarea name="action" defaultValue={draft?.action} maxLength={4000} required />
      </label>
      <label>
        Trigger
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          {kinds.map((item) => (
            <option key={item} value={item}>
              {item.replace('_', ' ')}
            </option>
          ))}
        </select>
      </label>
      {(calendar || kind === 'once') && (
        <label>
          Time zone
          <input
            name="zone"
            defaultValue={previous && 'zone' in previous ? previous.zone : localZone()}
            required
          />
        </label>
      )}
      {calendar && (
        <label>
          <input
            type="checkbox"
            name="follow"
            defaultChecked={previous && 'followSystem' in previous && previous.followSystem}
          />{' '}
          Follow system time zone
        </label>
      )}
      {kind === 'once' && (
        <label>
          Date and time
          <input
            name="at"
            placeholder="2026-11-30T09:00 or include an offset"
            defaultValue={previous?.kind === kind ? previous.at : undefined}
            required
          />
        </label>
      )}
      {calendar && kind !== 'cron' && (
        <label>
          Time
          <input
            name="at"
            type="time"
            defaultValue={
              previous && 'at' in previous && previous.kind !== 'once' ? previous.at : '09:00'
            }
            required
          />
        </label>
      )}
      {kind === 'weekly' && (
        <label>
          Day of week
          <select name="weekday" defaultValue={previous?.kind === kind ? previous.weekday : 1}>
            {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
              (day, index) => (
                <option key={day} value={index + 1}>
                  {day}
                </option>
              ),
            )}
          </select>
        </label>
      )}
      {kind === 'monthly' && (
        <label>
          Day of month
          <input
            type="number"
            name="day"
            min={1}
            max={31}
            defaultValue={previous?.kind === kind ? previous.day : 1}
            required
          />
        </label>
      )}
      {kind === 'cron' && (
        <label>
          Cron expression
          <input
            name="cron"
            defaultValue={previous?.kind === kind ? previous.expression : '0 9 * * *'}
            required
          />
        </label>
      )}
      {(kind === 'interval' || kind === 'condition' || kind === 'github_watch') && (
        <label>
          Interval in minutes
          <input
            type="number"
            name="minutes"
            min={kind === 'github_watch' ? 5 : 1}
            defaultValue={previous && 'minutes' in previous ? previous.minutes : 30}
            required
          />
        </label>
      )}
      {kind === 'condition' && (
        <>
          <label>
            Monitored origin
            <input
              name="origin"
              placeholder="https://example.com"
              defaultValue={previous?.kind === kind ? previous.origin : undefined}
              required
            />
          </label>
          <label>
            Notification cooldown in minutes
            <input
              type="number"
              name="cooldown"
              min={1}
              defaultValue={previous?.kind === kind ? previous.cooldownMinutes : 30}
              required
            />
          </label>
        </>
      )}
      {kind === 'event' && (
        <label>
          Runtime event
          <select name="event" defaultValue={previous?.kind === kind ? previous.event : undefined}>
            <option value="runtime.resumed">Runtime resumed</option>
            <option value="desktop.unlocked">Desktop unlocked</option>
          </select>
        </label>
      )}
      {kind === 'task_event' && (
        <>
          <label>
            Task
            <select
              name="task"
              defaultValue={previous?.kind === kind ? previous.taskId : ''}
              required
            >
              <option value="">Select a task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Task event
            <select
              name="event"
              defaultValue={previous?.kind === kind ? previous.event : undefined}
            >
              <option value="task.completed">Task completed</option>
              <option value="task.dependencies_ready">Dependencies ready</option>
            </select>
          </label>
        </>
      )}
      <label>
        Expiration
        <input
          type="datetime-local"
          name="expiration"
          defaultValue={draft?.expiresAt ? validLocal(draft.expiresAt) : undefined}
        />
      </label>
      <label>
        Missed runs
        <select name="missed" defaultValue={draft?.missed ?? ''}>
          <option value="">Use profile setting</option>
          <option value="skip">Skip</option>
          <option value="run_once">Run once</option>
          <option value="catch_up">Catch up</option>
        </select>
      </label>
      <label>
        Notifications
        <select name="notifications" defaultValue={draft?.notifications ?? 'meaningful'}>
          <option value="meaningful">Meaningful updates</option>
          <option value="all">All results</option>
          <option value="none">Off</option>
        </select>
      </label>
      <label>
        Maximum attempts
        <input
          type="number"
          name="attempts"
          min={1}
          max={5}
          defaultValue={draft?.maxAttempts ?? 3}
          required
        />
      </label>
      <details>
        <summary>Per-run resource limits</summary>
        <fieldset>
          <label>
            Model requests
            <input
              type="number"
              name="requests"
              min={2}
              max={48}
              defaultValue={draft?.limits.iterations ?? defaultProactiveLimits.iterations}
              required
            />
          </label>
          <label>
            Tool operations
            <input
              type="number"
              name="tools"
              min={4}
              max={32}
              defaultValue={draft?.limits.steps ?? defaultProactiveLimits.steps}
              required
            />
          </label>
          <label>
            Active seconds
            <input
              type="number"
              name="seconds"
              min={10}
              max={1800}
              defaultValue={(draft?.limits.activeMs ?? defaultProactiveLimits.activeMs) / 1000}
              required
            />
          </label>
          <label>
            Input tokens
            <input
              type="number"
              name="input"
              min={8192}
              max={600000}
              defaultValue={draft?.limits.inputTokens ?? defaultProactiveLimits.inputTokens}
              required
            />
          </label>
          <label>
            Output tokens
            <input
              type="number"
              name="output"
              min={4096}
              max={65536}
              defaultValue={draft?.limits.outputTokens ?? defaultProactiveLimits.outputTokens}
              required
            />
          </label>
        </fieldset>
      </details>
      <label>
        Maximum cost per run in USD
        <input
          type="number"
          step="0.001"
          name="cost"
          min={0}
          defaultValue={(draft?.maxMicros ?? 150_000) / 1_000_000}
          required
        />
      </label>
      <label>
        <input name="search" type="checkbox" defaultChecked={draft?.scope.publicSearch} /> Allow
        public web search and reads
      </label>
      <label>
        Specific public site origins
        <input
          name="origins"
          defaultValue={draft?.scope.publicOrigins.join(' ')}
          placeholder="https://example.com"
        />
      </label>
      <label>
        <input name="memory" type="checkbox" defaultChecked={draft?.scope.memory} /> Allow profile
        memory recall with standing consent
      </label>
      {kind === 'github_watch' && (
        <>
          <label>GitHub event
            <select name="githubWatch" defaultValue={previous?.kind === 'github_watch' ? previous.watch : 'workflow_failure'}>
              <option value="workflow_failure">Workflow failure</option>
              <option value="release">Published release</option>
            </select>
          </label>
        </>
      )}
      <ConnectorScopeFields value={draft?.scope.connector}
        watchedRepository={kind === 'github_watch' ? previous?.kind === 'github_watch' ? previous.repository : null : undefined} />
      {error && <p role="alert">{error}</p>}
      <Button type="submit" variant="primary">
        Preview and review
      </Button>
    </form>
  );
}
