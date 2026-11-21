import { useLayoutEffect, useRef } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

export default function ReplyEquation({
  formula,
  display = false,
}: {
  formula: string;
  display?: boolean;
}) {
  const target = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = target.current;
    if (!element) return;
    try {
      katex.render(formula, element, {
        displayMode: display,
        trust: false,
        maxExpand: 256,
        maxSize: 12,
        throwOnError: true,
      });
    } catch {
      element.textContent = formula;
    }
  }, [formula, display]);

  return <span className={display ? 'reply-equation' : undefined} ref={target} />;
}
