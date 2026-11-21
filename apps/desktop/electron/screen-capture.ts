import { desktopCapturer, dialog, screen, systemPreferences, type BrowserWindow } from 'electron';

export async function captureDisplay(window: BrowserWindow): Promise<Buffer | undefined> {
  if (process.platform !== 'darwin' && process.platform !== 'win32')
    throw new Error('Full-screen capture is available on macOS and Windows.');

  const primary = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays();
  const labels = displays.map((display, index) => {
    const { width, height } = display.size;
    return `Display ${index + 1} (${width} × ${height}${display.id === primary ? ', primary' : ''})`;
  });
  if (!displays.length) throw new Error('No connected display is available.');
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Share full screen',
    message: 'Choose a display to capture',
    detail: 'Aria adds one screenshot to your draft. Review it before sending the message.',
    buttons: ['Cancel', ...labels],
    defaultId: 0,
    cancelId: 0,
  });
  const display = displays[response - 1];
  if (!display || window.isDestroyed()) return;

  const permissionMessage =
    'Allow Aria in System Settings → Privacy & Security → Screen & System Audio Recording, then retry.';
  if (process.platform === 'darwin') {
    const permission = systemPreferences.getMediaAccessStatus('screen');
    if (permission === 'denied' || permission === 'restricted') throw new Error(permissionMessage);
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 2400, height: 1600 },
  });
  if (window.isDestroyed()) return;
  if (
    process.platform === 'darwin' &&
    systemPreferences.getMediaAccessStatus('screen') !== 'granted'
  )
    throw new Error(permissionMessage);
  const source = sources.find((candidate) => candidate.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty())
    throw new Error('The selected display could not be captured. Select it again and retry.');
  return source.thumbnail.toJPEG(90);
}
