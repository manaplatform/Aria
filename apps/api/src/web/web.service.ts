import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  browserSearchResultsSchema,
  defaultWebPolicy,
  normalizeWebDestination,
  publicWebUrl,
  runtimeWebSchema,
  sourceSchema,
  webFetchResultSchema,
  type BrowserBridgeOp,
  type ChatRequest,
  type ConductorSource,
  type ExecutionStep,
  type ResearchToolId,
  type RuntimeWeb,
} from '@aria/shared';
import { ToolError } from '../conductor/capability-host';
import { RunError, type RunFile } from '../conductor/run-assets';
import { BrowserPortClient, type BrowserProgress } from './browser-port.client';

type ResearchResult = {
  text?: string;
  file?: RunFile;
  sources?: ConductorSource[];
  references?: ConductorSource[];
  data?: Record<string, unknown>;
};
type ResearchContext = Pick<ChatRequest, 'requestId' | 'conversationId' | 'messages'>;
type Document = { producer: string; text: string; source: ConductorSource };

const nonDomainExtensions = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'txt', 'csv', 'tsv',
  'py', 'go', 'rs', 'java', 'rb', 'php', 'yaml', 'yml', 'toml', 'xml', 'html',
  'css', 'scss', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'pdf', 'zip',
  'tar', 'gz', 'log', 'lock', 'sh', 'env', 'sql', 'db', 'sqlite',
]);

