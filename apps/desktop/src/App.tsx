import { Component, lazy, Suspense, useEffect, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import ChatLayout from './components/layout/ChatLayout';
import { Button, ErrorState, Skeleton, TooltipProvider } from './components/ui';
import { flushPersistence, initializeWorkspace, useWorkspaceStore } from './stores/workspaceStore';
import { bindChatBridge } from './stores/chatStore';
const ChatView = lazy(() => import('./components/chat/ChatView'));
const SettingsView = lazy(() => import('./components/settings/SettingsView'));
const Agenda = lazy(() => import('./components/proactive/AgendaPage'));
const AgendaDetail = lazy(() => import('./components/proactive/AgendaDetail'));
const Automations = lazy(() => import('./components/proactive/AutomationsPage'));
const Notifications = lazy(() => import('./components/proactive/NotificationCenter'));
const LegacyWorkspace = lazy(() => import('./pages/LegacyWorkspace'));
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch() {
    void window.aria?.diagnosticRendererError().catch(() => undefined);
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
  const appearance = useWorkspaceStore((state) => state.data.preferences);
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
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.accent = appearance.accentColor ?? 'violet';
    root.dataset.fontSize = appearance.fontSize ?? 'default';
    root.dataset.density = appearance.density ?? 'comfortable';
    root.dataset.motion = appearance.reducedMotion ?? 'system';
  }, [appearance.accentColor, appearance.fontSize, appearance.density, appearance.reducedMotion]);
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
            <Route path="/agenda" element={<Agenda />} />
            <Route path="/agenda/tasks/:id" element={<AgendaDetail />} />
            <Route path="/agenda/objectives/:id" element={<AgendaDetail />} />
            <Route path="/agenda/jobs/:id" element={<AgendaDetail />} />
            <Route path="/automations/:id?" element={<Automations />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="/settings/:category" element={<SettingsView />} />
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
