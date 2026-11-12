import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { GenerationMode, ProviderModel } from '@aria/shared';
import { providerError } from '../ai/ai.service';

export interface Connection {
  provider: 'openai';
  baseUrl: string;
  apiKey: string;
}
export function connection(): Connection {
  return {
    provider: 'openai',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY?.trim() || '',
  };
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
export function describeModel(id: string, shutdownDate?: string): ProviderModel {
  let modes: GenerationMode[] = [];
  if (/^(gpt-image|dall-e)/i.test(id)) modes = ['image'];
  else if (/^(tts-|.*-tts(?:-|$))/i.test(id)) modes = ['speech'];
  else if (/realtime/i.test(id)) modes = ['speech'];
  else if (/^gpt-live(?:-|$)/i.test(id) && !/transcri|translat/i.test(id)) modes = ['live'];
  else if (/transcrib|^whisper/i.test(id) && !/live/i.test(id)) modes = ['transcription'];
  else if (
    !/embed|moderation|^sora|^gpt-live|translat|transcri/i.test(id) &&
    /^(gpt-|chatgpt-|o\d|ft:)/i.test(id)
  )
    modes = ['chat'];
  return {
    id,
    modes,
    ...(shutdownDate ? { shutdownDate } : {}),
    ...(/^(tts-|.*-tts(?:-|$)|whisper)/i.test(id) ? { deprecated: true } : {}),
  };
}
@Injectable()
export class ProvidersService {
  private cache = new Map<string, { at: number; models: ProviderModel[] }>();
  async list(
    config: Connection = connection(),
    refresh = false,
    signal?: AbortSignal,
  ): Promise<ProviderModel[]> {
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
        data?: { id?: unknown; shutdown_date?: unknown }[];
      };
      if (!Array.isArray(body.data) || body.data.length > 10000)
        throw new Error('Invalid catalog.');
      const ids = new Set<string>();
      const models: ProviderModel[] = [];
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
        if (!ids.has(item.id)) models.push(describeModel(item.id, date));
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
  async assertModel(model: string, signal?: AbortSignal, mode?: GenerationMode): Promise<void> {
    if (
      !model ||
      !(await this.list(connection(), false, signal)).some(
        (item) =>
          item.id === model && (!mode || item.modes.length === 0 || item.modes.includes(mode)),
      )
    )
      throw new BadRequestException(
        'The selected model is unavailable. Refresh models and select a replacement.',
      );
  }
}
