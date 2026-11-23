import { useEffect, useState } from 'react';
import { useLocation, useNavigate, Outlet } from 'react-router-dom';
import { Globe2, PanelLeftOpen, Search, Sparkles, VolumeX } from 'lucide-react';
import { useWorkspaceStore, flushPersistence } from '../../stores/workspaceStore';
import { selectChat, useChatStore } from '../../stores/chatStore';
import { AppSidebar } from './AppSidebar';
import { BrowserPane, useBrowserSlot } from '../browser/BrowserPane';
import { ComputerPanel } from '../browser/ComputerPanel';
import {
  browserCommand,
  connectBrowser,
  setBrowserMode,
  useBrowserStore,
} from '../../stores/browserStore';
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
  const browserMode = useBrowserStore((state) => state.mode);
  const playing = useBrowserStore((state) => state.state.tabs.find((tab) => tab.playingMedia));
  const conversation = chat.conversations.find((item) => item.id === chat.selectedId);
  const showBrowser = browserMode !== 'chat' && location.pathname === '/chat' && !conversation?.temporary;
  const slot = useBrowserSlot(chat.selectedId, showBrowser && !drawer);
  useEffect(connectBrowser, []);
  const newChat = () => {
    selectChat(null);
    navigate('/chat');
    if (useBrowserStore.getState().mode === 'browser') setBrowserMode('split');
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
        if (useBrowserStore.getState().mode === 'browser') setBrowserMode('split');
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
            {playing && (
              <IconButton
                label="Stop browser playback"
                onClick={() => void browserCommand({ kind: 'stop-media', tabId: playing.id })}
              >
                <VolumeX size={17} />
              </IconButton>
            )}
            {location.pathname === '/chat' && window.aria?.browserLayout && (
              <div
                className="browser-mode-controls"
                role="group"
                aria-label="Chat and browser layout"
              >
                {(['chat', 'split', 'browser'] as const).map((mode) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    key={mode}
                    aria-pressed={browserMode === mode}
                    onClick={() => setBrowserMode(mode)}
                  >
                    {mode === 'browser' && <Globe2 size={14} />}
                    {mode === 'chat' ? 'Chat' : mode === 'split' ? 'Split' : 'Browser'}
                  </Button>
                ))}
              </div>
            )}
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
        {location.pathname === '/chat' && chat.selectedId && (
          <ComputerPanel key={chat.selectedId} conversationId={chat.selectedId} />
        )}
        <div className={`chat-browser-workspace ${showBrowser ? browserMode : 'chat'}`}>
          <div className="chat-outlet" hidden={showBrowser && browserMode === 'browser'}>
            <Outlet />
          </div>
          {showBrowser && <BrowserPane slot={slot} />}
        </div>
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
