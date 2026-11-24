import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { addAbortListener } from 'node:events';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { SaxesParser } from 'saxes';
import {
  publicWebUrl,
  resolvePublicAddress,
  webFetchResultSchema,
  type BrowserPhase,
  type WebFetchResult,
} from '@aria/shared';

export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly phase?: BrowserPhase,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const maxBody = 1024 * 1024;
const redirectCodes = new Set([301, 302, 303, 307, 308]);
const permittedHeaders = [
  'content-type',
  'content-length',
  'last-modified',
  'x-robots-tag',
  'strict-transport-security',
  'retry-after',
];
type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;
type Links = NonNullable<WebFetchResult['links']>;

function publicLink(href: string, base: URL) {
  try {
    return publicWebUrl(new URL(href, base).href).href;
  } catch {
    return undefined;
  }
}

function* nodes(root: HtmlNode): Generator<HtmlNode> {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    yield node;
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
}

const ignored = new Set(['script', 'style', 'template', 'noscript', 'input', 'textarea', 'select']);
const attr = (node: HtmlElement, name: string) =>
  node.attrs.find((item) => item.name === name)?.value ?? '';
const clean = (text: string, limit = 500) => text.replace(/\s+/gu, ' ').trim().slice(0, limit);

function textOf(root: HtmlNode, capacity: number) {
  let result = '';
  const stack = [root];
  while (stack.length && result.length < capacity) {
    const node = stack.pop()!;
    if ('value' in node && node.nodeName === '#text') result += ` ${node.value.slice(0, capacity)}`;
    if (
      'tagName' in node &&
      (ignored.has(node.tagName) || node.attrs.some(({ name }) => name === 'hidden'))
    )
      continue;
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
  }
  return clean(result, capacity);
}

function link(links: Links, href: string, label: string, url: URL) {
  const address = href && publicLink(href, url);
  if (address && links.length < 24 && !links.some(({ href }) => href === address))
    links.push({ href: address, label: clean(label, 200) });
}

function htmlEvidence(input: string, url: URL) {
  const document = parse(input);
  const elements = Array.from(nodes(document)).filter(
    (node): node is HtmlElement => 'tagName' in node,
  );
  const first = (name: string) => elements.find(({ tagName }) => tagName === name);
  const meta = (name: string) =>
    elements.find(
      (node) =>
        node.tagName === 'meta' &&
        [attr(node, 'name').toLowerCase(), attr(node, 'property').toLowerCase()].includes(name),
    );
  const metaValue = (name: string) => {
    const node = meta(name);
    return node ? clean(attr(node, 'content')) || undefined : undefined;
  };
  const root = first('html');
  const body = first('body');
  const title = first('title');
  const base = first('base');
  const baseHref = base && publicLink(attr(base, 'href'), url);
  const linkBase = baseHref ? new URL(baseHref) : url;
  const links: Links = [];
  const metadata: NonNullable<WebFetchResult['metadata']> = {
    ...(root && {
      language: attr(root, 'lang').slice(0, 80),
      direction: attr(root, 'dir').slice(0, 20),
    }),
    description: metaValue('description'),
    robots: metaValue('robots'),
    viewport: metaValue('viewport'),
    headings: [],
    images: { total: 0, missingAlt: 0 },
    semantic: [],
    alternates: [],
    structuredTypes: [],
    published: metaValue('article:published_time') ? [metaValue('article:published_time')!] : [],
    modified: metaValue('article:modified_time') ? [metaValue('article:modified_time')!] : [],
    dates: [],
  };
  for (const node of elements) {
    const tag = node.tagName;
    if (tag === 'a' && links.length < 24)
      link(links, attr(node, 'href'), textOf(node, 200), linkBase);
    if (/^h[1-6]$/.test(tag) && metadata.headings!.length < 40)
      metadata.headings!.push({ level: Number(tag[1]), text: textOf(node, 200) });
    if (tag === 'img') {
      metadata.images!.total++;
      if (!node.attrs.some(({ name }) => name === 'alt')) metadata.images!.missingAlt++;
    }
    if (
      ['main', 'article', 'section', 'nav', 'header', 'footer', 'aside', 'figure'].includes(tag) &&
      !metadata.semantic!.includes(tag)
    )
      metadata.semantic!.push(tag);
    if (tag === 'time' && metadata.dates!.length < 8)
      metadata.dates!.push(clean(attr(node, 'datetime') || textOf(node, 200)));
    if (tag === 'link') {
      const href = attr(node, 'href') && publicLink(attr(node, 'href'), linkBase);
      const rel = attr(node, 'rel').toLowerCase().split(/\s+/);
      const language = attr(node, 'hreflang').slice(0, 80);
      if (href && rel.includes('canonical')) metadata.canonical ??= href;
      if (href && language && rel.includes('alternate') && metadata.alternates!.length < 12)
        metadata.alternates!.push({ language, href });
    }
    if (tag === 'script' && attr(node, 'type').toLowerCase() === 'application/ld+json') {
      const json = node.childNodes.map((child) => ('value' in child ? child.value : '')).join('');
      collectStructuredMetadata(json, metadata);
    }
  }
  const preferred = first('main') ?? first('article') ?? body ?? document;
  return { title: title && textOf(title, 300), text: textOf(preferred, 8000), metadata, links };
}

