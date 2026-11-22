import { render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { replyVisualLimits } from '@aria/shared';
import { TooltipProvider } from '../src/components/ui';
import MarkdownRenderer from '../src/components/chat/MarkdownRenderer';

function reply(content: string, streaming = false) {
  return (
    <TooltipProvider>
      <MarkdownRenderer content={content} rich streaming={streaming} />
    </TooltipProvider>
  );
}

const flow = {
  v: 1,
  type: 'flowchart',
  title: 'Review process',
  nodes: [
    { id: 'draft', label: 'Draft' },
    { id: 'done', label: 'Done' },
  ],
  edges: [{ from: 'draft', to: 'done' }],
};
const fence = (source: string) => `\`\`\`aria-visual\n${source}\n\`\`\``;

it('waits for a complete streamed fence and preserves the mounted visual across later deltas', async () => {
  const block = fence(JSON.stringify(flow));
  const view = render(reply(`Introduction\n\n${block.slice(0, -3)}`, true));
  expect(screen.getByText('Introduction')).toBeVisible();
  expect(screen.getByText('Preparing visual…')).toBeVisible();
  expect(screen.queryByRole('figure')).toBeNull();
  view.rerender(reply(`Introduction\n\n${block}`, true));
  expect(screen.queryByRole('figure')).toBeNull();
  view.rerender(reply(`Introduction\n\n${block}\n`, true));
  const figure = await screen.findByRole('figure', { name: 'Review process' });
  expect(await screen.findByRole('img', { name: 'Review process flowchart' })).toBeVisible();
  screen.getByText('Show connections').click();
  view.rerender(reply(`Introduction\n\n${block}\n\nNext steps`, true));
  expect(screen.getByRole('figure', { name: 'Review process' })).toBe(figure);
  expect(figure.querySelector('details')).toHaveAttribute('open');
});

it('shows copyable source for interrupted or invalid visuals and honors fenced code examples', () => {
  const view = render(reply(fence(JSON.stringify(flow)).slice(0, -3)));
  expect(screen.getByText('Visual unavailable · View source')).toBeVisible();
  screen.getByText('Visual unavailable · View source').click();
  expect(screen.getByRole('button', { name: 'Copy visual source' })).toBeVisible();
  view.rerender(
    reply(
      [
        fence('x'.repeat(replyVisualLimits.characters + 1)),
        fence('invalid JSON'),
        fence(JSON.stringify({ ...flow, v: 2 })),
        fence(JSON.stringify({ ...flow, edges: [{ from: 'draft', to: 'missing' }] })),
        fence(JSON.stringify({ ...flow, url: 'https://example.com' })),
        fence(JSON.stringify(flow)),
      ].join('\n\n'),
    ),
  );
  expect(screen.getAllByText('Visual unavailable · View source')).toHaveLength(6);
  expect(screen.queryByRole('figure')).toBeNull();
  view.rerender(reply(`\`\`\`\`markdown\n${fence(JSON.stringify(flow))}\n\`\`\`\``));
  expect(screen.getByRole('button', { name: 'Copy code' })).toBeVisible();
  expect(screen.queryByRole('figure')).toBeNull();
});

it('renders equations as MathML and keeps ordinary currency, symbols, links, and code readable', async () => {
  const { container } = render(
    reply(String.raw`## Results ✓

From $5 to $10. Inline $$x^2$$.

$$
\frac{a}{b}
$$

<script>alert(1)</script>

[unsafe](javascript:alert(1))

| Symbol | Meaning |
| --- | --- |
| → | Next |

${'```js'}
const value = 1;
${'```'}`),
  );
  expect(screen.getByRole('heading', { name: 'Results ✓' })).toBeVisible();
  expect(screen.getByText(/^From \$5 to \$10/)).toBeVisible();
  expect(screen.getByRole('table')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Copy code' })).toBeVisible();
  expect(container.querySelector('script, a[href^="javascript:"]')).toBeNull();
  await waitFor(() => expect(container.querySelectorAll('math')).toHaveLength(2));
  expect(container.querySelector('.reply-equation math mfrac')).not.toBeNull();
});

it('passes untrusted formula commands through the bounded KaTeX renderer', async () => {
  const { container } = render(reply(String.raw`Formula $$\href{https://example.com}{click}$$.`));
  await waitFor(() => expect(container.querySelector('math')).not.toBeNull());
  expect(container.querySelector('a, img')).toBeNull();
});
