import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { webLinkSchema, webMetadataSchema, webUrlSchema, type browserReadView } from '@aria/shared';
import { z } from 'zod';

type Command = {
  op:
    | 'inspect'
    | 'extract'
    | 'scroll'
    | 'describe'
    | 'click'
    | 'type'
    | 'plan'
    | 'submit'
    | 'selected'
    | 'screenshot'
    | 'computer-state'
    | 'wait-change'
    | 'play-media'
    | 'stop-media'
    | 'media-state'
    | 'upload-target'
    | 'read-view'
    | 'search-results';
  documentId: string;
  ids?: string[];
  elementId?: string;
  value?: string;
  fields?: { elementId: string; value: string }[];
  delta?: number;
  query?: string;
  selection?: boolean;
  fingerprint?: string;
  includeUploads?: boolean;
  view?: z.infer<typeof browserReadView>;
  offset?: number;
};
const element = z.strictObject({
  elementId: z.string().uuid(),
  tag: z.string().max(32),
  label: z.string().max(100),
  role: z.string().max(50),
  href: z.string().max(2000).optional(),
  type: z.string().max(32),
  editable: z.boolean(),
});
const resultSchema = z.strictObject({
  elements: z.array(element).max(48).optional(),
  text: z.string().max(8000).optional(),
  matches: z.array(z.string().max(320)).max(10).optional(),
  selected: z.string().max(4000).optional(),
  y: z.number().finite().optional(),
  error: z.string().max(120).optional(),
  element: element.optional(),
  fingerprint: z.string().max(6000).optional(),
  action: z.string().max(2000).optional(),
  body: z.string().max(12_000).optional(),
  sensitive: z.boolean().optional(),
  viewport: z.object({ width: z.number(), height: z.number(), dpr: z.number() }).optional(),
  editable: z.boolean().optional(),
  field: z.string().max(80).optional(),
  playingMedia: z.boolean().optional(),
  results: z
    .array(
      z.strictObject({
        url: z.string().max(2000),
        title: z.string().max(300),
        snippet: z.string().max(400).optional(),
      }),
    )
    .max(8)
    .optional(),
  searchEmpty: z.boolean().optional(),
  captchaDetected: z.boolean().optional(),
  links: z.array(webLinkSchema).max(24).optional(),
  metadata: webMetadataSchema.optional(),
  html: z.string().max(5000).optional(),
  nextOffset: z.number().int().max(200).optional(),
  performance: z.strictObject({
    domContentLoadedMs: z.number(),
    loadMs: z.number().optional(),
    measuredResources: z.number().int(),
    timedResources: z.array(z.strictObject({
      path: z.string().max(200),
      durationMs: z.number(),
      transferBytes: z.number(),
    })).max(15),
    viewport: z.strictObject({ width: z.number(), height: z.number(), dpr: z.number() }),
  }).optional(),
});

