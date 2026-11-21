import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { nativeImage } from 'electron';
import {
  computerLimits,
  type ComputerAction,
  type ComputerObservation,
  type RuntimeSettings,
} from '@aria/shared';
import type { ComputerDriver } from './computer';
import { DockerSandbox } from './sandbox';
import { RuntimeError } from './store';

type Desktop = {
  engine: DockerSandbox;
  image: string;
  profile: string;
  window: string;
  revision: string;
};
type Input = Exclude<ComputerAction, { type: 'screenshot' | 'wait' }>;
const keyNames = new Map([
  ['Control', 'ctrl'],
  ['Alt', 'alt'],
  ['Meta', 'super'],
  ['Shift', 'shift'],
  ['Enter', 'Return'],
  ['Space', 'space'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['PageUp', 'Page_Up'],
  ['PageDown', 'Page_Down'],
  ['Tab', 'Tab'],
  ['Escape', 'Escape'],
  ['Backspace', 'BackSpace'],
  ['Delete', 'Delete'],
  ['Home', 'Home'],
  ['End', 'End'],
]);

function desktopInput(action: Input) {
  if (action.type === 'set_value')
    throw new RuntimeError('INVALID_ARGUMENT', 'Use visual input in the virtual desktop.');
  const key = (name: string) => {
    const value = keyNames.get(name) ?? (/^[a-zA-Z0-9]$/.test(name) ? name : undefined);
    if (!value)
      throw new RuntimeError(
        'INVALID_ARGUMENT',
        'This key is not supported by the virtual desktop.',
      );
    return value;
  };
  const move = (x: number, y: number) => {
    if (x >= 1024 || y >= 768)
      throw new RuntimeError('INVALID_ARGUMENT', 'The pointer is outside the virtual display.');
    return ['mousemove', String(x), String(y)];
  };
  const keys = 'keys' in action ? (action.keys?.map(key) ?? []) : [];
  if (action.type === 'keypress') return ['key', '--clearmodifiers', keys.join('+')];
  if (action.type === 'type') return ['type', '--clearmodifiers', '--', action.text];
  if (keys.some((item) => !['ctrl', 'alt', 'super', 'shift'].includes(item)))
    throw new RuntimeError('INVALID_ARGUMENT', 'Pointer actions only accept modifier keys.');
  const withModifiers = (commands: string[]) =>
    keys.length ? ['keydown', keys.join('+'), ...commands, 'keyup', keys.join('+')] : commands;
  if (action.type === 'drag') {
    const [start, ...positions] = action.path;
    return withModifiers([
      ...move(start.x, start.y),
      'mousedown',
      '1',
      ...positions.flatMap(({ x, y }) => move(x, y)),
      'mouseup',
      '1',
    ]);
  }
  const position = move(action.x, action.y);
  if (action.type === 'move') return withModifiers(position);
  if (action.type === 'double_click')
    return withModifiers([...position, 'click', '--repeat', '2', '--delay', '60', '1']);
  if (action.type === 'click')
    return withModifiers([
      ...position,
      'click',
      { left: '1', middle: '2', right: '3' }[action.button],
    ]);
  const axis = (delta: number, up: string, down: string) =>
    delta
      ? [
          'click',
          '--repeat',
          String(Math.min(12, Math.max(1, Math.round(Math.abs(delta) / 100)))),
          delta < 0 ? up : down,
        ]
      : [];
  return withModifiers([
    ...position,
    ...axis(action.scrollX, '6', '7'),
    ...axis(action.scrollY, '4', '5'),
  ]);
}

export class VirtualComputer implements ComputerDriver {
  readonly environment = 'virtual-desktop' as const;
  private proof?: string;
  private readonly desktops = new Map<string, Desktop>();

  constructor(
    private readonly settings: () => RuntimeSettings,
    private readonly directory: string,
  ) {}

  private configuration() {
    const { engineSocket, desktopImage } = this.settings();
    return desktopImage
      ? { engineSocket, image: desktopImage, key: `${engineSocket}\n${desktopImage}` }
      : undefined;
  }

  ready() {
    return !!this.proof && this.proof === this.configuration()?.key;
  }

  async verify(signal: AbortSignal) {
    const configuration = this.configuration();
    if (!configuration)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Configure the graphical Docker image in Settings first.',
      );
    const id = randomUUID();
    this.proof = undefined;
    try {
      const desktop = await this.start(id, configuration, signal);
      const application = await desktop.engine.desktopCommand(
        id,
        ['/usr/bin/dbus-run-session', '--', '/usr/bin/mousepad'],
        signal,
        6000,
        true,
      );
      if (application.code !== 0)
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'The sample desktop application could not start.',
        );
      let title = '';
      for (let index = 0; index < 20 && !/mousepad/i.test(title); index++) {
        title = await this.activeWindow(desktop, id, signal);
        if (!/mousepad/i.test(title)) await sleep(150, undefined, { signal });
      }
      if (!/mousepad/i.test(title))
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'The sample desktop editor never received focus.',
        );
      const screenshot = await this.screenshot(desktop, id, signal);
      if (screenshot.getSize().width !== 1024 || screenshot.getSize().height !== 768)
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'The graphical image returned unexpected display dimensions.',
        );
      const marker = 'Aria isolated desktop verification';
      const input = await desktop.engine.desktopCommand(
        id,
        ['/usr/bin/xdotool', 'type', '--', marker],
        signal,
      );
      const copy = await desktop.engine.desktopCommand(
        id,
        ['/usr/bin/xdotool', 'key', 'ctrl+a', 'ctrl+c'],
        signal,
      );
      const selected = await desktop.engine.desktopCommand(
        id,
        ['/usr/bin/xclip', '-selection', 'clipboard', '-o'],
        signal,
      );
      if (
        input.code !== 0 ||
        copy.code !== 0 ||
        selected.code !== 0 ||
        selected.stdout.toString('utf8') !== marker
      )
        throw new RuntimeError(
          'CAPABILITY_UNAVAILABLE',
          'The isolated editor did not receive the verification text.',
        );
    } finally {
      await this.close('', id, id);
    }
    if (this.desktops.has(id))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The verification desktop could not be cleaned up.',
      );
    this.proof = configuration.key;
  }

  private async start(
    id: string,
    configuration: NonNullable<ReturnType<VirtualComputer['configuration']>>,
    signal: AbortSignal,
  ) {
    const engine = new DockerSandbox(configuration.engineSocket);
    const profile = engine.profile(this.directory);
    await engine.createDesktop(id, profile, configuration.image, signal);
    const desktop = {
      engine,
      profile,
      image: configuration.image,
      window: '',
      revision: randomUUID(),
    };
    this.desktops.set(id, desktop);
    return desktop;
  }

  async open(
    _owner: string,
    id: string,
    input: Parameters<ComputerDriver['open']>[2],
    signal: AbortSignal,
  ) {
    const configuration = this.configuration();
    if (!configuration || !this.ready())
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Verify the installed virtual desktop image in Settings.',
      );
    try {
      const desktop = await this.start(id, configuration, signal);
      const app =
        input.application === 'writer'
          ? ['/usr/bin/libreoffice', '--writer', '--norestore']
          : ['/usr/bin/mousepad'];
      const result = await desktop.engine.desktopCommand(
        id,
        ['/usr/bin/dbus-run-session', '--', ...app],
        signal,
        6000,
        true,
      );
      if (result.code !== 0)
        throw new RuntimeError('EXECUTION_FAILED', 'The requested application did not launch.');
      return id;
    } catch (error) {
      await this.close('', id, id);
      throw error;
    }
  }

  async restore(
    _owner: string,
    id: string,
    target: string,
    _destination: string | undefined,
    signal: AbortSignal,
  ) {
    const configuration = this.configuration();
    if (!configuration || !this.ready() || id !== target)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Verify the configured virtual desktop backend before restoring.',
      );
    const engine = new DockerSandbox(configuration.engineSocket);
    const profile = engine.profile(this.directory);
    if (!(await engine.ownsDesktop(id, profile, configuration.image, signal)))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The earlier isolated desktop is no longer available.',
      );
    this.desktops.set(id, {
      engine,
      profile,
      image: configuration.image,
      window: '',
      revision: randomUUID(),
    });
    return target;
  }

  private async checked(id: string, signal: AbortSignal) {
    const desktop = this.desktops.get(id);
    if (!desktop || !(await desktop.engine.ownsDesktop(id, desktop.profile, desktop.image, signal)))
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The verified isolated desktop is no longer running.',
      );
    return desktop;
  }

  private async activeWindow(desktop: Desktop, id: string, signal: AbortSignal) {
    const active = await desktop.engine.desktopCommand(
      id,
      ['/usr/bin/xdotool', 'getactivewindow', 'getwindowgeometry', 'getwindowname'],
      signal,
    );
    const window =
      active.code === 0 && !active.truncated ? active.stdout.toString('utf8').slice(0, 800) : '';
    if (window !== desktop.window) {
      desktop.window = window;
      desktop.revision = randomUUID();
    }
    return window.split('\n').filter(Boolean).at(-1)?.slice(0, 300) || 'Virtual desktop';
  }

  private async screenshot(desktop: Desktop, id: string, signal: AbortSignal) {
    const captured = await desktop.engine.desktopCommand(
      id,
      ['/usr/bin/import', '-window', 'root', 'png:-'],
      signal,
      computerLimits.imageBytes,
    );
    const picture = nativeImage.createFromBuffer(captured.stdout);
    if (captured.code !== 0 || captured.truncated || picture.isEmpty())
      throw new RuntimeError(
        'EXECUTION_FAILED',
        'A usable virtual desktop screenshot could not be captured.',
      );
    return picture;
  }

  async observe(_owner: string, target: string, id: string, image: boolean, signal: AbortSignal) {
    const desktop = await this.checked(id, signal);
    const title = await this.activeWindow(desktop, id, signal);
    const observation: ComputerObservation = {
      id: randomUUID(),
      sessionId: id,
      targetId: target,
      revision: desktop.revision,
      at: Date.now(),
      environment: this.environment,
      width: 1024,
      height: 768,
      devicePixelRatio: 1,
      title,
    };
    if (!image) return { observation };
    const picture = await this.screenshot(desktop, id, signal);
    await this.activeWindow(desktop, id, signal);
    if (desktop.revision !== observation.revision)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The active virtual window changed during capture.',
      );
    observation.screenshot = picture.getSize();
    return { observation, bytes: new Uint8Array(picture.toPNG()) };
  }

  async input(
    _owner: string,
    _target: string,
    id: string,
    observation: ComputerObservation,
    action: Input,
    signal: AbortSignal,
  ) {
    const desktop = await this.checked(id, signal);
    await this.activeWindow(desktop, id, signal);
    if (observation.revision !== desktop.revision)
      throw new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'The active virtual window moved or changed. Capture it again.',
      );
    const command = desktopInput(action);
    const result = await desktop.engine.desktopCommand(
      id,
      ['/usr/bin/xdotool', ...command],
      signal,
    );
    if (result.aborted || result.code !== 0) {
      await this.close('', id, id);
      throw new Error('The virtual desktop input may have been interrupted.');
    }
  }

  owner() {
    for (const desktop of this.desktops.values()) desktop.revision = randomUUID();
  }

  async stage(id: string, filename: string, bytes: Buffer, signal: AbortSignal) {
    const desktop = await this.checked(id, signal);
    await desktop.engine.stageDesktop(id, filename, bytes, signal);
  }

  async output(id: string, filename: string, signal: AbortSignal) {
    const desktop = await this.checked(id, signal);
    return desktop.engine.desktopOutput(id, filename, signal);
  }

  async close(_owner: string, _target: string, id: string) {
    const desktop = this.desktops.get(id);
    if (desktop && (await desktop.engine.remove(id))) this.desktops.delete(id);
  }
}
