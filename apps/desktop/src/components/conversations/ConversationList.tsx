import { useState } from 'react';
import { Ellipsis, MessageCircle, Pencil, Pin, Trash2 } from 'lucide-react';
import type { ChatConversation } from '@aria/shared';
import { useConversations } from '../../hooks/useConversations';
import { deleteChat, pinChat, renameChat, selectChat } from '../../stores/chatStore';
import { Button, Field, Menu, MenuItem, Modal } from '../ui';

export function ConversationList({ query, onSelect }: { query: string; onSelect: () => void }) {
  const { groups, selectedId, count } = useConversations(query);
  const [dialog, setDialog] = useState<{
    kind: 'rename' | 'delete';
    conversation: ChatConversation;
  } | null>(null);
  const [title, setTitle] = useState('');
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <div className="conversation-list" aria-label="Conversation history">
        {groups.map((group) => (
          <section key={group.title} className="conversation-group" aria-label={group.title}>
            <h2>{group.title}</h2>
            {group.conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`conversation-item ${conversation.id === selectedId ? 'selected' : ''}`}
              >
                <button
                  className="conversation-select"
                  aria-current={conversation.id === selectedId ? 'page' : undefined}
                  onClick={() => {
                    selectChat(conversation.id);
                    onSelect();
                  }}
                  title={conversation.title}
                >
                  <MessageCircle size={15} />
                  <span>{conversation.title}</span>
                  {conversation.pinned && <Pin size={11} className="conversation-pin" />}
                </button>
                <Menu label={`Options for ${conversation.title}`} trigger={<Ellipsis size={16} />}>
                  <MenuItem
                    onSelect={() => {
                      setTitle(conversation.title);
                      setDialog({ kind: 'rename', conversation });
                    }}
                  >
                    <Pencil size={14} />
                    Rename
                  </MenuItem>
                  <MenuItem onSelect={() => pinChat(conversation.id)}>
                    <Pin size={14} />
                    {conversation.pinned ? 'Unpin' : 'Pin conversation'}
                  </MenuItem>
                  <MenuItem onSelect={() => setDialog({ kind: 'delete', conversation })}>
                    <Trash2 size={14} />
                    Delete
                  </MenuItem>
                </Menu>
              </div>
            ))}
          </section>
        ))}
        {!groups.length && (
          <p className="history-empty">
            {query
              ? 'No conversations found.'
              : count
                ? 'No recent conversations.'
                : 'Your conversations will appear here.'}
          </p>
        )}
      </div>
      <Modal
        open={dialog?.kind === 'rename'}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        title="Rename conversation"
        description="Choose a name that makes this conversation easy to find."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (dialog && title.trim()) {
              renameChat(dialog.conversation.id, title);
              setDialog(null);
            }
          }}
        >
          <Field label="Conversation name">
            <input
              autoFocus
              value={title}
              maxLength={1000}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <div className="dialog-actions">
            <Button type="button" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!title.trim()}>
              Save name
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={dialog?.kind === 'delete'}
        onOpenChange={(open) => {
          if (!open && !deleting) setDialog(null);
        }}
        title="Delete conversation?"
        description={`“${dialog?.conversation.title ?? ''}” and its messages will be removed from this device. This cannot be undone.`}
      >
        <div className="dialog-actions">
          <Button disabled={deleting} onClick={() => setDialog(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={deleting}
            onClick={() => {
              if (!dialog) return;
              setDeleting(true);
              void deleteChat(dialog.conversation.id).finally(() => {
                setDeleting(false);
                setDialog(null);
              });
            }}
          >
            {deleting ? 'Deleting…' : 'Delete conversation'}
          </Button>
        </div>
      </Modal>
    </>
  );
}
