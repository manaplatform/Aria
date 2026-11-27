import { Cloud, CloudRain, Sun, Wind } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PresentationNode } from '@aria/shared';

type Node = Extract<PresentationNode, { type: 'weather' }>;
type Forecast = Extract<NonNullable<Node['data']>, { provider: string }>;
const axisStyle = {
  tick: { fill: 'var(--muted)' },
  axisLine: { stroke: 'var(--border-strong)' },
  tickLine: false,
};
const timeAxis = {
  ...axisStyle,
  dataKey: 'label',
  minTickGap: 20,
  interval: 'preserveStartEnd' as const,
};
const chartMargin = { left: 2, right: 12, top: 8 };
const tooltipStyle = {
  backgroundColor: 'var(--surface-raised)',
  borderColor: 'var(--border)',
  borderRadius: 8,
  color: 'var(--foreground)',
};
const number = (value: number | null) =>
  value === null
    ? '—'
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
function WeatherConditionIcon({ condition }: { condition: string | null }) {
  const Icon =
    condition?.startsWith('clear') || condition?.startsWith('fair')
      ? Sun
      : condition?.includes('rain') || condition?.includes('sleet')
        ? CloudRain
        : Cloud;
  return <Icon size={22} aria-hidden="true" />;
}
function CurrentWeather({ forecast }: { forecast: Forecast }) {
  const current = forecast.current;
  if (!current) return null;
  return (
    <div className="weather-current">
      <WeatherConditionIcon condition={current.condition} />
      <strong>
        {number(current.temperature)}°{forecast.units.temperature === 'celsius' ? 'C' : 'F'}
      </strong>
      <span>{current.condition?.replaceAll('_', ' ') ?? 'Condition unavailable'}</span>
      <span>
        <Wind size={16} aria-hidden="true" /> {number(current.windSpeed)} {forecast.units.wind}
        {current.windDirection !== null && <> · from {number(current.windDirection)}°</>}
      </span>
      <span>Estimated forecast</span>
    </div>
  );
}
function HourlyForecast({ forecast }: { forecast: Forecast }) {
  if (!forecast.hourly?.length) return null;
  const format = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: forecast.location.timezone,
  });
  const data = forecast.hourly
    .slice(0, 24)
    .map((entry) => ({ ...entry, label: format.format(new Date(entry.time)) }));
  const temperatureUnit = forecast.units.temperature === 'celsius' ? '°C' : '°F';
  const hasTemperature = data.some((entry) => entry.temperature !== null);
  const hasPrecipitationData = data.some((entry) => entry.precipitationAmount !== null);
  const hasPrecipitation = data.some(
    (entry) => entry.precipitationAmount !== null && entry.precipitationAmount !== 0,
  );
  return (
    <section aria-label="Hourly forecast">
      <h5>Hourly forecast</h5>
      {hasTemperature ? (
        <figure className="weather-chart" aria-label="Hourly forecast temperature chart">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={data} margin={chartMargin}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis {...timeAxis} />
              <YAxis {...axisStyle} width="auto" domain={['auto', 'auto']} unit={temperatureUnit} />
              <Tooltip isAnimationActive={false} contentStyle={tooltipStyle} />
              <Line
                type="monotone"
                dataKey="temperature"
                name="Temperature"
                unit={temperatureUnit}
                stroke="var(--reply-chart-1)"
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </figure>
      ) : (
        <p>Hourly temperatures unavailable.</p>
      )}
      <div className="weather-hourly">
        {data.map((entry) => (
          <div key={entry.time}>
            <time dateTime={entry.time}>{entry.label}</time>
            <WeatherConditionIcon condition={entry.condition} />
            <strong>{number(entry.temperature)}°</strong>
            <span>
              {entry.precipitationAmount === null ? '—' : `${number(entry.precipitationAmount)} mm`}
            </span>
          </div>
        ))}
      </div>
      {hasPrecipitationData && (
        <>
          <h6>Hourly precipitation</h6>
          {hasPrecipitation ? (
            <figure className="weather-chart" aria-label="Hourly precipitation chart">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={data} margin={chartMargin}>
                  <CartesianGrid vertical={false} stroke="var(--border)" />
                  <XAxis {...timeAxis} />
                  <YAxis {...axisStyle} width="auto" unit=" mm" />
                  <Tooltip isAnimationActive={false} contentStyle={tooltipStyle} />
                  <Bar
                    dataKey="precipitationAmount"
                    name="Precipitation"
                    unit=" mm"
                    fill="var(--reply-chart-2)"
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </figure>
          ) : (
            <p>
              {data.every((entry) => entry.precipitationAmount === 0)
                ? '0 mm forecast for all shown hours.'
                : '0 mm forecast for hours with precipitation data.'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
function DailyForecast({ forecast }: { forecast: Forecast }) {
  if (!forecast.daily?.length) return null;
  return (
    <section aria-label="Daily forecast">
      <h5>Daily forecast</h5>
      <div className="weather-daily">
        {forecast.daily.map((day) => (
          <div key={day.date}>
            <time dateTime={day.date}>{day.date}</time>
            <span>
              {number(day.minimumTemperature)}° / {number(day.maximumTemperature)}°
            </span>
            {day.partial && <small>Partial day</small>}
          </div>
        ))}
      </div>
    </section>
  );
}
function ForecastCard({ forecast, view }: { forecast: Forecast; view: Node['view'] }) {
  return (
    <article className="weather-card">
      <h4>{forecast.location.name}</h4>
      <p>{forecast.location.timezone}</p>
      {view !== 'hourly' && view !== 'daily' && <CurrentWeather forecast={forecast} />}
      {(view === 'hourly' || view === 'forecast') && <HourlyForecast forecast={forecast} />}
      {(view === 'daily' || view === 'forecast') && <DailyForecast forecast={forecast} />}
      <small>
        {forecast.provider}. {forecast.attribution} Retrieved{' '}
        {new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: forecast.location.timezone,
        }).format(new Date(forecast.retrievedAt))}
        .
      </small>
    </article>
  );
}
export default function WeatherCard({ node }: { node: Node }) {
  const data = node.data;
  if (!data) return null;
  if ('provider' in data) return <ForecastCard forecast={data} view={node.view} />;
  if ('results' in data)
    return (
      <div className="weather-comparison" aria-label={node.label ?? 'Weather comparison'}>
        {data.results.map((item, index) =>
          'provider' in item ? (
            <ForecastCard
              key={`${item.location.latitude}:${item.location.longitude}`}
              forecast={item}
              view="current"
            />
          ) : (
            <p key={index}>Location clarification required.</p>
          ),
        )}
      </div>
    );
  return null;
}
