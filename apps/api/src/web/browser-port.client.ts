import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  browserProgressSchema,
  browserResponseSchema,
  type BrowserRequest,
  type BrowserResponse,
} from '@aria/shared';

export interface BrowserPort {
  start(): void;
  close(): void;
  postMessage(message: unknown): void;
  on(event: 'message', callback: (event: { data: unknown }) => void): void;
  on(event: 'close', callback: () => void): void;
}

@Injectable()
export class BrowserPortClient {
  private connection?: { port: BrowserPort; generation: string };
  private readonly pending = new Map<
    string,
    {
      request: BrowserRequest;
      approval?: () => void;
      settle: (response?: BrowserResponse, error?: Error) => void;
    }
  >();

  get available() {
    return !!this.connection;
  }

  install(port: BrowserPort, generation: string) {
    const connection = { port, generation };
    this.connection = connection;
    port.on('message', ({ data }) => {
      if (this.connection !== connection) return;
      const progress = browserProgressSchema.safeParse(data);
      if (progress.success) {
        const {
          operationId,
          requestId,
          conversationId,
          generation: observed,
          stepId,
          op,
        } = progress.data;
        const entry = this.pending.get(operationId);
        if (
          entry &&
          observed === generation &&
          entry.request.requestId === requestId &&
          entry.request.conversationId === conversationId &&
          entry.request.stepId === stepId &&
          entry.request.op === op
        )
          entry.approval?.();
        return;
      }
      const parsed = browserResponseSchema.safeParse(data);
      if (!parsed.success) return;
      const response = parsed.data;
      const pending = this.pending.get(response.operationId);
      if (
        !pending ||
        response.generation !== generation ||
        response.requestId !== pending.request.requestId ||
        response.conversationId !== pending.request.conversationId ||
        response.stepId !== pending.request.stepId ||
        response.op !== pending.request.op
      )
        return;
      if (response.result.ok && (response.result.screenshot?.byteLength ?? 0) > 1024 * 1024)
        pending.settle(undefined, new Error('The browser screenshot exceeded its size limit.'));
      else pending.settle(response);
    });
    port.on('close', () => {
      if (this.connection !== connection) return;
      this.connection = undefined;
      for (const pending of this.pending.values())
        pending.settle(undefined, new Error('The native browser connection closed.'));
    });
    port.start();
  }

  invoke(
    input: Omit<BrowserRequest, 'v' | 'generation' | 'operationId' | 'deadline'>,
    signal: AbortSignal,
    approval?: () => void,
  ) {
    signal.throwIfAborted();
    const connection = this.connection;
    if (!connection) throw new Error('The native browser requires Aria Desktop.');
    const request: BrowserRequest = {
      ...input,
      v: 1,
      generation: connection.generation,
      operationId: randomUUID(),
      deadline: Date.now() + 80_000,
    };
    if (Buffer.byteLength(JSON.stringify(request)) > 16_384)
      throw new Error('The browser request is too large.');
    return new Promise<BrowserResponse['result']>((resolve, reject) => {
      const cancel = () => {
        try {
          connection.port.postMessage({
            generation: request.generation,
            operationId: request.operationId,
          });
        } catch {
          /* Closed. */
        }
        settle(
          undefined,
          new Error(
            signal.aborted ? 'The browser operation stopped.' : 'The browser operation timed out.',
          ),
        );
      };
      const settle = (response?: BrowserResponse, error?: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        this.pending.delete(request.operationId);
        if (response) resolve(response.result);
        else reject(error);
      };
      const timer = setTimeout(cancel, 80_000);
      this.pending.set(request.operationId, { request, settle, approval });
      signal.addEventListener('abort', cancel, { once: true });
      try {
        connection.port.postMessage(request);
      } catch {
        settle(undefined, new Error('The native browser connection closed.'));
      }
    });
  }
}
