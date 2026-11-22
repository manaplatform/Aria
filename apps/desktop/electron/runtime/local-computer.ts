import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import { app, nativeImage, screen, shell, type Display } from 'electron';
import { z } from 'zod';
import {
  computerLimits,
  type ComputerAction,
  type ComputerObservation,
  type LocalDesktopAccess,
} from '@aria/shared';
import { captureDisplayThumbnail, displayAccessGranted } from '../screen-capture';
import { isLocalPointerAction, localPointerPoints, type ComputerDriver } from './computer';
import { digest, RuntimeError, type LocalDesktopGrant, type RuntimeStore } from './store';

const response = z.object({
  id: z.string().uuid(),
  error: z.string().max(300).optional(),
  approved: z.boolean().optional(),
  accessibility: z.boolean().optional(),
  trusted: z.boolean().optional(),
  submitted: z.boolean().optional(),
  verified: z.boolean().optional(),
  applicationLaunch: z.boolean().optional(),
  application: z
    .object({
      token: z.string().uuid(),
      path: z.string().min(1).max(4096).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u),
      bundleId: z.string().min(1).max(256).regex(/^[A-Za-z0-9.-]+$/),
    })
    .optional(),
  displayKey: z.string().min(1).max(256).optional(),
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
  private operation?: string;
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
    this.operation = operation;
    const value = await new Promise<z.infer<typeof response> | undefined>((resolve) => {
      const abort = () => this.close();
      this.pending = (result) => {
        signal.removeEventListener('abort', abort);
        this.pending = undefined;
        this.id = undefined;
        this.operation = undefined;
        resolve(result);
        if (!this.alive) this.child.kill();
      };
      signal.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(`${JSON.stringify({ id, operation, ...input })}\n`);
    });
    signal.throwIfAborted();
    if (!value && (operation === 'screen_pointer' || operation === 'open_application'))
      throw new RuntimeError(
        'OUTCOME_UNCERTAIN',
        'The native driver stopped after receiving the action.',
      );
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
    if (this.operation === 'screen_pointer') {
      // A submitted native gesture is bounded and must be allowed to release its button.
      const deadline = setTimeout(() => {
        if (this.pending) {
          this.pending();
          this.child.kill('SIGKILL');
        }
      }, 1000);
      deadline.unref();
      return;
    }
    this.pending?.();
    this.child.kill('SIGKILL');
  }
}

type ScreenTarget = { id: number; label: string; requestPointerPermission?: boolean };
type ScreenControl = { helper: Helper; displayKey: string; pointer: boolean; applicationLaunch: boolean };
const screenActions = ['screenshot', 'open_file_manager'] as const;
const pointerActions = ['move', 'click', 'double_click', 'drag', 'scroll'] as const;
type Grant = { owner: string; expires: number; key?: string; revision: string } & (
  | { kind: 'window'; helper: Helper }
  | { kind: 'screen'; display: ScreenTarget; control?: ScreenControl; standing?: LocalDesktopGrant }
);

function displayGeometry(display: Display) {
  return JSON.stringify([display.bounds, display.size, display.scaleFactor, display.rotation]);
}

export class LocalComputer implements ComputerDriver {
  readonly environment = 'local-desktop' as const;
  private prepared?: Grant;
  private readonly sessions = new Map<string, Grant>();

  private suspended = false;
  private generation = 0;

  constructor(
    private readonly store: RuntimeStore,
    private readonly providerIdentity: () => string | undefined,
  ) {}

  private binary() {
    const file =
      process.platform === 'win32'
        ? 'Aria.Computer.exe'
        : process.platform === 'darwin' && Number(release().split('.')[0]) >= 24
          ? 'aria-macos-computer'
          : undefined;
    if (!file) return;
    const filename = app.isPackaged
      ? path.join(process.resourcesPath, 'aria-computer', file)
      : path.join(__dirname, '..', 'computer-helpers', file);
    return existsSync(filename) ? filename : undefined;
  }

  supported() {
    return !!this.binary();
  }

  configured() {
    return !!this.standingGrant() || this.ready();
  }

  ready() {
    return (
      !this.suspended &&
      (!!this.availableGrant() ||
        !!this.standingGrant() ||
        [...this.sessions.values()].some((grant) => this.alive(grant)))
    );
  }

  private standingGrant() {
    const provider = this.providerIdentity();
    if (!provider) return;
    try {
      const grant = this.store.localDesktopGrant();
      if (grant?.provider === provider) return grant;
    } catch {
      // An unreadable grant store denies desktop access without blocking ordinary chat.
    }
  }