function collectStructuredMetadata(
  json: string,
  metadata: NonNullable<WebFetchResult['metadata']>,
) {
  if (json.length > 24_000) return;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return;
  }
  const record =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;
  const items = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.['@graph'])
      ? record['@graph']
      : [record];
  for (const item of items.slice(0, 16)) {
    if (!item || typeof item !== 'object') continue;
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    for (const type of types.slice(0, 8))
      if (typeof type === 'string' && metadata.structuredTypes!.length < 12)
        metadata.structuredTypes!.push(type.slice(0, 100));
    for (const [key, values] of [
      ['datePublished', metadata.published!],
      ['dateModified', metadata.modified!],
    ] as const)
      if (typeof item[key] === 'string' && values.length < 6) values.push(clean(item[key]));
  }
}

function staticLinks(text: string, mime: string, url: URL) {
  const links: Links = [];
  if (mime.includes('xml')) {
    const parser = new SaxesParser({ xmlns: false });
    let loc = false;
    let value = '';
    parser.on('opentag', ({ name }) => {
      if (name === 'loc') {
        loc = true;
        value = '';
      }
    });
    parser.on('text', (chunk) => {
      if (loc) value = (value + chunk).slice(0, 2001);
    });
    parser.on('closetag', ({ name }) => {
      if (name === 'loc' && loc) {
        link(links, value.trim(), '', url);
        loc = false;
      }
    });
    try {
      parser.write(text).close();
    } catch {
      /* A truncated sitemap can still contain complete entries. */
    }
  } else if (url.pathname === '/robots.txt') {
    for (const entry of text.matchAll(/^\s*sitemap:\s*(\S+)/gim))
      link(links, entry[1], 'Sitemap', url);
  }
  return links;
}

async function getResponse(
  url: URL,
  method: 'GET' | 'HEAD',
  signal: AbortSignal,
  onNetwork: () => void,
) {
  const name = url.hostname.replace(/^\[|\]$/g, '');
  let address;
  try {
    signal.throwIfAborted();
    address = await new Promise<LookupAddress>((resolve, reject) => {
      const abort = addAbortListener(signal, () => reject(signal.reason));
      void resolvePublicAddress(name, (host) => lookup(host, { all: true })).then(
        (value) => {
          abort[Symbol.dispose]();
          resolve(value);
        },
        (error) => {
          abort[Symbol.dispose]();
          reject(error);
        },
      );
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === 'Local and private destinations are blocked.')
      throw new BrowserError('DESTINATION_BLOCKED', error.message, 'navigation_failed');
    throw new BrowserError(
      'DNS_FAILED',
      'The website address could not be resolved.',
      'navigation_failed',
    );
  }
  signal.throwIfAborted();
  const secure = url.protocol === 'https:';
  const client = secure ? https : http;
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    onNetwork();
    const request = client.request(
      {
        hostname: address.address,
        family: address.family,
        port: secure ? 443 : 80,
        path: url.pathname + url.search,
        method,
        agent: false,
        ...(secure && {
          servername: isIP(name) ? '' : name,
          checkServerIdentity: (
            _hostname: string,
            cert: Parameters<typeof checkServerIdentity>[1],
          ) => checkServerIdentity(name, cert),
        }),
        headers: {
          host: url.host,
          Accept: 'text/html,text/plain,application/xml,application/json,*/*;q=0.1',
          'Accept-Encoding': 'identity',
          'User-Agent': 'Aria',
        },
        maxHeaderSize: 16_384,
        signal,
      },
      resolve,
    );
    request.once('error', reject);
    request.end();
  });
}

