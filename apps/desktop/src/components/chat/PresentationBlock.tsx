import {
  Component,
  lazy,
  memo,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, FileText, Info, Link, Server } from 'lucide-react';
import {
  evaluateCalculation,
  presentationChart,
  presentationStateSchema,
  type ChatMessage,
  type PresentationActionRequest,
  type PresentationBlock as Block,
  type PresentationDataset,
  type PresentationNode,
  type PresentationState,
} from '@aria/shared';
import { Button, Modal } from '../ui';
import { desktop, errorMessage } from '../../services/desktop';
import { sendingAllowed, sendChat, updateChat } from '../../stores/chatStore';
import { flushPersistence, useWorkspaceStore } from '../../stores/workspaceStore';
import { openResearchSource } from '../../stores/browserStore';
import { notify } from '../../stores/uiStore';
import MarkdownRenderer from './MarkdownRenderer';

const Chart = lazy(() => import('./ReplyChart'));
const Diagram = lazy(() => import('./PresentationDiagram'));
const Equation = lazy(() => import('./ReplyEquation'));
const WeatherCard = lazy(() => import('./WeatherCard'));
const icons = { info: Info, check: Check, link: Link, server: Server, file: FileText };
type Values = NonNullable<PresentationActionRequest['values']>;
type Stateful = {
  current?: PresentationState[string];
  save(value: PresentationState[string]): void;
};

function report(messageId: string, status: 'rendered' | 'failed', start: number) {
  void window.aria
    ?.personaRender?.(messageId, status, Math.min(30_000, performance.now() - start))
    .catch(() => undefined);
}

export class PresentationBoundary extends Component<{ id: string; children: ReactNode }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    report(this.props.id, 'failed', performance.now());
  }
  render() {
    return this.state.failed ? (
      <p role="status">Interactive content is unavailable.</p>
    ) : (
      this.props.children
    );
  }
}