function trimCandidateUrl(raw: string) {
  let candidate = raw.replace(/[.,;:!?'"*~،؛؟»\]}]+$/, '');
  while (candidate.endsWith(')')) {
    const opens = (candidate.match(/\(/g) ?? []).length;
    const closes = (candidate.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    candidate = candidate.slice(0, -1).replace(/[.,;:!?'"*~،؛؟»\]}]+$/, '');
  }
  return candidate;
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
  private readonly userUrls = new Set<string>();
  private readonly userOrigins = new Set<string>();
  constructor(
    private readonly request: ResearchContext,
    readonly policy: RuntimeWeb,
    private readonly browser?: BrowserPortClient,
  ) {
    for (const message of request.messages)
      if (message.role === 'user' && typeof message.content === 'string')
        this.observeUserMessage(message.content);
  }

  observeUserMessage(content: string) {
    const requestText = content.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('>')).join('\n');
    const add = (raw: string) => {
      try {
        const url = normalizeWebDestination(trimCandidateUrl(raw));
        this.userUrls.add(url);
        this.userOrigins.add(new URL(url).origin);
      } catch { /* Ignore text that is not an eligible destination. */ }
    };
    for (const token of requestText.matchAll(/https?:\/\/[^\s<>"`]+/gi)) add(token[0]);
    for (const match of requestText.matchAll(
      /(?:^|[\s(<"'`\[])((?:[\p{L}\p{N}-]+\.)+[\p{L}][\p{L}\p{N}-]+(?:[/?#][^\s<>"`\]}]*)?)/giu,
    )) {
      const domain = match[1].split(/[/?#]/, 1)[0].toLowerCase();
      if (domain === match[1].toLowerCase() && nonDomainExtensions.has(domain.split('.').at(-1)!)) continue;
      add(match[1]);
    }
  }

  get native() {
    return (
      this.policy.enabled &&
      this.policy.aiBrowser &&
      Boolean(this.browser && this.browser.available !== false)
    );
  }

  observeSources(sources: ConductorSource[], producer: string) {
    for (const source of sources) {
      if (!sourceSchema.safeParse(source).success) continue;
      try { publicWebUrl(source.url); } catch { continue; }
      source.id ??= randomUUID();
      source.producerStepId = producer;
      this.sources.set(source.id, { url: source.url, producer });
    }
  }

  destination(args: Record<string, unknown>, dependsOn: string[], siteResource = false) {
    if (typeof args.sourceId === 'string') {
      const source = this.sources.get(args.sourceId);
      if (source) {
        if (dependsOn.includes(source.producer)) return source.url;
        throw new ToolError('INVALID_REFERENCE',
          `Declare the source dependency with \`dependsOn: ["${source.producer}"]\` to access this result.`,
          'MISSING_DEPENDENCY',
        );
      }
      throw new ToolError('INVALID_REFERENCE', 'This source reference is unavailable in the current execution. Select a source returned by a completed tool.', 'SOURCE_UNAVAILABLE');
    }
    if (typeof args.url === 'string') {
      const url = normalizeWebDestination(args.url);
      if (this.userUrls.has(url)) return url;
      let missingProducer: string | undefined;
      for (const source of this.sources.values()) {
        if (normalizeWebDestination(source.url) === url) {
          if (dependsOn.includes(source.producer)) return url;
          missingProducer ??= source.producer;
        }
      }
      const address = new URL(url);
      if (siteResource && !address.search && !address.hash && ['/robots.txt', '/sitemap.xml'].includes(address.pathname) &&
          (this.userOrigins.has(address.origin) || [...this.sources.values()].some((source) =>
            dependsOn.includes(source.producer) && new URL(source.url).origin === address.origin))) return url;
      if (missingProducer) {
        throw new ToolError('INVALID_REFERENCE',
          `Declare the source dependency with \`dependsOn: ["${missingProducer}"]\` to access this URL.`,
          'MISSING_DEPENDENCY',
        );
      }
    }
    throw new ToolError('INVALID_REFERENCE',
      'Use an exact user-provided destination or copy sourceId and producerStepId from a completed tool result. A failed search provides no verified destination.',
      'DESTINATION_UNVERIFIED',
    );
  }

  preflight(op: ResearchToolId, args: Record<string, unknown>, step: ExecutionStep) {
    if (op === 'web_read' || op === 'web_find') {
      const entry = this.documents.get(String(args.documentId));
      if (!entry || !step.dependsOn.includes(entry.producer))
        throw new ToolError('INVALID_REFERENCE', entry
          ? `Declare the fetch dependency with dependsOn: ["${entry.producer}"] to access this document.`
          : 'Reference a document from a completed fetch in this execution.',
          entry ? 'MISSING_DEPENDENCY' : 'DOCUMENT_UNAVAILABLE');
      return args;
    }
    for (const id of [args.tabId, args.documentId, args.elementId].filter(
      (value): value is string => typeof value === 'string',
    )) {
      const producers = this.browserRefs.get(id);
      if (!producers || !step.dependsOn.some((dependency) => producers.has(dependency)))
        throw new ToolError('INVALID_REFERENCE', producers?.size
          ? `Declare the producing step dependency with dependsOn: ["${[...producers].at(-1)}"] to reference this browser target.`
          : 'Reference a browser tab, page, or element returned by a completed dependency.',
          producers ? 'MISSING_DEPENDENCY' : 'BROWSER_REFERENCE_UNAVAILABLE');
    }
    if (op === 'browser_open' || op === 'browser_navigate' || op === 'web_fetch')
      return {
        ...(typeof args.tabId === 'string' && { tabId: args.tabId }),
        url: this.destination(args, step.dependsOn, op === 'web_fetch'),
        ...(op === 'web_fetch' && { method: args.method ?? 'GET' }),
      };
    return args;
  }

  private async browse(
    op: BrowserBridgeOp,
    args: Record<string, unknown>,
    step: ExecutionStep,
    signal: AbortSignal,
    progress?: (phase: BrowserProgress) => void,
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
      ...(progress ? [progress] : []),
    );
    if (!result.ok) {
      const code = result.code === 'DUPLICATE_DISPATCH' || result.code === 'TIMEOUT'
        ? result.code
        : result.code.startsWith('APPROVAL') || result.code === 'DESTINATION_BLOCKED'
          ? 'PERMISSION_DENIED'
          : ['RUN_UNAVAILABLE', 'UNAVAILABLE', 'TAB_UNAVAILABLE'].includes(result.code)
            ? 'CAPABILITY_UNAVAILABLE' : 'EXECUTION_FAILED';
      throw new ToolError(code, result.message, result.code, result.phase, result.retryAfterMs);
    }
    return result;
  }

  private pageSource(url: string, title?: string, fields?: Partial<ConductorSource>) {
    return sourceSchema.parse({
      id: randomUUID(),
      url,
      title: title || url.slice(0, 300),
      domain: new URL(url).hostname,
      retrievedAt: new Date().toISOString(),
      provenance: 'browser',
      contentType: 'text/html',
      ...fields,
    });
  }

  async invoke(
    op: ResearchToolId,
    args: Record<string, unknown>,
    step: ExecutionStep,
    signal: AbortSignal,
    progress?: (phase: BrowserProgress) => void,
  ): Promise<ResearchResult> {
    try {
      const dispatch = this.preflight(op, args, step);
      if (op === 'web_search') {
        const response = await this.browse(op, dispatch, step, signal, progress);
        const { results } = browserSearchResultsSchema.parse(JSON.parse(response.text));
        const seen = new Set<string>();
        const sources: ConductorSource[] = [];
        const links = results.flatMap(({ url: raw, title, snippet }) => {
          let url: string;
          try { url = publicWebUrl(raw).href; } catch { return []; }
          if (seen.has(url)) return [];
          seen.add(url);
          const source = this.pageSource(url, title, {
            provenance: 'search', contentType: undefined, evidenceStatus: 'discovered', excerpt: snippet,
          });
          sources.push(source);
          return [{ sourceId: source.id!, producerStepId: step.id, url, title, ...(snippet ? { snippet } : {}) }];
        });
        this.observeSources(sources, step.id);
        return { sources, data: { status: links.length ? 'results' : 'no_results', results: links } };
      }
      if (op === 'web_fetch') {
        const result = await this.browse(op, dispatch, step, signal, progress);
        const page = webFetchResultSchema.parse(JSON.parse(result.text));
        const { text, title, metadata, links, ...summary } = page;
        const source = this.pageSource(page.url, title, {
          provenance: 'publisher', contentType: page.headers['content-type']?.slice(0, 100),
          evidenceStatus: text ? page.truncated ? 'partial' : 'inspected' : 'metadata',
          publishedAt: this.publication(metadata?.published),
          excerpt: text?.slice(0, 500),
        });
        this.observeSources([source], step.id);
        const documentId = text ? randomUUID() : undefined;
        if (documentId && text) this.documents.set(documentId, { producer: step.id, text, source });
        const references = this.linkSources(links ?? [], step.id);
        return { data: {
          ...summary, metadata, documentId, source, preview: text?.slice(0, 2000), links,
        }, sources: [source], references };
      }
      if (op === 'web_read' || op === 'web_find') {
        const entry = this.documents.get(String(args.documentId));
        if (!entry || !step.dependsOn.includes(entry.producer))
          throw new RunError(
            entry
              ? `Declare the fetch dependency with \`dependsOn: ["${entry.producer}"]\` to access this document.`
              : 'Reference a document from a successful fetch dependency.',
          );
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
      const result = await this.browse(op, dispatch, step, signal, progress);
      const json = JSON.parse(result.text) as Record<string, unknown>;
      signal.throwIfAborted();
      this.observeBrowserRefs(json, step.id);
      const sources = result.url && ['browser_get_page', 'browser_extract'].includes(op)
        ? [this.pageSource(result.url, result.title, {
            evidenceStatus: json.phase === 'partial' ? 'partial' : 'inspected',
            excerpt: typeof json.text === 'string' ? json.text.slice(0, 500) : undefined,
            publishedAt: this.publication((json.metadata as { published?: unknown } | undefined)?.published),
          })]
        : undefined;
      if (sources) this.observeSources(sources, step.id);
      const references = this.linkSources([
        ...(Array.isArray(json.elements) ? json.elements : []),
        ...(Array.isArray(json.links) ? json.links : []),
      ], step.id);
      return {
        data: json,
        sources,
        references,
        file: result.screenshot
          ? {
              name: 'aria-browser.png',
              mimeType: 'image/png',
              bytes: Buffer.from(result.screenshot),
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof RunError || error instanceof ToolError) throw error;
      if (signal.aborted) throw error;
      throw new RunError('The web operation did not return a usable response.');
    }
  }

  private publication(values: unknown) {
    if (!Array.isArray(values)) return undefined;
    for (const value of values) {
      if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) continue;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }

  private linkSources(values: { href?: unknown; label?: unknown; sourceId?: string; producerStepId?: string }[], stepId: string) {
    const references: ConductorSource[] = [];
    for (const item of values.slice(0, 48)) {
      if (!item || typeof item.href !== 'string') continue;
      let url: string;
      try { url = publicWebUrl(item.href).href; } catch { continue; }
      const known = references.find((source) => source.url === url);
      if (!known && references.length === 24) continue;
      const source = known ?? this.pageSource(url, typeof item.label === 'string' ? item.label : undefined, {
        evidenceStatus: 'discovered', contentType: undefined,
      });
      if (!known) references.push(source);
      item.sourceId = source.id;
      item.producerStepId = stepId;
    }
    this.observeSources(references, stepId);
    return references;
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
