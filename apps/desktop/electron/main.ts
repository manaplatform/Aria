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
import { ProviderStorage } from './provider-storage';
import {
  connectionInputSchema,
  endActivity,
  identifier,
  modelCapabilitySchema,
  registryInputSchema,
} from '@aria/shared';
import { ChatService } from './chat-service';
import { MediaStorage } from './media-storage';
import { MediaService, liveRequestSchema } from './media-service';
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
      id: identifier,
      capabilities: z.array(modelCapabilitySchema).max(12),
      source: z.enum(['provider', 'documentation', 'unknown']),
      transport: z.enum(['realtime', 'speech-api', 'inline-png', 'base64-image']).optional(),
      voices: z.array(z.string().max(40)).max(24).optional(),
      contextTokens: z.number().nonnegative().optional(),
      inputCost: z.number().nonnegative().optional(),
      outputCost: z.number().nonnegative().optional(),
    }),
  )
  .max(10000);
async function loadModels(connection: { provider: 'openai'; baseUrl: string; apiKey: string }) {
  const response = await chat.http('providers/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(connection),
    signal: AbortSignal.timeout(20000),
  });
  return catalogSchema.parse(await response.json());
}
async function changeRegistry<T>(save: () => Promise<T>) {
  if (configuring) throw new Error('AI Models settings are already being saved.');
  chat.assertIdle();
  media.assertIdle();
  configuring = true;
  try {
    const saved = await save();
    await chat.restart();
    return saved;
  } finally {
    configuring = false;
  }
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
                error: 'This response was interrupted. You can send it again.',
                retryConfirmed: false,
                activity: endActivity(message.activity),
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
  handle('aria:registry-settings', () => provider.get());
  handle('aria:save-registry', (input) =>
    changeRegistry(() => provider.save(registryInputSchema.parse(input), loadModels)),
  );
  handle('aria:import-registry-environment', () =>
    changeRegistry(() => provider.importEnvironment()),
  );
  handle('aria:restart-chat-service', () => changeRegistry(async () => undefined));
  handle('aria:discover-models', async (input) => {
    if (configuring) throw new Error('Wait for settings to finish saving.');
    return loadModels(await provider.preview(connectionInputSchema.parse(input)));
  });
  handle('aria:verify-model', async (input, id) => {
    if (configuring) throw new Error('Wait for settings to finish saving.');
    const draft = connectionInputSchema.parse(input);
    const model = identifier.parse(id);
    const connection = await provider.preview(draft);
    const response = await chat.http('providers/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...connection, model }),
      signal: AbortSignal.timeout(20000),
    });
    z.object({ verified: z.literal(true) }).parse(await response.json());
    provider.markVerified(draft, connection.apiKey, model);
  });
  handle('aria:submit-chat', (input) => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    const parsed = chatRequestSchema.parse(input);
    media.assertIdle();
    if (parsed.attachmentIds?.length) {
      const messages = initial.data.chat.messages.filter(
        (message) => message.conversationId === parsed.conversationId,
      );
      const assistant = messages.at(-1);
      const latest = messages.at(-2);
      if (
        assistant?.id !== parsed.assistantMessageId ||
        assistant.requestId !== parsed.requestId ||
        latest?.role !== 'user' ||
        parsed.attachmentIds.some(
          (id) =>
            !latest.assets?.some((asset) => asset.id === id) &&
            !latest.operation?.assetIds.includes(id),
        )
      )
        throw new Error('Attach the files to this turn before sending them.');
    }
    chat.submit(parsed);
  });
  handle('aria:cancel-chat', (id) => chat.cancel(identifier.parse(id)));
  handle('aria:choose-media', async (kind) => {
    const parsed = z.enum(['image', 'audio', 'text', 'any']).parse(kind);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Attach files to this message',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Images, audio, and text',
          extensions: [
            'png',
            'jpg',
            'jpeg',
            'webp',
            'flac',
            'mp3',
            'mp4',
            'mpeg',
            'mpga',
            'm4a',
            'ogg',
            'wav',
            'webm',
            'txt',
            'md',
            'csv',
            'tsv',
            'json',
            'ts',
            'js',
            'py',
            'tsx',
            'jsx',
            'html',
            'css',
            'yaml',
            'yml',
            'xml',
            'toml',
            'log',
            'rs',
            'go',
            'java',
            'sql',
          ],
        },
      ],
    });
    if (result.canceled) return [];
    if (result.filePaths.length > 4) throw new Error('Choose up to four attachments.');
    const imported = [];
    try {
      for (const filename of result.filePaths) imported.push(await assets.import(filename, parsed));
      return imported;
    } catch (error) {
      await Promise.allSettled(imported.map((asset) => assets.remove(asset.id)));
      throw error;
    }
  });
  handle('aria:export-media', async (id) => {
    const { asset, bytes } = await assets.get(z.string().uuid().parse(id));
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: asset.name });
    if (!result.canceled && result.filePath) await fs.writeFile(result.filePath, bytes);
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
    if (!initial.warning) await assets.pruneUnreferenced(initial.data).catch(() => undefined);
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
          'X-Content-Type-Options': 'nosniff',
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
      available: async () =>
        (await safeStorage.isAsyncEncryptionAvailable()) &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
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
      assets,
    );
    media = new MediaService(chat, assets, (event) =>
      mainWindow?.webContents.send('aria:live-event', event),
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
