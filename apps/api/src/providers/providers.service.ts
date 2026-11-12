import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { modelCapabilitySchema, type DiscoveredModel } from '@aria/shared';
import { documentedModel } from './openai-catalog';
import { providerError } from '../ai/ai.service';

export interface Connection {
  provider: 'openai';
  baseUrl: string;
  apiKey: string;
}
export function endpoint(base: string, route: string): string {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new BadRequestException(
      'Enter an HTTP or HTTPS endpoint without credentials, a query, or a fragment.',
    );
  return `${base.replace(/\/+$/, '')}/${route}`;
}
export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('Missing response body.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new BadGatewayException('The provider response exceeded the supported size.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
function describeModel(item: Record<string, unknown>, baseUrl: string): DiscoveredModel {
  const id = item.id as string;
  const official = new URL(baseUrl).origin === 'https://api.openai.com';
  const raw = Array.isArray(item.capabilities) ? item.capabilities : undefined;
  const capabilities = raw?.slice(0, 32).flatMap((value) => {
    const capability = modelCapabilitySchema.safeParse(value);
    return capability.success && (capability.data !== 'web-search' || official)
      ? [capability.data]
      : [];
  });
  if (!capabilities)
    return (
      (official ? documentedModel(id) : undefined) ?? { id, capabilities: [], source: 'unknown' }
    );
  const transport = item.transport;
  return {
    id,
    capabilities: [...new Set(capabilities)],
    source: 'provider',
    ...(['realtime', 'speech-api', 'inline-png', 'base64-image'].includes(String(transport))
      ? { transport: transport as DiscoveredModel['transport'] }
      : {}),
    ...(Array.isArray(item.voices)
      ? {
          voices: item.voices
            .slice(0, 24)
            .filter(
              (voice): voice is string =>
                typeof voice === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(voice),
            ),
        }
      : {}),
    ...Object.fromEntries(
      ['contextTokens', 'inputCost', 'outputCost'].flatMap((key) =>
        typeof item[key] === 'number' && Number.isFinite(item[key]) && item[key] >= 0
          ? [[key, item[key]]]
          : [],
      ),
    ),
  };
}
@Injectable()
export class ProvidersService {
  private cache = new Map<string, { at: number; models: DiscoveredModel[] }>();
  async discover(
    config: Connection,
    refresh = false,
    signal?: AbortSignal,
  ): Promise<DiscoveredModel[]> {
    if (config.provider !== 'openai') throw new BadRequestException('Select a supported provider.');
    if (!config.apiKey) throw new BadRequestException('Enter an API key before loading models.');
    const url = endpoint(config.baseUrl, 'models');
    const key = createHash('sha256').update(url).update('\0').update(config.apiKey).digest('hex');
    const cached = this.cache.get(key);
    if (!refresh && cached && Date.now() - cached.at < 300000) return cached.models;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw { statusCode: response.status };
      }
      const body = JSON.parse((await readBounded(response, 2_000_000)).toString()) as {
        data?: Record<string, unknown>[];
      };
      if (!Array.isArray(body.data) || body.data.length > 10000)
        throw new Error('Invalid catalog.');
      const ids = new Set<string>();
      const models: DiscoveredModel[] = [];
      for (const item of body.data) {
        if (typeof item?.id !== 'string' || !item.id.trim() || item.id.length > 200)
          throw new Error('Invalid model.');
        const date = typeof item.shutdown_date === 'string' ? item.shutdown_date : undefined;
        if (
          date &&
          /^\d{4}-\d{2}-\d{2}$/.test(date) &&
          date <= new Date().toISOString().slice(0, 10)
        )
          continue;
        if (!ids.has(item.id)) models.push(describeModel(item, config.baseUrl));
        ids.add(item.id);
      }
      models.sort((a, b) => a.id.localeCompare(b.id));
      if (this.cache.size >= 20) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: Date.now(), models });
      return models;
    } catch (error) {
      this.cache.delete(key);
      throw new BadGatewayException(providerError(error));
    }
  }
}