function execute(command: Command) {
  const world = globalThis as typeof globalThis & {
    ariaInspection?: {
      documentId: string;
      items: Map<string, { node: Element; signature: string }>;
    };
    ariaPlayback?: HTMLMediaElement;
  };
  const signature = (node: Element) =>
    JSON.stringify([
      node.tagName,
      node.getAttribute('role'),
      node.getAttribute('type'),
      node.getAttribute('href'),
      node.getAttribute('name'),
      node.getAttribute('aria-label'),
      node.getAttribute('formaction'),
      node.getAttribute('form'),
      node.textContent?.trim().slice(0, 100),
    ]);
  const visible = (node: Element) => {
    const style = getComputedStyle(node);
    return (
      !!node.getClientRects().length &&
      style.visibility === 'visible' &&
      !node.closest('[hidden], [inert], [aria-hidden="true"]')
    );
  };
  const label = (node: Element) =>
    (
      node.getAttribute('aria-label') ||
      node.getAttribute('placeholder') ||
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.labels?.item(0)?.textContent
        : null) ||
      node.textContent ||
      ''
    )
      .trim()
      .slice(0, 100);
  if (command.op === 'read-view') {
    const clip = (value: string | null | undefined, limit = 500) => value?.trim().slice(0, limit) || '';
    const absolute = (value: string | null) => {
      if (!value) return undefined;
      try {
        const url = new URL(value, document.baseURI);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
          url.href.length <= 2000 ? url.href : undefined;
      } catch { return undefined; }
    };
    const offset = command.offset ?? 0;
    const view = command.view ?? 'content';
    if (view === 'links') {
      const anchors = document.querySelectorAll('a[href]');
      const links = [];
      const seen = new Set<string>();
      let capacity = 6400;
      let i = offset;
      for (; i < Math.min(200, anchors.length) && links.length < 18; i++) {
        const anchor = anchors[i];
        const href = absolute(anchor.getAttribute('href'));
        if (href && !seen.has(href) && visible(anchor)) {
          const item = { href, label: label(anchor) };
          const length = JSON.stringify(item).length + 2;
          if (length > capacity) break;
          capacity -= length;
          seen.add(href);
          links.push(item);
        }
      }
      return { links, ...(i < Math.min(200, anchors.length) && { nextOffset: i }) };
    }
    if (view === 'metadata') {
      const meta = (name: string) => clip(document.querySelector(`meta[name="${name}"],meta[property="${name}"]`)?.getAttribute('content'));
      const published = [meta('article:published_time')].filter(Boolean);
      const modified = [meta('article:modified_time')].filter(Boolean);
      const structuredTypes: string[] = [];
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (let i = 0; i < Math.min(8, scripts.length); i++) {
        const value = scripts[i].textContent ?? '';
        if (value.length > 24_000) continue;
        try {
          const data = JSON.parse(value);
          const items = Array.isArray(data) ? data : Array.isArray(data?.['@graph']) ? data['@graph'] : [data];
          for (const item of items.slice(0, 16)) {
            if (typeof item?.datePublished === 'string' && published.length < 6) published.push(clip(item.datePublished));
            if (typeof item?.dateModified === 'string' && modified.length < 6) modified.push(clip(item.dateModified));
            for (const type of [item?.['@type']].flat().slice(0, 8))
              if (typeof type === 'string' && structuredTypes.length < 12) structuredTypes.push(clip(type, 100));
          }
        } catch { /* A malformed block is not evidence. */ }
      }
      return { metadata: {
        description: meta('description'),
        canonical: absolute(document.querySelector('link[rel~="canonical"]')?.getAttribute('href') ?? null),
        robots: meta('robots'),
        language: clip(document.documentElement?.lang, 80),
        direction: clip(document.documentElement?.dir, 20),
        viewport: meta('viewport'),
        headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 30)
          .map((node) => ({ level: Number(node.tagName[1]), text: clip(node.textContent, 150) })),
        images: { total: document.images.length, missingAlt: document.querySelectorAll('img:not([alt])').length },
        semantic: ['main', 'article', 'section', 'nav', 'header', 'footer', 'aside', 'figure'].filter((tag) => document.querySelector(tag)),
        alternates: Array.from(document.querySelectorAll('link[rel~="alternate"][hreflang]')).slice(0, 12)
          .flatMap((node) => {
            const href = absolute(node.getAttribute('href'));
            return href ? [{ href, language: clip(node.getAttribute('hreflang'), 80) }] : [];
          }),
        structuredTypes, published, modified,
        dates: Array.from(document.querySelectorAll('time')).slice(0, 8)
          .map((node) => clip(node.getAttribute('datetime') || node.textContent, 150)),
      } };
    }
    if (view === 'performance') {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      if (!nav) return {};
      return { performance: {
        domContentLoadedMs: nav.domContentLoadedEventEnd,
        ...(nav.loadEventEnd > 0 && { loadMs: nav.loadEventEnd }),
        measuredResources: resources.length,
        timedResources: resources.filter((resource) => resource.transferSize > 0 && resource.name.startsWith(location.origin + '/'))
          .sort((a, b) => b.transferSize - a.transferSize).slice(0, 15)
          .map((resource) => ({
            path: new URL(resource.name).pathname.slice(0, 200), durationMs: resource.duration, transferBytes: resource.transferSize,
          })),
        viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      } };
    }
    if (view === 'html') {
      const escape = (value: string) => value.replace(/[<>&]/g, (part) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[part]!);
      const elements = (document.querySelector('main,article') ?? document.body)
        ?.querySelectorAll('article,section,h1,h2,h3,h4,h5,h6,p,li,time,figure,figcaption');
      if (!elements) return { html: '' };
      const fragments: string[] = [];
      for (let i = offset; i < Math.min(offset + 20, 200, elements.length); i++) {
        const node = elements[i];
        if (!visible(node)) continue;
        const tag = node.tagName.toLowerCase();
        fragments.push(`<${tag}>${escape(clip(node.childElementCount === 0 ? node.textContent : '', 150))}</${tag}>`);
      }
      return { html: fragments.join('\n').slice(0, 5000),
        ...(offset + 20 < Math.min(200, elements.length) && { nextOffset: offset + 20 }) };
    }
    const main = document.querySelector<HTMLElement>('main,article,[role="main"]') ?? document.body;
    return { text: clip(main?.innerText, 8000) };
  }
  const safeField = (node: Element): node is HTMLInputElement | HTMLTextAreaElement =>
    (node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLInputElement && ['text', 'search'].includes(node.type))) &&
    !node.disabled &&
    !node.readOnly &&
    !node.autocomplete &&
    !/(?:pass(?:word)?|credit|card|token|secret|email|phone|address|payment|account|otp|pin|user.?name)/i.test(
      `${node.name} ${node.id} ${label(node)}`,
    );
  const descriptor = (node: Element, elementId: string) => ({
    elementId,
    tag: node.tagName.toLowerCase(),
    label: label(node),
    role: (node.getAttribute('role') || node.tagName.toLowerCase()).slice(0, 50),
    href: node instanceof HTMLAnchorElement ? node.href.slice(0, 2000) : undefined,
    type: node instanceof HTMLInputElement || node instanceof HTMLButtonElement ? node.type : '',
    editable: safeField(node),
  });
  const get = (id?: string) => {
    const item =
      id && world.ariaInspection?.documentId === command.documentId
        ? world.ariaInspection.items.get(id)
        : undefined;
    return item &&
      item.node.isConnected &&
      signature(item.node) === item.signature &&
      visible(item.node)
      ? item.node
      : undefined;
  };
  if (command.op === 'stop-media') {
    world.ariaPlayback?.pause();
    world.ariaPlayback = undefined;
    return { playingMedia: false };
  }
  if (command.op === 'media-state') {
    const media = world.ariaPlayback;
    return {
      playingMedia: Boolean(media?.isConnected && !media.paused && !media.ended && !media.muted),
    };
  }
  if (command.op === 'play-media') {
    const candidates = Array.from(
      document.querySelectorAll<HTMLMediaElement>('audio, video'),
    ).filter(
      (media) =>
        visible(media) &&
        !media.srcObject &&
        Boolean(media.currentSrc || media.src || media.querySelector('source[src]')),
    );
    if (candidates.length !== 1) return { error: 'MEDIA_UNAVAILABLE' };
    const [media] = candidates;
    const previous = world.ariaPlayback;
    if (previous && previous !== media) previous.pause();
    world.ariaPlayback = media;
    media.muted = false;
    if (!media.volume) media.volume = 0.4;
    const start = media.currentTime;
    return new Promise<{ playingMedia?: boolean; error?: string }>((resolve) => {
      let completed = false;
      const finish = (success: boolean) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        media.removeEventListener('timeupdate', progress);
        media.removeEventListener('error', failed);
        if (success) resolve({ playingMedia: true });
        else {
          if (world.ariaPlayback === media) {
            media.pause();
            world.ariaPlayback = undefined;
          }
          resolve({ error: 'MEDIA_UNAVAILABLE' });
        }
      };
      const failed = () => finish(false);
      const progress = () => {
        if (
          world.ariaPlayback === media &&
          media.isConnected &&
          !media.paused &&
          !media.ended &&
          !media.muted &&
          media.currentTime > start + 0.02
        )
          finish(true);
      };
      const timer = setTimeout(failed, 4000);
      media.addEventListener('timeupdate', progress);
      media.addEventListener('error', failed, { once: true });
      void media.play().then(progress, failed);
    });
  }
  if (command.op === 'search-results') {
    const results: { url: string; title: string; snippet?: string }[] = [];
    const bing = location.hostname === 'bing.com' || location.hostname.endsWith('.bing.com');
    const captchaDetected = Boolean(document.querySelector(
      '[data-testid="captcha"], .cf-turnstile, iframe[src*="captcha"], iframe[src*="turnstile"], iframe[src*="hcaptcha"], iframe[src*="recaptcha"], #b_captcha, .b_captcha',
    )) || /verify (?:that )?you are human|complete the (?:security|captcha) check|unusual traffic/i.test(
      document.body?.innerText?.slice(0, 2000) ?? '',
    );
    const decodeSearchUrl = (rawHref: string): string | undefined => {
      try {
        const parsed = new URL(rawHref);
        if (parsed.hostname.endsWith('.bing.com') && parsed.pathname === '/ck/a') {
          const encoded = parsed.searchParams.get('u');
          if (encoded?.startsWith('a1')) {
            const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
            const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
            const decoded = new TextDecoder().decode(bytes);
            const target = new URL(decoded);
            if (['http:', 'https:'].includes(target.protocol) && target.href.length <= 2000)
              return target.href;
          }
          if (encoded && /^https?:\/\//i.test(encoded)) {
            const target = new URL(encoded);
            if (target.href.length <= 2000) return target.href;
          }
          return undefined;
        }
        return ['http:', 'https:'].includes(parsed.protocol) && parsed.href.length <= 2000
          ? parsed.href
          : undefined;
      } catch {
        return undefined;
      }
    };
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
      '[data-type="web"] .result-content a[href]',
    )) {
      if (!visible(anchor)) continue;
      const href = decodeSearchUrl(anchor.href);
      if (!href || new URL(href).origin === location.origin) continue;
      const title = anchor.innerText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      if (!title || results.some((result) => result.url === href)) continue;
      const container = anchor.closest('.result-content') ?? anchor.closest('[data-type="web"]');
      const rawSnippet =
        container?.querySelector<HTMLElement>('.snippet-description, .result-snippet, .generic-snippet, p')
          ?.innerText ||
        (container instanceof HTMLElement
          ? container.innerText
              .replace(anchor.innerText, '')
              .replace(/\bhttps?:\/\/\S+/gi, '')
          : '');
      const snippet = rawSnippet.replace(/\s+/g, ' ').trim().slice(0, 400);
      results.push({
        url: href,
        title: title.slice(0, 300),
        ...(snippet && snippet !== title ? { snippet } : {}),
      });
      if (results.length === 8) break;
    }
    if (bing && !results.length) {
      const bingContent = document.querySelector<HTMLElement>('#b_content');
      // Bing ships organic links in its HTML before the results container is revealed.
      const stagedResults = !captchaDetected && bingContent?.style.visibility === 'hidden'
        ? bingContent.querySelector('#b_results') : null;
      const stagedLink = (anchor: HTMLAnchorElement, item: Element) => {
        if (!stagedResults || item.parentElement !== stagedResults || !anchor.getClientRects().length ||
            anchor.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
        for (let node: HTMLElement | null = anchor; node && node !== bingContent; node = node.parentElement) {
          if (['hidden', 'collapse'].includes(node.style.visibility)) return false;
        }
        return true;
      };
      for (const item of document.querySelectorAll('li.b_algo')) {
        const anchor = item.querySelector<HTMLAnchorElement>('h2 a[href], .b_title a[href]');
        if (!anchor || (!visible(anchor) && !stagedLink(anchor, item))) continue;
        const resolvedUrl = decodeSearchUrl(anchor.href);
        if (!resolvedUrl || new URL(resolvedUrl).origin === location.origin ||
            results.some((result) => result.url === resolvedUrl)) continue;
        const title = (anchor.innerText || anchor.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        if (!title) continue;
        const caption = item.querySelector<HTMLElement>('.b_caption p, .b_snippet, p');
        const snippetNode = caption?.cloneNode(true) as HTMLElement | undefined;
        snippetNode?.querySelectorAll('.b_algoReadMore').forEach((node) => node.remove());
        const snippet = (snippetNode?.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400);
        results.push({
          url: resolvedUrl,
          title,
          ...(snippet && snippet !== title ? { snippet } : {}),
        });
        if (results.length === 8) break;
      }
    }
    const bNo = document.querySelector('.b_no');
    const searchEmpty = !results.length && (
      Boolean(bing && bNo && visible(bNo)) ||
      [...document.querySelectorAll('h1, h2, [role="heading"]')].some(
        (heading) =>
          /^no (?:search )?results(?: found)?[.!]?$|^there are no results for\b/i.test(
            heading.textContent?.trim() ?? '',
          ) && visible(heading),
      )
    );
    return { results, searchEmpty, ...(captchaDetected && !results.length && { captchaDetected: true }) };
  }
  if (command.op === 'selected')
    return { selected: window.getSelection()?.toString().slice(0, 4000) || '' };
  if (command.op === 'screenshot')
    return {
      sensitive: [...document.querySelectorAll('input, textarea')].some((node) => visible(node)),
    };
  if (command.op === 'computer-state') {
    const inputs = [
      ...document.querySelectorAll('input, textarea, iframe, frame, [contenteditable]'),
    ];
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      sensitive: inputs.some(
        (node) =>
          visible(node) &&
          !safeField(node) &&
          !(node instanceof HTMLInputElement && node.type === 'file' && !node.files?.length),
      ),
      editable: !!document.activeElement && safeField(document.activeElement),
    };
  }
  if (command.op === 'wait-change') {
    return new Promise<Record<string, never>>((resolve) => {
      const finish = () => {
        observer.disconnect();
        clearTimeout(timer);
        resolve({});
      };
      const observer = new MutationObserver(finish);
      const timer = setTimeout(finish, 750);
      observer.observe(document.documentElement, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      });
    });
  }
  if (command.op === 'inspect') {
    const previous =
      world.ariaInspection?.documentId === command.documentId
        ? world.ariaInspection.items
        : undefined;
    const references = new Map(
      previous
        ? [...previous].map(([id, entry]) => [entry.node, { id, signature: entry.signature }])
        : [],
    );
    const items = new Map<string, { node: Element; signature: string }>();
    world.ariaInspection = { documentId: command.documentId, items };
    const elements = [];
    for (const node of document.querySelectorAll(
      'a[href], button, input, textarea, summary, [role="button"]',
    )) {
      if (
        !visible(node) ||
        (node instanceof HTMLInputElement &&
          (['password', 'hidden'].includes(node.type) ||
            (node.type === 'file' && !command.includeUploads)))
      )
        continue;
      const prior = references.get(node);
      const current = signature(node);
      const id: string | undefined =
        prior?.signature === current ? prior.id : command.ids?.[elements.length];
      if (!id) break;
      items.set(id, { node, signature: current });
      elements.push(descriptor(node, id));
    }
    return { elements };
  }
  if (command.op === 'extract') {
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    if (!(root instanceof HTMLElement)) return { text: '' };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = '';
    while (walker.nextNode() && text.length < 8000) {
      const node = walker.currentNode.parentElement;
      if (
        node &&
        !node.closest(
          'script, style, form, noscript, input, textarea, select, nav, [contenteditable]',
        ) &&
        visible(node)
      ) {
        const line = walker.currentNode.textContent?.trim();
        if (line) text += (text ? '\n' : '') + line.slice(0, 8000 - text.length - 1);
      }
    }
    if (command.selection)
      return { selected: window.getSelection()?.toString().slice(0, 4000) || '' };
    if (command.query) {
      const matches: string[] = [];
      const needle = command.query.toLowerCase();
      const content = text.toLowerCase();
      let from = 0;
      while (matches.length < 10) {
        const at = content.indexOf(needle, from);
        if (at < 0) break;
        matches.push(text.slice(Math.max(0, at - 60), at + needle.length + 60));
        from = at + needle.length;
      }
      return { matches };
    }
    return { text };
  }
  if (command.op === 'scroll') {
    window.scrollBy({ top: command.delta || 0, behavior: 'instant' });
    return { y: window.scrollY };
  }
  const node = get(command.elementId);
  if (!node || !command.elementId) return { error: 'STALE_ELEMENT' };
  const summary = descriptor(node, command.elementId);
  const fingerprint = signature(node);
  if (command.op === 'describe') return { element: summary, fingerprint };
  if (command.op === 'upload-target') {
    if (
      !(node instanceof HTMLInputElement) ||
      node.type !== 'file' ||
      node.disabled ||
      node.multiple ||
      node.files?.length
    )
      return { error: 'MANUAL_ACTION_REQUIRED' };
    const form = node.form;
    if (
      !form ||
      form.method !== 'post' ||
      form.enctype !== 'multipart/form-data' ||
      !/^[A-Za-z0-9_.-]{1,80}$/.test(node.name) ||
      [...form.elements].some(
        (member) => member !== node && !(member instanceof HTMLButtonElement && !member.name),
      )
    )
      return { error: 'MANUAL_ACTION_REQUIRED' };
    const action = new URL(form.action);
    if (
      action.protocol !== 'https:' ||
      action.origin !== location.origin ||
      action.search ||
      action.hash
    )
      return { error: 'MANUAL_ACTION_REQUIRED' };
    return { action: action.href, field: node.name };
  }
  if ((command.op === 'click' || command.op === 'type') && fingerprint !== command.fingerprint)
    return { error: 'STALE_ELEMENT' };
  if (command.op === 'click') {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!hit || !node.contains(hit)) return { error: 'STALE_ELEMENT' };
    if (
      !(node instanceof HTMLButtonElement && node.type === 'button' && !node.disabled) &&
      node.tagName !== 'SUMMARY'
    )
      return { error: 'MANUAL_ACTION_REQUIRED' };
    (node as HTMLElement).click();
    return {};
  }
  if (command.op === 'type') {
    if (!safeField(node) || command.value === undefined || /[\r\n\0]/.test(command.value))
      return { error: 'MANUAL_ACTION_REQUIRED' };
    node.value = command.value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    return {};
  }
  if (
    !(node instanceof HTMLButtonElement || node instanceof HTMLInputElement) ||
    node.type !== 'submit' ||
    node.disabled ||
    node.name ||
    node.hasAttribute('formaction') ||
    node.hasAttribute('formmethod') ||
    node.hasAttribute('formenctype') ||
    node.hasAttribute('formtarget') ||
    node.hasAttribute('formnovalidate')
  )
    return { error: 'MANUAL_ACTION_REQUIRED' };
  const form = node.form;
  if (
    !form ||
    form.method !== 'post' ||
    !['', '_self'].includes(form.target) ||
    form.enctype !== 'application/x-www-form-urlencoded'
  )
    return { error: 'MANUAL_ACTION_REQUIRED' };
  const action = new URL(form.action, location.href);
  if (action.origin !== location.origin || action.protocol !== 'https:' || action.hash)
    return { error: 'MANUAL_ACTION_REQUIRED' };
  const fields = new Map<Element, string>();
  for (const field of command.fields ?? []) {
    const input = get(field.elementId);
    if (
      !input ||
      !safeField(input) ||
      input.form !== form ||
      fields.has(input) ||
      /[\r\n\0]/.test(field.value)
    )
      return { error: 'MANUAL_ACTION_REQUIRED' };
    fields.set(input, field.value);
  }
  const params = new URLSearchParams();
  for (const control of Array.from(form.elements)) {
    if (control === node) continue;
    const val = fields.get(control);
    if (val === undefined || !safeField(control) || !control.name || params.has(control.name))
      return { error: 'MANUAL_ACTION_REQUIRED' };
    params.append(control.name, val);
  }
  if (!fields.size || params.size !== fields.size) return { error: 'MANUAL_ACTION_REQUIRED' };
  const body = params.toString();
  if (body.length > 12_000) return { error: 'MANUAL_ACTION_REQUIRED' };
  if (command.op === 'plan') return { action: action.href, body, element: summary };
  if (command.fingerprint !== JSON.stringify([action.href, body]))
    return { error: 'STALE_ELEMENT' };
  for (const [control, input] of fields)
    (control as HTMLInputElement | HTMLTextAreaElement).value = input;
  form.requestSubmit(node);
  return {};
}

