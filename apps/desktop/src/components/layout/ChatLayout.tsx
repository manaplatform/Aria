import { useEffect, useState } from 'react';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { PanelLeftOpen, Search, Sparkles } from 'lucide-react';
import { useWorkspaceStore, flushPersistence } from '../../stores/workspaceStore';
import { selectChat, useChatStore } from '../../stores/chatStore';
import { AppSidebar } from './AppSidebar';
import { Button, ErrorState, IconButton, Modal, Toast } from '../ui';

export default function ChatLayout() {
  const chat = useWorkspaceStore((state) => state.data.chat);
  const collapsed = useWorkspaceStore((state) => state.data.preferences.chatSidebarCollapsed);
  const preferences = useWorkspaceStore((state) => state.preferences);
  const saveError = useWorkspaceStore((state) => state.saveError);
  const status = useChatStore((state) => state.status);
  const [narrow, setNarrow] = useState(window.innerWidth < 900);
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const conversation = chat.conversations.find((item) => item.id === chat.selectedId);
  const newChat = () => {
    selectChat(null);
    navigate('/chat');
    setDrawer(false);
    requestAnimationFrame(() => window.dispatchEvent(new Event('aria:focus-chat')));
  };
  useEffect(() => {
    const resize = () => {
      setNarrow(window.innerWidth < 900);
      if (window.innerWidth >= 900) setDrawer(false);
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        selectChat(null);
        navigate('/chat');
        setDrawer(false);
        requestAnimationFrame(() => window.dispatchEvent(new Event('aria:focus-chat')));
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (window.innerWidth < 900) setDrawer(true);
        else preferences({ chatSidebarCollapsed: false });
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>('.conversation-search input')?.focus(),
        );
      }
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        navigate('/chat');
        requestAnimationFrame(() => window.dispatchEvent(new Event('aria:focus-chat')));
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [navigate, preferences]);
  return (
    <div className={`chat-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      {!narrow && (
        <AppSidebar
          compact={collapsed}
          onNewChat={newChat}
          onSelect={() => setDrawer(false)}
          onExpand={() => preferences({ chatSidebarCollapsed: false })}
          onCollapse={() => preferences({ chatSidebarCollapsed: true })}
        />
      )}
      <main className="chat-main">
        <header className="chat-header">
          <div className="chat-header-title">
            {(narrow || collapsed) && (
              <IconButton
                label="Open sidebar"
                onClick={() =>
                  narrow ? setDrawer(true) : preferences({ chatSidebarCollapsed: false })
                }
              >
                <PanelLeftOpen size={18} />
              </IconButton>
            )}
            <span title={conversation?.title}>
              {location.pathname === '/settings'
                ? 'Settings'
                : conversation?.title || 'New conversation'}
            </span>
          </div>
          <div className="row">
            <IconButton
              label="Find a conversation"
              onClick={() => {
                if (narrow) setDrawer(true);
                else preferences({ chatSidebarCollapsed: false });
                requestAnimationFrame(() =>
                  document.querySelector<HTMLInputElement>('.conversation-search input')?.focus(),
                );
              }}
            >
              <Search size={17} />
            </IconButton>
            <Button variant="ghost" className="model-label" onClick={() => navigate('/settings')}>
              <Sparkles size={14} />
              {status.configured ? status.model : 'Connect a model'}
            </Button>
          </div>
        </header>
        {saveError && (
          <ErrorState
            message={`Changes could not be saved: ${saveError}`}
            retry={() => void flushPersistence()}
          />
        )}
        <Outlet />
      </main>
      <Modal
        open={narrow && drawer}
        onOpenChange={setDrawer}
        title="Conversations"
        description="Your conversations, search, and settings."
        className="conversation-drawer"
        onOpenAutoFocus={(event) => {
          const input = document.querySelector<HTMLInputElement>(
            '.conversation-drawer .conversation-search input',
          );
          if (input) {
            event.preventDefault();
            input.focus();
          }
        }}
      >
        <AppSidebar
          compact={false}
          onNewChat={newChat}
          onSelect={() => setDrawer(false)}
          onExpand={() => undefined}
          onCollapse={() => setDrawer(false)}
        />
      </Modal>
      <Toast />
    </div>
  );
}
