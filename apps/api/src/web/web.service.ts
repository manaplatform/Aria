import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  browserSearchResultsSchema,
  defaultWebPolicy,
  runtimeWebSchema,
  sourceSchema,
  type BrowserBridgeOp,
  type ChatRequest,
  type ConductorSource,
  type ExecutionStep,
  type ResearchToolId,
  type RuntimeWeb,
} from '@aria/shared';
import { ToolError } from '../conductor/capability-host';
import { RunError, type RunFile } from '../conductor/run-assets';
import { BrowserPortClient } from './browser-port.client';

type ResearchResult = {
  text?: string;
  file?: RunFile;
  sources?: ConductorSource[];
  data?: Record<string, unknown>;
};
type ResearchContext = Pick<ChatRequest, 'requestId' | 'conversationId' | 'messages'>;
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
  private readonly browserRefs = new Map<string, Set<string>>();
  constructor(
    private readonly request: ResearchContext,
    readonly policy: RuntimeWeb,
    private readonly browser?: BrowserPortClient,
  ) {}

  get native() {
    return (
      this.policy.enabled &&
      this.policy.aiBrowser &&
      Boolean(this.browser && this.browser.available !== false)
    );
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
      'Use the user’s URL or a source from a declared dependency. If you only have a topic or question, run web_search with a query first.',
    );
  }

  private async browse(
    op: BrowserBridgeOp,
    args: Record<string, unknown>,
    step: ExecutionStep,
    signal: AbortSignal,
    approval?: () => void,
  ) {
    if (!this.native || !this.browser)
      throw new RunError('Allow Aria to search and browse in Settings → Web & Browser.');
    const result = await this.browser.invoke(
      {
        requestId: this.request.requestId,
        conversationId: this.request.conversationId,
        stepId: step.id,
        op,
        args,
      },
      signal,
      ...(approval ? [approval] : []),
    );
    if (!result.ok) {
      const code =
        result.code === 'DUPLICATE_DISPATCH'
          ? result.code
          : result.code.startsWith('APPROVAL')
            ? 'PERMISSION_DENIED'
            : 'EXECUTION_FAILED';
      throw new ToolError(code, result.message);
    }
    return result;
  }

  private pageSource(url: string, title?: string) {
    return sourceSchema.parse({
      id: randomUUID(),
      url,
      title: title || url.slice(0, 300),
      domain: new URL(url).hostname,
      retrievedAt: new Date().toISOString(),
      provenance: 'browser',
      contentType: 'text/html',
    });
  }

  async invoke(
    op: ResearchToolId,
    args: Record<string, unknown>,
    step: ExecutionStep,
    signal: AbortSignal,
    approval?: () => void,
  ): Promise<ResearchResult> {
    try {
      if (op === 'web_search') {
        const response = await this.browse(op, args, step, signal, approval);
        const { results } = browserSearchResultsSchema.parse(JSON.parse(response.text));
        const seen = new Set<string>();
        const links = results.flatMap(({ url: raw, title }) => {
          const url = normalized(raw);
          if (seen.has(url)) return [];
          seen.add(url);
          const sourceId = randomUUID();
          this.sources.set(sourceId, { url, producer: step.id });
          return [{ sourceId, url, title }];
        });
        return { data: { status: links.length ? 'results' : 'no_results', results: links } };
      }
      if (op === 'web_fetch') {
        const url = this.destination(args, step.dependsOn);
        const result = await this.browse(op, { url }, step, signal, approval);
        const page: unknown = JSON.parse(result.text);
        const text =
          page && typeof page === 'object' && 'text' in page && typeof page.text === 'string'
            ? page.text
            : '';
        if (!result.url || !text.trim()) throw new RunError('The page contained no readable text.');
        const source = this.pageSource(result.url, result.title);
        this.observeSources([source], step.id);
        const documentId = randomUUID();
        this.documents.set(documentId, { producer: step.id, text, source });
        return { data: { documentId, source, preview: text.slice(0, 1000) }, sources: [source] };
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
      const result = await this.browse(op, browserArgs, step, signal, approval);
      const json = JSON.parse(result.text) as Record<string, unknown>;
      this.observeBrowserRefs(json, step.id);
      let sources: ConductorSource[] | undefined;
      if (op === 'browser_extract' && result.url) {
        sources = [this.pageSource(result.url, result.title)];
        this.observeSources(sources, step.id);
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
      throw new RunError('The web operation did not return a usable response.');
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
