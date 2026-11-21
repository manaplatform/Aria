import { Graph, layout, type EdgeLabel, type GraphLabel, type NodeLabel } from '@dagrejs/dagre';
import type { ReplyVisual } from '@aria/shared';
import { useId, useMemo } from 'react';

type Flowchart = Extract<ReplyVisual, { type: 'flowchart' }>;

function layoutFlowchart(visual: Flowchart) {
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>();
  graph.setGraph({ rankdir: 'TB', ranksep: 34, nodesep: 22, marginx: 12, marginy: 12 });
  const ids = new Map(visual.nodes.map(({ id }, index) => [id, `node${index}`]));
  for (const { id, label } of visual.nodes) {
    graph.setNode(ids.get(id)!, { width: 164, height: 30 + 16 * Math.ceil(label.length / 13) });
  }
  for (const { from, to, label } of visual.edges) {
    graph.setEdge(
      ids.get(from)!,
      ids.get(to)!,
      label
        ? {
            width: 100,
            height: 12 + 14 * Math.ceil(label.length / 9),
            labelpos: 'r',
            labeloffset: 6,
          }
        : {},
    );
  }
  layout(graph);
  return {
    width: graph.graph().width ?? 0,
    height: graph.graph().height ?? 0,
    nodes: visual.nodes.map((node) => ({ ...node, ...graph.node(ids.get(node.id)!) })),
    edges: visual.edges.map((edge) => ({
      ...edge,
      ...graph.edge(ids.get(edge.from)!, ids.get(edge.to)!),
    })),
  };
}

export default function ReplyFlowchart({ visual }: { visual: Flowchart }) {
  const arrowId = useId();
  const drawing = useMemo(() => layoutFlowchart(visual), [visual]);
  const labels = new Map(visual.nodes.map(({ id, label }) => [id, label]));
  return (
    <>
      <div className="reply-flowchart-scroll">
        <svg
          className="reply-flowchart"
          width={drawing.width}
          height={drawing.height}
          viewBox={`0 0 ${drawing.width} ${drawing.height}`}
          role="img"
          aria-label={`${visual.title} flowchart`}
        >
          <defs>
            <marker id={arrowId} markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 Z" fill="var(--muted)" />
            </marker>
          </defs>
          {drawing.edges.map(({ from, to, label, points, x, y, width, height }) => (
            <g key={`${from}:${to}`}>
              <polyline
                points={points?.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="none"
                stroke="var(--muted)"
                strokeWidth="1.5"
                markerEnd={`url(#${arrowId})`}
              />
              {label && x !== undefined && y !== undefined && width && height && (
                <foreignObject x={x - width / 2} y={y - height / 2} width={width} height={height}>
                  <div className="reply-flow-label reply-flow-edge">{label}</div>
                </foreignObject>
              )}
            </g>
          ))}
          {drawing.nodes.map(({ id, label, x = 0, y = 0, width, height }) => (
            <foreignObject
              key={id}
              x={x - width / 2}
              y={y - height / 2}
              width={width}
              height={height}
            >
              <div className="reply-flow-label reply-flow-node">{label}</div>
            </foreignObject>
          ))}
        </svg>
      </div>
      <details className="reply-visual-details">
        <summary>Show connections</summary>
        {visual.edges.length > 0 ? (
          <ul>
            {visual.edges.map(({ from, to, label }) => (
              <li key={`${from}:${to}`}>
                {labels.get(from)} <span aria-label="leads to">→</span> {labels.get(to)}
                {label && ` (${label})`}
              </li>
            ))}
          </ul>
        ) : (
          <ul>
            {visual.nodes.map(({ id, label }) => (
              <li key={id}>{label}</li>
            ))}
          </ul>
        )}
      </details>
    </>
  );
}
