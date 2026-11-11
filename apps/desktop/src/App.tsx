import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import DesktopShell from './components/layout/DesktopShell';
import { Button, ErrorState, Skeleton, TooltipProvider } from './components/ui';
import { flushPersistence, initializeWorkspace, useWorkspaceStore } from './stores/workspaceStore';
import { disconnectWorkspace } from './stores/executionStore';
import { useConnectionStore } from './stores/connectionStore';
import { AgentsPage, HistoryPage, TasksPage, TerminalPage } from './pages/WorkPages';
const Home = lazy(() => import('./pages/Home'));
const ChatWorkspace = lazy(() => import('./components/chat/ChatWorkspace'));
const Knowledge = lazy(() => import('./pages/Knowledge'));
const Settings = lazy(() => import('./pages/Settings'));
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Aria renderer error', error, info.componentStack);
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error">
        <ErrorState message={this.state.error} />
        <Button onClick={() => window.location.reload()}>Reload Aria</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Application() {
  const ready = useWorkspaceStore((state) => state.ready);
  const error = useWorkspaceStore((state) => state.loadError);
  const theme = useWorkspaceStore((state) => state.data.preferences.theme);
  useEffect(
    () =>
      window.aria?.onBeforeClose(async () => {
        await flushPersistence();
        if (useWorkspaceStore.getState().saveError)
          throw new Error(useWorkspaceStore.getState().saveError!);
      }),
    [],
  );
  useEffect(() => {
    void initializeWorkspace();
    const focus = () => {
      void useConnectionStore
        .getState()
        .check(useWorkspaceStore.getState().data.preferences.apiUrl);
    };
    const timer = setInterval(focus, 30000);
    window.addEventListener('focus', focus);
    void initializeWorkspace().then(focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, []);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (query.matches ? 'dark' : 'light') : theme;
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [theme]);
  // Disconnect on actual window disposal; StrictMode's initial effect replay must not tear down the shared adapter.
  useEffect(() => {
    const close = () => disconnectWorkspace();
    window.addEventListener('unload', close);
    return () => window.removeEventListener('unload', close);
  }, []);
  if (error) return <ErrorState message={error} retry={() => window.location.reload()} />;
  if (!ready)
    return (
      <div className="boot-screen">
        <Skeleton />
      </div>
    );
  return (
    <HashRouter>
      <DesktopShell>
        <Suspense fallback={<Skeleton />}>
          <Routes>
            <Route path="/home" element={<Home />} />
            <Route path="/workspace" element={<ChatWorkspace />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/terminal" element={<TerminalPage />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </Suspense>
      </DesktopShell>
    </HashRouter>
  );
}
export default function App() {
  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={350}>
        <Application />
      </TooltipProvider>
    </ErrorBoundary>
  );
}
