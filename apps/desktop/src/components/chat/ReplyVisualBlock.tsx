import { replyVisualLimits, replyVisualSchema } from '@aria/shared';
import { Component, lazy, memo, Suspense, useId, useMemo, type ReactNode } from 'react';
import { CopyButton } from '../ui';

const ReplyChart = lazy(() => import('./ReplyChart'));
const ReplyFlowchart = lazy(() => import('./ReplyFlowchart'));

function VisualSource({ source }: { source: string }) {
  return (
    <details className="reply-visual-fallback">
      <summary>Visual unavailable · View source</summary>
      <CopyButton text={source} label="Copy visual source" />
      <pre>{source}</pre>
    </details>
  );
}

class VisualErrorBoundary extends Component<{ source: string; children: ReactNode }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <VisualSource source={this.props.source} /> : this.props.children;
  }
}

function readVisual(source: string) {
  if (source.length > replyVisualLimits.characters + 1) return undefined;
  try {
    const visual = replyVisualSchema.safeParse(JSON.parse(source));
    return visual.success ? visual.data : undefined;
  } catch {
    return undefined;
  }
}

export const ReplyVisualBlock = memo(function ReplyVisualBlock({
  source,
  state,
}: {
  source: string;
  state: 'pending' | 'ready' | 'invalid';
}) {
  const captionId = useId();
  const visual = useMemo(
    () => (state === 'ready' ? readVisual(source) : undefined),
    [source, state],
  );
  if (state === 'pending')
    return (
      <p className="reply-visual-placeholder" role="status">
        Preparing visual…
      </p>
    );
  if (!visual) return <VisualSource source={source} />;

  return (
    <figure className="reply-visual" aria-labelledby={captionId}>
      <figcaption id={captionId}>{visual.title}</figcaption>
      <VisualErrorBoundary key={source} source={source}>
        <Suspense
          fallback={
            <p className="reply-visual-placeholder" role="status">
              Loading visual…
            </p>
          }
        >
          {visual.type === 'flowchart' ? (
            <ReplyFlowchart visual={visual} />
          ) : (
            <ReplyChart visual={visual} />
          )}
        </Suspense>
      </VisualErrorBoundary>
    </figure>
  );
});
