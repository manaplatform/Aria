import { useMemo } from 'react';
import { activeWorkspace, useWorkspaceStore } from '../stores/workspaceStore';
import { useExecutionStore } from '../stores/executionStore';
export const useWorkspace = () => useWorkspaceStore(activeWorkspace);
export function useTasks() {
  const workspace = useWorkspace();
  const sample = useWorkspaceStore((state) => state.sample);
  const local = useWorkspaceStore((state) => state.data.tasks);
  const remote = useExecutionStore((state) => state.tasks);
  return useMemo(
    () =>
      sample ? Object.values(remote) : local.filter((task) => task.workspaceId === workspace?.id),
    [sample, remote, local, workspace?.id],
  );
}
export function usePlans() {
  const workspace = useWorkspace();
  const sample = useWorkspaceStore((state) => state.sample);
  const local = useWorkspaceStore((state) => state.data.plans);
  const remote = useExecutionStore((state) => state.plans);
  return useMemo(
    () =>
      sample ? Object.values(remote) : local.filter((plan) => plan.workspaceId === workspace?.id),
    [sample, remote, local, workspace?.id],
  );
}
