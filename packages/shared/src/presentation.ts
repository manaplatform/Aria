import { z } from 'zod';
import { replyVisualSchema } from './reply-visual.js';
import { weatherResult } from './weather.js';

export const presentationLimits = {
  blocks: 4,
  updates: 12,
  nodes: 64,
  depth: 6,
  bytes: 64 * 1024,
  rows: 500,
  columns: 12,
};
export const presentationFence = 'aria-ui';
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const label = z.string().trim().min(1).max(160);
const text = z.string().max(4000);
const ids = z.array(id).max(32);
const base = { id, label: label.optional() };
const named = { id, label };
const number = z.number().min(-1e100).max(1e100);
export const presentationCell = z.union([z.string().max(500), number, z.boolean(), z.null()]);
const rows = z
  .array(z.array(presentationCell).min(1).max(presentationLimits.columns))
  .min(1)
  .max(presentationLimits.rows);
const columns = z.array(label).min(1).max(presentationLimits.columns);
const datasetRef = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), quote: z.string().min(1).max(16000) }),
  z.strictObject({
    kind: z.literal('result'),
    stepId: z.uuid(),
    path: z.array(z.union([id, z.number().int().min(0).max(1000)])).max(8),
    keys: z.array(id).min(1).max(presentationLimits.columns).optional(),
  }),
  z.strictObject({ kind: z.literal('illustrative'), rows }),
]);
const fields = z.discriminatedUnion('kind', [
  z.strictObject({ ...named, kind: z.literal('checkbox'), value: z.boolean().optional() }),
  z.strictObject({ ...named, kind: z.literal('text'), value: z.string().max(500).optional() }),
  z.strictObject({ ...named, kind: z.literal('date'), value: z.iso.date().optional() }),
  z.strictObject({
    ...named,
    kind: z.literal('select'),
    options: z.array(label).min(1).max(16),
    value: label.optional(),
  }),
  z.strictObject({
    ...named,
    kind: z.literal('slider'),
    min: number,
    max: number,
    step: number.positive().optional(),
    value: number.optional(),
  }),
]);
const graphNode = z.strictObject({
  ...named,
  group: label.optional(),
  icon: z.enum(['info', 'check', 'link', 'server', 'file']).optional(),
});
const edges = z.array(z.strictObject({ from: id, to: id, label: label.optional() })).max(72);
export const presentationNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal(['text', 'heading', 'markdown', 'code', 'math', 'badge', 'callout']),
    text,
    language: label.optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('list'),
    items: z.array(label).min(1).max(32),
    ordered: z.boolean().optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('icon'),
    icon: z.enum(['info', 'check', 'link', 'server', 'file']),
  }),
  z.strictObject({ ...base, type: z.literal('divider') }),
  z.strictObject({
    ...base,
    type: z.literal(['card', 'row', 'column', 'grid', 'tabs', 'section', 'comparison']),
    children: ids.min(1),
  }),
  z.strictObject({
    ...named,
    type: z.literal('table'),
    dataset: id,
    sortable: z.boolean().optional(),
    filterable: z.boolean().optional(),
  }),
  z.strictObject({
    ...named,
    type: z.literal('chart'),
    dataset: id,
    chart: z.enum(['bar', 'line', 'pie', 'scatter']),
  }),
  z.strictObject({
    ...named,
    type: z.literal(['metric', 'progress']),
    dataset: id,
    row: z.number().int().min(0).max(499),
    column: z.number().int().min(0).max(11),
    unit: label.optional(),
  }),
  z.strictObject({ ...named, type: z.literal('status'), stepId: z.uuid() }),
  z.strictObject({ ...base, type: z.literal('weather'), stepId: z.uuid(), view: z.enum(['current', 'hourly', 'daily', 'forecast', 'comparison']), data: weatherResult.optional() }),
  z.strictObject({
    ...named,
    type: z.literal('diagram'),
    kind: z.enum([
      'svg',
      'flowchart',
      'architecture',
      'dependency',
      'sequence',
      'timeline',
      'tree',
    ]),
    description: z.string().min(1).max(500),
    nodes: z.array(graphNode).min(1).max(32),
    edges,
  }),
  z.strictObject({
    ...named,
    type: z.literal('form'),
    fields: z.array(fields).min(1).max(12),
    action: id.optional(),
  }),
  z.strictObject({
    ...named,
    type: z.literal('calculator'),
    expression: z.string().min(1).max(240),
    fields: z.array(fields).max(12),
  }),
  z.strictObject({ ...named, type: z.literal('button'), action: id }),
]);
const actions = z.discriminatedUnion('kind', [
  z.strictObject({ ...named, kind: z.literal('copy'), target: id }),
  z.strictObject({
    ...named,
    kind: z.literal('link'),
    sourceId: z.uuid().optional(),
    url: z.string().max(2000).optional(),
  }),
  z.strictObject({ ...named, kind: z.literal('export'), target: id }),
  z.strictObject({
    ...named,
    kind: z.literal('followUp'),
    request: z.string().trim().min(1).max(1000),
  }),
  z.strictObject({ ...named, kind: z.literal('approval'), stepId: z.uuid() }),
]);
const common = {
  v: z.literal(1),
  id,
  revision: z.number().int().min(1).max(presentationLimits.updates),
  roots: ids.min(1),
  nodes: z.array(presentationNodeSchema).min(1).max(presentationLimits.nodes),
  actions: z.array(actions).max(16).optional(),
  sources: z.array(z.uuid()).max(8).optional(),
};
function unique(values: readonly string[]) {
  return new Set(values).size === values.length;
}
export const presentationSize = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
type Common = z.infer<z.ZodObject<typeof common>>;
function validBlock(
  block: Common & { datasets?: { id: string; columns: string[]; rows?: unknown[][] }[] },
) {
  const nodes = new Map(block.nodes.map((node) => [node.id, node]));
  const actionMap = new Map(block.actions?.map((action) => [action.id, action]));
  const datasets = new Map(block.datasets?.map((dataset) => [dataset.id, dataset]));
  const visited = new Set<string>();
  function walk(ids: readonly string[], depth: number): boolean {
    if (depth > presentationLimits.depth) return false;
    for (const id of ids) {
      const node = nodes.get(id);
      if (!node || visited.has(id)) return false;
      visited.add(id);
      if ('children' in node && !walk(node.children, depth + 1)) return false;
    }
    return true;
  }
  return (
    nodes.size === block.nodes.length &&
    actionMap.size === (block.actions?.length ?? 0) &&
    datasets.size === (block.datasets?.length ?? 0) &&
    [...datasets.values()].every(
      (dataset) =>
        unique(dataset.columns) &&
        (!dataset.rows || dataset.rows.every((row) => row.length === dataset.columns.length)),
    ) &&
    walk(block.roots, 1) &&
    visited.size === nodes.size &&
    block.nodes.every((node) => {
      if ('dataset' in node && !datasets.has(node.dataset)) return false;
      if ('action' in node && node.action && !actionMap.has(node.action)) return false;
      if (node.type === 'form' && node.action && actionMap.get(node.action)?.kind !== 'followUp')
        return false;
      if (node.type === 'diagram') {
        const ids = new Set(node.nodes.map((item) => item.id));
        return (
          ids.size === node.nodes.length &&
          (node.kind === 'sequence' || unique(node.edges.map(({ from, to }) => from + ':' + to))) &&
          node.edges.every(({ from, to }) => ids.has(from) && ids.has(to))
        );
      }
      if ('fields' in node)
        return (
          unique(node.fields.map((field) => field.id)) &&
          node.fields.every((field) =>
            field.kind === 'slider'
              ? field.min < field.max &&
                (field.value === undefined ||
                  (field.min <= field.value && field.value <= field.max))
              : field.kind !== 'select' ||
                (unique(field.options) &&
                  (field.value === undefined || field.options.includes(field.value))),
          )
        );
      return true;
    }) &&
    [...actionMap.values()].every((action) => {
      if (action.kind === 'link') return Boolean(action.sourceId) !== Boolean(action.url);
      if (action.kind === 'copy')
        return Boolean(nodes.get(action.target) && 'text' in nodes.get(action.target)!);
      if (action.kind === 'export')
        return ['table', 'chart', 'diagram'].includes(nodes.get(action.target)?.type ?? '');
      return true;
    }) &&
    presentationSize(block) <= presentationLimits.bytes
  );
}
export const presentationInputSchema = z
  .strictObject({
    ...common,
    datasets: z
      .array(z.strictObject({ id, columns, data: datasetRef }))
      .max(8)
      .optional(),
  })
  .refine(validBlock);