function InteractiveTable({
  node,
  dataset,
  current,
  save,
}: Stateful & {
  node: Extract<PresentationNode, { type: 'table' }>;
  dataset: PresentationDataset;
}) {
  const [filter, setFilter] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const sort = typeof current === 'number' ? current : 0;
  const collator = useMemo(
    () => new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }),
    [],
  );
  const rows = useMemo(() => {
    const query = filter.toLocaleLowerCase().trim();
    const list = dataset.rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          !query ||
          row.some((value) =>
            String(value ?? '')
              .toLocaleLowerCase()
              .includes(query),
          ),
      );
    if (!sort) return list;
    const column = Math.abs(sort) - 1;
    return list.sort((a, b) => {
      const left = a.row[column];
      const right = b.row[column];
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : collator.compare(String(left ?? ''), String(right ?? ''));
      return Math.sign(sort) * order;
    });
  }, [dataset.rows, filter, sort, collator]);
  const virtual = rows.length > 100;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 37,
    overscan: 8,
    enabled: virtual,
  });
  const windowRows = virtual ? virtualizer.getVirtualItems() : undefined;
  const start = windowRows?.[0]?.start ?? 0;
  const end = windowRows ? virtualizer.getTotalSize() - (windowRows.at(-1)?.end ?? 0) : 0;
  const visible = windowRows
    ? windowRows.map(({ index }) => ({ ...rows[index], position: index }))
    : rows.map((row, position) => ({ ...row, position }));
  return (
    <figure className="persona-data">
      <figcaption>
        {node.label}
        {dataset.illustrative && ' · Illustrative data'}
      </figcaption>
      {node.filterable && (
        <label className="persona-field">
          Filter {node.label}
          <input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
      )}
      <div
        className="reply-table-scroll persona-table"
        ref={scroller}
        tabIndex={0}
        role="region"
        aria-label={node.label}
      >
        <table aria-label={node.label} aria-rowcount={rows.length + 1}>
          <thead>
            <tr>
              {dataset.columns.map((column, index) => {
                const columnId = index + 1;
                const direction =
                  sort === columnId ? 'ascending' : sort === -columnId ? 'descending' : 'none';
                return (
                  <th key={column} scope="col" aria-sort={node.sortable ? direction : undefined}>
                    {node.sortable ? (
                      <button
                        type="button"
                        onClick={() => save(sort === columnId ? -columnId : columnId)}
                      >
                        {column}
                        {direction !== 'none' && (
                          <span aria-hidden="true">{sort > 0 ? ' ↑' : ' ↓'}</span>
                        )}
                      </button>
                    ) : (
                      column
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {start > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: start, padding: 0 }} colSpan={dataset.columns.length} />
              </tr>
            )}
            {visible.map(({ row, index, position }) => (
              <tr key={index} aria-rowindex={position + 2}>
                {row.map((value, index) => (
                  <td key={index} dir="auto">
                    {value === null ? '—' : String(value)}
                  </td>
                ))}
              </tr>
            ))}
            {end > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: end, padding: 0 }} colSpan={dataset.columns.length} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {node.filterable && <span role="status">{rows.length} rows</span>}
    </figure>
  );
}

function Fields({
  node,
  state,
  save,
  submit,
  disabled,
}: {
  node: Extract<PresentationNode, { type: 'form' | 'calculator' }>;
  state: PresentationState;
  save(id: string, value: PresentationState[string]): void;
  submit(values: Values): void;
  disabled: boolean;
}) {
  const [entered, setEntered] = useState<Values>({});
  const values = Object.fromEntries(
    node.fields.map((field) => [
      field.id,
      field.kind === 'checkbox'
        ? (state[field.id] ?? field.value ?? false)
        : (entered[field.id] ?? field.value ?? (field.kind === 'slider' ? field.min : '')),
    ]),
  );
  const set = (id: string, value: Values[string]) => {
    if (typeof value === 'boolean') save(id, value);
    else setEntered((previous) => ({ ...previous, [id]: value }));
  };
  let calculation: string | undefined;
  if (node.type === 'calculator') {
    try {
      const expression = node.expression.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_, id: string) => {
        if (!Object.hasOwn(values, id)) throw new Error();
        const value = values[id];
        if (value === '' || !Number.isFinite(Number(value))) throw new Error();
        return '(' + Number(value) + ')';
      });
      if (expression.length > 512) throw new Error();
      calculation = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 12 }).format(
        evaluateCalculation(expression).result,
      );
    } catch {
      calculation = 'Enter valid values to calculate the result.';
    }
  }
  return (
    <form
      className="persona-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) submit(values);
      }}
    >
      <fieldset>
        <legend>{node.label}</legend>
        {node.fields.map((field) => (
          <label key={field.id} className="persona-field">
            <span>{field.label}</span>
            {field.kind === 'checkbox' ? (
              <input
                type="checkbox"
                checked={values[field.id] === true}
                onChange={(event) => set(field.id, event.target.checked)}
              />
            ) : field.kind === 'select' ? (
              <select
                value={String(values[field.id])}
                onChange={(event) => set(field.id, event.target.value)}
              >
                <option value="">Select…</option>
                {field.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : field.kind === 'slider' ? (
              <span className="persona-controls">
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step ?? 'any'}
                  value={Number(values[field.id])}
                  onChange={(event) => set(field.id, event.target.valueAsNumber)}
                />
                <span>{values[field.id]}</span>
              </span>
            ) : (
              <input
                type={field.kind}
                maxLength={500}
                value={String(values[field.id])}
                onChange={(event) => set(field.id, event.target.value)}
              />
            )}
          </label>
        ))}
        {node.type === 'form' && node.action && (
          <Button disabled={disabled} type="submit" size="sm">
            Review request
          </Button>
        )}
        {calculation !== undefined && <output aria-live="polite">{calculation}</output>}
      </fieldset>
    </form>
  );
}

function Status({ message, stepId }: { message: ChatMessage; stepId: string }) {
  const step = message.activity?.find((item) => item.stepId === stepId);
  const status = step?.outcomeUnverified
    ? 'Unverified'
    : step?.status === 'approval'
      ? 'Waiting for approval'
      : step?.status
        ? step.status[0].toUpperCase() + step.status.slice(1)
        : 'Unverified';
  return <span className="persona-badge">{status}</span>;
}