  private alive(grant: Grant) {
    if (this.suspended) return false;
    if (grant.kind === 'window') return grant.helper.alive;
    return (
      (!grant.standing || grant.standing.id === this.standingGrant()?.id) &&
      (!grant.control || grant.control.helper.alive) &&
      displayAccessGranted() &&
      screen.getAllDisplays().some(({ id }) => id === grant.display.id)
    );
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

  private screenActions(control?: ScreenControl): ComputerAction['type'][] {
    return [
      ...screenActions,
      ...(control?.applicationLaunch ? ['open_application' as const] : []),
      ...(control?.pointer ? pointerActions : []),
    ];
  }

  actions(owner: string, id?: string): ComputerAction['type'][] {
    const grant = id ? this.sessions.get(id) : this.availableGrant();
    if (!grant || grant.owner !== owner || !this.alive(grant)) return [];
    return grant.kind === 'window'
      ? ['set_value', 'screenshot', 'wait']
      : this.screenActions(grant.control);
  }

  async inspectActions(owner: string, signal: AbortSignal) {
    const prepared = this.actions(owner);
    const standing = this.standingGrant();
    if (prepared.length || !standing || this.suspended || !displayAccessGranted()) return prepared;
    const found = await this.resolveScreen(standing.displayKey, signal);
    if (!found) return [];
    try {
      await captureDisplayThumbnail(found.display.id, { width: 64, height: 64 });
      await this.checkScreen(found.control, found.display, signal);
      signal.throwIfAborted();
      if (this.suspended || this.standingGrant()?.id !== standing.id) return [];
      return this.screenActions(found.control);
    } catch {
      signal.throwIfAborted();
      return [];
    } finally {
      found.control.helper.close();
    }
  }

  targetAlive(owner: string, _target: string, id: string) {
    const grant = this.sessions.get(id);
    return !!grant && grant.owner === owner && this.alive(grant);
  }

  standingAccess(owner: string, id: string, provider: string) {
    const grant = this.sessions.get(id);
    return (
      grant?.kind === 'screen' &&
      grant.owner === owner &&
      grant.standing?.provider === provider &&
      this.alive(grant)
    );
  }

  pointerFingerprint(
    ...[capture, action]: Parameters<NonNullable<ComputerDriver['pointerFingerprint']>>
  ) {
    const { screenshot } = capture.observation;
    if (!capture.bytes || !screenshot) return;
    const image = nativeImage.createFromBuffer(Buffer.from(capture.bytes));
    if (image.isEmpty()) return;
    const { width, height } = image.getSize();
    if (width !== screenshot.width || height !== screenshot.height) return;
    // Changes elsewhere on the display, such as the approval dialog closing, are immaterial.
    const radius = 48;
    const regions = localPointerPoints(action, screenshot).map((point) => {
      const x = Math.max(0, point.x - radius);
      const y = Math.max(0, point.y - radius);
      const region = image.crop({
        x,
        y,
        width: Math.min(width, point.x + radius + 1) - x,
        height: Math.min(height, point.y + radius + 1) - y,
      });
      return region.isEmpty() ? undefined : digest(region.toPNG());
    });
    if (regions.every(Boolean)) return digest(JSON.stringify(regions));
  }

  async prepare(owner: string, signal: AbortSignal, beforeCommit = () => {}) {
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
      beforeCommit();
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

  async prepareScreen(
    owner: string,
    display: ScreenTarget,
    signal: AbortSignal,
    standingProvider?: string,
    beforeCommit = () => {},
  ) {
    signal.throwIfAborted();
    const selected = this.selectedDisplay(display.id);
    const helper = this.newHelper();
    try {
      const control =
        helper && (await this.probe(helper, selected, !!display.requestPointerPermission, signal));
      if (standingProvider) {
        const matched = control && (await this.resolveScreen(control.displayKey, signal));
        if (!matched || matched.display.id !== display.id) {
          matched?.control.helper.close();
          throw new RuntimeError(
            'CAPABILITY_UNAVAILABLE',
            'Aria could not identify this display for ongoing access.',
          );
        }
        matched.control.helper.close();
      }
      try {
        await captureDisplayThumbnail(display.id, { width: 64, height: 64 });
      } catch (error) {
        if (!standingProvider || displayAccessGranted()) throw error;
      }
      if (control) await this.checkScreen(control, selected, signal);
      signal.throwIfAborted();
      beforeCommit();
      if (this.suspended)
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'Unlock the desktop before selecting a display.',
        );
      if (standingProvider && control) {
        if (this.providerIdentity() !== standingProvider)
          throw new RuntimeError(
            'PERMISSION_DENIED',
            'The primary changed during display selection.',
          );
        this.store.saveLocalDesktopGrant({
          id: randomUUID(),
          provider: standingProvider,
          displayKey: control.displayKey,
          label: display.label,
        });
        this.closePrepared();
      } else {
        this.setPrepared({
          kind: 'screen',
          owner,
          display,
          control,
          expires: Date.now() + 120_000,
          revision: randomUUID(),
        });
        if (control) return;
      }
    } catch (error) {
      helper?.close();
      throw error;
    }
    helper?.close();
  }

  private selectedDisplay(id: number) {
    const display = screen.getAllDisplays().find((display) => display.id === id);
    if (!display)
      throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'The selected display was disconnected.');
    return display;
  }

