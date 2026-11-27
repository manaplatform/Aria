import { promises as fs } from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { checkServerIdentity } from 'node:tls';
import { gunzipSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import tzLookup from '@photostructure/tz-lookup';
import { z } from 'zod';
import {
  defaultWeatherSettings,
  resolvePublicAddress,
  weatherCoordinates,
  weatherOperations,
  weatherSettingsSchema,
  type WeatherOperation,
  type WeatherSettings,
  type DiagnosticContext,
} from '@aria/shared';
import { writeBrowserJson } from './web-settings-storage';
import { RuntimeError } from './runtime/store';
import { weatherProviders, type WeatherLocation } from './weather-providers';

type Coordinates = z.infer<typeof weatherCoordinates>;
type Location = WeatherLocation;
type CacheEntry = { body: unknown; retrievedAt: number; expires: number; modified?: string };
const places = z.object({
  results: z
    .array(
      z.object({
        name: z.string().min(1).max(160),
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        timezone: z.string().max(100).optional(),
        country: z.string().max(160).optional(),
        admin1: z.string().max(160).optional(),
      }),
    )
    .max(20)
    .optional(),
});
const cacheSchema = z.record(
  z.string().max(2048),
  z.object({
    body: z.unknown(),
    retrievedAt: z.number(),
    expires: z.number(),
    modified: z.string().max(100).optional(),
  }),
);
const ledgerSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.number().finite());
const maxCacheBytes = 16_000_000;

