import { useMemo } from 'react';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { generating, useChatStore } from '../stores/chatStore';

export function useChat() {
  const chat = useWorkspaceStore((state) => state.data.chat);
  const status = useChatStore((state) => state.status);
  const conversation = chat.conversations.find((item) => item.id === chat.selectedId);
  const messages = useMemo(
    () => chat.messages.filter((item) => item.conversationId === chat.selectedId),
    [chat.messages, chat.selectedId],
  );
  return {
    conversation,
    messages,
    draft: conversation?.draft ?? chat.newDraft,
    busy: messages.some(generating),
    status,
  };
}
