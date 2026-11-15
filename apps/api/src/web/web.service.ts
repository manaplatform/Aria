import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  browserOps,
  defaultWebPolicy,
  runtimeWebSchema,
  sourceSchema,
  type BrowserOp,
  type ChatRequest,
  type ConductorSource,
  type ExecutionStep,
  type ResearchToolId,
  type RuntimeWeb,
} from '@aria/shared';
import { RunError, type RunFile } from '../conductor/run-assets';
import type { SearchAdapter } from './brave.adapter';
import { searchRegistry } from './search-registry';
import { BrowserPortClient } from './browser-port.client';
import { publicFetch } from './public-fetch';
import { readableDocument } from './readable-document';

type ResearchResult = {
  text?: string;
  file?: RunFile;
  sources?: ConductorSource[];
  data?: Record<string, unknown>;
};
type ResearchContext = Pick<ChatRequest, 'requestId' | 'conversationId' | 'messages'>;
type SearchArgs = Parameters<SearchAdapter['search']>[0];
type Document = { producer: string; text: string; source: ConductorSource };

function normalized(url: string) {
  const address = new URL(url);
  address.hash = '';
  return address.href;
}

@Injectable()
export class WebService {
  private policy: RuntimeWeb = defaultWebPolicy;
  constructor(@Inject(BrowserPortClient) private readonly browser: BrowserPortClient) {}
  install(policy: unknown) {
    this.policy = runtimeWebSchema.parse(policy);
  }

  scope(request: ResearchContext, native: boolean) {
    const policy = this.policy;
    return new ResearchRun(
      request,
      policy,
      native && this.browser.available ? this.browser : undefined,
    );
  }
}

export class ResearchRun {
  private readonly sources = new Map<string, { url: string; producer: string }>();
  private readonly documents = new Map<string, Document>();
  private readonly fetches = new Map<string, ReturnType<typeof publicFetch>>();
  private readonly cursor = new Map<string, { page: number; key: string; producer: string }>();
  private readonly searches = new Map<string, ReturnType<SearchAdapter['search']>>();
  private readonly browserRefs = new Map<string, Set<string>>();
  private readonly adapters: Map<string, SearchAdapter>;
  constructor(
    private readonly request: ResearchContext,
    readonly policy: RuntimeWeb,
    private readonly browser?: BrowserPortClient,
  ) {
    this.adapters = searchRegistry(policy);
  }

  get independent() {
    return this.adapters.size > 0;
  }
  get searchTargets() {
    return [...this.adapters.values()].map(({ id, name, options }) => ({ id, name, options }));
  }
  get native() {
    return this.policy.enabled && this.policy.aiBrowser && !!this.browser;
  }

  observeSources(sources: ConductorSource[], producer: string) {
    for (const source of sources) {
      source.id ??= randomUUID();
      this.sources.set(source.id, { url: source.url, producer });
    }
  }

