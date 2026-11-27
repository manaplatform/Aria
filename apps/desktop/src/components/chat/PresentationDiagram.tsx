import { useId, useMemo, useState } from 'react';
import {
  diagramLabel,
  diagramNodeHeight,
  diagramNodeWidth,
  layoutPresentationDiagram,
  type PresentationDiagram,
} from '../../../electron/presentation-diagram';
import { Button } from '../ui';

export default function Diagram({ diagram }: { diagram: PresentationDiagram }) {
  const arrow = useId();
  const description = useId();
  const [zoom, setZoom] = useState(1);
  const drawing = useMemo(() => layoutPresentationDiagram(diagram), [diagram]);
  const labels = new Map(diagram.nodes.map(({ id, label }) => [id, label]));
  return (
    <>
      <div className="persona-controls" aria-label="Diagram zoom">
        <Button
          size="sm"
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
          aria-label="Zoom out"
        >
          −
        </Button>
        <Button size="sm" onClick={() => setZoom(1)} aria-label="Reset zoom">
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          size="sm"
          onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
          aria-label="Zoom in"
        >
          +
        </Button>
      </div>
      <div
        className="persona-diagram-scroll"
        role="region"
        tabIndex={0}
        aria-label={diagram.label + ' · scroll to pan'}
      >
        <svg
          role="img"
          aria-label={diagram.label}
          aria-describedby={description}
          viewBox={'0 0 ' + drawing.width + ' ' + drawing.height}
          style={{
            width: zoom * drawing.width,
            maxWidth: zoom <= 1 ? '100%' : undefined,
            height: 'auto',
          }}
        >
          <desc id={description}>{diagram.description}</desc>
          <defs>
            <marker id={arrow} markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto">
              <path d="M0 0 L8 4 L0 8Z" fill="currentColor" />
            </marker>
          </defs>
          {drawing.groups.map(({ label, left, top, width, height }) => (
            <g key={label}>
              <rect
                className="persona-diagram-group"
                x={left}
                y={top}
                width={width}
                height={height}
                rx="8"
              />
              <text x={left + 8} y={top + 16} fill="currentColor">
                {label}
              </text>
            </g>
          ))}
          {drawing.lifelines.map(({ x, top, bottom }) => (
            <line
              key={x}
              x1={x}
              x2={x}
              y1={top}
              y2={bottom}
              stroke="currentColor"
              strokeDasharray="4 4"
            />
          ))}
          {drawing.links.map(({ from, to, label, points, x, y }, index) => (
            <g key={from + ':' + to + ':' + index}>
              <polyline
                points={points.map(({ x, y }) => x + ',' + y).join(' ')}
                fill="none"
                stroke="currentColor"
                markerEnd={'url(#' + arrow + ')'}
              />
              {label && x !== undefined && y !== undefined && (
                <text x={x} y={y - 6} fill="currentColor" textAnchor="middle">
                  {label}
                </text>
              )}
            </g>
          ))}
          {drawing.nodes.map(({ id, x, y, label, icon }) => (
            <g key={id}>
              <rect
                className="persona-diagram-node"
                x={x - diagramNodeWidth / 2}
                y={y - diagramNodeHeight / 2}
                width={diagramNodeWidth}
                height={diagramNodeHeight}
                rx="8"
              />
              {icon && (
                <circle cx={x - diagramNodeWidth / 2 + 12} cy={y} r={3} fill="currentColor" />
              )}
              {diagramLabel(label).map((line, index, lines) => (
                <text
                  key={index}
                  x={x}
                  y={y + 5 + (index - (lines.length - 1) / 2) * 16}
                  textAnchor="middle"
                  fill="currentColor"
                  style={{ unicodeBidi: 'plaintext' }}
                >
                  {line}
                </text>
              ))}
            </g>
          ))}
        </svg>
      </div>
      <details>
        <summary>Description and connections</summary>
        <p>{diagram.description}</p>
        <ul>
          {(diagram.edges.length
            ? diagram.edges.map(
                ({ from, to, label }) =>
                  labels.get(from) + ' → ' + labels.get(to) + (label ? ' · ' + label : ''),
              )
            : diagram.nodes.map(({ label }) => label)
          ).map((description, index) => (
            <li key={index}>{description}</li>
          ))}
        </ul>
      </details>
    </>
  );
}
