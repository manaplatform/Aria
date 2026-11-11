import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '../ui';
import { openExternal, errorMessage } from '../../services/desktop';
import { notify } from '../../stores/uiStore';
export function CodeBlock({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>Code</span>
        <CopyButton text={extractText(children)} label="Copy code" />
      </div>
      <pre>{children}</pre>
    </div>
  );
}
function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node)
    return extractText((node.props as { children?: ReactNode }).children);
  return '';
}
export default function MarkdownRenderer({ content }: { content: string }): ReactNode {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href)
                  void openExternal(href).catch((error) => notify(errorMessage(error), true));
              }}
            >
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="muted">[Image: {alt || 'attachment'}]</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
