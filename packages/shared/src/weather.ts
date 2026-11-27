import { z } from 'zod';

export const weatherCoordinates = z.strictObject({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  name: z.string().trim().min(1).max(160).optional(),
  timezone: z.string().min(1).max(100).optional(),
});
export const weatherLocation = z.union([z.string().trim().min(2).max(160), weatherCoordinates]);
const forecastInput = z.strictObject({ location: weatherLocation.optional() });
export const weatherOperations = {
  'location.search': z.strictObject({
    query: z.string().trim().min(2).max(160),
    language: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
  }),
  'location.current': z.strictObject({}),
  'weather.current': forecastInput,
  'weather.hourly': forecastInput.extend({
    hourOffset: z
      .number()
      .int()
      .min(0)
      .max(200)
      .optional()
      .describe(
        'Zero-based offset into the available future forecast. Use nextHourOffset to continue.',
      ),
  }),
  'weather.daily': forecastInput,
  'weather.forecast': forecastInput,
  'weather.compare': z.strictObject({ locations: z.array(weatherLocation).min(2).max(5) }),
} as const;
export type WeatherOperation = keyof typeof weatherOperations;
const resolvedLocation = weatherCoordinates.extend({
  name: z.string().min(1).max(500),
  timezone: z.string().min(1).max(100),
});
const reading = z.strictObject({
  time: z.string().datetime({ offset: true }),
  temperature: z.number().finite().nullable(),
  apparentTemperature: z.number().finite().nullable(),
  humidity: z.number().finite().nullable(),
  windSpeed: z.number().finite().nullable(),
  windDirection: z.number().finite().nullable(),
  condition: z.string().max(100).nullable(),
  precipitationAmount: z.number().finite().nullable(),
  precipitationProbability: z.number().finite().nullable(),
});
export const normalizedWeatherForecast = z.strictObject({
  location: resolvedLocation,
  kind: z.literal('forecast'),
  current: reading
    .extend({ kind: z.literal('estimated_current') })
    .nullable()
    .optional(),
  hourly: z.array(reading).max(24).optional(),
  hourOffset: z.number().int().min(0).optional(),
  nextHourOffset: z.number().int().min(0).optional(),
  daily: z
    .array(
      z.strictObject({
        date: z.string().max(20),
        minimumTemperature: z.number().finite().nullable(),
        maximumTemperature: z.number().finite().nullable(),
        samples: z.number().int().positive(),
        partial: z.boolean(),
      }),
    )
    .max(10)
    .optional(),
  provider: z.string().max(100),
  attribution: z.string().max(1000),
  generatedAt: z.string().datetime({ offset: true }),
  retrievedAt: z.string().datetime({ offset: true }),
  freshUntil: z.string().datetime({ offset: true }),
  units: z.strictObject({
    temperature: z.enum(['celsius', 'fahrenheit']),
    wind: z.enum(['m/s', 'km/h', 'mph']),
    precipitation: z.literal('mm'),
    humidity: z.literal('%'),
    windDirection: z.literal('degrees'),
  }),
});
const clarification = z.strictObject({
  clarification: z.string().max(200),
  candidates: z.array(resolvedLocation).min(1).max(10),
});
export const weatherResult = z.union([
  normalizedWeatherForecast,
  clarification,
  z.strictObject({
    locations: z.array(resolvedLocation).max(10),
    attribution: z.string().max(500),
  }),
  z.strictObject({
    results: z
      .array(
        z.union([
          normalizedWeatherForecast,
          z.strictObject({ candidates: z.array(resolvedLocation).min(1).max(10) }),
        ]),
      )
      .min(2)
      .max(5),
  }),
]);
export const weatherSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  provider: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,49}$/)
    .default('met_norway'),
  defaultLocation: weatherLocation.optional(),
  temperature: z.enum(['celsius', 'fahrenheit']),
  wind: z.enum(['m/s', 'km/h', 'mph']),
});
export type WeatherSettings = z.infer<typeof weatherSettingsSchema>;
export type WeatherSettingsView = WeatherSettings & {
  cachedEntries: number;
  providerStatus: 'not_checked' | 'available' | 'unavailable';
  providers: { id: string; name: string }[];
};
export const defaultWeatherSettings: WeatherSettings = {
  enabled: true,
  provider: 'met_norway',
  temperature: 'celsius',
  wind: 'm/s',
};