  private destination(args: Record<string, unknown>, dependsOn: string[]) {
    if (typeof args.sourceId === 'string') {
      const source = this.sources.get(args.sourceId);
      if (source && dependsOn.includes(source.producer)) return source.url;
    }
    if (typeof args.url === 'string') {
      const url = normalized(args.url);
      for (const source of this.sources.values())
        if (dependsOn.includes(source.producer) && normalized(source.url) === url) return url;
      const latest = this.request.messages.at(-1);
      if (latest?.role === 'user') {
        const requestText = latest.content
          .split(/\r?\n/)
          .filter((line) => !line.trimStart().startsWith('>'))
          .join('\n');
        for (const token of requestText.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
          const candidate = token[0].replace(/[).,;!?\]}]+$/, '');
          try {
            if (normalized(candidate) === url) return url;
          } catch {
            /* Invalid URL. */
          }
        }
      }
    }
    throw new RunError(
      'Use a URL from the latest user message or a source from a declared dependency.',
    );
  }

  private async search(
    args: SearchArgs,
    step: ExecutionStep,
    signal: AbortSignal,
  ): Promise<ResearchResult> {
    const adapter =
      step.target.kind === 'tool' && step.target.searchConnectionId
        ? this.adapters.get(step.target.searchConnectionId)
        : undefined;
    if (!adapter)
      throw new RunError('Enable the selected search provider in Settings → Web & Browser.');
    for (const key of ['language', 'country', 'freshness', 'cursor'] as const)
      if (args[key] !== undefined && !adapter.options.includes(key))
        throw new RunError(`${adapter.name} does not support the requested ${key} option.`);
    const options = {
      ...args,
      language:
        args.language ?? (adapter.options.includes('language') ? this.policy.language : undefined),
      country:
        args.country ?? (adapter.options.includes('country') ? this.policy.country : undefined),
      cursor: undefined,
    };
    const key = JSON.stringify([adapter.id, options]);
    const cursor = args.cursor ? this.cursor.get(args.cursor) : undefined;
    if (args.cursor && (!cursor || cursor.key !== key || !step.dependsOn.includes(cursor.producer)))
      throw new RunError('The search cursor does not match this query and its dependencies.');
    const page = cursor?.page ?? 0;
    const cacheKey = JSON.stringify([key, page]);
    const pending = this.searches.get(cacheKey) ?? adapter.search(options, page, signal);
    this.searches.set(cacheKey, pending);
    const response = await pending;
    const results = response.urls.map((url) => {
      const sourceId = randomUUID();
      this.sources.set(sourceId, { url, producer: step.id });
      return { sourceId, url };
    });
    const nextCursor = response.next ? randomUUID() : undefined;
    if (nextCursor) this.cursor.set(nextCursor, { key, producer: step.id, page: page + 1 });
    return { data: { status: results.length ? 'results' : 'no_results', results, nextCursor } };
  }

  async invoke(
    op: ResearchToolId,
    args: Record<string, unknown>,
    step: ExecutionStep,
    signal: AbortSignal,
  ): Promise<ResearchResult> {
    try {
      if (op === 'web_search') return await this.search(args as SearchArgs, step, signal);
      if (op === 'web_fetch') {
        const url = this.destination(args, step.dependsOn);
        const pending = this.fetches.get(url) ?? publicFetch(url, signal);
        this.fetches.set(url, pending);
        const result = await pending;
        const read = readableDocument(result.body, result.mime);
        if (!read.text) throw new RunError('The page contained no readable text.');
        const source = sourceSchema.parse({
          id: randomUUID(),
          url: result.url,
          title: read.title || new URL(result.url).hostname,
          domain: new URL(result.url).hostname,
          publisher: 'publisher' in read ? read.publisher : undefined,
          publishedAt: 'publishedAt' in read ? read.publishedAt : undefined,
          retrievedAt: new Date().toISOString(),
          provenance: 'publisher',
          contentType: result.mime,
        });
        this.observeSources([source], step.id);
        const documentId = randomUUID();
        this.documents.set(documentId, { producer: step.id, text: read.text, source });
        return {
          data: { documentId, source, preview: read.text.slice(0, 1000) },
          sources: [source],
        };
      }
      if (op === 'web_read' || op === 'web_find') {
        const entry = this.documents.get(String(args.documentId));
        if (!entry || !step.dependsOn.includes(entry.producer))
          throw new RunError('Reference a document from a successful fetch dependency.');
        if (op === 'web_read')
          return { text: entry.text.slice(0, 12_000), sources: [entry.source] };
        const query = String(args.query).toLowerCase();
        const haystack = entry.text.toLowerCase();
        const matches: string[] = [];
        for (let pos = 0; matches.length < 12;) {
          const found = haystack.indexOf(query, pos);
          if (found < 0) break;
          matches.push(entry.text.slice(Math.max(0, found - 160), found + query.length + 160));
          pos = found + query.length;
        }
        return { data: { matches, source: entry.source }, sources: [entry.source] };
      }
      if (!this.native || !this.browser || !browserOps.includes(op as BrowserOp))
        throw new RunError('Enable AI browsing in Settings → Web & Browser.');
      for (const id of [args.tabId, args.documentId, args.elementId].filter(
        (value): value is string => typeof value === 'string',
      )) {
        const producers = this.browserRefs.get(id);
        if (!producers || !step.dependsOn.some((dependency) => producers.has(dependency)))
          throw new RunError(
            'Reference a browser tab, page or element from a successful dependency.',
          );
      }
      let browserArgs = args;
      if (op === 'browser_open' || op === 'browser_navigate')
        browserArgs = {
          ...(args.tabId ? { tabId: args.tabId } : {}),
          url: this.destination(args, step.dependsOn),
        };
      const result = await this.browser.invoke(
        {
          requestId: this.request.requestId,
          conversationId: this.request.conversationId,
          stepId: step.id,
          op: op as BrowserOp,
          args: browserArgs,
        },
        signal,
      );
      if (!result.ok) throw new RunError(`${result.code}: ${result.message}`);
      const json = JSON.parse(result.text) as Record<string, unknown>;
      this.observeBrowserRefs(json, step.id);
      let sources: ConductorSource[] | undefined;
      if (op === 'browser_extract' && result.url) {
        const source = sourceSchema.safeParse({
          id: randomUUID(),
          url: result.url,
          title: result.title || result.url.slice(0, 300),
          domain: new URL(result.url).hostname,
          retrievedAt: new Date().toISOString(),
          provenance: 'browser',
          contentType: 'text/html',
        });
        if (source.success) {
          sources = [source.data];
          this.observeSources(sources, step.id);
        }
      }
      if (Array.isArray(json.elements))
        for (const item of json.elements) {
          const link = sourceSchema.safeParse({ title: '', url: item.href });
          if (link.success) {
            link.data.id = randomUUID();
            this.observeSources([link.data], step.id);
            item.sourceId = link.data.id;
          }
        }
      return {
        data: json,
        sources,
        file: result.screenshot
          ? {
              name: 'aria-browser.png',
              mimeType: 'image/png',
              bytes: Buffer.from(result.screenshot),
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof RunError) throw error;
      if (signal.aborted) throw error;
      throw new RunError(
        error instanceof Error && error.name !== 'ZodError'
          ? error.message.slice(0, 250)
          : 'The web tool returned an unexpected response.',
      );
    }
  }

  private observeBrowserRefs(item: unknown, step: string) {
    if (!item || typeof item !== 'object') return;
    for (const [key, value] of Object.entries(item)) {
      if (typeof value === 'string' && ['tabId', 'documentId', 'elementId'].includes(key)) {
        const producers = this.browserRefs.get(value) ?? new Set<string>();
        producers.add(step);
        this.browserRefs.set(value, producers);
      } else if (typeof value === 'object') this.observeBrowserRefs(value, step);
    }
  }
}
