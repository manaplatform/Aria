import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ChatEvent, ChatMessage, ChatRequest, DesktopBridge } from '@aria/shared';
import ChatView from '../src/components/chat/ChatView';
import { ConversationList } from '../src/components/conversations/ConversationList';
import { TooltipProvider } from '../src/components/ui';
import { emptyData } from '../src/services/desktop';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import {
  applyChatEvent,
  buildChatContext,
  deleteChat,
  regenerateChat,
  renameChat,
  selectChat,
  sendChat,
  setChatDraft,
  stopChat,
  useChatStore,
} from '../src/stores/chatStore';
import { useLiveVoiceStore } from '../src/stores/liveVoiceStore';
import { conversationDateGroup } from '../src/hooks/useConversations';

let requests: ChatRequest[];
beforeEach(() => {
  requests = [];
  useLiveVoiceStore.setState({ phase: 'idle', sessionId: null, conversationId: null });
  window.aria = {
    platform: 'darwin',
    save: vi.fn().mockResolvedValue(undefined),
    submitChat: vi.fn(async (request: ChatRequest) => {
      requests.push(request);
    }),
    cancelChat: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopBridge;
  useWorkspaceStore.setState({ data: emptyData(), ready: true, sample: false, saveError: null });
  useChatStore.setState({ status: { state: 'ready', configured: true, model: 'test-model' } });
  Element.prototype.scrollTo = vi.fn();
});
afterEach(() => {
  delete window.aria;
});
const mount = () =>
  render(
    <MemoryRouter>
      <TooltipProvider>
        <ChatView />
      </TooltipProvider>
    </MemoryRouter>,
  );
const event = (
  request: ChatRequest,
  sequence: number,
  payload:
    | Omit<Extract<ChatEvent, { type: 'delta' }>, keyof ChatRequest | 'sequence'>
    | { type: 'completed' },
) =>
  applyChatEvent({
    requestId: request.requestId,
    conversationId: request.conversationId,
    assistantMessageId: request.assistantMessageId,
    sequence,
    ...payload,
  });

it('starts without a project, populates suggestions, handles newlines and IME, and creates a saved conversation on first send', async () => {
  const user = userEvent.setup();
  mount();
  expect(useWorkspaceStore.getState().data.workspaces).toEqual([]);
  expect(screen.getByRole('heading', { name: 'How can I help you today?' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: /Find the right words/ }));
  expect(
    (screen.getByRole('textbox', { name: 'Message Aria' }) as HTMLTextAreaElement).value,
  ).toContain('Help me write');
  const input = screen.getByRole('textbox', { name: 'Message Aria' });
  await user.clear(input);
  await user.type(input, 'Hello');
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
  expect(requests).toHaveLength(0);
  await user.keyboard('{Shift>}{Enter}{/Shift}Aria');
  expect(input).toHaveValue('Hello\nAria');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(useWorkspaceStore.getState().data.chat.conversations[0].title).toBe('Hello');
  expect(useWorkspaceStore.getState().data.chat.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(window.aria!.save).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Stop response' })).toBeEnabled();
});
it('retains newly typed drafts, manual titles, and background responses when switching conversations', async () => {
  setChatDraft('First question');
  await sendChat();
  const first = requests[0];
  renameChat(first.conversationId, 'My own title');
  setChatDraft('A follow-up');
  selectChat(null);
  setChatDraft('Second question');
  await sendChat();
  event(first, 1, { type: 'delta', text: 'First answer' });
  event(first, 2, { type: 'completed' });
  selectChat(first.conversationId);
  const chat = useWorkspaceStore.getState().data.chat;
  expect(chat.conversations.find((item) => item.id === first.conversationId)).toMatchObject({
    title: 'My own title',
    draft: 'A follow-up',
  });
  expect(chat.messages.find((item) => item.id === first.assistantMessageId)).toMatchObject({
    content: 'First answer',
    status: 'completed',
  });
});
it('ignores duplicate, stopped, deleted, and superseded stream events and regenerates without duplicating the user turn', async () => {
  setChatDraft('Question');
  await sendChat();
  const first = requests[0];
  event(first, 1, { type: 'delta', text: 'Partial' });
  event(first, 1, { type: 'delta', text: 'Partial' });
  await stopChat(first.conversationId);
  event(first, 2, { type: 'delta', text: ' late' });
  expect(useWorkspaceStore.getState().data.chat.messages[1]).toMatchObject({
    content: 'Partial',
    status: 'stopped',
  });
  await regenerateChat(first.conversationId);
  const retry = requests[1];
  event(first, 99, { type: 'completed' });
  event(retry, 1, { type: 'delta', text: 'New answer' });
  event(retry, 2, { type: 'completed' });
  expect(useWorkspaceStore.getState().data.chat.messages).toHaveLength(2);
  expect(useWorkspaceStore.getState().data.chat.messages[1]).toMatchObject({
    content: 'New answer',
    status: 'completed',
  });
  await deleteChat(first.conversationId);
  event(retry, 3, { type: 'delta', text: ' resurrected' });
  expect(useWorkspaceStore.getState().data.chat.messages).toEqual([]);
});
it('offers actionable failure and retry without fabricating assistant content', async () => {
  window.aria!.submitChat = vi.fn().mockRejectedValue(new Error('Connection unavailable'));
  setChatDraft('Please help');
  await sendChat();
  mount();
  expect(screen.getByRole('alert')).toHaveTextContent('Connection unavailable');
  expect(useWorkspaceStore.getState().data.chat.messages[1].content).toBe('');
  expect(screen.getByRole('button', { name: 'Send again' })).toBeEnabled();
});
it('searches message contents and supports rename, pin, and confirmed deletion', async () => {
  const user = userEvent.setup();
  setChatDraft('A searchable question');
  await sendChat();
  event(requests[0], 1, { type: 'delta', text: 'An uncommon answer about orbits' });
  event(requests[0], 2, { type: 'completed' });
  const view = render(
    <TooltipProvider>
      <ConversationList query="orbits" onSelect={() => undefined} />
    </TooltipProvider>,
  );
  expect(screen.getByRole('button', { name: 'A searchable question' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Options for A searchable question' }));
  await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
  await user.clear(screen.getByLabelText('Conversation name'));
  await user.type(screen.getByLabelText('Conversation name'), 'Orbital ideas');
  await user.click(screen.getByRole('button', { name: 'Save name' }));
  await user.click(screen.getByRole('button', { name: 'Options for Orbital ideas' }));
  await user.click(screen.getByRole('menuitem', { name: 'Pin conversation' }));
  expect(screen.getByRole('region', { name: 'Pinned' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Options for Orbital ideas' }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(useWorkspaceStore.getState().data.chat.conversations).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  view.rerender(
    <TooltipProvider>
      <ConversationList query="no match" onSelect={() => undefined} />
    </TooltipProvider>,
  );
  expect(screen.getByText('No conversations found.')).toBeVisible();
});
it('keeps provider context to 20 complete turns without discarding local history', () => {
  const messages: ChatMessage[] = Array.from({ length: 25 }, (_, index) =>
    ['user', 'assistant'].map((role) => ({
      id: `${index}-${role}`,
      conversationId: 'chat',
      requestId: `r-${index}`,
      role: role as 'user' | 'assistant',
      content: `${role}-${index}`,
      createdAt: '',
      status: 'completed' as const,
      sequence: 0,
    })),
  ).flat();
  messages.push({ ...messages[0], id: 'latest', content: 'Newest question' });
  const context = buildChatContext(messages);
  expect(context).toHaveLength(41);
  expect(context[0].content).toBe('user-5');
  expect(context.at(-1)?.content).toBe('Newest question');
  expect(messages).toHaveLength(51);
});
it('preserves earlier reading position during streaming and follows updates again near the bottom', async () => {
  setChatDraft('A longer answer please');
  await sendChat();
  const view = mount();
  const scroll = view.container.querySelector('.chat-scroll')!;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, writable: true, value: 100 },
  });
  fireEvent.scroll(scroll);
  act(() => event(requests[0], 1, { type: 'delta', text: 'Some new content' }));
  expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeVisible();
  expect(scroll.scrollTop).toBe(100);
  scroll.scrollTop = 800;
  fireEvent.scroll(scroll);
  act(() => event(requests[0], 2, { type: 'delta', text: ' and a little more' }));
  await waitFor(() => expect(scroll.scrollTop).toBe(1000));
});
it('groups conversations by local calendar dates', () => {
  const now = new Date(2026, 10, 12, 0, 30);
  expect(conversationDateGroup(new Date(2026, 10, 12, 0, 1).toISOString(), now)).toBe('Today');
  expect(conversationDateGroup(new Date(2026, 10, 11, 23, 59).toISOString(), now)).toBe(
    'Yesterday',
  );
  expect(conversationDateGroup(new Date(2026, 10, 6).toISOString(), now)).toBe('Previous 7 days');
});
