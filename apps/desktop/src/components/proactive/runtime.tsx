import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProactiveCommand, ProactiveEvent, ProactiveResult } from '@aria/shared';
import { Link } from 'react-router-dom';
import { desktop, errorMessage } from '../../services/desktop';
import { ErrorState, Skeleton } from '../ui';

export const dateLabel = (at: number | null) => (at === null ? '—' : new Date(at).toLocaleString());
export const statusLabel = (state: string) => state.replaceAll('_', ' ');
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const commandId = () => crypto.randomUUID();
export const ref = (row: { id: string; revision: number }) => ({
  id: row.id,
  revision: row.revision,
  commandId: commandId(),
});

export function targetRoute(target: NonNullable<ProactiveEvent['target']>) {
  return (
    (target.kind === 'automation'
      ? '/automations/'
      : target.kind === 'job'
        ? '/agenda/jobs/'
        : '/agenda/tasks/') + target.id
  );
}

export function useProactive<T extends 'snapshot' | 'detail'>(
  query: Extract<ProactiveCommand, { action: T }>,
) {
  const serialized = JSON.stringify(query);
  const [result, setResult] = useState<Extract<ProactiveResult, { kind: T }>>();
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const request = useRef(0);
  const reload = useCallback(async () => {
    const current = ++request.current;
    try {
      const response = await desktop().proactive(JSON.parse(serialized) as ProactiveCommand);
      if (current !== request.current) return;
      if (response.kind === 'error') throw new Error(response.message);
      setResult(response as Extract<ProactiveResult, { kind: T }>);
    } catch (error) {
      if (current === request.current) setError(errorMessage(error));
    }
  }, [serialized]);
  const cancelPending = useCallback(() => {
    request.current++;
  }, []);
  useEffect(() => {
    void reload();
    const unsubscribe = window.aria?.onProactiveEvent?.(() => void reload());
    return () => {
      cancelPending();
      unsubscribe?.();
    };
  }, [cancelPending, reload]);
  const act = async (command: ProactiveCommand) => {
    setError('');
    setRunning(true);
    try {
      const value = await desktop().proactive(command);
      if (value.kind === 'error') throw new Error(value.message);
      if (value.kind === 'accepted') await reload();
      return value;
    } catch (error) {
      setError(errorMessage(error));
      return undefined;
    } finally {
      setRunning(false);
    }
  };
  return { result, error, running, act, reload };
}

export function ProactivePage({
  title,
  actions,
  error,
  loading,
  children,
}: {
  title: string;
  actions?: ReactNode;
  error?: string;
  loading?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="page-scroll">
      <div className="work-page proactive-page">
        <header className="page-heading">
          <h1>{title}</h1>
          {actions}
        </header>
        {error && <ErrorState message={error} />}
        {loading && !error ? <Skeleton /> : children}
      </div>
    </div>
  );
}

export function JobLink({
  job,
}: {
  job: { id: string; state: string; due: number; reason: string | null };
}) {
  return (
    <Link className="proactive-row" to={'/agenda/jobs/' + job.id}>
      <strong>{statusLabel(job.state)}</strong>
      <span>{dateLabel(job.due)}</span>
      {job.reason && <small>{job.reason}</small>}
    </Link>
  );
}
