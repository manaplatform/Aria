import type { Response } from 'express';
import type { ChatRequest, ConductorEvent } from '@aria/shared';

type Frame = { event: ConductorEvent; bytes: number };

export class ChatStream {
  private readonly pending: Frame[] = [];
  private bytes = 0;
  private sequence = 0;
  private blocked = false;
  private done?: () => void;
  private congested?: NodeJS.Timeout;

  constructor(
    private readonly response: Response,
    private readonly controller: AbortController,
    private readonly request: ChatRequest,
  ) {
    response.on('drain', this.flush);
    controller.signal.addEventListener('abort', this.close, { once: true });
  }

  readonly push = (event: ConductorEvent) => {
    if (this.controller.signal.aborted || this.response.destroyed) return;
    if (!this.blocked) {
      this.write(event);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 256;
    if (this.bytes + bytes + this.response.writableLength > 1_000_000) {
      this.abort();
      return;
    }
    const tail = this.pending.at(-1);
    if (
      event.type === 'delta' &&
      tail?.event.type === 'delta' &&
      tail.event.text.length + event.text.length <= 16_000
    ) {
      tail.event.text += event.text;
      tail.bytes += bytes;
    } else this.pending.push({ event, bytes });
    this.bytes += bytes;
  };

  heartbeat() {
    if (!this.blocked && !this.controller.signal.aborted) this.send(': heartbeat\n\n');
  }

  async drain() {
    if (!this.blocked || this.controller.signal.aborted) return;
    await new Promise<void>((resolve) => {
      this.done = resolve;
    });
  }

  private write(event: ConductorEvent) {
    const { requestId, conversationId, assistantMessageId, execution } = this.request;
    this.send(
      `data: ${JSON.stringify({
        requestId,
        conversationId,
        assistantMessageId,
        sequence: ++this.sequence,
        ...(execution && { executionId: execution.executionId, generation: execution.generation }),
        ...event,
      })}\n\n`,
    );
  }

  private send(frame: string) {
    this.blocked = !this.response.write(frame);
    if (this.blocked && !this.congested) {
      this.congested = setTimeout(() => this.abort(), 5000);
      this.congested.unref();
    }
  }

  private abort() {
    this.controller.abort();
    this.response.destroy();
  }

  private readonly flush = () => {
    this.blocked = false;
    while (!this.blocked && this.pending.length) {
      const frame = this.pending.shift()!;
      this.bytes -= frame.bytes;
      this.write(frame.event);
    }
    if (!this.blocked) {
      clearTimeout(this.congested);
      this.congested = undefined;
      this.done?.();
    }
  };

  private readonly close = () => {
    clearTimeout(this.congested);
    this.response.off('drain', this.flush);
    this.pending.length = 0;
    this.done?.();
  };
}
