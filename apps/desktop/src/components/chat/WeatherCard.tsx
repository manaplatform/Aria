import { Cloud, CloudRain, Sun, Wind } from 'lucide-react';
import {
  Bar,
  BarChart,
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
  return (
    <section aria-label="Hourly forecast">
      <h5>Hourly forecast</h5>
      <div className="weather-chart" role="img" aria-label="Hourly forecast temperature chart">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="label" minTickGap={25} />
            <YAxis width={36} />
            <Tooltip />
            <Line
              type="monotone"
              dataKey="temperature"
              stroke="var(--reply-chart-1)"
              dot={false}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
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
      {data.some((entry) => entry.precipitationAmount !== null) && (
        <div className="weather-chart" role="img" aria-label="Hourly precipitation chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data}>
              <XAxis dataKey="label" minTickGap={25} />
              <YAxis width={36} />
              <Tooltip />
              <Bar dataKey="precipitationAmount" fill="var(--reply-chart-2)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
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
