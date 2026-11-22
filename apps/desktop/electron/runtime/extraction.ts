import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { evidenceSchema } from '@aria/shared';
import { z } from 'zod';
import { textPassages, type Extract } from './knowledge';
import { RuntimeError } from './store';

const resultSchema = z.union([
  z.strictObject({
    passages: z
      .array(
        z.strictObject({
          text: z.string().max(1_000_000),
          location: evidenceSchema.shape.location,
        }),
      )
      .max(1500),
  }),
  z.strictObject({ error: z.string().max(300) }),
]);
let queue = Promise.resolve();

export const extractDocument: Extract = (asset, bytes, signal) => {
  const extension = path.extname(asset.name).toLowerCase();
  if (asset.mimeType === 'text/plain' && extension !== '.html')
    return Promise.resolve(textPassages(bytes));
  if (!['.pdf', '.xlsx', '.docx', '.pptx', '.html'].includes(extension))
    return Promise.reject(
      new RuntimeError(
        'CAPABILITY_UNAVAILABLE',
        'Text extraction is unavailable for this file format.',
      ),
    );
  const operation = queue.then(async () => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(16_000)]);
    deadline.throwIfAborted();
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        partition: `aria-extract-${randomUUID()}`,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        devTools: false,
      },
    });
    const web = window.webContents;
    web.setWindowOpenHandler(() => ({ action: 'deny' }));
    web.on('will-navigate', (event) => event.preventDefault());
    const partition = web.session;
    partition.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    partition.setPermissionCheckHandler(() => false);
    partition.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    const destroy = () => {
      if (!window.isDestroyed()) window.destroy();
    };
    deadline.addEventListener('abort', destroy, { once: true });
    const memory = setInterval(() => {
      if (
        !web.isDestroyed() &&
        (app.getAppMetrics().find((process) => process.pid === web.getOSProcessId())?.memory
          .workingSetSize ?? 0) > 350_000
      )
        destroy();
    }, 500);
    try {
      await window.loadFile(path.resolve(__dirname, '../../dist/extraction.html'));
      const result = resultSchema.parse(
        await web.executeJavaScript(
          `window.extractDocument(${JSON.stringify(bytes.toString('base64'))}, ${JSON.stringify(extension)})`,
        ),
      );
      deadline.throwIfAborted();
      if ('error' in result) throw new RuntimeError('EXECUTION_FAILED', result.error);
      return result.passages;
    } finally {
      clearInterval(memory);
      deadline.removeEventListener('abort', destroy);
      destroy();
    }
  });
  queue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};
