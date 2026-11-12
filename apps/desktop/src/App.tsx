import { Component, lazy, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import ChatLayout from './components/layout/ChatLayout';
import { Button, ErrorState, Skeleton, TooltipProvider } from './components/ui';
import { flushPersistence, initializeWorkspace, useWorkspaceStore } from './stores/workspaceStore';
import { bindChatBridge, stopAllChats } from './stores/chatStore';
const ChatView = lazy(() => import('./components/chat/ChatView'));
const SettingsView = lazy(() => import('./components/settings/SettingsView'));
const LegacyWorkspace = lazy(() => import('./pages/LegacyWorkspace'));
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
        await stopAllChats();
        await flushPersistence();
        if (useWorkspaceStore.getState().saveError)
          throw new Error(useWorkspaceStore.getState().saveError!);
      }),
    [],
  );
  useEffect(() => {
    void initializeWorkspace();
    const flush = () => void flushPersistence();
    window.addEventListener('blur', flush);
    return () => {
      window.removeEventListener('blur', flush);
    };
  }, []);
  useEffect(() => (ready ? bindChatBridge() : undefined), [ready]);
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
  if (error) return <ErrorState message={error} retry={() => window.location.reload()} />;
  if (!ready)
    return (
      <div className="boot-screen">
        <Skeleton />
      </div>
    );
  return (
    <HashRouter>
      <Suspense fallback={<Skeleton />}>
        <Routes>
          <Route element={<ChatLayout />}>
            <Route path="/chat" element={<ChatView />} />
            <Route path="/settings" element={<SettingsView />} />
          </Route>
          <Route path="/advanced/*" element={<LegacyWorkspace />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </Suspense>
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