  private newHelper() {
    const binary = this.binary();
    if (binary) return new Helper(binary);
  }

  private screenBounds(display: Display) {
    return process.platform === 'win32'
      ? screen.dipToScreenRect(null, display.bounds)
      : display.bounds;
  }

  private async probe(
    helper: Helper,
    display: Display,
    requestPointerPermission: boolean,
    signal: AbortSignal,
  ) {
    try {
      const proof = await helper.run(
        'screen_probe',
        {
          displayId: display.id,
          bounds: this.screenBounds(display),
          requestPointerPermission,
        },
        signal,
      );
      if (proof.approved && proof.displayKey) {
        return {
          helper,
          displayKey: proof.displayKey,
          pointer: !!proof.accessibility,
          applicationLaunch: !!proof.applicationLaunch,
        };
      }
    } catch {
      signal.throwIfAborted();
    }
  }

  private async checkScreen(control: ScreenControl, display: Display, signal: AbortSignal) {
    const proof = await this.probe(control.helper, display, false, signal);
    if (
      proof?.displayKey !== control.displayKey ||
      displayGeometry(display) !== displayGeometry(this.selectedDisplay(display.id))
    )
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The selected display changed. Open a new local desktop session.',
      );
    control.pointer = proof.pointer;
    control.applicationLaunch = proof.applicationLaunch;
  }

  private async resolveScreen(displayKey: string, signal: AbortSignal, requestPermission = false) {
    const helper = this.newHelper();
    if (!helper) return;
    let retain = false;
    try {
      let selected: Display | undefined;
      for (const display of screen.getAllDisplays()) {
        const proof = await this.probe(helper, display, false, signal);
        if (proof?.displayKey !== displayKey) continue;
        if (selected) return;
        selected = display;
      }
      if (!selected) return;
      const control = await this.probe(helper, selected, requestPermission, signal);
      if (control?.displayKey !== displayKey) return;
      retain = true;
      return { display: selected, control };
    } finally {
      if (!retain) helper.close();
    }
  }

  async access(signal: AbortSignal, requestPermission = false): Promise<LocalDesktopAccess> {
    const standing = this.store.localDesktopGrant();
    if (!standing) return { state: 'off' };
    const display = standing.label;
    if (this.standingGrant()?.id !== standing.id) return { state: 'primary-changed', display };
    if (this.suspended) return { state: 'unavailable', display };
    const found = await this.resolveScreen(standing.displayKey, signal, requestPermission);
    if (!found) return { state: 'unavailable', display };
    try {
      if (requestPermission || displayAccessGranted()) {
        try {
          await captureDisplayThumbnail(found.display.id, { width: 64, height: 64 });
        } catch {
          signal.throwIfAborted();
          return { state: displayAccessGranted() ? 'unavailable' : 'screen-permission', display };
        }
      }
      signal.throwIfAborted();
      if (!displayAccessGranted()) return { state: 'screen-permission', display };
      return { state: found.control.pointer ? 'ready' : 'pointer-permission', display };
    } finally {
      found.control.helper.close();
    }
  }

  async open(
    owner: string,
    id: string,
    _input: Parameters<ComputerDriver['open']>[2],
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const prepared = this.availableGrant();
    if (prepared?.owner === owner) {
      this.prepared = undefined;
      this.sessions.set(id, prepared);
      return id;
    }
    const standing = this.standingGrant();
    if (!standing || this.suspended)
      throw new RuntimeError('PERMISSION_DENIED', 'Approve a display in Settings → Tools.');
    if (!displayAccessGranted())
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'Allow Aria in macOS Screen & System Audio Recording.',
      );
    const generation = this.generation;
    const found = await this.resolveScreen(standing.displayKey, signal);
    if (!found)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Reconnect the approved display or change it in Settings → Tools.',
      );
    const { display, control } = found;
    try {
      await captureDisplayThumbnail(display.id, { width: 64, height: 64 });
      await this.checkScreen(control, display, signal);
      signal.throwIfAborted();
      if (this.generation !== generation || this.standingGrant()?.id !== standing.id)
        throw new RuntimeError('PERMISSION_DENIED', 'The local desktop grant changed.');
      this.sessions.set(id, {
        kind: 'screen',
        owner,
        standing,
        revision: randomUUID(),
        expires: Infinity,
        display: { id: display.id, label: standing.label },
        control,
      });
      return id;
    } catch (error) {
      control.helper.close();
      throw error;
    }
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
      if (grant.control) await this.checkScreen(grant.control, display, signal);
      this.grant(owner, id);
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
        state: { actions: allowed },
      };
      if (!image) return { observation, geometryOnly: true };
      signal.throwIfAborted();
      const side = computerLimits.frameSide;
      let frame = await captureDisplayThumbnail(display.id, { width: side, height: side });
      if (grant.control) await this.checkScreen(grant.control, display, signal);
      signal.throwIfAborted();
      this.grant(owner, id);
      if (displayGeometry(this.selectedDisplay(display.id)) !== geometry)
        throw new RuntimeError(
          'PERMISSION_DENIED',
          'The display changed during capture. Observe it again.',
        );
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

  private screenInput(
    owner: string,
    id: string,
    observation: ComputerObservation,
    type: ComputerAction['type'],
  ) {
    const grant = this.grant(owner, id);
    const control = grant.kind === 'screen' ? grant.control : undefined;
    if (grant.kind !== 'screen' || !control || !this.screenActions(control).includes(type))
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'The selected display has no verified permission for that action.',
      );
    const display = this.selectedDisplay(grant.display.id);
    if (observation.revision !== grant.revision || grant.key !== displayGeometry(display))
      throw new RuntimeError(
        'PERMISSION_DENIED',
        'The display changed. Observe it again before dispatching input.',
      );
    return { helper: control.helper, displayKey: control.displayKey, bounds: this.screenBounds(display) };
  }

  async prepareApplication(
    owner: string,
    id: string,
    observation: ComputerObservation,
    application: string,
    signal: AbortSignal,
  ) {
    const { helper, ...display } = this.screenInput(owner, id, observation, 'open_application');
    const resolved = await helper.run('resolve_application', { ...display, application }, signal);
    if (!resolved.application)
      throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'The native helper could not identify the app.');
    // The native helper pins the legacy selector to the system Messages bundle.
    return { ...resolved.application, requiresApproval: application !== 'messages' };
  }

  async input(
    owner: string,
    _target: string,
    id: string,
    observation: ComputerObservation,
    action: Parameters<ComputerDriver['input']>[4],
    signal: AbortSignal,
    applicationToken?: string,
  ) {
    const grant = this.grant(owner, id);
    if (
      grant.kind === 'screen' &&
      (isLocalPointerAction(action) || action.type === 'open_application')
    ) {
      const { helper, ...display } = this.screenInput(owner, id, observation, action.type);
      if (action.type === 'open_application') {
        if (!applicationToken)
          throw new RuntimeError('PERMISSION_DENIED', 'Resolve the installed app before launching it.');
        const launched = await helper.run(
          'open_application',
          { ...display, token: applicationToken },
          signal,
        );
        if (!launched.submitted || !launched.verified)
          throw new RuntimeError(
            'OUTCOME_UNCERTAIN',
            'macOS did not confirm the app opened. Inspect the desktop before retrying.',
          );
        return 'verified' as const;
      }
      const frame = observation.screenshot;
      if (!frame) throw new RuntimeError('INVALID_ARGUMENT', 'A screenshot is required.');
      const normalized = localPointerPoints(action, frame).map(({ x, y }) => ({
        x: (x + 0.5) / frame.width,
        y: (y + 0.5) / frame.height,
      }));
      const result = await helper.run(
        'screen_pointer',
        {
          action: action.type,
          ...display,
          ...(action.type === 'drag' ? { path: normalized } : normalized[0]),
          ...(action.type === 'click' && { button: action.button }),
          ...(action.type === 'scroll' && { scrollX: action.scrollX, scrollY: action.scrollY }),
        },
        signal,
      );
      if (!result.submitted || (action.type === 'move' && !result.verified))
        throw new RuntimeError(
          'OUTCOME_UNCERTAIN',
          'The system did not confirm the pointer action. Observe the desktop before retrying.',
        );
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
    const matches = (grant: Grant) => grant.kind === 'screen' && grant.display.id === displayId;
    if (this.prepared && matches(this.prepared)) this.closePrepared();
    const affected = [...this.sessions].filter(([, grant]) => matches(grant));
    for (const [id, grant] of affected) this.close(grant.owner, id, id);
    return affected.length > 0;
  }

  setSuspended(suspended: boolean) {
    this.suspended = suspended;
    if (suspended) this.reset();
  }

  revoke() {
    this.reset();
    this.store.revokeLocalDesktopGrant();
  }

  reset() {
    this.generation++;
    this.closePrepared();
    for (const grant of this.sessions.values()) this.closeGrant(grant);
    this.sessions.clear();
  }

  private closePrepared() {
    if (this.prepared) this.closeGrant(this.prepared);
    this.prepared = undefined;
  }

  private closeGrant(grant: Grant) {
    if (grant.kind === 'window') grant.helper.close();
    else grant.control?.helper.close();
  }
}
