import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import DesktopShell from '../components/layout/DesktopShell';
import { Button, Skeleton } from '../components/ui';
import { connectWorkspace, disconnectWorkspace } from '../stores/executionStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useConnectionStore } from '../stores/connectionStore';
import { AgentsPage, HistoryPage, TasksPage, TerminalPage } from './WorkPages';
const Home = lazy(() => import('./Home'));
const ChatWorkspace = lazy(() => import('../components/chat/ChatWorkspace'));
const Knowledge = lazy(() => import('./Knowledge'));
const Settings = lazy(() => import('./Settings'));

export default function LegacyWorkspace() {
  const navigate = useNavigate();
  useEffect(() => {
    const state = useWorkspaceStore.getState();
    void connectWorkspace(
      state.sample ? 'sample' : (state.data.preferences.activeWorkspaceId ?? ''),
      state.sample,
    );
    const check = () =>
      void useConnectionStore
        .getState()
        .check(useWorkspaceStore.getState().data.preferences.apiUrl);
    check();
    const timer = setInterval(check, 30000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
      disconnectWorkspace();
    };
  }, []);
  return (
    <div className="legacy-container">
      <div className="legacy-return">
        <Button variant="ghost" size="sm" onClick={() => navigate('/chat')}>
          <ArrowLeft size={14} />
          Return to chat
        </Button>
        <span>Advanced · Legacy workspace</span>
      </div>
      <DesktopShell>
        <Suspense fallback={<Skeleton />}>
          <Routes>
            <Route path="home" element={<Home />} />
            <Route path="workspace" element={<ChatWorkspace />} />
            <Route path="agents" element={<AgentsPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="terminal" element={<TerminalPage />} />
            <Route path="knowledge" element={<Knowledge />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/advanced/home" replace />} />
          </Routes>
        </Suspense>
      </DesktopShell>
    </div>
  );
}
