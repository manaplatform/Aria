import { z } from 'zod';
import { type webSearchArgs, webUrlSchema } from '@aria/shared';

const responseSchema = z.object({
  query: z.object({ more_results_available: z.boolean().optional() }).optional(),
  web: z
    .object({
      results: z
        .array(z.object({ url: z.string().max(2000) }))
        .max(30)
        .default([]),
    })
    .optional(),
});
type SearchArgs = z.infer<typeof webSearchArgs>;
export interface SearchAdapter {
  id: string;
  name: string;
  options: readonly ('language' | 'country' | 'freshness' | 'cursor')[];
  search(
    args: SearchArgs,
    page: number,
    signal: AbortSignal,
  ): Promise<{ urls: string[]; next: boolean }>;
}
export function braveAdapter(key: string): SearchAdapter {
  return {
    id: 'brave',
    name: 'Brave Search',
    options: ['language', 'country', 'freshness', 'cursor'],
    async search(args, page, parent) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', args.query);
      url.searchParams.set('count', '8');
      url.searchParams.set('offset', String(page));
      if (args.language) url.searchParams.set('search_lang', args.language);
      if (args.country) url.searchParams.set('country', args.country);
      if (args.freshness)
        url.searchParams.set(
          'freshness',
          { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[args.freshness],
        );
      const signal = AbortSignal.any([parent, AbortSignal.timeout(12_000)]);
      for (let attempt = 0; ; attempt++) {
        let response: Response;
        try {
          response = await fetch(url, {
            signal,
            redirect: 'error',
            headers: {
              Accept: 'application/json',
              'X-Subscription-Token': key,
            },
          });
        } catch {
          signal.throwIfAborted();
          if (attempt === 0) continue;
          throw new Error('Brave Search could not be reached. Check your connection.');
        }
        if (!response.ok) {
          await response.body?.cancel();
          if ([401, 403].includes(response.status))
            throw new Error('Brave rejected the key. Check Web & Browser settings.');
          const retry = response.headers.get('retry-after');
          const seconds = retry !== null && /^\d+$/.test(retry) ? Number(retry) : Infinity;
          if (
            attempt === 0 &&
            (response.status >= 500 || (response.status === 429 && seconds <= 1))
          ) {
            if (response.status === 429 && seconds) {
              const { setTimeout } = await import('node:timers/promises');
              await setTimeout(seconds * 1000, undefined, { signal });
            }
            continue;
          }
          if (response.status === 429) throw new Error('Brave Search rate limit reached.');
          if (response.status === 400 || response.status === 422)
            throw new Error('Brave does not accept these search options.');
          throw new Error(`Brave Search returned HTTP ${response.status}.`);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Brave returned an empty response.');
        const buffers: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > 512_000) throw new Error('Brave returned too much search data.');
            buffers.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const result = responseSchema.parse(JSON.parse(Buffer.concat(buffers).toString('utf8')));
        const urls = (result.web?.results ?? []).flatMap(({ url: value }) => {
          if (!webUrlSchema.safeParse(value).success) return [];
          const address = new URL(value);
          address.hash = '';
          return [address.href];
        });
        return {
          urls: [...new Set(urls)].slice(0, 8),
          next: page < 9 && !!result.query?.more_results_available,
        };
      }
    },
  };
}
