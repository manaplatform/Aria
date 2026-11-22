import { useEffect, useState } from 'react';
import type { ComputerAction, ComputerSessionSummary, ComputerSupervision } from '@aria/shared';
import { setBrowserMode } from '../../stores/browserStore';
import { notify } from '../../stores/uiStore';
import { errorMessage } from '../../services/desktop';
import { Button } from '../ui';

const closed = new Set(['completed', 'cancelled', 'failed', 'expired']);

export function ComputerPanel({ conversationId }: { conversationId: string }) {
  const [session, setSession] = useState<ComputerSessionSummary>();
  const [preview, setPreview] = useState<string>();
  const [expanded, setExpanded] = useState(true);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const bridge = window.aria;
    if (!bridge?.computerSessions) return;
    let current = true;
    let revision = 0;
    const update = (state?: ComputerSessionSummary) => {
      const token = ++revision;
      setSession(state && !closed.has(state.status) ? state : undefined);
      if (!state || closed.has(state.status) || state.status === 'waiting-for-user') {
        setPreview(undefined);
        return;
      }
      void bridge
        .computerPreview(conversationId, state.id)
        .then((frame) => {
          if (current && token === revision) setPreview(frame);
        })
        .catch(() => undefined);
    };
    const unsubscribe = bridge.onComputerSession((state) => {
      if (state.conversationId === conversationId) update(state);
    });
    void bridge
      .computerSessions(conversationId)
      .then((states) => {
        if (current && !revision) update(states.find((state) => !closed.has(state.status)));
      })
      .catch(() => undefined);
    return () => {
      current = false;
      unsubscribe();
    };
  }, [conversationId]);
  const interactive =
    session?.status === 'waiting-for-user' && session.environment === 'virtual-desktop';
  const sessionId = session?.id;
  useEffect(() => {
    if (!interactive || !sessionId) return;
    let mounted = true;
    let active = false;
    const update = async () => {
      if (active) return;
      active = true;
      try {
        const frame = await window.aria?.computerPreview(conversationId, sessionId);
        if (mounted && frame) setPreview(frame);
      } catch {
        /* Retry the local preview on its next tick. */
      } finally {
        active = false;
      }
    };
    void update();
    const timer = window.setInterval(() => void update(), 600);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      setPreview(undefined);
    };
  }, [conversationId, interactive, sessionId]);
  if (!session) return null;
  const command = async (action: ComputerSupervision['action']) => {
    setPending(true);
    try {
      if (
        (action === 'take-control' || action === 'private-auth') &&
        session.environment === 'managed-browser'
      )
        setBrowserMode('split');
      await window.aria?.superviseComputer(conversationId, { sessionId: session.id, action });
    } catch (error) {
      notify(errorMessage(error), true);
    } finally {
      setPending(false);
    }
  };
  const user = session.status === 'waiting-for-user';
  const paused = session.status === 'paused';
  const sendInput = (action: ComputerAction) => {
    if (!interactive) return;
    void window.aria
      ?.sendComputerInput(conversationId, session.id, action)
      .catch((error) => notify(errorMessage(error), true));
  };
  return (
    <section className="computer-panel" aria-label="Computer Use">
      <div className="row computer-panel-toolbar">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          Computer Use
        </Button>
        <span role="status">
          {session.operation ?? (user ? 'You have control' : session.status.replaceAll('-', ' '))}
        </span>
        <div className="row computer-panel-actions">
          {!user && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => void command(paused ? 'resume' : 'pause')}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void command(user ? 'return-control' : 'take-control')}
          >
            {user ? 'Return control' : 'Take control'}
          </Button>
          {!user && session.environment === 'managed-browser' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => void command('private-auth')}
            >
              Private sign-in
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => void command('stop')}>
            Stop
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => void command('close')}
          >
            Close
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="computer-panel-body">
          {preview && (
            <img
              src={preview}
              alt="Latest authorized computer observation"
              tabIndex={interactive ? 0 : undefined}
              onClick={(event) => {
                if (!interactive) return;
                event.currentTarget.focus();
                const bounds = event.currentTarget.getBoundingClientRect();
                sendInput({
                  type: 'click',
                  button: 'left',
                  x: Math.floor(((event.clientX - bounds.left) * 1024) / bounds.width),
                  y: Math.floor(((event.clientY - bounds.top) * 768) / bounds.height),
                });
              }}
              onKeyDown={(event) => {
                if (!interactive || event.key === 'Tab') return;
                event.preventDefault();
                const keys = [
                  event.ctrlKey && 'Control',
                  event.shiftKey && 'Shift',
                  event.altKey && 'Alt',
                  event.metaKey && 'Meta',
                ]
                  .filter((key): key is string => !!key)
                  .slice(0, 3);
                if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
                  sendInput({ type: 'type', text: event.key });
                else sendInput({ type: 'keypress', keys: [...keys, event.key] });
              }}
            />
          )}
          {!!session.history.length && (
            <details>
              <summary>Action history</summary>
              <ul>
                {session.history.map((event, index) => (
                  <li key={`${event.at}-${index}`}>
                    {event.action.replaceAll('_', ' ')} · {event.outcome}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
