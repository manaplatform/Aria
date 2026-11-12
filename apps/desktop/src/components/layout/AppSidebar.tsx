import { useRef, useState } from 'react';
import { PanelLeftClose, Plus, Search, Settings, UserRound } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { AriaMark } from './AriaMark';
import { ConversationList } from '../conversations/ConversationList';
import { IconButton } from '../ui';

export function AppSidebar({
  compact,
  onNewChat,
  onSelect,
  onExpand,
  onCollapse,
}: {
  compact: boolean;
  onNewChat: () => void;
  onSelect: () => void;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const [query, setQuery] = useState('');
  const name = useWorkspaceStore((state) => state.data.preferences.profileName);
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const settings = () => {
    navigate('/settings');
    onSelect();
  };
  return (
    <aside
      className={`chat-sidebar ${compact ? 'compact' : ''}`}
      aria-label="Conversation navigation"
    >
      <div className="chat-brand">
        <AriaMark small />
        <span>Aria</span>
        {!compact && (
          <IconButton label="Collapse sidebar" onClick={onCollapse}>
            <PanelLeftClose size={17} />
          </IconButton>
        )}
      </div>
      <nav aria-label="Chat navigation">
        <button className="new-chat" aria-label="New chat" onClick={onNewChat}>
          <Plus size={18} />
          <span>New chat</span>
          <kbd>{window.aria?.platform === 'darwin' ? '⌘' : 'Ctrl'} ⇧ O</kbd>
        </button>
        {compact ? (
          <IconButton
            label="Search conversations"
            onClick={() => {
              onExpand();
              requestAnimationFrame(() => input.current?.focus());
            }}
          >
            <Search size={18} />
          </IconButton>
        ) : (
          <label className="conversation-search">
            <Search size={15} />
            <input
              ref={input}
              type="search"
              aria-label="Search conversations"
              placeholder="Search conversations"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        )}
      </nav>
      {!compact && (
        <ConversationList
          query={query}
          onSelect={() => {
            navigate('/chat');
            onSelect();
          }}
        />
      )}
      <div className="chat-sidebar-footer">
        <button className="sidebar-settings" aria-label="Open settings" onClick={settings}>
          <Settings size={18} />
          <span>Settings</span>
        </button>
        <button className="local-profile" aria-label="Local profile settings" onClick={settings}>
          <span className="local-avatar">
            <UserRound size={17} />
          </span>
          <span>
            <strong>{name}</strong>
            <small>Local profile</small>
          </span>
        </button>
      </div>
    </aside>
  );
}