export const presentationBlockSchema = z
  .strictObject({
    ...common,
    datasets: z
      .array(
        z.strictObject({
          id,
          columns,
          rows,
          illustrative: z.boolean(),
          stepId: z.uuid().optional(),
        }),
      )
      .max(8)
      .optional(),
  })
  .refine(validBlock);
export const presentationPartSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('block'),
    offset: z.number().int().min(0).max(100000),
    block: presentationBlockSchema,
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    offset: z.number().int().min(0).max(100000),
    id,
  }),
]);
export const messagePresentationSchema = z
  .array(presentationPartSchema)
  .max(presentationLimits.blocks)
  .refine(
    (parts) =>
      unique(parts.map(presentationId)) &&
      parts.every((part, index) => index === 0 || part.offset >= parts[index - 1].offset) &&
      parts.reduce((sum, part) => sum + (part.kind === 'block' ? part.block.nodes.length : 0), 0) <=
        presentationLimits.nodes &&
      presentationSize(parts) <= presentationLimits.bytes,
  );
export type PresentationPart = z.infer<typeof presentationPartSchema>;
export type PresentationBlock = z.infer<typeof presentationBlockSchema>;
export type PresentationNode = z.infer<typeof presentationNodeSchema>;
export type PresentationCell = z.infer<typeof presentationCell>;
export type PresentationDataset = NonNullable<PresentationBlock['datasets']>[number];

