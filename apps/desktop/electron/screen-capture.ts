import {
  desktopCapturer,
  dialog,
  screen,
  systemPreferences,
  type BrowserWindow,
  type Size,
} from 'electron';

export function screenCaptureSupported() {
  return process.platform === 'darwin' || process.platform === 'win32';
}

export async function chooseDisplay(
  window: BrowserWindow,
  title: string,
  detail: string,
  offerPointerPermission = false,
) {
  if (!screenCaptureSupported())
    throw new Error('Full-screen capture is available on macOS and Windows.');

  const primary = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays();
  const labels = displays.map((display, index) => {
    const { width, height } = display.size;
    return `Display ${index + 1} (${width} × ${height}${display.id === primary ? ', primary' : ''})`;
  });
  if (!displays.length) throw new Error('No connected display is available.');
  const { response, checkboxChecked } = await dialog.showMessageBox(window, {
    type: 'question',
    title,
    message: 'Choose a display',
    detail,
    buttons: ['Cancel', ...labels],
    defaultId: 0,
    cancelId: 0,
    ...(offerPointerPermission &&
      process.platform === 'darwin' && {
        checkboxLabel: 'Request macOS Accessibility permission for pointer control',
      }),
  });
  const display = displays[response - 1];
  if (!display || window.isDestroyed()) return;
  return { id: display.id, label: labels[response - 1], requestPointerPermission: checkboxChecked };
}

export function displayAccessGranted() {
  return (
    process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted'
  );
}

export async function captureDisplayThumbnail(id: number, thumbnailSize: Size) {
  const permissionMessage =
    'Allow Aria in System Settings → Privacy & Security → Screen & System Audio Recording, then retry.';
  if (process.platform === 'darwin') {
    const permission = systemPreferences.getMediaAccessStatus('screen');
    if (permission === 'denied' || permission === 'restricted') throw new Error(permissionMessage);
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
  });
  if (!displayAccessGranted()) throw new Error(permissionMessage);
  const source = sources.find((candidate) => candidate.display_id === String(id));
  if (!source || source.thumbnail.isEmpty())
    throw new Error('The selected display could not be captured. Select it again and retry.');
  return source.thumbnail;
}

export async function captureDisplay(window: BrowserWindow): Promise<Buffer | undefined> {
  const display = await chooseDisplay(
    window,
    'Share full screen',
    'Aria adds one screenshot to your draft. Review it before sending the message.',
  );
  if (!display) return;
  const thumbnail = await captureDisplayThumbnail(display.id, { width: 2400, height: 1600 });
  if (!window.isDestroyed()) return thumbnail.toJPEG(90);
}
