import type { ConductorSource } from '@aria/shared';
import { lazy, Suspense, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CopyButton } from '../ui';
import { openExternal, errorMessage } from '../../services/desktop';
import { openResearchSource } from '../../stores/browserStore';
import { notify } from '../../stores/uiStore';
import { replyMarkdown } from './replyMarkdown';
import { ReplyVisualBlock } from './ReplyVisualBlock';

const ReplyEquation = lazy(() => import('./ReplyEquation'));

export function CodeBlock({
  children,
  label = 'Code',
}: {
  children: ReactNode;
  label?: string;
}): ReactNode {
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{label}</span>
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

function equation(source: string, display = false) {
  const formula = display ? source.trimEnd() : source;
  return formula.length > 2048 ? (
    formula
  ) : (
    <Suspense fallback={<span className={display ? 'reply-equation' : undefined}>{formula}</span>}>
      <ReplyEquation formula={formula} display={display} />
    </Suspense>
  );
}

const MarkdownPre: Components['pre'] = ({ node, children }) => {
  const code = node?.children.find((child) => child.type === 'element');
  const properties = code?.tagName === 'code' ? code.properties : undefined;
  const language = Array.isArray(properties?.className)
    ? properties.className.find((name) => String(name).startsWith('language-'))
    : undefined;
  const state = properties?.['data-aria-visual'];
  if (state === 'pending' || state === 'ready' || state === 'invalid')
    return <ReplyVisualBlock source={extractText(children)} state={state} />;
  if (node?.properties['data-aria-math'] === 'ready') return equation(extractText(children), true);
  return <CodeBlock label={language ? String(language).slice(9) : undefined}>{children}</CodeBlock>;
};

const MarkdownCode: Components['code'] = ({ className, children }) =>
  className?.split(' ').includes('math-inline') ? (
    equation(extractText(children))
  ) : (
    <code className={className}>{children}</code>
  );

const MarkdownTable: Components['table'] = ({ children }) => (
  <div className="reply-table-scroll">
    <table>{children}</table>
  </div>
);

export default function MarkdownRenderer({
  content,
  sources = [],
  research = false,
  evidenceIds = [],
  onEvidence,
  rich = false,
  streaming = false,
}: {
  content: string;
  sources?: ConductorSource[];
  research?: boolean;
  evidenceIds?: string[];
  onEvidence?: (id: string) => void;
  rich?: boolean;
  streaming?: boolean;
}): ReactNode {
  return (
    <div className={rich ? 'markdown reply-markdown' : 'markdown'}>
      <ReactMarkdown
        remarkPlugins={
          rich
            ? [
                remarkGfm,
                [remarkMath, { singleDollarTextMath: false }],
                [replyMarkdown, { streaming }],
              ]
            : [remarkGfm]
        }
        urlTransform={(value) =>
          value.startsWith('aria-evidence:') && evidenceIds.includes(value.slice(14))
            ? value
            : defaultUrlTransform(value)
        }
        components={{
          pre: MarkdownPre,
          code: MarkdownCode,
          ...(rich && { table: MarkdownTable }),
          a: ({ href, children }) =>
            href?.startsWith('aria-evidence:') && evidenceIds.includes(href.slice(14)) ? (
              <button
                className="document-evidence-link"
                type="button"
                onClick={() => onEvidence?.(href.slice(14))}
              >
                {children}
              </button>
            ) : !href ||
              ((research || sources.length) && !sources.some((source) => source.url === href)) ? (
              <>{children}</>
            ) : (
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  if (research || sources.length) void openResearchSource(href);
                  else if (href)
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
