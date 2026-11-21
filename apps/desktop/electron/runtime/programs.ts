import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import {
  programFrameSchema,
  programJson,
  programLimits,
  programReplySchema,
  type CapabilityHostRequest,
  type ProgramFrame,
} from '@aria/shared';
import type { DockerSandbox } from './sandbox';
import { RuntimeError } from './store';

type Request = Extract<CapabilityHostRequest, { type: 'runtime' }>;
const startSchema = z.strictObject({
  code: z.string().min(1).max(programLimits.code),
  bindings: z.record(z.string().max(100), z.string().uuid()).refine((v) => Object.keys(v).length <= 8),
  toolCalls: z.number().int().min(1).max(12),
  milliseconds: z.number().int().min(1).max(120_000),
});
const exchangeSchema = z.strictObject({
  replies: z.array(programReplySchema).max(12),
  wait: z.number().int().min(0).max(500),
});
type Start = z.infer<typeof startSchema>;
type Session = {
  owner: string;
  frames: ProgramFrame[];
  awaiting: Set<number>;
  seen: Set<number>;
  wake?: () => void;
  reply: (value: object) => void;
  done: Promise<void>;
  close: () => void;
};

function parse<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(programJson(value, programLimits.frame));
  if (!parsed.success) throw new RuntimeError('INVALID_ARGUMENT', 'Invalid program runtime request.');
  return parsed.data;
}

export class ProgramRuntime {
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Set<string>();

  private owner(request: Request) {
    return JSON.stringify([request.conversationId, request.assistantMessageId, request.requestId, request.revision]);
  }

  async dispatch(
    request: Request,
    engine: DockerSandbox,
    image: string,
    signal: AbortSignal,
  ) {
    const id = request.stepId;
    if (request.operation === 'program.start') {
      if (this.sessions.has(id) || this.starting.has(id) || this.sessions.size + this.starting.size >= 4)
        throw new RuntimeError('BUDGET_EXCEEDED', 'The desktop program runner is busy.');
      this.starting.add(id);
      try {
        await this.start(id, this.owner(request), engine, image, parse(startSchema, request.input), signal);
        return {};
      } finally {
        this.starting.delete(id);
      }
    }
    const session = this.sessions.get(id);
    if (!session || session.owner !== this.owner(request))
      throw new RuntimeError('PERMISSION_DENIED', 'The program no longer belongs to this turn.');
    if (request.operation === 'program.stop') {
      await this.stop(id, session);
      return {};
    }
    const { replies, wait } = parse(exchangeSchema, request.input);
    if (session.wake) throw new RuntimeError('DUPLICATE_DISPATCH', 'A program exchange is already pending.');
    for (const reply of replies) {
      if (!session.awaiting.delete(reply.id))
        throw new RuntimeError('CALLER_MISMATCH', 'The program reply does not match a pending call.');
      session.reply(reply);
    }
    await this.wait(session, wait, signal);
    return { data: { frames: this.drain(session) } };
  }

  private async start(
    id: string, owner: string, engine: DockerSandbox, image: string, input: Start, signal: AbortSignal,
  ) {
    const child = await engine.programProcess(id, image, signal);
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let terminal = false;
    let stopping = false;
    const finish = () => {
      if (stopping) return;
      stopping = true;
      child.stdin.destroy();
      child.kill('SIGKILL');
    };
    const done = new Promise<void>((resolve) => {
      child.on('close', () => {
        clearTimeout(timer);
        if (!terminal) receive({ type: 'failure', code: 'EXECUTION_FAILED' });
        void engine.remove(id).finally(resolve);
      });
    });
    const session: Session = {
      owner, frames: [], awaiting: new Set(), seen: new Set(), done, close: finish,
      reply: (value) => {
        if (!stopping && !terminal) child.stdin.write(JSON.stringify(value) + '\n');
      },
    };
    const receive = (frame: ProgramFrame) => {
      if (terminal) return;
      terminal = frame.type !== 'call';
      session.frames.push(frame);
      session.wake?.();
    };
    const fail = (code: 'BUDGET_EXCEEDED' | 'EXECUTION_FAILED' | 'INVALID_PROGRAM') => {
      receive({ type: 'failure', code });
      finish();
    };
    const timer = setTimeout(() => fail('BUDGET_EXCEEDED'), input.milliseconds);
    child.on('error', () => fail('EXECUTION_FAILED'));
    child.stdin.on('error', () => fail('EXECUTION_FAILED'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (terminal || stopping) return;
      buffer += decoder.write(chunk);
      try {
        while (!terminal && buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) >= programLimits.frame) throw new Error();
          const frame = parse(programFrameSchema, JSON.parse(line));
          if (frame.type === 'call') {
            if (
              session.seen.has(frame.id) || session.seen.size >= input.toolCalls ||
              !Object.values(input.bindings).includes(frame.handle)
            ) throw new Error();
            session.seen.add(frame.id);
            session.awaiting.add(frame.id);
          }
          receive(frame);
        }
        if (Buffer.byteLength(buffer) >= programLimits.frame) throw new Error();
      } catch {
        fail('INVALID_PROGRAM');
      }
    });
    this.sessions.set(id, session);
    if (signal.aborted) {
      await this.stop(id, session);
      signal.throwIfAborted();
    }
    session.reply(input);
  }

  private async wait(session: Session, milliseconds: number, signal: AbortSignal) {
    if (session.frames.length || !milliseconds) return;
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        session.wake = undefined;
        signal.removeEventListener('abort', wake);
        resolve();
      };
      const timer = setTimeout(wake, milliseconds);
      session.wake = wake;
      signal.addEventListener('abort', wake, { once: true });
      if (signal.aborted) wake();
    });
    signal.throwIfAborted();
  }

  private drain(session: Session) {
    const next: ProgramFrame[] = [];
    let size = 2;
    while (session.frames.length) {
      const length = Buffer.byteLength(JSON.stringify(session.frames[0])) + 1;
      if (next.length && size + length > programLimits.frame) break;
      next.push(session.frames.shift()!);
      size += length;
    }
    return next;
  }

  async stop(id: string, session: Session) {
    this.sessions.delete(id);
    session.close();
    await session.done;
  }

  release(requestId?: string) {
    return Promise.all([...this.sessions].flatMap(([id, session]) =>
      !requestId || (JSON.parse(session.owner) as string[])[2] === requestId
        ? [this.stop(id, session)]
        : [],
    ));
  }

  async probe(engine: DockerSandbox, image: string, signal: AbortSignal) {
    const id = randomUUID();
    const handle = randomUUID();
    await this.start(id, '[]', engine, image, {
      code: 'const answer = await tools.invoke("probe.echo", { value: 21 }); return { value: answer.value * 2, isolated: typeof process === "undefined" && typeof require === "undefined" && typeof fetch === "undefined" };',
      bindings: { 'probe.echo': handle },
      toolCalls: 1,
      milliseconds: 8000,
    }, signal);
    const session = this.sessions.get(id)!;
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(8500)]);
      while (!deadline.aborted) {
        await this.wait(session, 500, deadline);
        for (const frame of this.drain(session)) {
          if (frame.type === 'call' && frame.handle === handle && JSON.stringify(frame.input) === '{"value":21}') {
            session.awaiting.delete(frame.id);
            session.reply({ id: frame.id, value: { value: 21 } });
          } else if (frame.type === 'result' && JSON.stringify(frame.value) === '{"value":42,"isolated":true}') {
            return;
          } else {
            throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'The isolated JavaScript runner failed its capability probe.');
          }
        }
      }
      deadline.throwIfAborted();
    } finally {
      await this.stop(id, session);
    }
  }
}
