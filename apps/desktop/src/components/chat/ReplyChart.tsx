import type { ReplyVisual } from '@aria/shared';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type Chart = Exclude<ReplyVisual, { type: 'flowchart' }>;
type SeriesChart = Exclude<Chart, { type: 'pie' | 'scatter' }>;
type ScatterVisual = Extract<Chart, { type: 'scatter' }>;
type PieVisual = Extract<Chart, { type: 'pie' }>;

const color = (index: number) => `var(--reply-chart-${(index % 12) + 1})`;
const seriesKey = (index: number) => `series${index}`;
const dashed = [undefined, '6 3', '2 3', '8 3 2 3'];
const shapes = ['circle', 'diamond', 'square', 'triangle'] as const;
const axisStyle = {
  tick: { fill: 'var(--muted)' },
  axisLine: { stroke: 'var(--border-strong)' },
  tickLine: false,
};
const normalTick = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumSignificantDigits: 5,
});
const scientificTick = new Intl.NumberFormat(undefined, {
  notation: 'scientific',
  maximumSignificantDigits: 4,
});

function numberTick(value: number) {
  const magnitude = Math.abs(value);
  return (
    magnitude >= 1e15 || (magnitude > 0 && magnitude < 0.001) ? scientificTick : normalTick
  ).format(value);
}

function PlotTooltip() {
  return (
    <Tooltip
      isAnimationActive={false}
      contentStyle={{
        backgroundColor: 'var(--surface-raised)',
        borderColor: 'var(--border)',
        borderRadius: 8,
      }}
      labelStyle={{ color: 'var(--foreground)' }}
      itemStyle={{ color: 'var(--foreground)' }}
    />
  );
}

function CategoryChart({ visual }: { visual: SeriesChart }) {
  const data = visual.categories.map((label, row) => ({
    label,
    ...Object.fromEntries(
      visual.series.map(({ values }, index) => [seriesKey(index), values[row]]),
    ),
  }));
  return (
    <ComposedChart data={data} title={visual.title} margin={{ left: 2, right: 12, top: 8 }}>
      <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 4" />
      <XAxis
        {...axisStyle}
        dataKey="label"
        tickMargin={8}
        minTickGap={20}
        tickFormatter={(value: string) => (value.length > 16 ? `${value.slice(0, 15)}…` : value)}
      />
      <YAxis {...axisStyle} width="auto" tickMargin={7} tickFormatter={numberTick} />
      <ReferenceLine y={0} stroke="var(--subtle)" />
      <PlotTooltip />
      {visual.series.map(({ name }, index) => {
        const common = { name, dataKey: seriesKey(index), isAnimationActive: false };
        if (visual.type === 'bar')
          return <Bar key={common.dataKey} {...common} fill={color(index)} maxBarSize={46} />;
        if (visual.type === 'area')
          return (
            <Area
              key={common.dataKey}
              {...common}
              stroke={color(index)}
              fill={color(index)}
              strokeWidth={2}
              strokeDasharray={dashed[index]}
              fillOpacity={0.15}
              dot={{ r: 2 }}
            />
          );
        return (
          <Line
            key={common.dataKey}
            {...common}
            stroke={color(index)}
            strokeWidth={2}
            strokeDasharray={dashed[index]}
            dot={{ r: 2 }}
          />
        );
      })}
    </ComposedChart>
  );
}

function XYChart({ visual }: { visual: ScatterVisual }) {
  return (
    <ScatterChart title={visual.title} margin={{ left: 2, right: 14, top: 8 }}>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 4" />
      <XAxis
        {...axisStyle}
        type="number"
        dataKey="x"
        name={visual.xLabel ?? 'X'}
        tickFormatter={numberTick}
        domain={['auto', 'auto']}
      />
      <YAxis
        {...axisStyle}
        type="number"
        dataKey="y"
        name={visual.yLabel ?? 'Y'}
        width="auto"
        tickFormatter={numberTick}
        domain={['auto', 'auto']}
      />
      <PlotTooltip />
      {visual.series.map(({ name, points }, index) => (
        <Scatter
          key={seriesKey(index)}
          name={name}
          fill={color(index)}
          shape={shapes[index]}
          data={points.map(([x, y]) => ({ x, y }))}
          isAnimationActive={false}
        />
      ))}
    </ScatterChart>
  );
}

function RingChart({ visual }: { visual: PieVisual }) {
  const data = visual.categories.map((label, index) => ({
    label,
    value: visual.series[0].values[index],
    fill: color(index),
  }));
  return (
    <PieChart title={visual.title}>
      <Pie
        data={data}
        nameKey="label"
        dataKey="value"
        name={visual.series[0].name}
        innerRadius="53%"
        outerRadius="86%"
        stroke="var(--surface)"
        isAnimationActive={false}
      />
      <PlotTooltip />
    </PieChart>
  );
}

function ChartData({ visual }: { visual: Chart }) {
  const scatter = visual.type === 'scatter';
  const columns = scatter
    ? ['Series', visual.xLabel ?? 'X', visual.yLabel ?? 'Y']
    : [
        visual.type === 'pie' ? 'Category' : (visual.xLabel ?? 'Category'),
        ...visual.series.map(({ name }) => name),
      ];
  const rows = scatter
    ? visual.series.flatMap(({ name, points }) => points.map(([x, y]) => [name, x, y]))
    : visual.categories.map((label, index) => [
        label,
        ...visual.series.map(({ values }) => values[index]),
      ]);
  return (
    <details className="reply-visual-details">
      <summary>Show data</summary>
      <div className="reply-table-scroll">
        <table aria-label={`${visual.title} data`}>
          <thead>
            <tr>
              {columns.map((label, index) => (
                <th key={index} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, ...values], index) => (
              <tr key={index}>
                <th scope="row">{label}</th>
                {values.map((value, column) => (
                  <td key={column}>{value ?? '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export default function ReplyChart({ visual }: { visual: Chart }) {
  const pie = visual.type === 'pie';
  const labels = pie ? visual.categories : visual.series.map(({ name }) => name);
  return (
    <>
      {!pie && visual.yLabel && <div className="reply-chart-axis">{visual.yLabel}</div>}
      <div className="reply-chart-plot">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {pie ? (
            <RingChart visual={visual} />
          ) : visual.type === 'scatter' ? (
            <XYChart visual={visual} />
          ) : (
            <CategoryChart visual={visual} />
          )}
        </ResponsiveContainer>
      </div>
      {!pie && visual.xLabel && (
        <div className="reply-chart-axis reply-chart-axis-x">{visual.xLabel}</div>
      )}
      <ul className="reply-chart-legend" aria-label={pie ? 'Categories' : 'Series'}>
        {labels.map((label, index) => (
          <li key={index}>
            <span
              className="reply-chart-marker"
              style={{ backgroundColor: color(index) }}
              aria-hidden="true"
            />
            {label}
          </li>
        ))}
      </ul>
      <ChartData visual={visual} />
    </>
  );
}