export function presentationId(part: PresentationPart) {
  return part.kind === 'block' ? part.block.id : part.id;
}
export function updatePresentation(parts: PresentationPart[], part: PresentationPart) {
  const index = parts.findIndex((item) => presentationId(item) === presentationId(part));
  const previous = parts[index];
  if (
    previous &&
    (previous.kind !== 'block' ||
      part.kind !== 'block' ||
      previous.block.revision >= part.block.revision)
  )
    return parts;
  const next =
    index < 0
      ? [...parts, part]
      : parts.map((item, i) => (i === index ? { ...part, offset: item.offset } : item));
  return messagePresentationSchema.safeParse(next).success ? next : parts;
}

export const presentationActionRequest = z.strictObject({
  conversationId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200),
  blockId: id,
  revision: z.number().int().positive().max(presentationLimits.updates),
  actionId: id,
  fieldId: id.optional(),
  values: z
    .record(id, z.union([z.string().max(500), number, z.boolean()]))
    .refine((value) => Object.keys(value).length <= 12)
    .optional(),
});
export type PresentationActionRequest = z.infer<typeof presentationActionRequest>;
export type PresentationActionResult =
  | { kind: 'done' | 'cancelled' }
  | { kind: 'review'; request: string }
  | { kind: 'approval'; stepId: string };

export const presentationStateSchema = z
  .record(
    z.string().regex(/^[a-zA-Z0-9_-]{1,40}(?::[a-zA-Z0-9_-]{1,40}){1,2}$/),
    z.union([z.boolean(), id, z.number().int().min(-12).max(12)]),
  )
  .refine((value) => Object.keys(value).length <= presentationLimits.nodes);
export type PresentationState = z.infer<typeof presentationStateSchema>;

export function resolvePresentationFields(
  node: Extract<PresentationNode, { type: 'form' }>,
  values: NonNullable<PresentationActionRequest['values']>,
) {
  if (Object.keys(values).some((id) => !node.fields.some((field) => field.id === id)))
    throw new Error('The form fields changed. Review the form again.');
  return node.fields.map((field) => {
    const value =
      (Object.hasOwn(values, field.id) ? values[field.id] : undefined) ??
      field.value ??
      (field.kind === 'checkbox' ? false : field.kind === 'slider' ? field.min : '');
    const valid =
      field.kind === 'checkbox'
        ? typeof value === 'boolean'
        : field.kind === 'slider'
          ? typeof value === 'number' && value >= field.min && value <= field.max
          : typeof value === 'string' &&
            (field.kind === 'text' ||
              !value ||
              (field.kind === 'select'
                ? field.options.includes(value)
                : z.iso.date().safeParse(value).success));
    if (!valid) throw new Error('A form value is invalid.');
    return [field.label, value] as const;
  });
}

export function presentationChart(
  node: Extract<PresentationNode, { type: 'chart' }>,
  dataset: PresentationDataset,
) {
  const { columns, rows } = dataset;
  const chart =
    node.chart === 'scatter'
      ? {
          type: 'scatter',
          xLabel: columns[0],
          yLabel: columns[1],
          series: [{ name: node.label, points: rows }],
        }
      : {
          type: node.chart,
          ...(node.chart !== 'pie' && { xLabel: columns[0] }),
          categories: rows.map((row) => String(row[0] ?? '')),
          series: columns
            .slice(1)
            .map((name, index) => ({ name, values: rows.map((row) => row[index + 1]) })),
        };
  const validated = replyVisualSchema.safeParse({ ...chart, v: 1, title: node.label });
  return validated.success && validated.data.type !== 'flowchart' ? validated.data : undefined;
}
