import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { MemoryStore } from './store';
import type { MemoryMethod } from './worker';

export class MemoryClient {
  private worker?: Worker;
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      finish: (value: unknown, error?: string) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly directory: string,
    private readonly diagnostic: (event: string, detail?: { method?: string; durationMs?: number }) => void = () => {}) {}
  private report(event: string, detail?: { method?: string; durationMs?: number }) {
    try { this.diagnostic(event, detail); } catch { /* Diagnostics cannot affect memory. */ }
  }

  private start() {
    const worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: this.directory });
    this.report('worker.started');
    this.worker = worker;
    const fail = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.finish(undefined, 'Memory storage is unavailable. Check Memory settings.');
      }
      this.pending.clear();
    };
    worker.on('error', () => { this.report('worker.failed'); fail(); });
    worker.on('exit', (code) => { if (code !== 0 && !this.closed) this.report('worker.exited'); fail(); });
    worker.on('message', ({ id, value, error }) => {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.finish(value, error);
    });
    return worker;
  }

  call<M extends MemoryMethod>(
    method: M,
    ...args: Parameters<MemoryStore[M]>
  ): Promise<ReturnType<MemoryStore[M]>> {
    if (this.closed || this.pending.size >= 32)
      return Promise.reject(new Error('Memory storage is busy or unavailable.'));
    let worker: Worker;
    try {
      worker = this.worker ?? this.start();
    } catch {
      return Promise.reject(new Error('The memory worker could not start.'));
    }
    const id = ++this.sequence;
    const started = Date.now();
    this.report('operation.started', { method });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.report('operation.timed_out', { method, durationMs: Date.now() - started }); void worker.terminate(); }, 12_000);
      this.pending.set(id, {
        timer,
        finish: (value, error) => {
          this.report(error ? 'operation.failed' : 'operation.completed', { method, durationMs: Date.now() - started });
          if (error) reject(new Error(error)); else resolve(value as ReturnType<MemoryStore[M]>);
        },
      });
      try {
        worker.postMessage({ id, method, args });
      } catch {
        void worker.terminate();
      }
    });
  }

  async close() {
    if (this.worker) await this.call('close').catch(() => undefined);
    this.closed = true;
  }
}
