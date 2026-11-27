import { Graph, layout } from '@dagrejs/dagre';
import type { PresentationNode } from '@aria/shared';

export type PresentationDiagram = Extract<PresentationNode, { type: 'diagram' }>;
export const diagramNodeWidth = 174;
export const diagramNodeHeight = 60;

export function diagramLabel(label: string) {
  const chars = Array.from(label);
  const lines: string[] = [];
  while (chars.length > 19 && lines.length < 2) {
    const at = chars.slice(0, 20).lastIndexOf(' ');
    lines.push(
      chars
        .splice(0, at > 4 ? at + 1 : 19)
        .join('')
        .trim(),
    );
  }
  if (chars.length)
    lines.push(chars.length > 19 ? chars.slice(0, 18).join('') + '…' : chars.join(''));
  return lines;
}

export function layoutPresentationDiagram(diagram: PresentationDiagram) {
  if (diagram.kind === 'sequence') {
    const nodes = diagram.nodes.map((node, index) => ({ ...node, x: 114 + 220 * index, y: 60 }));
    const positions = new Map(nodes.map(({ id, x }) => [id, x]));
    const height = Math.max(155, 155 + 48 * diagram.edges.length);
    const links = diagram.edges.map((edge, index) => {
      const from = positions.get(edge.from)!;
      const to = positions.get(edge.to)!;
      const y = 120 + index * 48;
      const points =
        from === to
          ? [
              { x: from, y },
              { x: from + 36, y },
              { x: from + 36, y: y + 22 },
              { x: from, y: y + 22 },
            ]
          : [
              { x: from, y },
              { x: to, y },
            ];
      return { ...edge, points, x: from === to ? from + 57 : (from + to) / 2, y };
    });
    return {
      nodes,
      links,
      groups: [],
      lifelines: nodes.map(({ x }) => ({ x, top: 90, bottom: height - 19 })),
      width: 228 + 220 * (nodes.length - 1),
      height,
    };
  }
  const horizontal = ['architecture', 'dependency', 'timeline'].includes(diagram.kind);
  const graph = new Graph().setGraph({
    rankdir: horizontal ? 'LR' : 'TB',
    marginx: 28,
    marginy: 30,
    ranksep: 52,
    nodesep: 48,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const keys = new Map(diagram.nodes.map(({ id }, index) => [id, 'n' + index]));
  diagram.nodes.forEach(({ id }) =>
    graph.setNode(keys.get(id)!, { width: diagramNodeWidth, height: diagramNodeHeight }),
  );
  for (const { from, to, label } of diagram.edges)
    graph.setEdge(
      keys.get(from)!,
      keys.get(to)!,
      label ? { width: 110, height: 28, labelpos: 'c' } : {},
    );
  // Keep a chronology visible even when the model supplies only ordered events.
  if (!diagram.edges.length && diagram.kind === 'timeline')
    for (let i = 1; i < diagram.nodes.length; i++)
      graph.setEdge(keys.get(diagram.nodes[i - 1].id)!, keys.get(diagram.nodes[i].id)!);
  layout(graph);
  const nodes = diagram.nodes.map((node) => {
    const placed = graph.node(keys.get(node.id)!);
    return { ...node, x: placed.x as number, y: placed.y as number };
  });
  const orderedEdges =
    !diagram.edges.length && diagram.kind === 'timeline'
      ? diagram.nodes.slice(1).map(({ id }, index) => ({ from: diagram.nodes[index].id, to: id }))
      : diagram.edges;
  const links = orderedEdges.map((edge) => ({
    ...edge,
    ...graph.edge(keys.get(edge.from)!, keys.get(edge.to)!),
  })) as (PresentationDiagram['edges'][number] & {
    x?: number;
    y?: number;
    points: { x: number; y: number }[];
  })[];
  const groups = Array.from(new Set(nodes.flatMap(({ group }) => (group ? [group] : [])))).map(
    (label) => {
      const members = nodes.filter(({ group }) => group === label);
      const left = Math.min(...members.map(({ x }) => x)) - diagramNodeWidth / 2 - 10;
      const top = Math.min(...members.map(({ y }) => y)) - diagramNodeHeight / 2 - 24;
      const right = Math.max(...members.map(({ x }) => x)) + diagramNodeWidth / 2 + 10;
      const bottom = Math.max(...members.map(({ y }) => y)) + diagramNodeHeight / 2 + 10;
      return { label, left, top, width: right - left, height: bottom - top };
    },
  );
  return {
    nodes,
    links,
    groups,
    lifelines: [],
    width: graph.graph().width ?? 228,
    height: graph.graph().height ?? 116,
  };
}

const xml = (text: string) =>
  Array.from(text, (character) => {
    const code = character.codePointAt(0)!;
    const valid =
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code < 0xd800) ||
      (code >= 0xe000 && code < 0xfffe) ||
      code >= 0x10000;
    return valid ? character : '�';
  })
    .join('')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

export function exportPresentationDiagram(diagram: PresentationDiagram, dark: boolean) {
  const drawing = layoutPresentationDiagram(diagram);
  const colors = dark
    ? ['#161823', '#ecedf4', '#9799c1', '#252844']
    : ['#ffffff', '#1e2137', '#656888', '#eff0ff'];
  const [background, foreground, stroke, surface] = colors;
  const text = (x: number, y: number, value: string, attributes = '') =>
    '<text x="' + x + '" y="' + y + '" ' + attributes + '>' + xml(value) + '</text>';
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
      drawing.width +
      ' ' +
      drawing.height +
      '" role="img">',
    '<title>' + xml(diagram.label) + '</title><desc>' + xml(diagram.description) + '</desc>',
    '<rect width="100%" height="100%" fill="' + background + '"/>',
    '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8Z" fill="' +
      stroke +
      '"/></marker></defs>',
    '<g font-family="system-ui,sans-serif" font-size="13" fill="' + foreground + '">',
    ...drawing.groups.flatMap(({ label, left, top, width, height }) => [
      '<rect x="' +
        left +
        '" y="' +
        top +
        '" width="' +
        width +
        '" height="' +
        height +
        '" rx="8" fill="none" stroke="' +
        stroke +
        '" stroke-dasharray="4 4"/>',
      text(left + 8, top + 16, label),
    ]),
    ...drawing.lifelines.map(
      ({ x, top, bottom }) =>
        '<line x1="' +
        x +
        '" x2="' +
        x +
        '" y1="' +
        top +
        '" y2="' +
        bottom +
        '" stroke="' +
        stroke +
        '" stroke-dasharray="4 4"/>',
    ),
    ...drawing.links.flatMap(({ points, x, y, label }) => [
      '<polyline points="' +
        points.map(({ x, y }) => x + ',' + y).join(' ') +
        '" fill="none" stroke="' +
        stroke +
        '" marker-end="url(#arrow)"/>',
      label && x !== undefined && y !== undefined
        ? text(x, y - 6, label, 'text-anchor="middle"')
        : '',
    ]),
    ...drawing.nodes.flatMap(({ x, y, label }) => [
      '<rect x="' +
        (x - diagramNodeWidth / 2) +
        '" y="' +
        (y - diagramNodeHeight / 2) +
        '" width="' +
        diagramNodeWidth +
        '" height="' +
        diagramNodeHeight +
        '" rx="8" fill="' +
        surface +
        '" stroke="' +
        stroke +
        '"/>',
      ...diagramLabel(label).map((line, index, lines) =>
        text(
          x,
          y + 5 + (index - (lines.length - 1) / 2) * 16,
          line,
          'text-anchor="middle" direction="auto"',
        ),
      ),
    ]),
    '</g></svg>',
  ].join('');
}
