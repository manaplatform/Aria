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
  private readonly paused = new Set<string>();
  private readonly activePrompts = new Map<string, Set<AbortController>>();
  private readonly executionGrants = new Map<string, Set<string>>();

  constructor(
    private readonly prompt: (title: string, detail: string, signal: AbortSignal, allowExecution?: boolean) => Promise<boolean | 'execution'>,
    private readonly journal?: {
      begin(scope: Omit<Scope, 'binding'>, fingerprint: string): string;
      finish(id: string, decision: Decision): void;
    },
  ) {}

  within<T>(scope: Scope, work: () => T) {
    return this.scope.run(scope, work);
  }

  suspend(request: string, paused: boolean) {
    if (!paused) {
      this.paused.delete(request);
      return;
    }
    this.paused.add(request);
    this.activePrompts.get(request)?.forEach((controller) => controller.abort());
  }

  revokeExecution(request: string) {
    this.executionGrants.delete(request);
    this.activePrompts.get(request)?.forEach((controller) => controller.abort());
  }

  release(request: string) {
    this.paused.delete(request);
    this.executionGrants.delete(request);
    this.activePrompts.get(request)?.forEach((controller) => controller.abort());
    this.activePrompts.delete(request);
  }

  async approve(title: string, detail: string, signal: AbortSignal, executionGrant?: string) {
    signal.throwIfAborted();
    const binding = this.scope.getStore();
    if (binding && this.paused.has(binding.request)) return false;
    if (binding && executionGrant && this.executionGrants.get(binding.request)?.has(executionGrant)) return true;
    const key = JSON.stringify([binding, title, detail, executionGrant]);
    const scope = this.pending.get(signal) ?? new Map<string, Promise<boolean>>();
    const waiting = scope.get(key);
    if (waiting) return waiting;
    const controller = new AbortController();
    const active = binding ? this.activePrompts.get(binding.request) ?? new Set<AbortController>() : undefined;
    if (binding && active) this.activePrompts.set(binding.request, active.add(controller));
    const promptSignal = AbortSignal.any([signal, controller.signal]);
    const cancelled = (): Decision => promptSignal.reason?.name === 'TimeoutError' ? 'expired' : 'cancelled';
    const work = this.queue.then(async () => {
      if (promptSignal.aborted) return false;
      const id = binding && this.journal?.begin(
        binding,
        createHash('sha256').update(JSON.stringify([binding.binding, title, detail])).digest('hex'),
      );
      let decision: Decision = 'cancelled';
      try {
        const approved = await this.prompt(title, detail, promptSignal, Boolean(binding && executionGrant));
        decision = promptSignal.aborted ? cancelled() : approved ? 'approved' : 'declined';
        if (decision === 'approved' && approved === 'execution' && binding && executionGrant) {
          const grants = this.executionGrants.get(binding.request) ?? new Set<string>();
          this.executionGrants.set(binding.request, grants.add(executionGrant));
        }
        return decision === 'approved';
      } finally {
        if (id) this.journal!.finish(id, promptSignal.aborted ? cancelled() : decision);
      }
    });
    this.queue = work.then(() => undefined, () => undefined);
    let onAbort: (() => void) | undefined;
    const decision = Promise.race([work, new Promise<false>((resolve) => {
      onAbort = () => resolve(false);
      promptSignal.addEventListener('abort', onAbort, { once: true });
    })]);
    scope.set(key, decision);
    this.pending.set(signal, scope);
    try {
      return await decision;
    } finally {
      if (onAbort) promptSignal.removeEventListener('abort', onAbort);
      active?.delete(controller);
      if (binding && !active?.size) this.activePrompts.delete(binding.request);
      scope.delete(key);
      if (!scope.size) this.pending.delete(signal);
    }
  }
}
