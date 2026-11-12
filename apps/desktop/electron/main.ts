import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  safeStorage,
  utilityProcess,
  protocol,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStorage, localDataSchema } from './storage';
import { ProviderStorage, providerSettingsSchema } from './provider-storage';
import { ChatService } from './chat-service';
import { MediaStorage } from './media-storage';
import { MediaService, mediaRequestSchema, liveRequestSchema } from './media-service';
import { providerConnectionSchema } from './provider-storage';
import { chatRequestSchema } from './chat-protocol';
import {
  checkHealth,
  listFiles,
  readFile,
  repository,
  safeExternalUrl,
  scopedPath,
} from './project';

app.setName('Aria');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aria-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
if (process.env.ARIA_TEST_DATA_DIR) {
  mkdirSync(process.env.ARIA_TEST_DATA_DIR, { recursive: true });
  app.setPath('userData', path.resolve(process.env.ARIA_TEST_DATA_DIR));
}
let mainWindow: BrowserWindow | null = null;
let storage: LocalStorage;
let provider: ProviderStorage;
let chat: ChatService;
let assets: MediaStorage;
let media: MediaService;
let saving = Promise.resolve();
let configuring = false;
let shutdownComplete = false;
let shutdown: Promise<void> | undefined;
let initial: Awaited<ReturnType<LocalStorage['load']>>;
const string = z.string().max(8000);
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
let closeFlushEnabled = false;
let closePending = false;
let quitting = false;
function trustedUrl(value: string): boolean {
  try {
    return devServerUrl
      ? new URL(value).origin === new URL(devServerUrl).origin
      : value.split('#')[0] === pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
  } catch {
    return false;
  }
}
function validateSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  )
    throw new Error('Untrusted IPC sender.');
  const url = event.senderFrame.url;
  const expected = devServerUrl
    ? new URL(devServerUrl).origin
    : pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
  if (devServerUrl ? new URL(url).origin !== expected : url.split('#')[0] !== expected)
    throw new Error('Untrusted renderer URL.');
}
const catalogSchema = z
  .array(
    z.object({
      id: z.string().min(1).max(200),
      modes: z.array(z.enum(['chat', 'image', 'speech', 'transcription', 'live'])),
      deprecated: z.boolean().optional(),
      shutdownDate: z.string().optional(),
    }),
  )
  .max(10000);
