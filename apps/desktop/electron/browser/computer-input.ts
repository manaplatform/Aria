import type { WebContents } from 'electron';
import type { ComputerAction } from '@aria/shared';
import { RuntimeError } from '../runtime/store';

const modifiers = new Map([
  ['Alt', 1],
  ['Control', 2],
  ['Meta', 4],
  ['Shift', 8],
]);
const special = new Map([
  ['ArrowLeft', 37],
  ['ArrowUp', 38],
  ['ArrowRight', 39],
  ['ArrowDown', 40],
  ['Backspace', 8],
  ['Delete', 46],
  ['End', 35],
  ['Enter', 13],
  ['Escape', 27],
  ['Home', 36],
  ['PageDown', 34],
  ['PageUp', 33],
  ['Tab', 9],
  ['Space', 32],
]);

export function browserInputPoint(
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
) {
  if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight)
    throw new RuntimeError(
      'INVALID_ARGUMENT',
      'The pointer location is outside the observed image.',
    );
  return { x: Math.floor((x * width) / imageWidth), y: Math.floor((y * height) / imageHeight) };
}

export async function dispatchBrowserInput(
  contents: WebContents,
  action: Exclude<ComputerAction, { type: 'screenshot' | 'wait' }>,
  point: (x: number, y: number) => { x: number; y: number },
  signal: AbortSignal,
) {
  const keys = 'keys' in action ? (action.keys ?? []) : [];
  const mask = keys.reduce((value, item) => value | (modifiers.get(item) ?? 0), 0);
  const ordinary = keys.filter((key) => !modifiers.has(key));
  if (ordinary.length > (action.type === 'keypress' ? 1 : 0) || mask & 5)
    throw new RuntimeError(
      'INVALID_ARGUMENT',
      'This key combination is unavailable in the managed browser.',
    );
  const key = ordinary[0];
  const keyCode =
    key &&
    (special.get(key) ?? (/^[a-zA-Z0-9]$/.test(key) ? key.toUpperCase().charCodeAt(0) : undefined));
  if (action.type === 'keypress' && (!key || !keyCode || (mask & 2 && key.toLowerCase() !== 'a')))
    throw new RuntimeError('INVALID_ARGUMENT', 'This browser key is unavailable.');
  const coordinates =
    action.type === 'drag'
      ? action.path.map(({ x, y }) => point(x, y))
      : 'x' in action
        ? [point(action.x, action.y)]
        : [];
  const target = coordinates[0];
  signal.throwIfAborted();
  const transport = contents.debugger;
  if (transport.isAttached())
    throw new RuntimeError('CAPABILITY_UNAVAILABLE', 'The browser input channel is busy.');
  transport.attach('1.3');
  const send = async (method: string, args: Record<string, unknown>) => {
    signal.throwIfAborted();
    await transport.sendCommand(method, args);
    signal.throwIfAborted();
  };
  const mouse = (type: string, args: Record<string, unknown>) =>
    send('Input.dispatchMouseEvent', { type, modifiers: mask, ...args });
  let release: { method: string; args: Record<string, unknown> } | undefined;
  try {
    switch (action.type) {
      case 'set_value':
        throw new RuntimeError('INVALID_ARGUMENT', 'Use a browser text action for this target.');
      case 'type':
        await send('Input.insertText', { text: action.text });
        break;
      case 'keypress': {
        const args = {
          key: key === 'Space' ? ' ' : key,
          windowsVirtualKeyCode: keyCode,
          modifiers: mask,
        };
        release = { method: 'Input.dispatchKeyEvent', args: { ...args, type: 'keyUp' } };
        await send('Input.dispatchKeyEvent', {
          ...args,
          type: mask & 2 ? 'rawKeyDown' : 'keyDown',
          ...(mask & 2
            ? { commands: ['selectAll'] }
            : key?.length === 1 || key === 'Space'
              ? { text: args.key }
              : {}),
        });
        await send(release.method, release.args);
        release = undefined;
        break;
      }
      case 'move':
        await mouse('mouseMoved', target);
        break;
      case 'scroll':
        await mouse('mouseWheel', { ...target, deltaX: action.scrollX, deltaY: action.scrollY });
        break;
      case 'drag':
        release = {
          method: 'Input.dispatchMouseEvent',
          args: { type: 'mouseReleased', ...target, button: 'left' },
        };
        await mouse('mousePressed', { ...target, button: 'left', buttons: 1, clickCount: 1 });
        for (const location of coordinates.slice(1)) {
          release.args = { ...release.args, ...location };
          await mouse('mouseMoved', { ...location, button: 'left', buttons: 1 });
        }
        await send(release.method, release.args);
        release = undefined;
        break;
      case 'click':
      case 'double_click': {
        const button = action.type === 'click' ? action.button : 'left';
        const count = action.type === 'double_click' ? 2 : 1;
        await mouse('mouseMoved', target);
        for (let clickCount = 1; clickCount <= count; clickCount++) {
          const args = { ...target, button, clickCount, modifiers: mask };
          release = {
            method: 'Input.dispatchMouseEvent',
            args: { ...args, type: 'mouseReleased', buttons: 0 },
          };
          await mouse('mousePressed', {
            ...args,
            buttons: { left: 1, right: 2, middle: 4 }[button],
          });
          await send(release.method, release.args);
          release = undefined;
        }
        break;
      }
    }
  } finally {
    try {
      if (release && transport.isAttached())
        await transport.sendCommand(release.method, release.args).catch(() => undefined);
    } finally {
      if (transport.isAttached()) transport.detach();
    }
  }
}
