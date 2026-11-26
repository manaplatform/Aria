import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button } from '../ui';
import { commandId, dateLabel, ProactivePage, targetRoute, useProactive } from './runtime';

export default function NotificationCenter() {
  const [offset, setOffset] = useState(0);
  const view = useProactive({ action: 'snapshot', offset });
  const notifications = view.result?.value.notifications;
  return (
    <ProactivePage title="Notifications" error={view.error} loading={!view.result}>
      {notifications?.map((note) => (
        <article className="proactive-card" key={note.id}>
          <div className="proactive-controls">
            <strong>{note.category}</strong>
            {!note.read && <Badge>Unread</Badge>}
            <small>{dateLabel(note.created)}</small>
          </div>
          {note.message !== note.category && <p className="proactive-content">{note.message}</p>}
          <div className="proactive-controls">
            {note.targetId && (
              <Link to={targetRoute({ kind: note.targetKind, id: note.targetId })}>
                View responsibility
              </Link>
            )}
            {!note.targetId && <Link to="/agenda">Review in Agenda</Link>}
            {!note.read && (
              <Button
                onClick={() =>
                  void view.act({
                    action: 'notification_read',
                    id: note.id,
                    commandId: commandId(),
                  })
                }
              >
                Mark read
              </Button>
            )}
          </div>
        </article>
      ))}
      {notifications?.length === 0 && <p>No notifications on this page.</p>}
      <div className="proactive-controls">
        {offset > 0 && <Button onClick={() => setOffset(offset - 20)}>Previous</Button>}
        {notifications?.length === 20 && (
          <Button onClick={() => setOffset(offset + 20)}>Next</Button>
        )}
      </div>
    </ProactivePage>
  );
}
