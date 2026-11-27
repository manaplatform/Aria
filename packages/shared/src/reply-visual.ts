import { z } from 'zod';

export const replyVisualFence = 'aria-visual';
export const replyVisualLimits = {
  blocks: 4,
  characters: 12000,
  categories: 40,
  series: 4,
  slices: 12,
  nodes: 12,
  edges: 20,
} as const;

const label = z.string().trim().min(1).max(100);
const number = z.number().min(-1e100).max(1e100);
const nodeId = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/);
const base = { v: z.literal(1), title: label };
const axes = { xLabel: label.optional(), yLabel: label.optional() };

export const replyVisualSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...base,
      ...axes,
      type: z.literal(['bar', 'line', 'area']),
      categories: z.array(label).min(1).max(replyVisualLimits.categories),
      series: z
        .array(
          z.strictObject({
            name: label,
            values: z.array(number.nullable()).min(1).max(replyVisualLimits.categories),
          }),
        )
        .min(1)
        .max(replyVisualLimits.series),
    }),
    z.strictObject({
      ...base,
      ...axes,
      type: z.literal('scatter'),
      series: z
        .array(
          z.strictObject({
            name: label,
            points: z
              .array(z.tuple([number, number]))
              .min(1)
              .max(replyVisualLimits.categories),
          }),
        )
        .min(1)
        .max(replyVisualLimits.series),
    }),
    z.strictObject({
      ...base,
      type: z.literal('pie'),
      categories: z.array(label).min(1).max(replyVisualLimits.slices),
      series: z.tuple([
        z.strictObject({
          name: label,
          values: z.array(number.nonnegative()).min(1).max(replyVisualLimits.slices),
        }),
      ]),
    }),
    z.strictObject({
      ...base,
      type: z.literal('flowchart'),
      nodes: z
        .array(z.strictObject({ id: nodeId, label }))
        .min(1)
        .max(replyVisualLimits.nodes),
      edges: z
        .array(z.strictObject({ from: nodeId, to: nodeId, label: label.optional() }))
        .max(replyVisualLimits.edges),
    }),
  ])
  .refine((visual) => {
    if (visual.type === 'flowchart') {
      const ids = new Set(visual.nodes.map(({ id }) => id));
      const links = new Set(visual.edges.map(({ from, to }) => `${from}:${to}`));
      return (
        ids.size === visual.nodes.length &&
        links.size === visual.edges.length &&
        visual.edges.every(({ from, to }) => ids.has(from) && ids.has(to))
      );
    }
    if (visual.type === 'scatter') return true;
    if (visual.type === 'pie' && !visual.series[0].values.some((value) => value > 0)) return false;
    return visual.series.every(
      ({ values }) =>
        values.length === visual.categories.length && values.some((value) => value !== null),
    );
  });

export type ReplyVisual = z.infer<typeof replyVisualSchema>;

export const replyMarkdownPrompt = 'Format desktop chat replies with readable Markdown. Lead with the answer. Use short headings and lists for longer explanations, tables for exact comparisons, and meaningful symbols where helpful. Use $$formula$$ for inline LaTeX and put $$ on separate lines around a display equation.';

export const replyFormattingPrompt = [
  replyMarkdownPrompt,
  `When a chart or flowchart helps, put one JSON object in a top-level \`\`\`${replyVisualFence} block, close the fence on its own line, and continue the reply as Markdown. Use data from the conversation or observed results. Clearly label illustrative values. Summarize the main takeaway in prose. Use the artifact workflow when the user requests a downloadable chart.`,
  'Every visual has v:1, type and a short title. For type "bar", "line" or "area", add categories (ordered strings) and series ([{"name":"Series","values":[12,20,null]}], one value per category, null for a gap). For "scatter", add series ([{"name":"Series","points":[[1,2],[3,4]]}]). These charts accept xLabel and yLabel for axes and units. For "pie", use categories and a single named series of nonnegative values with at least one positive value. For "flowchart", use nodes ([{"id":"start","label":"Start"}]) and edges ([{"from":"start","to":"next","label":"optional"}]) using existing node IDs.',
  `Use up to ${replyVisualLimits.blocks} blocks per reply, ${replyVisualLimits.categories} categories or points per series, ${replyVisualLimits.series} series, ${replyVisualLimits.slices} pie slices, and ${replyVisualLimits.nodes} nodes and ${replyVisualLimits.edges} edges per flowchart.`,
].join('\n');
