import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  capabilityHostReply,
  capabilityHostEvent,
  type ConnectorInventory,
  executionLimits,
  defaultToolPolicy,
  toolPolicySchema,
  type CapabilityHostRequest,
  type CapabilityHostReply,
  type ToolProblem,
} from '@aria/shared';
import type { BrowserPort } from '../web/browser-port.client';
import { RunError } from './run-assets';
import { StandaloneDispatch } from './standalone-dispatch';

type HostCommand = CapabilityHostRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, 'id'>
    : never
  : never;
type RuntimeCommand = Extract<HostCommand, { type: 'runtime' }>;
type CheckpointCommand = Extract<HostCommand, { type: 'checkpoint' }>;

export class ToolError extends RunError {
  constructor(
    readonly code: ToolProblem['code'],
    message: string,
    readonly category?: string,
    readonly phase?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

@Injectable()
export class CapabilityHost implements OnModuleDestroy {
  private policy = defaultToolPolicy;
  connectors?: ConnectorInventory;
  private readonly progressListeners = new Map<string, (event: 'approval' | 'dispatch') => void>();
  private port?: BrowserPort;
  private readonly pending = new Map<string, (reply?: CapabilityHostReply) => void>();
  private readonly standalone = new StandaloneDispatch();

  onModuleDestroy() {
    this.standalone.close();
    for (const settle of this.pending.values()) settle();
  }

  get current() {
    return this.policy;
  }

  install(policy: unknown, port: BrowserPort) {
    this.policy = toolPolicySchema.parse(policy);
    this.port = port;
    this.connectors = undefined;
    port.on('message', ({ data }) => {
      if (this.port !== port) return;
      const event = capabilityHostEvent.safeParse(data);
      if (event.success) {
        if (event.data.event === 'connectors') this.connectors = event.data.inventory;
        else this.progressListeners.get(event.data.id)?.(event.data.event);
        return;
      }
      const parsed = capabilityHostReply.safeParse(data);
      if (parsed.success) this.pending.get(parsed.data.id)?.(parsed.data);
    });
    port.on('close', () => {
      if (this.port !== port) return;
      this.port = undefined;
      this.connectors = undefined;
      for (const settle of this.pending.values()) settle();
    });
    port.start();
  }

  async request(command: Exclude<HostCommand, RuntimeCommand>, signal: AbortSignal) {
    return (await this.dispatch(command, signal))?.content;
  }

  async runtime(command: RuntimeCommand, signal: AbortSignal, progress?: (event: 'approval' | 'dispatch') => void) {
    const reply = await this.dispatch(command, signal, progress);
    if (!reply?.runtime)
      throw new ToolError('EXECUTION_FAILED', 'The desktop returned no runtime result.');
    return reply.runtime;
  }

  async checkpoint(command: CheckpointCommand, signal: AbortSignal) {
    return (await this.dispatch(command, signal))?.checkpointed === true;
  }

  private async dispatch(command: HostCommand, signal: AbortSignal, progress?: (event: 'approval' | 'dispatch') => void) {
    signal.throwIfAborted();
    const port = this.port;
    if (!port) {
      if ((command.type === 'reserve' || command.type === 'receipt') && process.env.ARIA_MANAGED !== '1') {
        try {
          const accepted = command.type === 'reserve'
            ? this.standalone.reserve(command)
            : this.standalone.settle(command, command.state);
          if (accepted) return;
        } catch {
          throw new ToolError('CAPABILITY_UNAVAILABLE', 'The standalone dispatch journal is unavailable. Check its directory permissions.');
        }
        throw new ToolError('DUPLICATE_DISPATCH', 'The operation already has a reservation or receipt.');
      }
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
        this.progressListeners.delete(id);
        resolve(value);
      };
      this.pending.set(id, settle);
      if (progress) this.progressListeners.set(id, progress);
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
      throw new ToolError(reply.code, reply.message ?? message, reply.category, undefined, reply.retryAfterMs);
    }
    return reply;
  }
}
