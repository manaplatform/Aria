import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  defaultDiagnosticConfig,
  diagnosticLevels,
  type DiagnosticConfig,
  type DiagnosticEvent,
  type DiagnosticFilter,
  type DiagnosticLevel,
  type DiagnosticStatus,
} from '@aria/shared';
import { desktop, errorMessage } from '../../../services/desktop';
import { Button } from '../../ui';
import { SettingsPage } from '../SettingsPage';
import { SettingsGroup, SettingsSection, SettingsSelect, SettingsToggle } from '../components';

export default function DiagnosticsSettings() {
  const [status, setStatus] = useState<DiagnosticStatus>();
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [filter, setFilter] = useState<DiagnosticFilter>({});
  const [cursor, setCursor] = useState<number>();
  const [paused, setPaused] = useState(false);
  const [timeline, setTimeline] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expanded, setExpanded] = useState<string>();
  const [component, setComponent] = useState('');
  const [executionIds, setExecutionIds] = useState('');
  const [componentLevel, setComponentLevel] = useState<DiagnosticLevel>('info');
  const [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const querySequence = useRef(0);
  const displayed = useMemo(
    () => (timeline ? [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) : events),
    [events, timeline],
  );
  const virtual = useVirtualizer({
    count: displayed.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey: (index) => displayed[index].id,
  });
  const refresh = useCallback(async () => {
    const sequence = ++querySequence.current;
    try {
      const [page, current] = await Promise.all([
        desktop().diagnosticQuery({ ...filter, limit: 200 }),
        desktop().diagnosticStatus(),
      ]);
      if (sequence !== querySequence.current) return;
      setEvents(page.events);
      setCursor(page.nextCursor);
      setStatus(current);
      setError('');
    } catch (failure) {
      if (sequence === querySequence.current) setError(errorMessage(failure));
    }
  }, [filter]);
  useEffect(() => {
    void desktop()
      .diagnosticStatus()
      .then(setStatus)
      .catch((failure) => setError(errorMessage(failure)));
  }, []);
  useEffect(() => {
    const sequence = querySequence;
    const timer = setTimeout(() => void refresh(), 200);
    return () => {
      clearTimeout(timer);
      sequence.current++;
    };
  }, [refresh]);
  useEffect(() => {
    if (paused) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = desktop().onDiagnosticEvents(() => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh();
          if (autoScroll) scroll.current?.scrollTo({ top: 0 });
        }, 500);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [paused, autoScroll, refresh]);
  const configure = async (config: DiagnosticConfig) => {
    try {
      setStatus(await desktop().diagnosticConfigure(config));
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const action = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setStatus(await desktop().diagnosticStatus());
      await refresh();
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };
  const config = status?.config;
  return (
    <SettingsPage
      title="Developer & Diagnostics"
      description="Inspect local, sanitized diagnostic events and execution timelines."
    >
      {error && <p role="alert">{error}</p>}
      {status?.error && (
        <p role="alert">Some diagnostic storage operations failed. Aria will continue to run.</p>
      )}
      {config && (
        <SettingsSection
          title="Logging"
          description={`Local logs use ${(status.bytes / 1_000_000).toFixed(1)} MB. Dropped events: ${status.dropped}.`}
        >
          <SettingsGroup>
            <SettingsToggle
              label="Enable debug logging"
              checked={config.debug}
              onChange={(debug) =>
                void configure({
                  ...config,
                  debug,
                  trace: debug && config.trace,
                  level: debug
                    ? 'debug'
                    : config.level === 'debug' || config.level === 'trace'
                      ? 'info'
                      : config.level,
                })
              }
            />
            <SettingsToggle
              label="Enable trace logging"
              checked={config.trace}
              onChange={(trace) =>
                void configure({
                  ...config,
                  trace,
                  debug: trace || config.debug,
                  level: trace ? 'trace' : config.level === 'trace' ? 'debug' : config.level,
                })
              }
            />
            <SettingsSelect
              label="Global log level"
              value={config.level}
              onChange={(level) =>
                void configure({
                  ...config,
                  level: level as DiagnosticLevel,
                  debug: level === 'debug' || level === 'trace' || config.debug,
                  trace: level === 'trace' || config.trace,
                })
              }
            >
              {diagnosticLevels.map((level) => (
                <option key={level} value={level}>
                  {level.toUpperCase()}
                </option>
              ))}
            </SettingsSelect>
          </SettingsGroup>
          <p>
            Retention:{' '}
            <input
              aria-label="Retention days"
              type="number"
              min="1"
              max="90"
              value={config.retentionDays}
              onChange={(e) => {
                const retentionDays = Number(e.target.value);
                if (retentionDays >= 1 && retentionDays <= 90)
                  void configure({ ...config, retentionDays });
              }}
            />{' '}
            days. Storage limit:{' '}
            <input
              aria-label="Storage limit in megabytes"
              type="number"
              min="1"
              max="1000"
              value={config.maxBytes / 1_000_000}
              onChange={(e) => {
                const maxBytes = Number(e.target.value) * 1_000_000;
                if (maxBytes >= 1_000_000 && maxBytes <= 1_000_000_000)
                  void configure({ ...config, maxBytes });
              }}
            />{' '}
            MB.
          </p>
          <div className="row">
            <input
              aria-label="Component name"
              placeholder="Component"
              value={component}
              onChange={(e) => setComponent(e.target.value)}
            />
            <select
              aria-label="Component level"
              value={componentLevel}
              onChange={(e) => setComponentLevel(e.target.value as DiagnosticLevel)}
            >
              {diagnosticLevels.map((level) => (
                <option key={level} value={level}>
                  {level.toUpperCase()}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={() => {
                if (/^[\w.:/-]{1,200}$/.test(component))
                  void configure({
                    ...config,
                    components: { ...config.components, [component]: componentLevel },
                  });
              }}
            >
              Set component level
            </Button>
          </div>
          <p>
            Overrides:{' '}
            {Object.keys(config.components).length
              ? Object.entries(config.components).map(([name, level]) => (
                  <span key={name}>
                    {name}: {level}{' '}
                    <button
                      aria-label={`Remove ${name} log level`}
                      onClick={() => {
                        const components = { ...config.components };
                        delete components[name];
                        void configure({ ...config, components });
                      }}
                    >
                      Remove
                    </button>{' '}
                  </span>
                ))
              : 'None'}
          </p>
          <div className="row">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void action(() => desktop().diagnosticOpenDirectory())}
            >
              Open logs directory
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void action(() => desktop().diagnosticClear())}
            >
              Clear logs
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void configure(structuredClone(defaultDiagnosticConfig))}
            >
              Restore defaults
            </Button>
          </div>
        </SettingsSection>
      )}
      <SettingsSection
        title="Live logs"
        description="Messages, tool content and credentials are excluded. Temporary chat events are kept only in memory."
      >
        <div className="row">
          <input
            aria-label="Search logs"
            placeholder="Search"
            value={filter.search ?? ''}
            onChange={(e) => setFilter({ ...filter, search: e.target.value || undefined })}
          />
          <input
            aria-label="Filter component"
            placeholder="Component"
            value={filter.component ?? ''}
            onChange={(e) => setFilter({ ...filter, component: e.target.value || undefined })}
          />
          <select
            aria-label="Filter level"
            value={filter.level ?? ''}
            onChange={(e) =>
              setFilter({ ...filter, level: (e.target.value as DiagnosticLevel) || undefined })
            }
          >
            <option value="">All levels</option>
            {diagnosticLevels.map((level) => (
              <option key={level} value={level}>
                {level.toUpperCase()} and above
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <input
            aria-label="Execution IDs"
            placeholder="Execution IDs, comma-separated"
            value={executionIds}
            onChange={(e) => {
              const raw = e.target.value;
              setExecutionIds(raw);
              const ids = raw
                .split(',')
                .map((id) => id.trim())
                .filter((id) => /^[\w.:/-]{1,200}$/.test(id));
              setFilter({ ...filter, executionIds: ids.length ? ids.slice(0, 100) : undefined });
            }}
          />
          <input
            aria-label="Correlation ID"
            placeholder="Correlation ID"
            value={filter.correlationId ?? ''}
            onChange={(e) => setFilter({ ...filter, correlationId: e.target.value || undefined })}
          />
          <label>
            From{' '}
            <input
              type="datetime-local"
              onChange={(e) =>
                setFilter({
                  ...filter,
                  from: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                })
              }
            />
          </label>
          <label>
            To{' '}
            <input
              type="datetime-local"
              onChange={(e) =>
                setFilter({
                  ...filter,
                  to: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                })
              }
            />
          </label>
        </div>
        <div className="row">
          <Button size="sm" variant="secondary" onClick={() => setPaused(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <label>
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />{' '}
            Auto-scroll
          </label>
          <Button size="sm" variant="secondary" onClick={() => setTimeline(!timeline)}>
            {timeline ? 'Show recent logs' : 'Show execution timeline'}
          </Button>
          <Button size="sm" onClick={() => void action(() => desktop().diagnosticExport(filter))}>
            Export filtered diagnostics
          </Button>
        </div>
        <div
          ref={scroll}
          style={{ height: 440, overflow: 'auto', border: '1px solid var(--border)' }}
          aria-label="Diagnostic event timeline"
        >
          <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
            {virtual.getVirtualItems().map((row) => {
              const entry = displayed[row.index];
              return (
                <div
                  key={entry.id}
                  data-index={row.index}
                  ref={virtual.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${row.start}px)`,
                    padding: 8,
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <button onClick={() => setExpanded(expanded === entry.id ? undefined : entry.id)}>
                    {entry.timestamp} · {entry.level.toUpperCase()} · {entry.component} ·{' '}
                    {entry.event}
                    {timeline && entry.context.operationId
                      ? ` · operation ${entry.context.operationId}`
                      : ''}
                    {timeline && entry.context.parentOperationId
                      ? ` · parent ${entry.context.parentOperationId}`
                      : ''}
                  </button>
                  {expanded === entry.id && (
                    <>
                      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {JSON.stringify(entry, null, 2)}
                      </pre>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void desktop().copy(JSON.stringify(entry, null, 2))}
                      >
                        Copy entry
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {cursor !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void desktop()
                .diagnosticQuery({ ...filter, cursor, limit: 200 })
                .then((page) => {
                  setEvents((items) => [...items, ...page.events].slice(0, 2000));
                  setCursor(page.nextCursor);
                })
                .catch((failure) => setError(errorMessage(failure)))
            }
          >
            Load older events
          </Button>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