export async function fetchPublicPage(
  destination: string,
  method: 'GET' | 'HEAD',
  parent: AbortSignal,
  onNetwork: () => void,
): Promise<WebFetchResult> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(12_000)]);
  const redirects: WebFetchResult['redirects'] = [];
  let url = publicWebUrl(destination);
  url.hash = '';
  try {
    for (;;) {
      const response = await getResponse(url, method, signal, onNetwork);
      const status = response.statusCode ?? 502;
      const location = response.headers.location;
      if (location && redirectCodes.has(status)) {
        response.destroy();
        const next = publicLink(location, url);
        if (!next)
          throw new BrowserError(
            'DESTINATION_BLOCKED',
            'The redirect destination was blocked.',
            'navigation_failed',
          );
        if (redirects.length === 5 || redirects.some((item) => item.url === url.href))
          throw new BrowserError(
            'REDIRECT_LIMIT',
            'The website exceeded the redirect limit.',
            'navigation_failed',
          );
        redirects.push({ url: url.href, status });
        url = publicWebUrl(next);
        url.hash = '';
        continue;
      }
      const headers: WebFetchResult['headers'] = {};
      for (const name of permittedHeaders) {
        const value = response.headers[name];
        if (typeof value === 'string') headers[name] = value.slice(0, 500);
      }
      const output = { url: url.href, status, redirects, headers };
      const mime = (headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      const html = mime === 'text/html' || mime === 'application/xhtml+xml';
      const supported =
        html || /^text\/(?:plain|xml)$|^application\/(?:[\w.+-]+\+)?(?:json|xml)$/.test(mime);
      const outcome = [401, 403, 407, 429, 451].includes(status)
        ? 'restricted'
        : status >= 400
          ? 'http_error'
          : method !== 'HEAD' &&
              (!supported ||
                ![undefined, 'identity'].includes(response.headers['content-encoding']))
            ? 'unsupported'
            : 'retrieved';
      if (method === 'HEAD' || outcome !== 'retrieved') {
        response.destroy();
        return webFetchResultSchema.parse({ ...output, outcome });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of response) {
        const remaining = maxBody - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(remaining, chunk.length);
        if (chunk.length > remaining) {
          truncated = true;
          break;
        }
      }
      signal.throwIfAborted();
      const bytes = Buffer.concat(chunks, size);
      const charset =
        headers['content-type']?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ??
        (html
          ? bytes
              .subarray(0, 1024)
              .toString('ascii')
              .match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1]
          : undefined);
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(charset ?? 'utf-8');
      } catch {
        decoder = new TextDecoder();
      }
      const text = decoder.decode(bytes);
      return webFetchResultSchema.parse({
        ...output,
        ...(html
          ? htmlEvidence(text, url)
          : { text: text.slice(0, 8000), links: staticLinks(text, mime, url) }),
        outcome,
        truncated,
      });
    }
  } catch (error) {
    if (parent.aborted) throw parent.reason;
    if (signal.aborted)
      throw new BrowserError('TIMEOUT', 'HTTP retrieval reached its deadline.', 'timed_out', 1000);
    if (error instanceof BrowserError) throw error;
    throw new BrowserError(
      'NETWORK_FAILED',
      'The HTTP connection failed. Check the destination before retrying.',
      'navigation_failed',
      1000,
    );
  }
}
