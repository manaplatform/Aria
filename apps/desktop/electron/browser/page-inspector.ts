import type { WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
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
    | 'upload-target'
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
  results: z
    .array(z.strictObject({ url: z.string().max(2000), title: z.string().max(300) }))
    .max(8)
    .optional(),
  searchEmpty: z.boolean().optional(),
});

function execute(command: Command) {
  const world = globalThis as typeof globalThis & {
    ariaInspection?: {
      documentId: string;
      items: Map<string, { node: Element; signature: string }>;
    };
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
  if (command.op === 'search-results') {
    const results: { url: string; title: string }[] = [];
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
      '[data-type="web"] .result-content a[href]',
    )) {
      if (
        !visible(anchor) ||
        anchor.href.length > 2000 ||
        !['http:', 'https:'].includes(anchor.protocol)
      )
        continue;
      const title = anchor.innerText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      if (!title || results.some((result) => result.url === anchor.href)) continue;
      results.push({ url: anchor.href, title: title.slice(0, 300) });
      if (results.length === 8) break;
    }
    const searchEmpty = [...document.querySelectorAll('h1, h2, [role="heading"]')].some(
      (heading) =>
        /^no (?:search )?results(?: found)?[.!]?$/i.test(heading.textContent?.trim() ?? '') &&
        visible(heading),
    );
    return { results, searchEmpty };
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
    false,
  );
  return resultSchema.parse(raw);
}
