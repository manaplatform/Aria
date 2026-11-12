import type { DesktopBridge, LocalData } from '@aria/shared';
export const emptyData = (): LocalData => ({
  version: 2,
  workspaces: [],
  conversations: [],
  tasks: [],
  plans: [],
  chat: { conversations: [], messages: [], selectedId: null, newDraft: '' },
  preferences: {
    theme: 'dark',
    route: '/chat',
    activeWorkspaceId: null,
    sidebarCollapsed: false,
    rightOpen: true,
    rightWidth: 384,
    sectionHeights: {},
    collapsedSections: [],
    apiUrl: 'http://localhost:3000',
    chatSidebarCollapsed: false,
    profileName: 'You',
  },
});
export function desktop(): DesktopBridge {
  if (!window.aria) throw new Error('This feature requires the Aria desktop application.');
  return window.aria;
}
export const errorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method 'aria:[a-z-]+': (?:Error: )?/,
    '',
  );
export async function copyText(text: string): Promise<void> {
  if (window.aria) await window.aria.copy(text);
  else await navigator.clipboard.writeText(text);
}
export async function openExternal(url: string): Promise<void> {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error('This link type is not supported.');
  await desktop().openExternal(parsed.href);
}
