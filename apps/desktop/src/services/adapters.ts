import type {
  ApprovalRequest,
  Conversation,
  LiveUpdate,
  Snapshot,
  WorkspaceAdapter,
} from '@aria/shared';
import { createSampleSnapshot } from './sample';
export const unavailableCapabilities = {
  chat: false,
  execution: false,
  cancellation: false,
  agents: false,
  approvals: false,
  streaming: false,
};
export const emptySnapshot = (workspaceId: string): Snapshot => ({
  workspaceId,
  cursor: 0,
  agents: [],
  tasks: [],
  plans: [],
  messages: [],
  events: [],
  approvals: [],
});
const unavailable = async (): Promise<never> => {
  throw new Error(
    'This service is not implemented by the current backend. Your draft is saved locally.',
  );
};
export class BackendAdapter implements WorkspaceAdapter {
  readonly source = 'backend' as const;
  readonly capabilities = { ...unavailableCapabilities };
  async getSnapshot(workspaceId: string): Promise<Snapshot> {
    return emptySnapshot(workspaceId);
  }
  subscribe(): () => void {
    return () => undefined;
  }
  submitMessage = unavailable;
  cancel = unavailable;
  decideApproval = unavailable;
}
export class SampleAdapter implements WorkspaceAdapter {
  readonly source = 'sample' as const;
  readonly capabilities = {
    chat: true,
    execution: true,
    cancellation: true,
    agents: true,
    approvals: true,
    streaming: true,
  };
  private state = createSampleSnapshot();
  private listeners = new Set<(update: LiveUpdate) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private generation = 0;
  private cursor = 0;
  async getSnapshot(): Promise<Snapshot> {
    return structuredClone(this.state);
  }
  subscribe(_workspace: string, listener: (update: LiveUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.dispose();
    };
  }
  private emit(
    update:
      | Omit<Extract<LiveUpdate, { type: 'message' }>, 'cursor' | 'workspaceId'>
      | Omit<Extract<LiveUpdate, { type: 'event' }>, 'cursor' | 'workspaceId'>
      | Omit<Extract<LiveUpdate, { type: 'approval' }>, 'cursor' | 'workspaceId'>,
  ): void {
    const envelope = { ...update, workspaceId: 'sample', cursor: ++this.cursor } as LiveUpdate;
    this.state.cursor = envelope.cursor;
    if (update.type === 'message')
      this.state.messages = [
        ...this.state.messages.filter((item) => item.id !== update.message.id),
        update.message,
      ];
    if (update.type === 'event')
      this.state.events = [
        ...this.state.events.filter((item) => item.id !== update.event.id),
        update.event,
      ];
    if (update.type === 'approval')
      this.state.approvals = [
        ...this.state.approvals.filter((item) => item.id !== update.approval.id),
        update.approval,
      ];
    this.listeners.forEach((listener) => listener(envelope));
  }
  private delay(ms: number): Promise<boolean> {
    const generation = this.generation;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve(generation === this.generation);
      }, ms);
      this.timers.add(timer);
    });
  }
  async submitMessage(conversation: Conversation): Promise<void> {
    const id = crypto.randomUUID();
    const user = {
      id,
      workspaceId: 'sample',
      conversationId: conversation.id,
      role: 'user' as const,
      content: conversation.draft,
      createdAt: new Date().toISOString(),
      status: 'completed' as const,
      revision: 1,
    };
    this.emit({ type: 'message', message: user });
    const response =
      '**Sample response** — This workspace demonstrates the interface. No AI service, terminal command, file edit, or external operation was invoked.';
    const message = {
      ...user,
      id: `${id}-reply`,
      role: 'assistant' as const,
      content: '',
      status: 'streaming' as const,
      revision: 1,
    };
    for (let end = 12; end < response.length + 12; end += 12) {
      if (!(await this.delay(35))) return;
      const finished = end >= response.length;
      this.emit({
        type: 'message',
        message: {
          ...message,
          content: response.slice(0, end),
          status: finished ? 'completed' : 'streaming',
          revision: end,
        },
      });
    }
  }
  async cancel(): Promise<void> {
    this.generation++;
    const event = this.state.events.find((event) => event.id === 'test')!;
    this.emit({
      type: 'event',
      event: { ...event, status: 'cancelled', revision: ++event.revision },
    });
    this.state.messages
      .filter((message) => message.status === 'streaming')
      .forEach((message) =>
        this.emit({
          type: 'message',
          message: { ...message, status: 'failed', revision: message.revision + 1 },
        }),
      );
  }
  async decideApproval(id: string, decision: 'approved' | 'denied'): Promise<ApprovalRequest> {
    if (!(await this.delay(350))) throw new Error('Sample workspace was closed.');
    const approval = this.state.approvals.find((item) => item.id === id);
    if (!approval) throw new Error('Approval no longer exists.');
    const next = { ...approval, status: decision, revision: approval.revision + 1 };
    this.state.approvals = this.state.approvals.map((item) => (item.id === id ? next : item));
    this.emit({ type: 'approval', approval: next });
    return next;
  }
  async replay(): Promise<void> {
    const event = this.state.events.find((item) => item.id === 'test')!;
    for (let i = 0; i < 4; i++) {
      if (!(await this.delay(600))) return;
      const output = {
        id: `replay-${i}`,
        sequence: i + 3,
        stream: 'stdout' as const,
        text:
          i < 3
            ? ` ✓ sample/test-${i + 1}.test.ts (4 tests) 193ms\n`
            : '\n Test Files  6 passed (6)\n      Tests  30 passed (30)\n   Duration  2.41s\n',
      };
      event.command!.output = [
        ...event.command!.output.filter((chunk) => chunk.id !== output.id),
        output,
      ];
      event.status = i === 3 ? 'completed' : 'running';
      if (i === 3) event.command!.exitCode = 0;
      this.emit({
        type: 'event',
        event: structuredClone({ ...event, revision: ++event.revision }),
      });
    }
  }
  dispose(): void {
    this.generation++; /* Timers settle and release their promises; stale work is ignored. */
  }
}