function parseInspection(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return resultSchema.parse(raw);
  const observed = raw as Record<string, unknown>;
  if (Array.isArray(observed.links)) observed.links = observed.links.filter((link) => webLinkSchema.safeParse(link).success);
  if (observed.metadata && typeof observed.metadata === 'object' && !Array.isArray(observed.metadata)) {
    const metadata = observed.metadata as Record<string, unknown>;
    if (!webUrlSchema.safeParse(metadata.canonical).success) delete metadata.canonical;
    if (Array.isArray(metadata.alternates)) metadata.alternates = metadata.alternates.filter((item) =>
      item && typeof item === 'object' && webUrlSchema.safeParse(item.href).success);
  }
  return resultSchema.parse(observed);
}

export async function inspectPage(contents: WebContents, command: Command) {
  const args =
    command.op === 'inspect'
      ? { ...command, ids: Array.from({ length: 48 }, () => randomUUID()) }
      : command;
  const raw: unknown = await contents.executeJavaScriptInIsolatedWorld(
    1001,
    [
      {
        code: `(${execute.toString()})(${JSON.stringify(args)})`,
      },
    ],
    command.op === 'play-media',
  );
  return parseInspection(raw);
}

export async function inspectWithDebugger(contents: WebContents, command: Command, signal: AbortSignal) {
  if (command.op !== 'read-view' && command.op !== 'search-results')
    throw new Error('Only fixed read operations may use this inspection path.');
  signal.throwIfAborted();
  const client = contents.debugger;
  if (client.isAttached()) throw new Error('The browser tab is already under inspection.');
  client.attach('1.3');
  const detach = () => { if (client.isAttached()) client.detach(); };
  signal.addEventListener('abort', detach, { once: true });
  try {
    const { frameTree } = await client.sendCommand('Page.getFrameTree');
    signal.throwIfAborted();
    const { executionContextId } = await client.sendCommand('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'aria-public-page-inspection',
    });
    signal.throwIfAborted();
    const { result, exceptionDetails } = await client.sendCommand('Runtime.evaluate', {
      contextId: executionContextId,
      expression: `(${execute.toString()})(${JSON.stringify(command)})`,
      returnByValue: true,
    });
    signal.throwIfAborted();
    if (exceptionDetails) throw new Error('The page could not be inspected.');
    return parseInspection(result.value);
  } finally {
    signal.removeEventListener('abort', detach);
    detach();
  }
}