async function loadModels(connection: { provider: 'openai'; baseUrl: string; apiKey: string }) {
  const response = await chat.http('providers/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      apiKey: connection.apiKey,
    }),
    signal: AbortSignal.timeout(20000),
  });
  return catalogSchema.parse(await response.json());
}
function registerIpc(): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      validateSender(event);
      return fn(...args);
    });
  handle('aria:enable-close-flush', () => {
    closeFlushEnabled = true;
  });
  handle('aria:close-ready', async () => {
    await media.close();
    mainWindow?.destroy();
    if (quitting) app.quit();
  });
  handle('aria:close-failed', (error) => {
    closePending = false;
    quitting = false;
    dialog.showErrorBox('Local changes could not be saved', string.parse(error));
  });
  handle('aria:load', () => ({
    ...initial,
    data: {
      ...initial.data,
      chat: {
        ...initial.data.chat,
        messages: initial.data.chat.messages.map((message) =>
          ['pending', 'streaming'].includes(message.status)
            ? {
                ...message,
                status: 'interrupted',
                error: 'This response was interrupted. You can retry it.',
              }
            : message,
        ),
      },
    },
  }));
  handle('aria:save', async (data) => {
    const parsed = localDataSchema.parse(data);
    saving = saving
      .catch(() => undefined)
      .then(async () => {
        const previous = initial.data;
        await storage.save(parsed);
        initial = { data: parsed };
        await assets.prune(previous, parsed).catch(() => undefined);
      });
    await saving;
  });
  handle('aria:choose-workspace', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Open a project folder',
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = await fs.realpath(result.filePaths[0]);
    const existing = initial.data.workspaces.find((w) => w.root === root);
    const repo = await repository(root);
    const workspace = {
      id: existing?.id ?? randomUUID(),
      name: path.basename(root),
      root,
      branch: repo.branch,
      updatedAt: new Date().toISOString(),
    };
    await storage.register(workspace);
    initial.data = {
      ...initial.data,
      workspaces: [...initial.data.workspaces.filter((w) => w.id !== workspace.id), workspace],
    };
    return workspace;
  });
  handle('aria:repository', (id) => repository(storage.root(string.parse(id))));
  handle('aria:list-files', (id, directory) =>
    listFiles(storage.root(string.parse(id)), string.parse(directory)),
  );
  handle('aria:read-file', (id, file) =>
    readFile(storage.root(string.parse(id)), string.parse(file)),
  );
  handle('aria:choose-files', async (id) => {
    const root = storage.root(string.parse(id));
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      defaultPath: root,
      title: 'Attach files from this project',
    });
    if (result.canceled) return [];
    return Promise.all(
      result.filePaths.map(async (filename) => {
        const relative = path.relative(root, filename);
        const resolved = await scopedPath(root, relative);
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) throw new Error('Attachments must be regular files.');
        return { id: randomUUID(), name: path.basename(filename), path: relative, size: stat.size };
      }),
    );
  });
  handle('aria:health', (url) => checkHealth(string.parse(url)));
  handle('aria:copy', (text) => clipboard.writeText(z.string().max(10_000_000).parse(text)));
  handle('aria:open-external', (url) => shell.openExternal(safeExternalUrl(string.parse(url))));
  handle('aria:chat-status', () => chat.getStatus());
  handle('aria:provider-settings', () => provider.get());
  handle('aria:save-provider-settings', async (input) => {
    if (configuring) throw new Error('Connection settings are already being saved.');
    chat.assertIdle();
    media.assertIdle();
    const parsed = providerSettingsSchema.parse(input);
    configuring = true;
    try {
      const effective = await provider.resolve({
        provider: parsed.provider,
        baseUrl: parsed.baseUrl,
        apiKey: parsed.apiKey,
        removeKey: parsed.removeKey,
      });
      if (effective.apiKey) {
        const models = await loadModels(effective);
        const selections = parsed.models ?? { chat: parsed.model };
        const selected = {
          ...selections,
          chat: process.env.OPENAI_MODEL?.trim() || selections.chat,
        };
        if (
          Object.entries(selected).some(
            ([mode, id]) =>
              id &&
              !models.some(
                (m) =>
                  m.id === id &&
                  (m.modes.length === 0 ||
                    m.modes.includes(
                      mode as 'chat' | 'image' | 'speech' | 'transcription' | 'live',
                    )),
              ),
          )
        )
          throw new Error(
            'A selected model is unavailable. Refresh models and select a replacement.',
          );
      }
      const settings = await provider.save(parsed);
      await chat.restart();
      return settings;
    } finally {
      configuring = false;
    }
  });
  handle('aria:restart-chat-service', async () => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    media.assertIdle();
    await chat.restart();
  });
  handle('aria:test-provider', async () => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    media.assertIdle();
    await chat.testProvider();
  });
  handle('aria:submit-chat', (input) => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    const parsed = chatRequestSchema.parse(input);
    media.assertConversationIdle(parsed.conversationId);
    chat.submit(parsed);
  });
  handle('aria:cancel-chat', async (id) => {
    const parsed = z.string().min(1).max(200).parse(id);
    await Promise.all([chat.cancel(parsed), media.cancel(parsed)]);
  });
  handle('aria:provider-models', async (input) => {
    if (configuring) throw new Error('Wait for settings to finish saving.');
    return loadModels(
      await provider.resolve(
        input === undefined ? undefined : providerConnectionSchema.parse(input),
      ),
    );
  });
  handle('aria:choose-media', async (kind) => {
    const parsed = z.enum(['image', 'audio']).parse(kind);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: parsed === 'image' ? 'Choose reference images' : 'Choose audio to transcribe',
      properties: parsed === 'image' ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [
        {
          name: parsed === 'image' ? 'Images' : 'Audio',
          extensions:
            parsed === 'image'
              ? ['png', 'jpg', 'jpeg', 'webp']
              : ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'],
        },
      ],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > (parsed === 'image' ? 4 : 1))
      throw new Error('Choose up to four images or one audio file.');
    return Promise.all(result.filePaths.map((filename) => assets.import(filename, parsed)));
  });
  handle('aria:export-media', async (id) => {
    const { asset, bytes } = await assets.get(z.string().uuid().parse(id));
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: asset.name });
    if (!result.canceled && result.filePath) await fs.writeFile(result.filePath, bytes);
  });
  handle('aria:submit-media', (input) => {
    if (configuring) throw new Error('Wait for settings to finish saving.');
    const parsed = mediaRequestSchema.parse(input);
    chat.assertConversationIdle(parsed.conversationId);
    media.submit(parsed);
  });
  handle('aria:start-live', async (input) => {
    if (configuring) throw new Error('Wait for settings to finish saving.');
    chat.assertIdle();
    await media.startLive(liveRequestSchema.parse(input));
  });
  ipcMain.on('aria:live-audio', (event, sessionId: unknown, audio: unknown) => {
    try {
      validateSender(event);
      media.sendAudio(
        z.string().min(1).max(200).parse(sessionId),
        z.instanceof(Uint8Array).parse(audio),
      );
    } catch {
      void media.endLive();
    }
  });
  handle('aria:mute-live', (sessionId, muted) =>
    media.mute(z.string().min(1).max(200).parse(sessionId), z.boolean().parse(muted)),
  );
  handle('aria:end-live', () => media.endLive());
}
function createWindow(): void {
  closeFlushEnabled = false;
  closePending = false;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#101116',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.on('render-process-gone', () => {
    closeFlushEnabled = false;
    closePending = false;
    void chat.cancelAll();
    void media.close();
  });
  mainWindow.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) {
      void chat.cancelAll();
      void media.close();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      callback(
        contents === mainWindow?.webContents &&
          permission === 'media' &&
          details.isMainFrame &&
          trustedUrl(details.requestingUrl) &&
          'mediaTypes' in details &&
          Array.isArray(details.mediaTypes) &&
          details.mediaTypes.length > 0 &&
          details.mediaTypes.every((type) => type === 'audio'),
      );
    },
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (contents, permission, _origin, details) =>
      contents === mainWindow?.webContents &&
      permission === 'media' &&
      details.isMainFrame &&
      trustedUrl(details.requestingUrl || '') &&
      details.mediaType === 'audio',
  );
  mainWindow.on('closed', () => {
    void media.close();
    void chat.cancelAll();
    mainWindow = null;
  });
  mainWindow.on('close', (event) => {
    if (!closeFlushEnabled) return;
    event.preventDefault();
    if (!closePending) {
      closePending = true;
      mainWindow?.webContents.send('aria:before-close');
    }
  });
  if (devServerUrl) void mainWindow.loadURL(devServerUrl);
  else void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
}
app
  .whenReady()
  .then(async () => {
    if (!app.isPackaged) {
      try {
        process.loadEnvFile(path.resolve(__dirname, '../../..', '.env'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const directory = process.env.ARIA_TEST_DATA_DIR || app.getPath('userData');
    storage = new LocalStorage(directory);
    initial = await storage.load();
    assets = new MediaStorage(directory);
    protocol.handle('aria-media', async (request) => {
      try {
        const url = new URL(request.url);
        if (url.hostname !== 'asset' || url.search || url.hash || request.method !== 'GET')
          return new Response(null, { status: 404 });
        const { asset, bytes } = await assets.get(url.pathname.slice(1));
        const headers = {
          'Content-Type': asset.mimeType,
          'Cache-Control': 'no-store',
          'Accept-Ranges': 'bytes',
          'Content-Security-Policy': "default-src 'none'",
        };
        const range = request.headers.get('range');
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!match) return new Response(null, { status: 416 });
          const start = Number(match[1]);
          const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
          if (start > end || start >= bytes.length) return new Response(null, { status: 416 });
          return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
            status: 206,
            headers: {
              ...headers,
              'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
              'Content-Length': String(end - start + 1),
            },
          });
        }
        return new Response(new Uint8Array(bytes), {
          headers: { ...headers, 'Content-Length': String(bytes.length) },
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    provider = new ProviderStorage(directory, {
      available: () => safeStorage.isAsyncEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptStringAsync(value),
      decrypt: (value) => safeStorage.decryptStringAsync(value),
    });
    chat = new ChatService(
      provider,
      (env) =>
        utilityProcess.fork(path.join(__dirname, 'api/dist/main.js'), [], {
          env: env as Record<string, string>,
          stdio: 'ignore',
          serviceName: 'Aria Chat API',
        }),
      (event) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed())
          mainWindow.webContents.send('aria:chat-event', event);
      },
      (status) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed())
          mainWindow.webContents.send('aria:chat-status-update', status);
      },
    );
    media = new MediaService(
      chat,
      assets,
      (event) => mainWindow?.webContents.send('aria:chat-event', event),
      (event) => mainWindow?.webContents.send('aria:live-event', event),
    );
    registerIpc();
    createWindow();
    void chat.start();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error) => {
    dialog.showErrorBox('Aria could not start', String(error));
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  quitting = true;
  // The window close handshake flushes renderer state before this final shutdown.
  if (!mainWindow && chat && !shutdownComplete) {
    event.preventDefault();
    shutdown ??= media
      .close()
      .then(() => chat.close())
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  }
});
