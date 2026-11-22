import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

type Scope = {
  conversation: string;
  request: string;
  step: string;
  operation: string;
  binding: unknown;
};
type Decision = 'approved' | 'declined' | 'cancelled' | 'expired';

/** Serializes native prompts and records decisions against the trusted operation scope. */
export class OperationApproval {
  private queue = Promise.resolve();
  private readonly pending = new Map<AbortSignal, Map<string, Promise<boolean>>>();
  private readonly scope = new AsyncLocalStorage<Scope>();

  constructor(
    private readonly prompt: (title: string, detail: string, signal: AbortSignal) => Promise<boolean>,
    private readonly journal?: {
      begin(scope: Omit<Scope, 'binding'>, fingerprint: string): string;
      finish(id: string, decision: Decision): void;
    },
  ) {}

  within<T>(scope: Scope, work: () => T) {
    return this.scope.run(scope, work);
  }

  async approve(title: string, detail: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const binding = this.scope.getStore();
    const key = JSON.stringify([binding, title, detail]);
    const scope = this.pending.get(signal) ?? new Map<string, Promise<boolean>>();
    const waiting = scope.get(key);
    if (waiting) return waiting;
    const cancelled = (): Decision => signal.reason?.name === 'TimeoutError' ? 'expired' : 'cancelled';
    const work = this.queue.then(async () => {
      if (signal.aborted) return false;
      const id = binding && this.journal?.begin(
        binding,
        createHash('sha256').update(JSON.stringify([binding.binding, title, detail])).digest('hex'),
      );
      let decision: Decision = 'cancelled';
      try {
        const approved = await this.prompt(title, detail, signal);
        decision = signal.aborted ? cancelled() : approved ? 'approved' : 'declined';
        return decision === 'approved';
      } finally {
        if (id) this.journal!.finish(id, signal.aborted ? cancelled() : decision);
      }
    });
    this.queue = work.then(() => undefined, () => undefined);
    let onAbort: (() => void) | undefined;
    const decision = Promise.race([work, new Promise<false>((resolve) => {
      onAbort = () => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
    scope.set(key, decision);
    this.pending.set(signal, scope);
    try {
      return await decision;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      scope.delete(key);
      if (!scope.size) this.pending.delete(signal);
    }
  }
}
