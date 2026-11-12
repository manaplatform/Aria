import { AriaMark } from './AriaMark';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  Bot,
  ChevronRight,
  CircleHelp,
  Code2,
  Command,
  FolderOpen,
  GitBranch,
  History,
  Home,
  Layers,
  ListTodo,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  Search,
  Settings,
  Sparkles,
  Terminal,
  BookOpen,
  RotateCcw,
  X,
} from 'lucide-react';
import { useWorkspace, useTasks } from '../../hooks/useWorkspace';
import { useWorkspaceStore, flushPersistence } from '../../stores/workspaceStore';
import { useExecutionStore } from '../../stores/executionStore';
import { useConnectionStore } from '../../stores/connectionStore';
import {
  Badge,
  Button,
  ErrorState,
  IconButton,
  Menu,
  MenuItem,
  Modal,
  ResizeHandle,
  Toast,
} from '../ui';
import { TaskEditor } from '../orchestration/Tasks';
import OrchestrationSidebar from './OrchestrationSidebar';
export const destinations = [
  { path: '/advanced/home', label: 'Home', icon: Home },
  { path: '/advanced/workspace', label: 'Workspace', icon: Layers },
  { path: '/advanced/agents', label: 'Agents', icon: Bot },
  { path: '/advanced/tasks', label: 'Tasks', icon: ListTodo },
  { path: '/advanced/terminal', label: 'Terminal', icon: Terminal },
  { path: '/advanced/knowledge', label: 'Knowledge', icon: BookOpen },
  { path: '/advanced/history', label: 'History', icon: History },
  { path: '/advanced/settings', label: 'Settings', icon: Settings },
];
function AppSidebar() {
  const workspace = useWorkspace();
  const tasks = useTasks();
  const data = useWorkspaceStore((state) => state.data);
  const sample = useWorkspaceStore((state) => state.sample);
  const agents = useExecutionStore((state) => state.agents);
  const prefs = useWorkspaceStore((state) => state.preferences);
  const choose = useWorkspaceStore((state) => state.chooseWorkspace);
  const select = useWorkspaceStore((state) => state.selectWorkspace);
  const navigate = useNavigate();
  const activeAgents = Object.values(agents).filter((agent) => agent.status === 'running').length;
  return (
    <aside className={`app-sidebar ${data.preferences.sidebarCollapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-brand">
        <div className="brand-row">
          <AriaMark />
          <span>Aria</span>
        </div>
        <p>
          AI Operating Environment
          <br />
          for Developers
        </p>
      </div>
      <nav aria-label="Main navigation">
        {destinations.map((destination) => (
          <NavLink
            key={destination.path}
            to={destination.path}
            title={destination.label}
            className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
          >
            <destination.icon size={18} />
            <span>{destination.label}</span>
            {destination.path === '/advanced/tasks' && tasks.length > 0 && (
              <small>{tasks.length}</small>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="sidebar-project">
          <Menu
            label="Select project"
            trigger={
              <>
                <span className="project-icon">
                  <Code2 size={17} />
                </span>
                <span className="project-selector-text">
                  <strong>{workspace?.name ?? 'No project selected'}</strong>
                  <small>
                    <span className="status-dot" />
                    {workspace?.branch ?? 'Local workspace'}
                    {sample ? ' · sample' : ''}
                  </small>
                </span>
              </>
            }
          >
            {data.workspaces.map((item) => (
              <MenuItem
                key={item.id}
                onSelect={() => {
                  select(item.id);
                  navigate('/advanced/workspace');
                }}
              >
                <FolderOpen size={14} />
                {item.name}
              </MenuItem>
            ))}
            <MenuItem onSelect={() => void choose()}>
              <Plus size={14} />
              Open project folder
            </MenuItem>
            <MenuItem
              onSelect={() => {
                useWorkspaceStore.getState().enterSample();
                navigate('/advanced/workspace');
              }}
            >
              <Sparkles size={14} />
              Explore sample workspace
            </MenuItem>
          </Menu>
        </div>
        <div className="workspace-summary">
          <div className="spread">
            <strong>Workspace</strong>
            <Badge tone={sample ? 'violet' : 'neutral'}>{sample ? 'Sample' : 'Local'}</Badge>
          </div>
          <div>
            <Bot size={13} />
            <span>Agents running</span>
            <span>{activeAgents}</span>
          </div>
          <div>
            <ListTodo size={13} />
            <span>Open tasks</span>
            <span>
              {tasks.filter((task) => !['completed', 'cancelled'].includes(task.status)).length}
            </span>
          </div>
          <div>
            <GitBranch size={13} />
            <span>Branch</span>
            <span title={workspace?.branch ?? undefined}>{workspace?.branch ?? '—'}</span>
          </div>
        </div>
        <div className="sidebar-footer">
          <span>
            Aria Desktop <small>0.1</small>
          </span>
          <IconButton
            label={data.preferences.sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            onClick={() => prefs({ sidebarCollapsed: !data.preferences.sidebarCollapsed })}
          >
            {data.preferences.sidebarCollapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <PanelLeftClose size={16} />
            )}
          </IconButton>
        </div>
      </div>
    </aside>
  );
}
function CommandSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const data = useWorkspaceStore((state) => state.data);
  const tasks = useTasks();
  const go = (path: string) => {
    navigate(path);
    onClose();
  };
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const matches = (text: string) => text.toLowerCase().includes(query.toLowerCase());
  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title="Search Aria"
      description="Jump to a page, project, task, or saved draft."
      className="command-dialog"
    >
      <div className="command-search">
        <Search size={19} />
        <input
          autoFocus
          aria-label="Search commands"
          placeholder="Where would you like to go?"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div
        className="command-results"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
            );
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            buttons[
              (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            ]?.focus();
            event.preventDefault();
          }
        }}
      >
        {destinations
          .filter((item) => matches(item.label))
          .map((item) => (
            <button key={item.path} onClick={() => go(item.path)}>
              <item.icon size={16} />
              <span>{item.label}</span>
              <ArrowRight size={13} />
            </button>
          ))}
        {data.workspaces
          .filter((item) => matches(item.name))
          .map((item) => (
            <button
              key={item.id}
              onClick={() => {
                useWorkspaceStore.getState().selectWorkspace(item.id);
                go('/advanced/workspace');
              }}
            >
              <FolderOpen size={16} />
              <span>{item.name}</span>
              <Badge>Project</Badge>
            </button>
          ))}
        {tasks
          .filter((task) => matches(task.title))
          .slice(0, 10)
          .map((task) => (
            <button key={task.id} onClick={() => go('/advanced/tasks')}>
              <ListTodo size={16} />
              <span>{task.title}</span>
              <Badge>Task</Badge>
            </button>
          ))}
        {data.conversations
          .filter((item) => matches(item.title))
          .slice(-5)
          .map((item) => (
            <button
              key={item.id}
              onClick={() => {
                useWorkspaceStore.getState().selectWorkspace(item.workspaceId);
                useWorkspaceStore.getState().selectConversation(item.id);
                go('/advanced/workspace');
              }}
            >
              <History size={16} />
              <span>{item.title}</span>
              <Badge>Draft</Badge>
            </button>
          ))}
      </div>
      <div className="command-footer">
        <span>↑ ↓ to navigate · Enter to select</span>
        <kbd>esc</kbd>
      </div>
    </Modal>
  );
}
export default function DesktopShell({ children }: { children: ReactNode }) {
  const workspace = useWorkspace();
  const sample = useWorkspaceStore((state) => state.sample);
  const prefs = useWorkspaceStore((state) => state.data.preferences);
  const setPrefs = useWorkspaceStore((state) => state.preferences);
  const saveError = useWorkspaceStore((state) => state.saveError);
  const [search, setSearch] = useState(false);
  const [newTask, setNewTask] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [width, setWidth] = useState(window.innerWidth);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const health = useConnectionStore((state) => state.result);
  const destination =
    destinations.find((item) => item.path === location.pathname) ?? destinations[0];
  useEffect(() => {
    if (destinations.some((item) => item.path === location.pathname))
      setPrefs({ route: location.pathname });
  }, [location.pathname, setPrefs]);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    const browse = () => navigate('/advanced/knowledge');
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && ['k', 'l'].includes(event.key.toLowerCase())) {
        event.preventDefault();
        if (event.key.toLowerCase() === 'k') setSearch((value) => !value);
        else window.dispatchEvent(new Event('aria:focus-composer'));
      }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', key);
    window.addEventListener('aria:browse-context', browse);
    window.addEventListener('blur', flushPersistence);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', key);
      window.removeEventListener('aria:browse-context', browse);
      window.removeEventListener('blur', flushPersistence);
    };
  }, [navigate]);
  const hasRight = ['/advanced/workspace', '/advanced/agents', '/advanced/tasks'].includes(
    location.pathname,
  );
  const narrow = width < 1100;
  const rightWidth = Math.max(
    280,
    Math.min(
      prefs.rightWidth,
      width - (prefs.sidebarCollapsed ? 64 : width < 1440 ? 200 : 224) - 560,
    ),
  );
  return (
    <div className="desktop-shell">
      <AppSidebar />
      <main className="app-main">
        <header className="top-toolbar">
          <div className="breadcrumb">
            <span>{destination.label}</span>
            <span className="breadcrumb-slash">/</span>
            <Menu
              label="Project toolbar"
              trigger={
                <>
                  <Code2 size={16} />
                  <strong>{workspace?.name ?? 'Select project'}</strong>
                </>
              }
            >
              {useWorkspaceStore.getState().data.workspaces.map((item) => (
                <MenuItem
                  key={item.id}
                  onSelect={() => useWorkspaceStore.getState().selectWorkspace(item.id)}
                >
                  {item.name}
                </MenuItem>
              ))}
              <MenuItem onSelect={() => void useWorkspaceStore.getState().chooseWorkspace()}>
                <FolderOpen size={14} />
                Open project
              </MenuItem>
            </Menu>
          </div>
          <div className="toolbar-actions">
            <Button className="search-trigger" variant="ghost" onClick={() => setSearch(true)}>
              <kbd>
                <Command size={11} />K
              </kbd>
              <span>Search…</span>
            </Button>
            <Button
              variant="primary"
              className="new-task-button"
              disabled={!workspace}
              onClick={() => setNewTask(true)}
            >
              <Plus size={14} />
              New Task
            </Button>
            {hasRight && (
              <IconButton
                label={
                  (narrow ? drawerOpen : prefs.rightOpen)
                    ? 'Hide orchestration panel'
                    : 'Show orchestration panel'
                }
                onClick={() =>
                  narrow ? setDrawerOpen(!drawerOpen) : setPrefs({ rightOpen: !prefs.rightOpen })
                }
              >
                <PanelRight size={17} />
              </IconButton>
            )}
            <IconButton label="Connection and notifications" onClick={() => setNotifications(true)}>
              <Bell size={18} />
            </IconButton>
            <button
              className="profile-avatar"
              aria-label="Open settings"
              onClick={() => navigate('/advanced/settings')}
            >
              A
            </button>
          </div>
        </header>
        {sample && (
          <div className="sample-banner">
            <span>
              <Sparkles size={13} />
              <strong>Sample workspace</strong>
              <span className="sample-explanation">Simulated content · no real operations</span>
            </span>
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => useWorkspaceStore.getState().resetSample()}
              >
                <RotateCcw size={12} />
                Reset
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => useWorkspaceStore.getState().exitSample()}
              >
                <X size={13} />
                Exit sample
              </Button>
            </div>
          </div>
        )}
        {saveError && (
          <ErrorState
            message={`Local changes could not be saved: ${saveError}`}
            retry={() => void flushPersistence()}
          />
        )}
        <div className="workspace-layout">
          <div className="central-workspace">{children}</div>
          {hasRight && prefs.rightOpen && !narrow && (
            <>
              <ResizeHandle
                value={rightWidth}
                min={280}
                max={Math.max(
                  280,
                  Math.min(
                    520,
                    width - (prefs.sidebarCollapsed ? 64 : width < 1440 ? 200 : 224) - 560,
                  ),
                )}
                label="Resize orchestration panel"
                onChange={(rightWidth) => setPrefs({ rightWidth })}
              />
              <aside
                className="right-column"
                aria-label="Orchestration"
                style={{ width: rightWidth }}
              >
                <OrchestrationSidebar />
              </aside>
            </>
          )}
        </div>
        {narrow && hasRight && (
          <Modal
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            title="Orchestration"
            description="Task progress, plans, agents, and project context."
            className="orchestration-drawer"
          >
            <OrchestrationSidebar close={() => setDrawerOpen(false)} />
          </Modal>
        )}
      </main>
      <CommandSearch open={search} onClose={() => setSearch(false)} />
      {newTask && <TaskEditor onClose={() => setNewTask(false)} />}
      <Modal
        open={notifications}
        onOpenChange={setNotifications}
        title="Connection & activity"
        description="The current capabilities of your Aria workspace."
      >
        <div className="connection-modal">
          <Badge tone={health?.reachable ? 'success' : 'neutral'}>
            {health?.reachable ? 'API reachable' : 'Disconnected'}
          </Badge>
          <p>{health?.message ?? 'Check the backend connection from Settings.'}</p>
          <p>
            AI chat, autonomous agents, command execution, and external approvals require backend
            services. Local projects, drafts, tasks, and plans are available.
          </p>
          <Button
            onClick={() => {
              setNotifications(false);
              navigate('/advanced/settings');
            }}
          >
            <CircleHelp size={14} />
            Connection settings
            <ChevronRight size={13} />
          </Button>
        </div>
      </Modal>
      <Toast />
    </div>
  );
}
