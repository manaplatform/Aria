import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  safeStorage,
  utilityProcess,
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
if (process.env.ARIA_TEST_DATA_DIR) {
  mkdirSync(process.env.ARIA_TEST_DATA_DIR, { recursive: true });
  app.setPath('userData', path.resolve(process.env.ARIA_TEST_DATA_DIR));
}
let mainWindow: BrowserWindow | null = null;
let storage: LocalStorage;
let provider: ProviderStorage;
let chat: ChatService;
let configuring = false;
let shutdownComplete = false;
let shutdown: Promise<void> | undefined;
let initial: Awaited<ReturnType<LocalStorage['load']>>;
const string = z.string().max(8000);
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
let closeFlushEnabled = false;
let closePending = false;
let quitting = false;
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
function registerIpc(): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      validateSender(event);
      return fn(...args);
    });
  handle('aria:enable-close-flush', () => {
    closeFlushEnabled = true;
  });
  handle('aria:close-ready', () => {
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
    await storage.save(parsed);
    initial = { data: parsed };
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
    const parsed = providerSettingsSchema.parse(input);
    configuring = true;
    try {
      const settings = await provider.save(parsed);
      await chat.restart();
      return settings;
    } finally {
      configuring = false;
    }
  });
  handle('aria:restart-chat-service', async () => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    await chat.restart();
  });
  handle('aria:test-provider', async () => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    await chat.testProvider();
  });
  handle('aria:submit-chat', (input) => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    chat.submit(chatRequestSchema.parse(input));
  });
  handle('aria:cancel-chat', (id) => chat.cancel(z.string().min(1).max(200).parse(id)));
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
  });
  mainWindow.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) void chat.cancelAll();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  mainWindow.on('closed', () => {
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
    shutdown ??= chat.close().finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  }
});
