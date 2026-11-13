import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const { ProvidersService } = createRequire(import.meta.url)(
  '../dist/providers/providers.service.js',
) as typeof import('../src/providers/providers.service');

afterEach(() => vi.restoreAllMocks());

async function discover(items: Record<string, unknown>[], baseUrl = 'https://api.openai.com/v1') {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: items }));
  const models = await new ProvidersService().discover({
    provider: 'openai',
    baseUrl,
    apiKey: 'fixture-key',
  });
  expect(fetcher).toHaveBeenCalledOnce();
  return new Map(models.map((model) => [model.id, model]));
}

it('recognizes current image models and published snapshots from an ID-only OpenAI catalog', async () => {
  const ids = [
    'gpt-image-2.6-sunburst',
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst-2026-09-08',
  ];
  const models = await discover(ids.map((id) => ({ id })));
  expect(models.size).toBe(ids.length);
  for (const id of ids) {
    expect(models.get(id)).toMatchObject({
      id,
      source: 'documentation',
      capabilities: ['image', 'image-edit'],
      transport: 'inline-png',
    });
  }
});

it('recognizes documented text aliases and snapshots with the correct context limit', async () => {
  const models = await discover([{ id: 'gpt-5.6-luna' }, { id: 'gpt-5.5-2026-04-23' }]);
  for (const model of models.values()) {
    expect(model).toMatchObject({
      source: 'documentation',
      capabilities: ['chat', 'tools', 'vision', 'web-search'],
      contextTokens: 1_050_000,
    });
  }
});

it('resolves speech transport and voices for documented audio variants and snapshots', async () => {
  const models = await discover([{ id: 'gpt-realtime-2.1' }, { id: 'gpt-4o-mini-tts-2025-12-15' }]);
  expect(models.get('gpt-realtime-2.1')).toMatchObject({
    capabilities: ['speech'],
    transport: 'realtime',
  });
  expect(models.get('gpt-4o-mini-tts-2025-12-15')).toMatchObject({
    capabilities: ['speech'],
    transport: 'speech-api',
  });
  for (const model of models.values()) expect(model.voices?.length).toBeGreaterThan(0);
});

it('identifies documented embedding and moderation models as having no supported Aria operations', async () => {
  const ids = ['text-embedding-3-large', 'omni-moderation-latest'];
  const models = await discover(ids.map((id) => ({ id })));
  for (const id of ids)
    expect(models.get(id)).toMatchObject({ source: 'documentation', capabilities: [] });
});

it('keeps undocumented model IDs unknown instead of inferring capabilities from their spelling', async () => {
  const ids = ['gpt-image-2.6-sunburst-2099-01-01', 'gpt-unknown-model', 'private-deployment'];
  const models = await discover(ids.map((id) => ({ id })));
  for (const id of ids) expect(models.get(id)).toEqual({ id, source: 'unknown', capabilities: [] });
});

it('requires provider evidence for compatible endpoints even when they reuse an OpenAI model ID', async () => {
  const id = 'gpt-image-2.6-sunburst';
  const models = await discover([{ id }], 'https://compatible.example/v1');
  expect(models.get(id)).toEqual({ id, source: 'unknown', capabilities: [] });
});

it('keeps provider capabilities authoritative while filling omitted protocol metadata from documentation', async () => {
  const models = await discover([
    { id: 'gpt-image-2.6-sunburst', capabilities: ['image'] },
    { id: 'gpt-realtime-2.1', capabilities: ['speech'], voices: ['cedar'] },
    { id: 'gpt-5.6-luna', capabilities: ['chat'], contextTokens: 4096 },
  ]);
  expect(models.get('gpt-image-2.6-sunburst')).toMatchObject({
    source: 'provider',
    capabilities: ['image'],
    transport: 'inline-png',
  });
  expect(models.get('gpt-realtime-2.1')).toMatchObject({
    source: 'provider',
    capabilities: ['speech'],
    transport: 'realtime',
    voices: ['cedar'],
  });
  expect(models.get('gpt-5.6-luna')).toMatchObject({
    source: 'provider',
    capabilities: ['chat'],
    contextTokens: 4096,
  });
});

it('honors an explicitly empty provider capability list', async () => {
  const model = (await discover([{ id: 'gpt-6-luna', capabilities: [] }])).get('gpt-6-luna');
  expect(model).toMatchObject({ source: 'provider', capabilities: [] });
});
