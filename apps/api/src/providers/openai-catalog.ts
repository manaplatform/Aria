import type { DiscoveredModel, ModelCapability } from '@aria/shared';

// Versioned adapter data from the OpenAI model catalog and endpoint guides.
// https://developers.openai.com/api/docs/models
// https://developers.openai.com/api/docs/guides/image-generation
// https://developers.openai.com/api/docs/guides/text-to-speech
// https://developers.openai.com/api/docs/guides/speech-to-text
// https://developers.openai.com/api/docs/guides/live
export const openAiCatalogVersion = '2026-11-13';
type Descriptor = Omit<DiscoveredModel, 'id' | 'source'>;
const entries = (
  ids: string[],
  capabilities: ModelCapability[],
  options: Partial<Descriptor> = {},
) => ids.map((id): [string, Descriptor] => [id, { capabilities, ...options }]);
const liveVoices = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'verse'];
const descriptions = new Map([
  ...entries(
    [
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6-sol',
      'gpt-6.1-sol',
      'gpt-6.1-terra',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5.2',
      'gpt-5-mini',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
    ],
    ['chat', 'tools', 'vision', 'web-search'],
  ),
  ...entries(
    ['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2.6-flare'],
    ['image', 'image-edit'],
    { transport: 'inline-png' },
  ),
  ...entries(['gpt-4o-mini-tts'], ['speech'], {
    transport: 'speech-api',
    voices: [
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'fable',
      'nova',
      'onyx',
      'sage',
      'shimmer',
      'verse',
      'marin',
      'cedar',
    ],
  }),
  ...entries(['tts-1', 'tts-1-hd'], ['speech'], {
    transport: 'speech-api',
    voices: ['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'],
  }),
  ...entries(['gpt-realtime', 'gpt-realtime-mini', 'gpt-realtime-2.1-mini'], ['speech'], {
    transport: 'realtime',
    voices: liveVoices,
  }),
  ...entries(
    ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-transcribe'],
    ['transcription'],
  ),
  ...entries(['gpt-live-1'], ['live'], { voices: liveVoices }),
]);

export function documentedModel(id: string): DiscoveredModel | undefined {
  const descriptor = descriptions.get(id);
  return descriptor && { ...descriptor, id, source: 'documentation' };
}