export class WeatherService {
  private settingsValue: WeatherSettings = { ...defaultWeatherSettings };
  private cache: Record<string, CacheEntry> = {};
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<CacheEntry>; waiters: number }
  >();
  private nextRequest = new Map<string, number>();
  private readonly settingsFile: string;
  private readonly cacheFile: string;
  private readonly ledgerFile: string;
  private cacheWrites: Promise<void> = Promise.resolve();
  private ledgerWrites: Promise<void> = Promise.resolve();
  private ledger: Record<string, number> = {};
  private ledgerHoldUntil = 0;
  private cacheGeneration = 0;
  private providerStatus: 'not_checked' | 'available' | 'unavailable' = 'not_checked';
  private readonly diagnosticContext = new AsyncLocalStorage<DiagnosticContext>();
  constructor(
    directory: string,
    private readonly diagnostic: (
      event: string,
      details: { provider?: string; status?: string },
      context: DiagnosticContext,
    ) => void = () => undefined,
  ) {
    this.settingsFile = path.join(directory, 'weather-settings-v1.json');
    this.cacheFile = path.join(directory, 'weather-cache-v1.json');
    this.ledgerFile = path.join(directory, 'weather-throttle-v1.json');
  }
  private report(event: string, details: { provider?: string; status?: string }) {
    try {
      this.diagnostic(event, details, this.diagnosticContext.getStore() ?? {});
    } catch {
      /* Diagnostics must not affect weather. */
    }
  }
  async load() {
    try {
      this.settingsValue = weatherSettingsSchema.parse(
        JSON.parse(await fs.readFile(this.settingsFile, 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.settingsValue = { ...defaultWeatherSettings, enabled: false };
    }
    try {
      const bytes = await fs.readFile(this.cacheFile);
      if (bytes.length > maxCacheBytes) throw new Error('Cache exceeds size limit');
      this.cache = cacheSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch {
      this.cache = {};
    }
    try {
      const bytes = await fs.readFile(this.ledgerFile);
      if (bytes.length > 1_000_000) throw new Error('Request ledger exceeds size limit');
      this.ledger = ledgerSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        this.ledgerHoldUntil = Date.now() + 24 * 60 * 60_000;
    }
  }
  settings() {
    return {
      ...this.settingsValue,
      cachedEntries: Object.keys(this.cache).length,
      providerStatus: this.providerStatus,
      providers: [...weatherProviders.values()].map(({ id, name }) => ({ id, name })),
    };
  }
  async configure(input: unknown) {
    const next = weatherSettingsSchema.parse(input);
    if (!weatherProviders.has(next.provider))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The selected weather provider is unavailable.',
      );
    await writeBrowserJson(this.settingsFile, next);
    const providerChanged = next.provider !== this.settingsValue.provider;
    if (providerChanged) this.providerStatus = 'not_checked';
    this.settingsValue = next;
    if (!next.enabled || providerChanged)
      for (const active of this.active.values()) active.controller.abort();
    return this.settings();
  }
  async clearCache() {
    this.cacheGeneration++;
    const pending = [...this.active.values()];
    for (const item of pending) item.controller.abort();
    await Promise.allSettled(pending.map((item) => item.promise));
    this.cache = {};
    await this.persist();
    return this.settings();
  }
  private async persist() {
    const entries = Object.entries(this.cache)
      .sort((a, b) => b[1].retrievedAt - a[1].retrievedAt)
      .slice(0, 100);
    let size = 2;
    const bounded: [string, CacheEntry][] = [];
    for (const entry of entries) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      if (size + bytes > maxCacheBytes) continue;
      size += bytes;
      bounded.push(entry);
    }
    this.cache = Object.fromEntries(bounded);
    const snapshot = { ...this.cache };
    this.cacheWrites = this.cacheWrites
      .then(() => writeBrowserJson(this.cacheFile, snapshot))
      .catch(() => undefined);
    await this.cacheWrites;
  }
  private async saveLedger() {
    const snapshot = { ...this.ledger };
    const write = this.ledgerWrites.then(() => writeBrowserJson(this.ledgerFile, snapshot));
    this.ledgerWrites = write.catch(() => undefined);
    await write;
  }
  private async request(
    url: URL,
    signal: AbortSignal,
    headers: Record<string, string>,
    redirects = 0,
  ): Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; bytes: Buffer }> {
    if (
      url.protocol !== 'https:' ||
      ![
        'geocoding-api.open-meteo.com',
        ...[...weatherProviders.values()].flatMap((provider) => provider.hostnames),
      ].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'The weather provider destination is not allowed.',
      );
    signal.throwIfAborted();
    let address: LookupAddress;
    try {
      address = await resolvePublicAddress(url.hostname, (host) => lookup(host, { all: true }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAI_AGAIN') throw error;
      this.report('dns_retry', {
        provider:
          [...weatherProviders.values()].find((item) => item.hostnames.includes(url.hostname))
            ?.id ?? 'open_meteo',
      });
      await delay(200, undefined, { signal });
      address = await resolvePublicAddress(url.hostname, (host) => lookup(host, { all: true }));
    }
    signal.throwIfAborted();
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const req = https.request(
        {
          hostname: address.address,
          family: address.family,
          port: 443,
          path: url.pathname + url.search,
          servername: url.hostname,
          checkServerIdentity: (_host, cert) => checkServerIdentity(url.hostname, cert),
          method: 'GET',
          agent: false,
          signal,
          maxHeaderSize: 16384,
          headers: {
            host: url.hostname,
            'User-Agent': 'Aria https://github.com/manaplatform/Aria',
            Accept: 'application/json',
            'Accept-Encoding': 'gzip, deflate',
            ...headers,
          },
        },
        resolve,
      );
      req.once('error', reject);
      req.end();
    });
    const status = response.statusCode ?? 502;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects >= 3)
        throw new RuntimeError('EXECUTION_FAILED', 'The provider exceeded the redirect limit.');
      const next = new URL(location, url);
      if (next.hostname !== url.hostname)
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'The provider redirected to an unapproved destination.',
        );
      return this.request(next, signal, headers, redirects + 1);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 2_000_000) {
        response.destroy();
        throw new RuntimeError('EXECUTION_FAILED', 'The provider response is too large.');
      }
      chunks.push(bytes);
    }
    let bytes = Buffer.concat(chunks);
    if (response.headers['content-encoding'] === 'gzip')
      bytes = gunzipSync(bytes, { maxOutputLength: 4_000_000 });
    else if (response.headers['content-encoding'] === 'deflate')
      bytes = inflateSync(bytes, { maxOutputLength: 4_000_000 });
    if (bytes.length > 4_000_000)
      throw new RuntimeError('EXECUTION_FAILED', 'The provider response is too large.');
    return { status, headers: response.headers, bytes };
  }
  private async fetch(
    url: URL,
    signal: AbortSignal,
    minimumMs: number,
    validate: (body: unknown) => void,
  ): Promise<CacheEntry> {
    signal.throwIfAborted();
    const key = url.href;
    const cached = this.cache[key];
    const provider =
      [...weatherProviders.values()].find((item) => item.hostnames.includes(url.hostname))?.id ??
      'open_meteo';
    if (cached && cached.expires > Date.now()) {
      this.report('cache_hit', { provider });
      return cached;
    }
    this.report('cache_miss', { provider });
    let entry = this.active.get(key);
    if (!entry) {
      const controller = new AbortController();
      const generation = this.cacheGeneration;
      const run = async () => {
        const fingerprint = createHash('sha256').update(key).digest('hex');
        const providerFingerprint = createHash('sha256')
          .update(`provider:${url.hostname}`)
          .digest('hex');
        const now = Date.now();
        for (const [id, expires] of Object.entries(this.ledger))
          if (expires <= now) delete this.ledger[id];
        if (now < this.ledgerHoldUntil || (this.ledger[fingerprint] ?? 0) > now)
          throw new RuntimeError(
            'CAPABILITY_UNAVAILABLE',
            'The provider refresh interval has not elapsed. Try again later.',
          );
        if ((this.ledger[providerFingerprint] ?? 0) > now)
          throw new RuntimeError(
            'CAPABILITY_UNAVAILABLE',
            'The provider is rate limited. Try again later.',
          );
        if (Object.keys(this.ledger).length >= 10_000)
          throw new RuntimeError(
            'CAPABILITY_UNAVAILABLE',
            'The local provider request limit has been reached. Try again later.',
          );
        const start = Math.max(now, this.nextRequest.get(url.hostname) ?? 0);
        if (start - now > 5000)
          throw new RuntimeError(
            'CAPABILITY_UNAVAILABLE',
            'The provider is rate limited. Try again later.',
          );
        this.nextRequest.set(url.hostname, start + 1000);
        controller.signal.throwIfAborted();
        if (start > now)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, start - now);
            controller.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(controller.signal.reason);
              },
              { once: true },
            );
          });
        this.ledger[fingerprint] = Date.now() + minimumMs;
        try {
          await this.saveLedger();
        } catch {
          throw new RuntimeError(
            'CAPABILITY_UNAVAILABLE',
            'The local provider request ledger could not be saved.',
          );
        }
        controller.signal.throwIfAborted();
        const timeout = AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
        let response: Awaited<ReturnType<WeatherService['request']>>;
        try {
          response = await this.request(
            url,
            timeout,
            cached?.modified ? { 'If-Modified-Since': cached.modified } : {},
          );
        } catch (error) {
          if (provider !== 'open_meteo' && !controller.signal.aborted)
            this.providerStatus = 'unavailable';
          throw error;
        }
        if (provider !== 'open_meteo')
          this.providerStatus = [200, 203, 304].includes(response.status)
            ? 'available'
            : 'unavailable';
        this.report('http_response', { provider, status: String(response.status) });
        if (response.status === 429) {
          const retry = response.headers['retry-after'];
          const seconds =
            typeof retry === 'string' && /^\d+$/.test(retry) ? Number(retry) * 1000 : 0;
          const date = typeof retry === 'string' ? Date.parse(retry) - Date.now() : 0;
          const retryAt =
            Date.now() +
            Math.max(60_000, Math.min(86_400_000, seconds || (Number.isFinite(date) ? date : 0)));
          this.nextRequest.set(url.hostname, retryAt);
          this.ledger[providerFingerprint] = retryAt;
          await this.saveLedger();
        }
        if (
          response.status !== 200 &&
          response.status !== 203 &&
          !(response.status === 304 && cached)
        )
          throw new RuntimeError(
            'EXECUTION_FAILED',
            `Weather provider request failed (HTTP ${response.status}).`,
          );
        const retrievedAt = Date.now();
        const headerExpiry = Date.parse(String(response.headers.expires ?? ''));
        const cacheControl = String(response.headers['cache-control'] ?? '');
        if (/\bno-store\b/i.test(cacheControl))
          throw new RuntimeError(
            'EXECUTION_FAILED',
            'The provider response cannot be cached safely.',
          );
        const maxAge = /(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/i.exec(cacheControl);
        const headerMaxAge = maxAge
          ? retrievedAt + Math.max(0, Number(maxAge[1]) - Number(response.headers.age ?? 0)) * 1000
          : 0;
        const value =
          response.status === 304
            ? cached!.body
            : (JSON.parse(response.bytes.toString('utf8')) as unknown);
        // Validate before a response enters the persistent cache.
        try {
          validate(value);
        } catch {
          this.report('validation_failed', { provider });
          throw new RuntimeError('EXECUTION_FAILED', 'The provider returned an invalid response.');
        }
        const result: CacheEntry = {
          body: value,
          retrievedAt,
          expires: Math.max(
            retrievedAt + minimumMs,
            Number.isFinite(headerExpiry) ? headerExpiry : 0,
            Number.isFinite(headerMaxAge) ? headerMaxAge : 0,
          ),
          modified:
            typeof response.headers['last-modified'] === 'string'
              ? response.headers['last-modified']
              : cached?.modified,
        };
        if (generation !== this.cacheGeneration || controller.signal.aborted)
          throw new RuntimeError('CANCELLED', 'The weather request was cancelled.');
        this.ledger[fingerprint] = Math.max(this.ledger[fingerprint], result.expires);
        await this.saveLedger();
        this.cache[key] = result;
        await this.persist();
        return result;
      };
      const promise = run().finally(() => this.active.delete(key));
      entry = { controller, promise, waiters: 0 };
      this.active.set(key, entry);
    }
    entry.waiters++;
    try {
      signal.throwIfAborted();
      return await new Promise<CacheEntry>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        entry!.promise
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
    } finally {
      if (--entry.waiters === 0 && this.active.get(key) === entry) entry.controller.abort();
    }
  }
  private async search(query: string, language: string | undefined, signal: AbortSignal) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.searchParams.set('name', query);
    url.searchParams.set('count', '10');
    if (language) url.searchParams.set('language', language);
    const entry = await this.fetch(url, signal, 24 * 60 * 60_000, (body) => {
      places.parse(body);
    });
    return (places.parse(entry.body).results ?? []).map((place) => {
      let timezone = place.timezone ?? tzLookup(place.latitude, place.longitude);
      try {
        new Intl.DateTimeFormat('en', { timeZone: timezone });
      } catch {
        timezone = tzLookup(place.latitude, place.longitude);
      }
      return {
        name: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
        latitude: place.latitude,
        longitude: place.longitude,
        timezone,
      };
    });
  }
  private async resolve(
    input: string | Coordinates | undefined,
    signal: AbortSignal,
  ): Promise<Location | { candidates: Location[] }> {
    input ??= this.settingsValue.defaultLocation;
    if (!input)
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'Provide a location or set a default location in Weather & Location settings.',
      );
    if (typeof input !== 'string') {
      const timezone = input.timezone ?? tzLookup(input.latitude, input.longitude);
      try {
        new Intl.DateTimeFormat('en', { timeZone: timezone });
      } catch {
        throw new RuntimeError('INVALID_ARGUMENT', 'The location time zone is invalid.');
      }
      return { ...input, name: input.name ?? `${input.latitude}, ${input.longitude}`, timezone };
    }
    const candidates = await this.search(input, undefined, signal);
    if (!candidates.length)
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'No location matched. Ask for a city and country or coordinates.',
      );
    if (candidates.length > 1) return { candidates };
    return candidates[0];
  }
  private async getForecast(
    location: Location,
    operation: WeatherOperation,
    signal: AbortSignal,
    hourOffset = 0,
  ) {
    const provider = weatherProviders.get(this.settingsValue.provider);
    if (!provider)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The selected weather provider is unavailable.',
      );
    const entry = await this.fetch(
      provider.url(location),
      signal,
      provider.minimumCacheMs,
      (body) => provider.validate(body),
    );
    return provider.normalize(
      entry.body,
      location,
      operation,
      this.settingsValue,
      entry,
      hourOffset,
    );
  }
  async dispatch(
    operation: WeatherOperation,
    input: unknown,
    signal: AbortSignal,
    context: DiagnosticContext = {},
  ): Promise<Record<string, unknown>> {
    return this.diagnosticContext.run(context, () =>
      this.dispatchOperation(operation, input, signal),
    );
  }
  private async dispatchOperation(
    operation: WeatherOperation,
    input: unknown,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.settingsValue.enabled)
      throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'Weather is disabled in Settings.');
    const args = weatherOperations[operation].parse(input);
    if (operation === 'location.current')
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Device location is not available on this installation. Provide a location or coordinates.',
      );
    if (operation === 'location.search') {
      const query = args as z.infer<(typeof weatherOperations)['location.search']>;
      return {
        locations: await this.search(query.query, query.language, signal),
        attribution:
          'Location data by GeoNames via Open-Meteo, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).',
      };
    }
    if (operation === 'weather.compare') {
      const values = (args as z.infer<(typeof weatherOperations)['weather.compare']>).locations;
      const results = await Promise.all(
        values.map(async (value) => {
          const resolved = await this.resolve(value, signal);
          return 'candidates' in resolved
            ? resolved
            : this.getForecast(resolved, 'weather.current', signal);
        }),
      );
      return { results };
    }
    const location = await this.resolve(
      (args as { location?: string | Coordinates }).location,
      signal,
    );
    return 'candidates' in location
      ? { clarification: 'Choose the intended location.', candidates: location.candidates }
      : this.getForecast(location, operation, signal, (args as { hourOffset?: number }).hourOffset);
  }
}
