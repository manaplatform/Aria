import { randomUUID } from 'node:crypto';
import { MessageChannelMain, type MessagePortMain } from 'electron';
import {
  browserCancelSchema,
  browserRequestSchema,
  type BrowserRequest,
  type BrowserResponse,
} from '@aria/shared';
import type { BrowserController } from './controller';

export interface BrowserBridgeSession {
  port: MessagePortMain;
  generation: string;
  close(): void;
}

export function openBrowserBridge(
  browser: BrowserController,
  authorize: (request: BrowserRequest) => AbortSignal | undefined,
  reserve?: (request: BrowserRequest, fingerprint: string, signal: AbortSignal) => Promise<boolean>,
  scoped?: <T>(request: BrowserRequest, work: () => T) => T,
): BrowserBridgeSession {
  const { port1, port2 } = new MessageChannelMain();
  const generation = randomUUID();
  const active = new Map<string, AbortController>();
  const seen = new Set<string>();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const pending of active.values()) pending.abort();
    active.clear();
    seen.clear();
    port1.close();
  };
  port1.on('close', close);
  port1.on('message', ({ data }) => {
    if (closed) return;
    const cancel = browserCancelSchema.safeParse(data);
    if (cancel.success && cancel.data.generation === generation) {
      active.get(cancel.data.operationId)?.abort();
      return;
    }
    const parsed = browserRequestSchema.safeParse(data);
    if (!parsed.success) return;
    const request = parsed.data;
    const { v, operationId, requestId, conversationId, stepId, op } = request;
    if (
      request.generation !== generation ||
      seen.has(request.operationId) ||
      active.size >= 12 ||
      Buffer.byteLength(JSON.stringify(request)) > 16_384
    )
      return;
    const parent = authorize(request);
    const remaining = Math.min(request.deadline - Date.now(), 80_000);
    const send = (result: BrowserResponse['result']) => {
      if (!closed) {
        try {
          port1.postMessage({
            v,
            generation,
            operationId,
            requestId,
            conversationId,
            stepId,
            op,
            result,
          });
        } catch {
          close();
        }
      }
    };
    if (!parent || parent.aborted || remaining <= 0) {
      send({
        ok: false,
        code: 'RUN_UNAVAILABLE',
        message: 'This browser request no longer belongs to an active chat turn.',
      });
      return;
    }
    if (seen.size >= 8192) {
      // Correlation state is bounded by the lifetime of the managed service.
      send({
        ok: false,
        code: 'BRIDGE_LIMIT',
        message: 'Restart the chat service in Settings before continuing browser actions.',
      });
      return;
    }
    seen.add(request.operationId);
    const controller = new AbortController();
    active.set(request.operationId, controller);
    const signal = AbortSignal.any([controller.signal, parent, AbortSignal.timeout(remaining)]);
    const execute = () => browser.execute(request, signal, {
        approval: () => {
          if (!closed && !signal.aborted)
            port1.postMessage({
              v,
              generation,
              operationId,
              requestId,
              conversationId,
              stepId,
              op,
              progress: 'approval',
            });
        },
        reserve: (fingerprint) => reserve?.(request, fingerprint, signal) ?? Promise.resolve(false),
      });
    void (scoped ? scoped(request, execute) : execute())
      .then(
        (result) => {
          if (!signal.aborted && active.get(request.operationId) === controller) send(result);
        },
        (error: unknown) => {
          if (
            active.get(request.operationId) !== controller ||
            parent.aborted ||
            controller.signal.aborted
          )
            return;
          const code =
            error &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string' &&
            /^[A-Z_]{1,40}$/.test(error.code)
              ? error.code
              : 'BROWSER_ERROR';
          const message =
            code === 'BROWSER_ERROR' || !(error instanceof Error)
              ? 'The browser operation could not complete. Check the tab and try again if the action is safe.'
              : error.message;
          send({ ok: false, code, message: message.slice(0, 400) });
        },
      )
      .finally(() => active.delete(request.operationId));
  });
  port1.start();
  return { port: port2, generation, close };
}
