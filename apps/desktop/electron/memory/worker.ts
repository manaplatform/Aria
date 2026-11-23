import { parentPort, workerData } from 'node:worker_threads';
import { MemoryStore } from './store';

export const methods = [
  'status',
  'diagnostics',
  'saveSettings',
  'search',
  'read',
  'resolve',
  'remember',
  'edit',
  'forget',
  'clear',
  'removeConversation',
  'enqueue',
  'process',
  'maintain',
  'embeddingBatch',
  'saveVectors',
  'dense',
  'exportPage',
  'close',
] as const;
export type MemoryMethod = (typeof methods)[number];

if (parentPort) {
  const port = parentPort;
  const store = new MemoryStore(String(workerData));
  port.on(
    'message',
    ({ id, method, args }: { id: number; method: MemoryMethod; args: never[] }) => {
      if (!methods.includes(method)) return;
      try {
        const value = Reflect.apply(store[method], store, args);
        port.postMessage({ id, value });
        if (method === 'close') port.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The memory operation failed.';
        port.postMessage({
          id,
          error: /^SQLITE|database|constraint|syntax error/i.test(message)
            ? 'Memory storage is temporarily unavailable. Retry in Settings.'
            : message.slice(0, 250),
        });
      }
    },
  );
}
