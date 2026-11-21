type Ticket = {
  turn: string;
  provider?: string;
  tool: string;
  toolLimit: number;
  locks: readonly string[];
  limit: number;
  signal: AbortSignal;
  ready: (release: () => void) => void;
  cancelled: () => void;
};

export class ExecutionScheduler {
  private readonly queue: Ticket[] = [];
  private readonly active = new Set<Ticket>();

  async acquire(ticket: Omit<Ticket, 'ready' | 'cancelled'>): Promise<() => void> {
    ticket.signal.throwIfAborted();
    if (this.queue.length >= 48) throw new Error('The tool execution queue is full.');
    return new Promise((resolve, reject) => {
      const cancelled = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) this.queue.splice(index, 1);
        reject(ticket.signal.reason);
        this.schedule();
      };
      const item: Ticket = {
        ...ticket,
        cancelled,
        ready: (release) => {
          ticket.signal.removeEventListener('abort', cancelled);
          resolve(release);
        },
      };
      ticket.signal.addEventListener('abort', cancelled, { once: true });
      this.queue.push(item);
      this.schedule();
    });
  }

  private schedule() {
    const waitingLocks = new Set<string>();
    for (const ticket of [...this.queue]) {
      const active = [...this.active];
      if (
        active.length >= 12 ||
        active.filter((current) => current.turn === ticket.turn).length >= ticket.limit ||
        (ticket.provider &&
          active.filter((current) => current.provider === ticket.provider).length >= 3) ||
        active.filter((current) => current.tool === ticket.tool).length >= ticket.toolLimit ||
        ticket.locks.some(
          (key) => waitingLocks.has(key) || active.some((current) => current.locks.includes(key)),
        )
      ) {
        ticket.locks.forEach((key) => waitingLocks.add(key));
        continue;
      }
      this.queue.splice(this.queue.indexOf(ticket), 1);
      this.active.add(ticket);
      ticket.ready(() => {
        this.active.delete(ticket);
        this.schedule();
      });
    }
  }
}
