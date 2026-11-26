import { Temporal } from '@js-temporal/polyfill';
import { CronExpressionParser } from 'cron-parser';
import type { ProactiveSettings, ProactiveTrigger } from '@aria/shared';

const minute = 60_000;

export function systemZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function localInstant(value: Temporal.PlainDateTime, zone: string) {
  const earlier = value.toZonedDateTime(zone, { disambiguation: 'earlier' });
  if (earlier.toPlainDateTime().equals(value)) return earlier.epochMilliseconds;
  return null;
}

export function validateZone(zone: string) {
  if (/^[+-]/.test(zone)) throw new Error('Choose a named time zone.');
  new Intl.DateTimeFormat(undefined, { timeZone: zone });
  return zone;
}

function once(trigger: Extract<ProactiveTrigger, { kind: 'once' }>) {
  validateZone(trigger.zone);
  const instant = /(?:Z|[+-]\d\d:\d\d)$/i.test(trigger.at)
    ? Temporal.Instant.from(trigger.at)
    : Temporal.PlainDateTime.from(trigger.at)
        .toZonedDateTime(trigger.zone, { disambiguation: 'reject' })
        .toInstant();
  return instant.epochMilliseconds;
}

function calendarExpression(
  trigger: Extract<ProactiveTrigger, { at: string; followSystem: boolean }>,
) {
  const [hour, minutes] = trigger.at.split(':').map(Number);
  const prefix = minutes + ' ' + hour;
  if (trigger.kind === 'daily') return prefix + ' * * *';
  if (trigger.kind === 'weekly') return prefix + ' * * ' + (trigger.weekday % 7);
  return prefix + ' ' + trigger.day + ' * *';
}

function cron(trigger: Extract<ProactiveTrigger, { followSystem: boolean }>) {
  if (trigger.kind !== 'cron') return calendarExpression(trigger);
  if (
    trigger.expression.split(/\s+/).length !== 5 ||
    !/^[\dA-Za-z *,/-]+$/.test(trigger.expression)
  )
    throw new Error(
      'Use a five-field cron expression with fixed values, ranges, lists, and steps.',
    );
  return trigger.expression;
}

function calendarOccurrence(
  trigger: Extract<ProactiveTrigger, { followSystem: boolean }>,
  now: number,
  backwards: boolean,
  currentZone: string,
) {
  const zone = validateZone(trigger.followSystem ? currentZone : trigger.zone);
  const local = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime();
  const early = local.toZonedDateTime(zone, { disambiguation: 'earlier' }).epochMilliseconds;
  const late = local.toZonedDateTime(zone, { disambiguation: 'later' }).epochMilliseconds;
  // A clock in the second copy of a fold can have an earlier wall time than
  // the most recent eligible occurrence in the first copy.
  const foldAdjustment = backwards && late !== early && now === late ? late - early : 0;
  const wallClock = local.toZonedDateTime('UTC').epochMilliseconds + foldAdjustment;
  const cursor = CronExpressionParser.parse(cron(trigger), {
    tz: 'UTC',
    currentDate: new Date(wallClock + (backwards ? 1 : 0)),
  });
  for (let count = 0; count < 180; count++) {
    const date = (backwards ? cursor.prev() : cursor.next()).toDate();
    const wall = Temporal.Instant.fromEpochMilliseconds(date.valueOf())
      .toZonedDateTimeISO('UTC')
      .toPlainDateTime();
    const candidate = localInstant(wall, zone);
    if (candidate !== null && (backwards ? candidate <= now : candidate > now))
      return { at: candidate, key: wall.toString({ smallestUnit: 'minute' }) };
  }
  throw new Error('The schedule has no eligible occurrence within the supported calendar search.');
}

export type Occurrence = { at: number; key: string };
export function occurrence(
  trigger: ProactiveTrigger,
  now: number,
  backwards = false,
  zone = systemZone(),
): Occurrence | null {
  if ('followSystem' in trigger) return calendarOccurrence(trigger, now, backwards, zone);
  if (trigger.kind === 'once') {
    const at = once(trigger);
    return (backwards ? at <= now : at > now) ? { at, key: String(at) } : null;
  }
  if (trigger.kind === 'interval' || trigger.kind === 'condition') {
    const interval = trigger.minutes * minute;
    const count = Math.floor((now - trigger.anchor) / interval) + (backwards ? 0 : 1);
    if (backwards && count < 0) return null;
    const at = trigger.anchor + Math.max(count, 0) * interval;
    return { at, key: String(at) };
  }
  return null;
}

export function preview(trigger: ProactiveTrigger, now: number, zone = systemZone()) {
  const times: number[] = [];
  for (let index = 0; index < 3; index++) {
    const next = occurrence(trigger, now, false, zone);
    if (!next) break;
    times.push(next.at);
    now = next.at;
  }
  return times;
}

export function quietUntil(quiet: ProactiveSettings['quietHours'], now: number): number | null {
  if (!quiet || quiet.start === quiet.end) return null;
  const local = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(
    validateZone(quiet.zone),
  );
  const time = local.toPlainTime();
  const start = Temporal.PlainTime.from(quiet.start);
  const end = Temporal.PlainTime.from(quiet.end);
  const afterStart = Temporal.PlainTime.compare(time, start) >= 0;
  const beforeEnd = Temporal.PlainTime.compare(time, end) < 0;
  const overnight = Temporal.PlainTime.compare(start, end) > 0;
  if (!(overnight ? afterStart || beforeEnd : afterStart && beforeEnd)) return null;
  const date = overnight && afterStart ? local.toPlainDate().add({ days: 1 }) : local.toPlainDate();
  return date.toPlainDateTime(end).toZonedDateTime(quiet.zone, { disambiguation: 'later' })
    .epochMilliseconds;
}
