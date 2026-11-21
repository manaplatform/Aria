import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { app, screen, shell, type Display } from 'electron';
import { z } from 'zod';
import { computerLimits, type ComputerAction, type ComputerObservation } from '@aria/shared';
import { captureDisplayThumbnail, displayAccessGranted } from '../screen-capture';
import type { ComputerDriver } from './computer';
import { RuntimeError } from './store';

const response = z.object({
  id: z.string().uuid(),
  error: z.string().max(300).optional(),
  approved: z.boolean().optional(),
  accessibility: z.boolean().optional(),
  trusted: z.boolean().optional(),
  submitted: z.boolean().optional(),
  verified: z.boolean().optional(),
  messages: z.boolean().optional(),
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
    if (!value && (operation === 'screen_pointer' || operation === 'open_application'))
      throw new RuntimeError('OUTCOME_UNCERTAIN', 'The native driver stopped after receiving the action.');
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

type ScreenTarget = { id: number; label: string; requestPointerPermission?: boolean };
type ScreenControl = { helper: Helper; pointer: boolean; messages: boolean };
type Grant = { owner: string; expires: number; key?: string; revision: string } & (
  | { kind: 'window'; helper: Helper }
  | { kind: 'screen'; display: ScreenTarget; control?: ScreenControl }
);

function displayGeometry(display: Display) {
  return JSON.stringify([display.bounds, display.size, display.scaleFactor, display.rotation]);
}

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
      !!this.availableGrant() || [...this.sessions.values()].some((grant) => this.alive(grant))
    );
  }

  private alive(grant: Grant) {
    return grant.kind === 'window'
      ? grant.helper.alive
      : displayAccessGranted() && screen.getAllDisplays().some(({ id }) => id === grant.display.id);
  }

  private availableGrant() {
    if (this.prepared && (!this.alive(this.prepared) || Date.now() >= this.prepared.expires)) {
      this.closeGrant(this.prepared);
      this.prepared = undefined;
    }
    return this.prepared;
  }

  private setPrepared(grant: Grant) {
    if (this.prepared) this.closeGrant(this.prepared);
    this.prepared = grant;
    const timer = setTimeout(() => this.availableGrant(), 120_000);
    timer.unref();
  }

  actions(owner: string, id?: string): ComputerAction['type'][] {
    const grant = id ? this.sessions.get(id) : this.availableGrant();
    if (!grant || grant.owner !== owner || !this.alive(grant)) return [];
    if (grant.kind === 'window') return ['set_value', 'screenshot', 'wait'];
    const actions: ComputerAction['type'][] = ['screenshot', 'open_file_manager'];
    if (grant.control?.helper.alive) {
      if (grant.control.messages) actions.push('open_application');
      if (grant.control.pointer) actions.push('move', 'click');
    }
    return actions;
  }

  targetAlive(owner: string, _target: string, id: string) {
    const grant = this.sessions.get(id);
    return !!grant && grant.owner === owner && this.alive(grant);
  }

  async prepare(owner: string, signal: AbortSignal) {
    const binary = this.binary();
    if (!binary)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Scoped local capture is unavailable on this operating system.',
      );
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
      this.setPrepared({
        kind: 'window',
        owner,
        helper,
        expires: Date.now() + 120_000,
        revision: randomUUID(),
      });
    } catch (error) {
      helper.close();
      throw error;
    }
  }

  async prepareScreen(owner: string, display: ScreenTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    await captureDisplayThumbnail(display.id, { width: 64, height: 64 });
    signal.throwIfAborted();
    const selected = this.selectedDisplay(display.id);
    const control = await this.screenControl(selected, display.requestPointerPermission === true, signal);
    this.setPrepared({
      kind: 'screen',
      owner,
      display,
      control,
      expires: Date.now() + 120_000,
      revision: randomUUID(),
    });
  }

  private selectedDisplay(id: number) {
    const display = screen.getAllDisplays().find((display) => display.id === id);
    if (!display)
      throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'The selected display was disconnected.');
    return display;
  }

  private async screenControl(display: Display, requestPointerPermission: boolean, signal: AbortSignal) {
    const binary = process.platform === 'darwin' ? this.binary() : undefined;
    if (!binary) return;
    const helper = new Helper(binary);
    try {
      const proof = await helper.run('screen_probe', {
        displayId: display.id, bounds: display.bounds, requestPointerPermission,
      }, signal);
      if (proof.approved && (proof.accessibility || proof.messages))
        return { helper, pointer: !!proof.accessibility, messages: !!proof.messages };
    } catch {
      signal.throwIfAborted();
    } finally {
      if (signal.aborted) helper.close();
    }
    helper.close();
  }

  async open(
    owner: string,
    id: string,
    _input: Parameters<ComputerDriver['open']>[2],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const selected = this.availableGrant();
    if (!selected || selected.owner !== owner)
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'Select a window or full screen for this conversation in Settings.',
      );
    this.prepared = undefined;
    this.sessions.set(id, selected);
    return id;
  }

  private grant(owner: string, id: string) {
    const grant = this.sessions.get(id);
    if (!grant || grant.owner !== owner || !this.alive(grant))
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'The local desktop selection expired or was revoked.',
      );
    return grant;
  }

  async observe(owner: string, target: string, id: string, image: boolean, signal: AbortSignal) {
    const grant = this.grant(owner, id);
    if (grant.kind === 'screen') {
      const display = this.selectedDisplay(grant.display.id);
      const geometry = displayGeometry(display);
      if (grant.key !== geometry) {
        grant.key = geometry;
        grant.revision = randomUUID();
      }
      const allowed = this.actions(owner, id);
      const observation: ComputerObservation = {
        id: randomUUID(),
        sessionId: id,
        targetId: target,
        revision: grant.revision,
        at: Date.now(),
        environment: this.environment,
        width: display.size.width,
        height: display.size.height,
        devicePixelRatio: display.scaleFactor,
        title: `Full screen · ${grant.display.label}`,
        state: {
          actions: allowed,
          ...(allowed.includes('open_application') && { applications: ['messages'] }),
        },
      };
      if (!image) return { observation, geometryOnly: true };
      signal.throwIfAborted();
      const side = computerLimits.frameSide;
      let frame = await captureDisplayThumbnail(display.id, { width: side, height: side });
      signal.throwIfAborted();
      this.grant(owner, id);
      if (displayGeometry(this.selectedDisplay(display.id)) !== geometry)
        throw new RuntimeError('PERMISSION_DENIED', 'The display changed during capture. Observe it again.');
      let bytes = frame.toPNG();
      if (bytes.length > computerLimits.imageBytes) {
        const width = Math.max(1, Math.floor(frame.getSize().width / 2));
        frame = frame.resize({ width });
        bytes = frame.toPNG();
      }
      return {
        observation: { ...observation, screenshot: frame.getSize() },
        bytes: new Uint8Array(bytes),
      };
    }
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
    if (grant.kind === 'screen' && (action.type === 'move' || action.type === 'click' || action.type === 'open_application')) {
      const { control } = grant;
      if (!control?.helper.alive || !this.actions(owner, id).includes(action.type))
        throw new RuntimeError('PERMISSION_DENIED', 'The selected display has no verified permission for that action.');
      const display = this.selectedDisplay(grant.display.id);
      if (observation.revision !== grant.revision || grant.key !== displayGeometry(display))
        throw new RuntimeError('PERMISSION_DENIED', 'The display changed. Observe it again before dispatching input.');
      if (action.type === 'open_application') {
        const launched = await control.helper.run('open_application', {
          application: action.application, bounds: display.bounds,
        }, signal);
        if (!launched.verified)
          throw new RuntimeError('OUTCOME_UNCERTAIN', 'The system did not confirm that Messages opened. Observe the desktop before retrying.');
        return 'verified' as const;
      }
      const frame = observation.screenshot;
      if (!frame || action.x >= frame.width || action.y >= frame.height || action.keys?.length)
        throw new RuntimeError('INVALID_ARGUMENT', 'Use an unmodified pointer action inside the current screenshot.');
      const result = await control.helper.run('screen_pointer', {
        action: action.type, bounds: display.bounds, x: (action.x + 0.5) / frame.width,
        y: (action.y + 0.5) / frame.height,
        ...(action.type === 'click' && { button: action.button }),
      }, signal);
      if (!result.submitted || (action.type === 'move' && !result.verified))
        throw new RuntimeError('OUTCOME_UNCERTAIN', 'The system did not confirm the pointer action. Observe the desktop before retrying.');
      if (result.verified) return 'verified' as const;
      return;
    }
    if (grant.kind === 'screen' && action.type === 'open_file_manager') {
      if (observation.revision !== grant.revision)
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'Observe the current display before opening the file manager.',
        );
      signal.throwIfAborted();
      const error = await shell.openPath(app.getPath('home'));
      signal.throwIfAborted();
      if (error)
        throw new RuntimeError('EXECUTION_FAILED', 'The system could not open the file manager.');
      return;
    }
    if (
      grant.kind !== 'window' ||
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
      this.closeGrant(grant);
      this.sessions.delete(id);
    }
  }

  disconnectDisplay(displayId: number) {
    if (this.prepared?.kind === 'screen' && this.prepared.display.id === displayId) {
      this.closeGrant(this.prepared);
      this.prepared = undefined;
    }
    for (const [id, grant] of this.sessions) {
      if (grant.kind === 'screen' && grant.display.id === displayId) this.close(grant.owner, id, id);
    }
  }

  revoke() {
    if (this.prepared) this.closeGrant(this.prepared);
    this.prepared = undefined;
    for (const grant of this.sessions.values()) this.closeGrant(grant);
    this.sessions.clear();
  }

  private closeGrant(grant: Grant) {
    if (grant.kind === 'window') grant.helper.close();
    else grant.control?.helper.close();
  }
}