const PresentationBlock = memo(
  function PresentationBlock({ block, message }: { block: Block; message: ChatMessage }) {
    const [review, setReview] = useState<string>();
    const [busy, setBusy] = useState(false);
    const inFlight = useRef(false);
    const [start] = useState(() => performance.now());
    const instance = useId();
    const nodes = useMemo(() => new Map(block.nodes.map((node) => [node.id, node])), [block.nodes]);
    const actions = useMemo(
      () => new Map(block.actions?.map((action) => [action.id, action])),
      [block.actions],
    );
    const datasets = useMemo(
      () => new Map(block.datasets?.map((dataset) => [dataset.id, dataset])),
      [block.datasets],
    );
    const state = message.presentationState ?? {};
    const complete = message.status === 'completed';
    useEffect(() => {
      const paint = requestAnimationFrame(() => report(message.id, 'rendered', start));
      return () => cancelAnimationFrame(paint);
    }, [message.id, start]);

    const save = (id: string, value: PresentationState[string]) => {
      updateChat((chat) => ({
        ...chat,
        messages: chat.messages.map((item) => {
          if (item.id !== message.id || item.requestId !== message.requestId) return item;
          const presentationState = { ...item.presentationState, [block.id + ':' + id]: value };
          return presentationStateSchema.safeParse(presentationState).success
            ? { ...item, presentationState }
            : item;
        }),
      }));
      void flushPersistence();
    };
    async function invoke(actionId: string, fieldId?: string, values?: Values) {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const result = await desktop().personaAction({
          conversationId: message.conversationId,
          messageId: message.id,
          blockId: block.id,
          revision: block.revision,
          actionId,
          fieldId,
          values,
        });
        if (result.kind === 'review') setReview(result.request);
        if (result.kind === 'approval') {
          const activity = document
            .getElementById('chat-message-' + message.id)
            ?.querySelector('details.conductor-activity');
          if (activity instanceof HTMLDetailsElement) {
            activity.open = true;
            activity.querySelector('summary')?.focus();
          }
        }
      } catch (error) {
        notify(errorMessage(error), true);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    }

    function render(id: string): ReactNode {
      const node = nodes.get(id);
      if (!node) return null;
      const current = state[block.id + ':' + id];
      const label = 'label' in node ? node.label : undefined;
      if ('children' in node) {
        if (node.type === 'section')
          return (
            <details
              key={id}
              open={current === true}
              onToggle={(event) => {
                if (event.currentTarget.open !== (current === true))
                  save(id, event.currentTarget.open);
              }}
            >
              <summary>{label ?? 'Details'}</summary>
              {node.children.map(render)}
            </details>
          );
        if (node.type === 'tabs') {
          const selected =
            typeof current === 'string' && node.children.includes(current)
              ? current
              : node.children[0];
          return (
            <Tabs.Root key={id} value={selected} onValueChange={(value) => save(id, value)}>
              <Tabs.List className="persona-controls" aria-label={label ?? 'Views'}>
                {node.children.map((child, index) => (
                  <Tabs.Trigger key={child} value={child} className="persona-tab">
                    {nodes.get(child)?.label ?? 'View ' + (index + 1)}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              {node.children.map((child) => (
                <Tabs.Content key={child} value={child}>
                  {render(child)}
                </Tabs.Content>
              ))}
            </Tabs.Root>
          );
        }
        return (
          <section key={id} className={'persona-layout persona-' + node.type} aria-label={label}>
            {label && <h4>{label}</h4>}
            {node.children.map(render)}
          </section>
        );
      }
      if ('dataset' in node) {
        const dataset = datasets.get(node.dataset);
        if (!dataset) return null;
        if (node.type === 'table')
          return (
            <InteractiveTable
              key={id}
              node={node}
              dataset={dataset}
              current={current}
              save={(value) => save(id, value)}
            />
          );
        if (node.type === 'chart') {
          const visual = presentationChart(node, dataset);
          return (
            <figure key={id} className="reply-visual">
              <figcaption>
                {node.label}
                {dataset.illustrative && ' · Illustrative data'}
              </figcaption>
              {visual ? (
                <Suspense fallback={<span role="status">Loading chart…</span>}>
                  <Chart visual={visual} />
                </Suspense>
              ) : (
                <span role="status">The data does not fit this chart.</span>
              )}
            </figure>
          );
        }
        const value = dataset.rows[node.row]?.[node.column];
        return (
          <div key={id} className="persona-metric">
            <span>
              {node.label}
              {dataset.illustrative && ' · Illustrative data'}
            </span>
            {node.type === 'progress' &&
              typeof value === 'number' &&
              value >= 0 &&
              value <= 100 && <progress max={100} value={value} aria-label={node.label} />}
            <strong>
              {value === null || value === undefined ? '—' : String(value)}
              {node.unit && ' ' + node.unit}
            </strong>
          </div>
        );
      }
      if (node.type === 'form' || node.type === 'calculator') {
        const values = Object.fromEntries(
          node.fields.map((field) => [field.id, state[block.id + ':' + node.id + ':' + field.id]]),
        );
        return (
          <Fields
            key={id}
            node={node}
            state={values}
            save={(id, value) => save(node.id + ':' + id, value)}
            disabled={!complete || busy}
            submit={(values) => {
              if (node.type === 'form' && node.action) void invoke(node.action, node.id, values);
            }}
          />
        );
      }
      if (node.type === 'button') {
        const action = actions.get(node.action);
        return (
          <Button
            key={id}
            size="sm"
            disabled={busy || (!complete && !['copy', 'approval'].includes(action?.kind ?? ''))}
            onClick={() => void invoke(node.action)}
          >
            {node.label}
          </Button>
        );
      }
      if (node.type === 'weather')
        return <Suspense key={id} fallback={<span>Loading weather…</span>}><WeatherCard node={node} /></Suspense>;
      if (node.type === 'status')
        return (
          <p key={id}>
            {node.label} <Status message={message} stepId={node.stepId} />
          </p>
        );
      if (node.type === 'diagram')
        return (
          <figure key={id} className="reply-visual">
            <figcaption>{node.label}</figcaption>
            <Suspense fallback={<span role="status">Loading diagram…</span>}>
              <Diagram diagram={node} />
            </Suspense>
          </figure>
        );
      if (node.type === 'divider') return <hr key={id} />;
      if (node.type === 'icon') {
        const Icon = icons[node.icon];
        return <Icon key={id} size={17} aria-label={label} aria-hidden={!label} />;
      }
      if (node.type === 'list') {
        const List = node.ordered ? 'ol' : 'ul';
        return (
          <List key={id}>
            {node.items.map((item, index) => (
              <li dir="auto" key={index}>
                {item}
              </li>
            ))}
          </List>
        );
      }
      if (node.type === 'markdown')
        return <MarkdownRenderer key={id} content={node.text} rich passive />;
      if (node.type === 'heading') return <h4 key={id}>{node.text}</h4>;
      if (node.type === 'code')
        return (
          <pre dir="ltr" key={id}>
            <code>{node.text}</code>
          </pre>
        );
      if (node.type === 'math')
        return (
          <Suspense key={id} fallback={<span>{node.text}</span>}>
            <Equation formula={node.text.slice(0, 2048)} display />
          </Suspense>
        );
      if (node.type === 'badge')
        return (
          <span key={id} className="persona-badge">
            {node.text}
          </span>
        );
      if (node.type === 'callout')
        return (
          <aside key={id} className="persona-callout">
            {node.text}
          </aside>
        );
      return <p key={id}>{node.text}</p>;
    }

    return (
      <div className="persona-block" dir="auto" data-persona-block={block.id}>
        {block.roots.map(render)}
        {block.sources?.length ? (
          <div className="persona-controls" aria-label="Component sources">
            {block.sources.map((id) => {
              const source = message.citations?.sources.find((source) => source.id === id);
              return (
                source && (
                  <Button
                    key={id}
                    size="sm"
                    variant="ghost"
                    onClick={() => void openResearchSource(source.url)}
                  >
                    {source.title}
                  </Button>
                )
              );
            })}
          </div>
        ) : null}
        {review !== undefined && (
          <Modal
            open
            title="Review generated request"
            description="Edit the message before sending it to Aria."
            className="persona-review"
            onOpenChange={(open) => {
              if (!open) setReview(undefined);
            }}
          >
            <label htmlFor={instance}>Message</label>
            <textarea
              id={instance}
              dir="auto"
              rows={7}
              maxLength={12000}
              value={review}
              onChange={(event) => setReview(event.target.value)}
            />
            <Button
              type="button"
              variant="primary"
              disabled={!review.trim()}
              onClick={() => {
                if (
                  useWorkspaceStore.getState().data.chat.selectedId !== message.conversationId ||
                  !sendingAllowed(message.conversationId)
                ) {
                  notify(
                    'Return to this conversation and wait for its current response before sending.',
                    true,
                  );
                  return;
                }
                setReview(undefined);
                void sendChat(review);
              }}
            >
              Send request
            </Button>
          </Modal>
        )}
      </div>
    );
  },
  (previous, next) =>
    previous.block === next.block &&
    previous.message.id === next.message.id &&
    previous.message.requestId === next.message.requestId &&
    previous.message.status === next.message.status &&
    previous.message.activity === next.message.activity &&
    previous.message.citations === next.message.citations &&
    previous.message.presentationState === next.message.presentationState,
);
export default PresentationBlock;
