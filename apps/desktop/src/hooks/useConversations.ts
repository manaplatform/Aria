import { useMemo } from 'react';
import { useWorkspaceStore } from '../stores/workspaceStore';

export function conversationDateGroup(date: string, now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const value = new Date(date);
  if (value >= start) return 'Today';
  const yesterday = new Date(start);
  yesterday.setDate(yesterday.getDate() - 1);
  if (value >= yesterday) return 'Yesterday';
  const week = new Date(start);
  week.setDate(week.getDate() - 7);
  return value >= week ? 'Previous 7 days' : 'Older';
}
export function useConversations(query: string) {
  const chat = useWorkspaceStore((state) => state.data.chat);
  return useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    const matchingIds = new Set(
      search
        ? chat.messages
            .filter((item) => item.content.toLocaleLowerCase().includes(search))
            .map((item) => item.conversationId)
        : [],
    );
    const filtered = chat.conversations.filter(
      (item) =>
        !search || item.title.toLocaleLowerCase().includes(search) || matchingIds.has(item.id),
    );
    const ordered = [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const groups = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Older']
      .map((title) => ({
        title,
        conversations: ordered.filter(
          (item) => (item.pinned ? 'Pinned' : conversationDateGroup(item.updatedAt)) === title,
        ),
      }))
      .filter((group) => group.conversations.length);
    return { groups, selectedId: chat.selectedId, count: chat.conversations.length };
  }, [chat, query]);
}
