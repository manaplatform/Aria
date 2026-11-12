import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkspaceAdapter } from '@aria/shared';
import { MessageComposer } from '../src/components/chat/ChatWorkspace';
import MarkdownRenderer from '../src/components/chat/MarkdownRenderer';
import { ApprovalCard } from '../src/components/orchestration/Approvals';
import { TaskEditor } from '../src/components/orchestration/Tasks';
import { TooltipProvider } from '../src/components/ui';
import { useWorkspaceStore } from '../src/stores/workspaceStore';
import { useExecutionStore } from '../src/stores/executionStore';
import { emptyData } from '../src/services/desktop';
import { BackendAdapter } from '../src/services/adapters';
import { createSampleSnapshot } from '../src/services/sample';
import type { ReactNode } from 'react';
function mount(component: ReactNode) {
  return render(<TooltipProvider>{component}</TooltipProvider>);
}
beforeEach(() => {
  const data = emptyData();
  data.workspaces = [
    { id: 'project', name: 'Project', root: '/tmp/project', branch: 'main', updatedAt: '' },
  ];
  data.preferences.activeWorkspaceId = 'project';
  data.conversations = [
    {
      id: 'draft',
      workspaceId: 'project',
      title: 'Draft',
      draft: '',
      mode: 'chat',
      attachments: [],
      updatedAt: '',
    },
  ];
  useWorkspaceStore.setState({ data, sample: false, ready: true, selectedConversationId: 'draft' });
  useExecutionStore.getState().reset('project', new BackendAdapter());
});
it('keeps unsupported chat as a saved draft and disables sending', async () => {
  const user = userEvent.setup();
  mount(<MessageComposer />);
  await user.type(screen.getByRole('textbox', { name: 'Message Aria' }), 'Keep this idea');
  await user.keyboard('{Enter}');
  expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  expect(useWorkspaceStore.getState().data.conversations[0].draft).toBe('Keep this idea');
});
it('Shift+Enter inserts a newline and Enter submits once when supported', async () => {
  const submitMessage = vi.fn().mockResolvedValue(undefined);
  const adapter: WorkspaceAdapter = {
    ...new BackendAdapter(),
    source: 'backend',
    capabilities: { ...new BackendAdapter().capabilities, chat: true },
    getSnapshot: vi.fn(),
    subscribe: () => () => undefined,
    submitMessage,
    cancel: vi.fn(),
    decideApproval: vi.fn(),
  };
  useExecutionStore.setState({ adapter });
  const user = userEvent.setup();
  mount(<MessageComposer />);
  await user.type(screen.getByRole('textbox', { name: 'Message Aria' }), 'First');
  await user.keyboard('{Shift>}{Enter}{/Shift}second');
  expect(useWorkspaceStore.getState().data.conversations[0].draft).toBe('First\nsecond');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(submitMessage).toHaveBeenCalledOnce());
  expect(submitMessage.mock.calls[0][0].draft).toBe('First\nsecond');
});
it('shows approval success only after acknowledgement and preserves failure', async () => {
  const approval = createSampleSnapshot().approvals[0];
  let resolve!: (value: typeof approval) => void;
  const decide = vi.fn(
    () =>
      new Promise<typeof approval>((done) => {
        resolve = done;
      }),
  );
  const adapter = new BackendAdapter();
  adapter.capabilities.approvals = true;
  adapter.decideApproval = decide as unknown as typeof adapter.decideApproval;
  useExecutionStore.getState().reset('sample', adapter);
  useExecutionStore.getState().snapshot(createSampleSnapshot());
  const user = userEvent.setup();
  mount(<ApprovalCard approval={approval} />);
  await user.click(screen.getByRole('button', { name: 'Approve Open pull request' }));
  await user.click(screen.getByRole('button', { name: 'Approve operation' }));
  expect(useExecutionStore.getState().approvals[approval.id].status).toBe('pending');
  expect(screen.getByRole('button', { name: 'Awaiting acknowledgement…' })).toBeDisabled();
  resolve({ ...approval, status: 'approved', revision: 2 });
  await waitFor(() =>
    expect(useExecutionStore.getState().approvals[approval.id].status).toBe('approved'),
  );
});
it('allows approval retry after backend rejection', async () => {
  const approval = createSampleSnapshot().approvals[0];
  const adapter = new BackendAdapter();
  adapter.capabilities.approvals = true;
  adapter.decideApproval = vi.fn().mockRejectedValue(new Error('Request rejected'));
  useExecutionStore.getState().reset('sample', adapter);
  useExecutionStore.getState().snapshot(createSampleSnapshot());
  const user = userEvent.setup();
  mount(<ApprovalCard approval={approval} />);
  await user.click(screen.getByRole('button', { name: 'Approve Open pull request' }));
  await user.click(screen.getByRole('button', { name: 'Approve operation' }));
  expect(await screen.findAllByText('Request rejected')).not.toHaveLength(0);
  expect(useExecutionStore.getState().approvals[approval.id].status).toBe('pending');
  expect(screen.getByRole('button', { name: 'Approve operation' })).toBeEnabled();
});
it('creates a manually managed task through its form', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  mount(<TaskEditor onClose={close} />);
  await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship desktop UI');
  await user.click(screen.getByRole('button', { name: 'Save task' }));
  expect(useWorkspaceStore.getState().data.tasks[0]).toMatchObject({
    title: 'Ship desktop UI',
    source: 'local',
    workspaceId: 'project',
  });
  expect(close).toHaveBeenCalledOnce();
});
it('renders code without executing HTML or allowing script URLs', () => {
  const { container } = mount(
    <MarkdownRenderer
      content={
        '```ts\nconst value = 1;\n```\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))'
      }
    />,
  );
  expect(screen.getByText('const value = 1;')).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
});
it('does not submit Enter while an IME composition is active', async () => {
  const submitMessage = vi.fn().mockResolvedValue(undefined);
  const adapter = new BackendAdapter();
  useExecutionStore.setState({
    adapter: {
      source: 'backend',
      capabilities: { ...adapter.capabilities, chat: true },
      getSnapshot: vi.fn(),
      subscribe: () => () => undefined,
      submitMessage,
      cancel: vi.fn(),
      decideApproval: vi.fn(),
    },
  });
  useWorkspaceStore.getState().updateConversation({ draft: '日本語' });
  mount(<MessageComposer />);
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message Aria' }), {
    key: 'Enter',
    isComposing: true,
  });
  expect(submitMessage).not.toHaveBeenCalled();
  expect(useWorkspaceStore.getState().data.conversations[0].draft).toBe('日本語');
});
it('retains text typed while an earlier message is being sent', async () => {
  let resolve!: () => void;
  const adapter = new BackendAdapter();
  const submitMessage = vi.fn(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  useExecutionStore.setState({
    adapter: {
      source: 'backend',
      capabilities: { ...adapter.capabilities, chat: true },
      getSnapshot: vi.fn(),
      subscribe: () => () => undefined,
      submitMessage,
      cancel: vi.fn(),
      decideApproval: vi.fn(),
    },
  });
  const user = userEvent.setup();
  mount(<MessageComposer />);
  const input = screen.getByRole('textbox', { name: 'Message Aria' });
  await user.type(input, 'First message{Enter}');
  await user.clear(input);
  await user.type(input, 'Next idea');
  resolve();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
  expect(input).toHaveValue('Next idea');
});
it('preserves earlier reading position and follows updates only near the bottom', async () => {
  const { default: ChatWorkspace } = await import('../src/components/chat/ChatWorkspace');
  const { act, fireEvent } = await import('@testing-library/react');
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  Element.prototype.scrollTo = vi.fn();
  const message = {
    id: 'reply',
    workspaceId: 'project',
    conversationId: 'draft',
    role: 'assistant' as const,
    content: 'First content',
    createdAt: new Date().toISOString(),
    status: 'streaming' as const,
    revision: 1,
  };
  useExecutionStore.setState({ loading: false, messages: { reply: message } });
  const { container } = mount(<ChatWorkspace />);
  const scroll = container.querySelector('.conversation-scroll')!;
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  fireEvent.scroll(scroll);
  act(() =>
    useExecutionStore.getState().apply({
      type: 'message',
      workspaceId: 'project',
      cursor: 1,
      message: { ...message, content: 'Updated content', revision: 2 },
    }),
  );
  expect(await screen.findByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();
  expect(scrollIntoView).not.toHaveBeenCalled();
  scroll.scrollTop = 800;
  fireEvent.scroll(scroll);
  act(() =>
    useExecutionStore.getState().apply({
      type: 'message',
      workspaceId: 'project',
      cursor: 2,
      message: { ...message, content: 'More content', revision: 3 },
    }),
  );
  await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
});
