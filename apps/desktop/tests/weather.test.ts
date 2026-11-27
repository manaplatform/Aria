import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { WeatherService } from '../electron/weather';
import { metNorwayProvider } from '../electron/weather-providers';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
it('aggregates daily temperatures across a daylight-saving transition in the location time zone', () => {
  vi.useFakeTimers();
  const start = Date.parse('2025-03-29T22:00:00.000Z');
  vi.setSystemTime(start);
  const body = {
    properties: {
      meta: { updated_at: new Date(start).toISOString() },
      timeseries: Array.from({ length: 26 }, (_, hour) => ({
        time: new Date(start + hour * 3_600_000).toISOString(),
        data: { instant: { details: { air_temperature: hour } } },
      })),
    },
  };
  const result = metNorwayProvider.normalize(
    body,
    { ...location, timezone: 'Europe/Oslo' },
    'weather.daily',
    { enabled: true, provider: 'met_norway', temperature: 'celsius', wind: 'm/s' },
    { retrievedAt: start, expires: start + 10_800_000 },
  );
  expect(result.daily).toMatchObject([
    { date: '2025-03-29', samples: 1, minimumTemperature: 0, maximumTemperature: 0, partial: true },
    {
      date: '2025-03-30',
      samples: 23,
      minimumTemperature: 1,
      maximumTemperature: 23,
      partial: false,
    },
    {
      date: '2025-03-31',
      samples: 2,
      minimumTemperature: 24,
      maximumTemperature: 25,
      partial: true,
    },
  ]);
});
it('paginates hourly forecasts within the Conductor result size limit', () => {
  const now = Date.now();
  const body = {
    properties: {
      meta: { updated_at: new Date(now).toISOString() },
      timeseries: Array.from({ length: 60 }, (_, hour) => ({
        time: new Date(now + hour * 3_600_000).toISOString(),
        data: { instant: { details: { air_temperature: 10, wind_speed: 2 } } },
      })),
    },
  };
  const settings = {
    enabled: true,
    provider: 'met_norway',
    temperature: 'celsius',
    wind: 'm/s',
  } as const;
  const first = metNorwayProvider.normalize(body, location, 'weather.hourly', settings, {
    retrievedAt: now,
    expires: now + 10_800_000,
  });
  const second = metNorwayProvider.normalize(
    body,
    location,
    'weather.hourly',
    settings,
    { retrievedAt: now, expires: now + 10_800_000 },
    24,
  );
  expect(first.hourly).toHaveLength(24);
  expect(first.nextHourOffset).toBe(24);
  expect(second.hourOffset).toBe(24);
  expect(JSON.stringify(first).length).toBeLessThan(12_000);
});
async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aria-weather-'));
  directories.push(directory);
  const service = new WeatherService(directory);
  await service.load();
  return { service, directory };
}
const location = {
  latitude: 59.912345,
  longitude: 10.752245,
  name: 'Oslo',
  timezone: 'Europe/Oslo',
};
function response(body: unknown, status = 200) {
  return {
    status,
    headers: { 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' },
    bytes: Buffer.from(JSON.stringify(body)),
  };
}
function forecast() {
  const now = new Date();
  return {
    properties: {
      meta: { updated_at: now.toISOString() },
      timeseries: Array.from({ length: 24 }, (_, hour) => ({
        time: new Date(now.getTime() + hour * 3_600_000).toISOString(),
        data: {
          instant: {
            details: {
              air_temperature: 10 + hour,
              relative_humidity: 60,
              wind_speed: 2,
              wind_from_direction: 180,
            },
          },
          next_1_hours: {
            summary: { symbol_code: 'clearsky_day' },
            details: { precipitation_amount: 0 },
          },
        },
      })),
    },
  };
}
function mockRequest(
  service: WeatherService,
  impl: (...args: unknown[]) => Promise<ReturnType<typeof response>>,
) {
  return vi
    .spyOn(
      service as unknown as {
        request: (...args: unknown[]) => Promise<ReturnType<typeof response>>;
      },
      'request',
    )
    .mockImplementation(impl);
}
it('shares concurrent requests, persists cached forecasts, and converts units', async () => {
  const { service, directory } = await setup();
  await service.configure({ enabled: true, temperature: 'fahrenheit', wind: 'km/h' });
  const request = mockRequest(service, async () => response(forecast()));
  const signal = new AbortController().signal;
  const [current, daily] = await Promise.all([
    service.dispatch('weather.current', { location }, signal),
    service.dispatch('weather.daily', { location }, signal),
  ]);
  expect(request).toHaveBeenCalledTimes(1);
  expect((current.current as { temperature: number }).temperature).toBe(50);
  expect((current.current as { kind: string }).kind).toBe('estimated_current');
  expect((daily.daily as unknown[]).length).toBeGreaterThan(0);
  expect(String((request.mock.calls[0][0] as URL).search)).toContain('lat=59.9123');
  const restarted = new WeatherService(directory);
  await restarted.load();
  const requestAgain = mockRequest(restarted, async () => {
    throw new Error('Unexpected network request');
  });
  await restarted.dispatch('weather.current', { location }, signal);
  expect(requestAgain).not.toHaveBeenCalled();
});
it('returns ambiguous location candidates without fetching weather', async () => {
  const { service } = await setup();
  const request = mockRequest(service, async () =>
    response({
      results: [
        {
          name: 'Springfield',
          country: 'US',
          latitude: 39.8,
          longitude: -89.6,
          timezone: 'America/Chicago',
        },
        {
          name: 'Springfield',
          country: 'US',
          latitude: 42.1,
          longitude: -72.6,
          timezone: 'America/New_York',
        },
      ],
    }),
  );
  const result = await service.dispatch(
    'weather.current',
    { location: 'Springfield' },
    new AbortController().signal,
  );
  expect(result.candidates).toHaveLength(2);
  expect(request).toHaveBeenCalledTimes(1);
});
it('rejects invalid or incomplete forecasts and never caches them', async () => {
  const { service } = await setup();
  const request = mockRequest(service, async () =>
    response({ properties: { meta: {}, timeseries: [] } }),
  );
  await expect(
    service.dispatch('weather.current', { location }, new AbortController().signal),
  ).rejects.toThrow();
  expect(service.settings().cachedEntries).toBe(0);
  expect(request).toHaveBeenCalledTimes(1);
});
it('fails explicitly on provider errors and respects disabled settings', async () => {
  const { service } = await setup();
  const request = mockRequest(service, async () => response({}, 503));
  await expect(
    service.dispatch('weather.current', { location }, new AbortController().signal),
  ).rejects.toThrow('HTTP 503');
  await service.configure({ enabled: false, temperature: 'celsius', wind: 'm/s' });
  await expect(
    service.dispatch('weather.current', { location }, new AbortController().signal),
  ).rejects.toThrow('disabled');
  expect(request).toHaveBeenCalledTimes(1);
});
it('revalidates expired cached responses using Last-Modified and handles 304', async () => {
  const { service } = await setup();
  const request = mockRequest(service, async () => response(forecast()));
  const signal = new AbortController().signal;
  await service.dispatch('weather.current', { location }, signal);
  const internals = service as unknown as {
    cache: Record<string, { expires: number }>;
    nextRequest: Map<string, number>;
    ledger: Record<string, number>;
  };
  Object.values(internals.cache)[0].expires = 0;
  for (const key of Object.keys(internals.ledger)) internals.ledger[key] = 0;
  internals.nextRequest.clear();
  request.mockImplementation(async () => response({}, 304));
  const result = await service.dispatch('weather.current', { location }, signal);
  expect(request.mock.calls[1][2]).toEqual({
    'If-Modified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT',
  });
  expect(result.provider).toBe('MET Norway');
});
it('does not bypass the provider refresh interval after clearing the cache or restarting', async () => {
  const { service, directory } = await setup();
  mockRequest(service, async () => response(forecast()));
  const signal = new AbortController().signal;
  await service.dispatch('weather.current', { location }, signal);
  await service.clearCache();
  const restarted = new WeatherService(directory);
  await restarted.load();
  const request = mockRequest(restarted, async () => response(forecast()));
  await expect(restarted.dispatch('weather.current', { location }, signal)).rejects.toThrow(
    'refresh interval',
  );
  expect(request).not.toHaveBeenCalled();
});
it('persists a provider-wide 429 cooldown across locations and restarts', async () => {
  const { service, directory } = await setup();
  mockRequest(service, async () => ({
    ...response({}, 429),
    headers: { 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT', 'retry-after': '120' },
  }));
  const signal = new AbortController().signal;
  await expect(service.dispatch('weather.current', { location }, signal)).rejects.toThrow(
    'HTTP 429',
  );
  const restarted = new WeatherService(directory);
  await restarted.load();
  const request = mockRequest(restarted, async () => response(forecast()));
  await expect(
    restarted.dispatch('weather.current', { location: { ...location, latitude: 60 } }, signal),
  ).rejects.toThrow('rate limited');
  expect(request).not.toHaveBeenCalled();
});
it('cancels a detached waiter without aborting a shared request needed by another', async () => {
  const { service } = await setup();
  let complete!: (value: ReturnType<typeof response>) => void;
  let ready!: () => void;
  const requested = new Promise<void>((resolve) => {
    ready = resolve;
  });
  mockRequest(
    service,
    async () =>
      new Promise((resolve) => {
        complete = resolve;
        ready();
      }),
  );
  const first = new AbortController();
  const cancelled = service.dispatch('weather.current', { location }, first.signal);
  const remaining = service.dispatch('weather.daily', { location }, new AbortController().signal);
  await requested;
  first.abort();
  await expect(cancelled).rejects.toThrow();
  complete(response(forecast()));
  await expect(remaining).resolves.toMatchObject({ provider: 'MET Norway' });
});
it('blocks arbitrary provider destinations before network access', async () => {
  const { service } = await setup();
  const internals = service as unknown as {
    request(url: URL, signal: AbortSignal, headers: Record<string, string>): Promise<unknown>;
  };
  await expect(
    internals.request(new URL('https://127.0.0.1/private'), new AbortController().signal, {}),
  ).rejects.toThrow('destination');
});
