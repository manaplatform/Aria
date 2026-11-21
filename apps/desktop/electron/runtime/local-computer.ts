import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { computerLimits, type ComputerObservation } from '@aria/shared';
import type { ComputerDriver } from './computer';
import { RuntimeError } from './store';

const response = z.object({
  id: z.string().uuid(),
  error: z.string().max(300).optional(),
  approved: z.boolean().optional(),
  accessibility: z.boolean().optional(),
  trusted: z.boolean().optional(),
  submitted: z.boolean().optional(),
  image: z
    .base64()
    .max(Math.ceil(computerLimits.imageBytes / 3) * 4)
    .optional(),
  imageWidth: z.number().int().positive().optional(),
  imageHeight: z.number().int().positive().optional(),
  surface: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().positive(),
      height: z.number().positive(),
      scale: z.number().positive(),
    })
    .optional(),
  title: z.string().max(200).optional(),
  editable: z.boolean().optional(),
  elementId: z.string().uuid().optional(),
});

class Helper {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private pending?: (value?: z.infer<typeof response>) => void;
  private id?: string;
  alive = true;

  constructor(filename: string) {
    this.child = spawn(filename, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 1_500_000) {
        this.close();
        return;
      }
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const parsed = response.parse(JSON.parse(this.buffer.slice(0, end)));
        this.buffer = this.buffer.slice(end + 1);
        if (parsed.id !== this.id) this.close();
        else this.pending?.(parsed);
      } catch {
        this.close();
      }
    });
    this.child.stderr.resume();
    this.child.on('error', () => this.close());
    this.child.on('exit', () => this.close());
    this.child.stdin.on('error', () => this.close());
  }

  async run(operation: string, input: Record<string, unknown>, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.alive || this.pending)
      throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'The native window driver is unavailable.');
    const id = randomUUID();
    this.id = id;
    const value = await new Promise<z.infer<typeof response> | undefined>((resolve) => {
      const abort = () => this.close();
      this.pending = (result) => {
        signal.removeEventListener('abort', abort);
        this.pending = undefined;
        this.id = undefined;
        resolve(result);
      };
      signal.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(`${JSON.stringify({ id, operation, ...input })}\n`);
    });
    signal.throwIfAborted();
    if (!value || value.error)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        value?.error ?? 'The native window driver stopped.',
      );
    return value;
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    this.pending?.();
    this.child.kill('SIGKILL');
  }
}

type Grant = { owner: string; helper: Helper; expires: number; key?: string; revision: string };

export class LocalComputer implements ComputerDriver {
  readonly environment = 'local-desktop' as const;
  private prepared?: Grant;
  private readonly sessions = new Map<string, Grant>();

  private binary() {
    const file =
      process.platform === 'win32'
        ? 'Aria.Computer.exe'
        : process.platform === 'darwin' && Number(release().split('.')[0]) >= 24
          ? 'aria-macos-computer'
          : undefined;
    if (!file) return;
    const filename = path.join(__dirname, '..', 'computer-helpers', file);
    return existsSync(filename) ? filename : undefined;
  }

  supported() {
    return !!this.binary();
  }

  ready() {
    return (
      !!this.binary() &&
      (this.hasPrepared() || [...this.sessions.values()].some(({ helper }) => helper.alive))
    );
  }

  private hasPrepared() {
    if (this.prepared && (!this.prepared.helper.alive || Date.now() >= this.prepared.expires)) {
      this.prepared.helper.close();
      this.prepared = undefined;
    }
    return !!this.prepared;
  }

  async prepare(owner: string, signal: AbortSignal) {
    const binary = this.binary();
    if (!binary)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Scoped local capture is unavailable on this operating system.',
      );
    this.prepared?.helper.close();
    this.prepared = undefined;
    const helper = new Helper(binary);
    try {
      const picked = await helper.run('pick', {}, signal);
      if (!picked.approved)
        throw new RuntimeError('PERMISSION_DENIED', 'Select an authorized text editor window.');
      if (!picked.accessibility && !(await helper.run('accessibility', {}, signal)).trusted)
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'Allow the local driver in macOS Accessibility settings, then select the window again.',
        );
      const observed = await helper.run('observe', { image: true }, signal);
      if (!observed.image || !observed.editable)
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'Open an editable text editor window and select it again.',
        );
      this.prepared = { owner, helper, expires: Date.now() + 120_000, revision: randomUUID() };
      const timer = setTimeout(() => this.hasPrepared(), 120_000);
      timer.unref();
    } catch (error) {
      helper.close();
      throw error;
    }
  }

  async open(
    owner: string,
    id: string,
    _input: Parameters<ComputerDriver['open']>[2],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.hasPrepared();
    const selected = this.prepared;
    if (!selected || selected.owner !== owner)
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'Select a window for this conversation from Aria’s trusted local desktop control.',
      );
    this.prepared = undefined;
    this.sessions.set(id, selected);
    return id;
  }

  private grant(owner: string, id: string) {
    const grant = this.sessions.get(id);
    if (!grant || grant.owner !== owner || !grant.helper.alive)
      throw new RuntimeError('PERMISSION_DENIED', 'The local window grant expired or was revoked.');
    return grant;
  }

  async observe(owner: string, target: string, id: string, image: boolean, signal: AbortSignal) {
    const grant = this.grant(owner, id);
    const captured = await grant.helper.run('observe', { image }, signal);
    if (!captured.surface || !captured.editable || !captured.elementId)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Select and focus the approved editable text editor window.',
      );
    const key = JSON.stringify([captured.surface, captured.elementId]);
    if (grant.key !== key) {
      grant.key = key;
      grant.revision = randomUUID();
    }
    const observation: ComputerObservation = {
      id: randomUUID(),
      sessionId: id,
      targetId: target,
      revision: grant.revision,
      at: Date.now(),
      environment: this.environment,
      width: Math.round(captured.surface.width),
      height: Math.round(captured.surface.height),
      devicePixelRatio: captured.surface.scale,
      title: captured.title,
      state: { editable: true, elementId: captured.elementId },
    };
    if (image && captured.image && captured.imageWidth && captured.imageHeight) {
      observation.screenshot = { width: captured.imageWidth, height: captured.imageHeight };
      return { observation, bytes: new Uint8Array(Buffer.from(captured.image, 'base64')) };
    }
    if (image)
      throw new RuntimeError(
        'EXECUTION_FAILED',
        'The local driver did not return an authorized frame.',
      );
    return { observation };
  }

  async input(
    owner: string,
    _target: string,
    id: string,
    observation: ComputerObservation,
    action: Parameters<ComputerDriver['input']>[4],
    signal: AbortSignal,
  ) {
    const grant = this.grant(owner, id);
    if (
      action.type !== 'set_value' ||
      action.elementId !== observation.state?.elementId ||
      observation.revision !== grant.revision
    )
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'Only the current authorized text editor control can receive local input.',
      );
    const result = await grant.helper.run(
      'set_value',
      { elementId: action.elementId, text: action.text },
      signal,
    );
    if (!result.submitted)
      throw new RuntimeError(
        'OUTCOME_UNCERTAIN',
        'Inspect the text editor before repeating this change.',
      );
  }

  owner(owner: string, _target: string, id: string) {
    this.grant(owner, id).revision = randomUUID();
  }

  close(owner: string, _target: string, id: string) {
    const grant = this.sessions.get(id);
    if (grant?.owner === owner) {
      grant.helper.close();
      this.sessions.delete(id);
    }
  }

  revoke() {
    this.prepared?.helper.close();
    this.prepared = undefined;
    for (const grant of this.sessions.values()) grant.helper.close();
    this.sessions.clear();
  }
}
