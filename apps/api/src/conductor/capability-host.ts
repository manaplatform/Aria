import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  capabilityHostReply,
  executionLimits,
  defaultToolPolicy,
  toolPolicySchema,
  type CapabilityHostRequest,
  type CapabilityHostReply,
  type ToolProblem,
} from '@aria/shared';
import type { BrowserPort } from '../web/browser-port.client';
import { RunError } from './run-assets';

type HostCommand = CapabilityHostRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, 'id'>
    : never
  : never;
type RuntimeCommand = Extract<HostCommand, { type: 'runtime' }>;

export class ToolError extends RunError {
  constructor(
    readonly code: ToolProblem['code'],
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class CapabilityHost {
  private policy = defaultToolPolicy;
  private port?: BrowserPort;
  private readonly pending = new Map<string, (reply?: CapabilityHostReply) => void>();

  get current() {
    return this.policy;
  }

  install(policy: unknown, port: BrowserPort) {
    this.policy = toolPolicySchema.parse(policy);
    this.port = port;
    port.on('message', ({ data }) => {
      if (this.port !== port) return;
      const parsed = capabilityHostReply.safeParse(data);
      if (parsed.success) this.pending.get(parsed.data.id)?.(parsed.data);
    });
    port.on('close', () => {
      if (this.port !== port) return;
      this.port = undefined;
      for (const settle of this.pending.values()) settle();
    });
    port.start();
  }

  async request(command: Exclude<HostCommand, RuntimeCommand>, signal: AbortSignal) {
    return (await this.dispatch(command, signal))?.content;
  }

  async runtime(command: RuntimeCommand, signal: AbortSignal) {
    const reply = await this.dispatch(command, signal);
    if (!reply?.runtime)
      throw new ToolError('EXECUTION_FAILED', 'The desktop returned no runtime result.');
    return reply.runtime;
  }

  private async dispatch(command: HostCommand, signal: AbortSignal) {
    signal.throwIfAborted();
    const port = this.port;
    if (!port) {
      if (command.type === 'reserve' && process.env.ARIA_MANAGED !== '1') return;
      throw new ToolError(
        'CAPABILITY_UNAVAILABLE',
        'The desktop capability service is unavailable.',
      );
    }
    const id = randomUUID();
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(command.type === 'runtime' ? executionLimits.operationMs : 5000),
    ]);
    const reply = await new Promise<CapabilityHostReply | undefined>((resolve) => {
      const cancel = () => {
        try {
          port.postMessage({ cancel: id });
        } catch {
          // The desktop connection already closed.
        }
        settle();
      };
      const settle = (value?: CapabilityHostReply) => {
        deadline.removeEventListener('abort', cancel);
        this.pending.delete(id);
        resolve(value);
      };
      this.pending.set(id, settle);
      deadline.addEventListener('abort', cancel, { once: true });
      try {
        port.postMessage({ ...command, id });
      } catch {
        settle();
      }
    });
    signal.throwIfAborted();
    if (!reply) throw new ToolError('TIMEOUT', 'The desktop capability service did not respond.');
    if (!reply.ok) {
      const message =
        reply.code === 'DUPLICATE_DISPATCH'
          ? 'An earlier dispatch may already have taken effect. Check the result before sending a new request.'
          : 'The tool or skill is no longer available to this turn.';
      throw new ToolError(reply.code, reply.message ?? message);
    }
    return reply;
  }
}
