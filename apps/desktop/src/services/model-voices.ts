export function speechVoices(model: string): string[] {
  if (/^tts-/i.test(model)) return ['alloy', 'echo', 'fable', 'nova', 'onyx', 'shimmer'];
  if (/realtime/i.test(model))
    return [
      'marin',
      'cedar',
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'sage',
      'shimmer',
      'verse',
    ];
  return [
    'marin',
    'cedar',
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
  ];
}
