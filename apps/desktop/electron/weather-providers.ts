import { z } from 'zod';
import { weatherCoordinates, type WeatherSettings } from '@aria/shared';
import { RuntimeError } from './runtime/store';

export type WeatherLocation = z.infer<typeof weatherCoordinates> & {
  name: string;
  timezone: string;
};
export interface WeatherProvider {
  readonly id: string;
  readonly name: string;
  readonly hostnames: readonly string[];
  readonly minimumCacheMs: number;
  url(location: WeatherLocation): URL;
  validate(body: unknown): void;
  normalize(
    body: unknown,
    location: WeatherLocation,
    operation: string,
    settings: WeatherSettings,
    cache: { retrievedAt: number; expires: number },
    hourOffset?: number,
  ): Record<string, unknown>;
}

const forecast = z.object({
  properties: z.object({
    meta: z.object({ updated_at: z.string().datetime({ offset: true }) }),
    timeseries: z
      .array(
        z.object({
          time: z.string().datetime({ offset: true }),
          data: z.object({
            instant: z.object({
              details: z.object({
                air_temperature: z.number().finite().optional(),
                relative_humidity: z.number().finite().min(0).max(100).optional(),
                wind_speed: z.number().finite().min(0).optional(),
                wind_from_direction: z.number().finite().min(0).max(360).optional(),
              }),
            }),
            next_1_hours: z
              .object({
                summary: z
                  .object({
                    symbol_code: z
                      .string()
                      .regex(/^[a-z0-9_]{1,100}$/)
                      .optional(),
                  })
                  .optional(),
                details: z
                  .object({ precipitation_amount: z.number().finite().min(0).optional() })
                  .optional(),
              })
              .optional(),
            next_6_hours: z
              .object({
                summary: z
                  .object({
                    symbol_code: z
                      .string()
                      .regex(/^[a-z0-9_]{1,100}$/)
                      .optional(),
                  })
                  .optional(),
              })
              .optional(),
          }),
        }),
      )
      .min(1)
      .max(500),
  }),
});
const truncate = (value: number) => Math.trunc(value * 10_000) / 10_000;

export const metNorwayProvider: WeatherProvider = {
  id: 'met_norway',
  name: 'MET Norway',
  hostnames: ['api.met.no'],
  minimumCacheMs: 3 * 60 * 60_000,
  url(location) {
    const url = new URL('https://api.met.no/weatherapi/locationforecast/2.0/compact');
    url.searchParams.set('lat', String(truncate(location.latitude)));
    url.searchParams.set('lon', String(truncate(location.longitude)));
    return url;
  },
  validate(body) {
    forecast.parse(body);
  },
  normalize(body, location, operation, settings, cache, hourOffset = 0) {
    const data = forecast.parse(body);
    const now = Date.now();
    const temp = (v: number | undefined) =>
      v === undefined ? null : settings.temperature === 'fahrenheit' ? (v * 9) / 5 + 32 : v;
    const wind = (v: number | undefined) =>
      v === undefined
        ? null
        : settings.wind === 'km/h'
          ? v * 3.6
          : settings.wind === 'mph'
            ? v * 2.236936292
            : v;
    const hours = [...data.properties.timeseries]
      .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
      .filter((item) => Date.parse(item.time) >= now - 60 * 60_000)
      .map((item) => ({
        time: item.time,
        temperature: temp(item.data.instant.details.air_temperature),
        apparentTemperature: null,
        humidity: item.data.instant.details.relative_humidity ?? null,
        windSpeed: wind(item.data.instant.details.wind_speed),
        windDirection: item.data.instant.details.wind_from_direction ?? null,
        condition:
          item.data.next_1_hours?.summary?.symbol_code ??
          item.data.next_6_hours?.summary?.symbol_code ??
          null,
        precipitationAmount: item.data.next_1_hours?.details?.precipitation_amount ?? null,
        precipitationProbability: null,
      }));
    if (!hours.length)
      throw new RuntimeError(
        'EXECUTION_FAILED',
        'The provider has no usable current or future forecast.',
      );
    if (
      !hours.some(
        (hour) =>
          hour.temperature !== null ||
          hour.humidity !== null ||
          hour.windSpeed !== null ||
          hour.precipitationAmount !== null ||
          hour.condition !== null,
      )
    )
      throw new RuntimeError('EXECUTION_FAILED', 'The provider returned an incomplete forecast.');
    const dates = new Intl.DateTimeFormat('en-CA', {
      timeZone: location.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const days = new Map<string, typeof hours>();
    for (const hour of hours) {
      const date = dates.format(new Date(hour.time));
      const values = days.get(date) ?? [];
      values.push(hour);
      days.set(date, values);
    }
    const clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: location.timezone,
      hour: '2-digit',
      hourCycle: 'h23',
    });
    const daily = [...days].map(([date, values]) => {
      const valuesWithTemp = values.flatMap((v) => (v.temperature === null ? [] : [v.temperature]));
      const hourly = values.every(
        (value, index) =>
          index === 0 || Date.parse(value.time) - Date.parse(values[index - 1].time) === 3_600_000,
      );
      return {
        date,
        minimumTemperature: valuesWithTemp.length ? Math.min(...valuesWithTemp) : null,
        maximumTemperature: valuesWithTemp.length ? Math.max(...valuesWithTemp) : null,
        samples: values.length,
        partial:
          values.length < 23 ||
          valuesWithTemp.length !== values.length ||
          !hourly ||
          clock.format(new Date(values[0].time)) !== '00' ||
          clock.format(new Date(values.at(-1)!.time)) !== '23',
      };
    });
    const current = hours.reduce((best, item) =>
      Math.abs(Date.parse(item.time) - now) < Math.abs(Date.parse(best.time) - now) ? item : best,
    );
    const currentAvailable = Math.abs(Date.parse(current.time) - now) <= 90 * 60_000;
    if (operation === 'weather.current' && !currentAvailable)
      throw new RuntimeError('EXECUTION_FAILED', 'The provider has no near-current forecast.');
    return {
      location,
      kind: 'forecast',
      current:
        operation === 'weather.daily' || operation === 'weather.hourly'
          ? undefined
          : currentAvailable
            ? { ...current, kind: 'estimated_current' }
            : null,
      hourly: ['weather.hourly', 'weather.forecast'].includes(operation)
        ? hours.slice(hourOffset, hourOffset + 24)
        : undefined,
      ...(operation === 'weather.hourly' && {
        hourOffset,
        ...(hourOffset + 24 < hours.length && { nextHourOffset: hourOffset + 24 }),
      }),
      daily: ['weather.daily', 'weather.forecast'].includes(operation)
        ? daily.slice(0, 10)
        : undefined,
      provider: 'MET Norway',
      attribution:
        'Weather forecast from the Norwegian Meteorological Institute, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); daily values are derived from forecast samples.',
      generatedAt: data.properties.meta.updated_at,
      retrievedAt: new Date(cache.retrievedAt).toISOString(),
      freshUntil: new Date(cache.expires).toISOString(),
      units: {
        temperature: settings.temperature,
        wind: settings.wind,
        precipitation: 'mm',
        humidity: '%',
        windDirection: 'degrees',
      },
    };
  },
};

export const weatherProviders = new Map<string, WeatherProvider>([
  [metNorwayProvider.id, metNorwayProvider],
]);
