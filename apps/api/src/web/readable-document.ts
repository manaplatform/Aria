import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';

const ignored = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'aside',
  'footer',
  'form',
  'iframe',
  'input',
  'button',
  'select',
  'textarea',
]);
const blocks = new Set([
  'p',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'br',
  'blockquote',
  'section',
  'article',
  'div',
]);
const clean = (text: string) =>
  text
    .replace(/[\t\f\r ]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();

export function readableDocument(body: string, mime: string) {
  if (mime === 'text/plain') return { title: '', text: clean(body).slice(0, 48_000) };
  const root = parse(body, { scriptingEnabled: false });
  const nodes: Tree.Node[] = [root];
  let title = '';
  let publisher: string | undefined;
  let publishedAt: string | undefined;
  let preferred: Tree.Element | undefined;
  let page: Tree.Element | undefined;
  while (nodes.length) {
    const node = nodes.pop()!;
    if ('tagName' in node) {
      if (node.tagName === 'title')
        title = node.childNodes.map((item) => ('value' in item ? item.value : '')).join('');
      if (node.tagName === 'article' || (!preferred && node.tagName === 'main')) preferred = node;
      if (node.tagName === 'body') page = node;
      if (node.tagName === 'meta') {
        const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
        if (attrs.property === 'og:site_name') publisher = clean(attrs.content || '').slice(0, 300);
        if (
          attrs.property === 'article:published_time' &&
          Number.isFinite(Date.parse(attrs.content))
        )
          publishedAt = new Date(attrs.content).toISOString();
      }
    }
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--) nodes.push(node.childNodes[i]);
  }
  function read(start?: Tree.Element) {
    if (!start) return '';
    const stack: Tree.Node[] = [start];
    let result = '';
    while (stack.length && result.length < 48_000) {
      const node = stack.pop()!;
      if ('tagName' in node) {
        if (
          ignored.has(node.tagName) ||
          node.attrs.some(
            ({ name, value }) =>
              name === 'hidden' ||
              (name === 'aria-hidden' && value === 'true') ||
              (name === 'style' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(value)),
          )
        )
          continue;
        if (blocks.has(node.tagName)) result += '\n';
      }
      if ('value' in node) result += node.value.slice(0, 48_000 - result.length);
      if ('childNodes' in node)
        for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    return clean(result);
  }
  return {
    title: clean(title).slice(0, 300),
    publisher,
    publishedAt,
    text: read(preferred) || read(page),
  };
}
