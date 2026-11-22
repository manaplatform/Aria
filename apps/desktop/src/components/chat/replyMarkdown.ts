import { replyVisualFence, replyVisualLimits } from '@aria/shared';
import type { Root } from 'mdast';

const openingVisual = new RegExp(`^ {0,3}(\x60{3,}|~{3,})[\\t ]*${replyVisualFence}[\\t ]*$`);
const openingMath = /^ {0,3}(\${2,})[\t ]*$/;

// CommonMark also produces a code node for an unclosed fence at the end of the input.
export function replyMarkdown({ streaming }: { streaming: boolean }) {
  return (root: Root, file: { value: unknown }) => {
    if (typeof file.value !== 'string') return;
    const source = file.value;
    let visuals = 0;
    for (const node of root.children) {
      const visual = node.type === 'code' && node.lang === replyVisualFence && !node.meta;
      if (!visual && node.type !== 'math') continue;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      const block = source.slice(start, end);
      const firstBreak = block.search(/[\r\n]/);
      const firstLine = firstBreak === -1 ? block : block.slice(0, firstBreak);
      const delimiter = (visual ? openingVisual : openingMath).exec(firstLine)?.[1];
      if (!delimiter) continue;
      const lastLine = block.slice(Math.max(block.lastIndexOf('\n'), block.lastIndexOf('\r')) + 1);
      const closing = /^ {0,3}([`~$]+)[\t ]*$/.exec(lastLine)?.[1];
      const lineEnded = !streaming || /^[\t ]*(?:\r|\n)/.test(source.slice(end));
      const closed =
        firstBreak >= 0 &&
        lineEnded &&
        closing?.startsWith(delimiter) &&
        [...closing].every((character) => character === delimiter[0]);
      const state =
        visual && ++visuals > replyVisualLimits.blocks
          ? 'invalid'
          : closed
            ? 'ready'
            : streaming
              ? 'pending'
              : 'invalid';
      node.data = {
        ...node.data,
        hProperties: {
          ...node.data?.hProperties,
          [visual ? 'data-aria-visual' : 'data-aria-math']: state,
        },
      };
    }
  };
}
