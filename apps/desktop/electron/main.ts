import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  safeStorage,
  systemPreferences,
  Tray,
  utilityProcess,
  protocol,
  type IpcMainInvokeEvent,
  type NativeImage,
} from 'electron';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defaultPreferences, LocalStorage, localDataSchema } from './storage';
import { ProactiveService } from './proactive/service';
import { ConnectorRegistry } from './connectors/registry';
import { githubProviderConfig } from './connectors/provider-config';
import { ProactiveStore } from './proactive/store';
import { BrowserController } from './browser/controller';
import { openBrowserBridge } from './browser/bridge';
import { CapabilityStorage, openCapabilityBridge } from './capability-storage';
import { WebSettingsStorage } from './web-settings-storage';
import { WeatherService } from './weather';
import { ProviderStorage } from './provider-storage';
import {
  browserCommandSchema,
  proactiveOperations,
  connectorCommand,
  githubAccountId,
  githubOperation,
  githubPublicOperation,
  githubResult,
  type ProactiveEvent,
  capabilityId,
  defaultWebPolicy,
  effectSchema,
  modelReference,
  memoryClear,
  resolvePersona,
  presentationActionRequest,
  memoryCategory,
  memoryManagementSearch,
  memoryOperations,
  memorySettingsSchema,
  resetConfigurationScopeSchema,
  systemBehaviorInputSchema,
  toolAvailabilitySchema,
  toolHealthSchema,
  type ChatConversation,
  type ChatMessage,
  type StorageAreaUsage,
  type UserPersonalization,
  loopCommandSchema,
  loopRecoveryRequestSchema,
  projectChatEvent,
  skillRefSchema,
  toolDiscoverySchema,
  type RuntimeRegistry,
  browserLayoutSchema,
  computerSupervision,
  computerUserInput,
  webSettingsInputSchema,
  webBudgetKeySchema,
  connectionInputSchema,
  endActivity,
  identifier,
  modelCapabilitySchema,
  registryInputSchema,
  selectChatContext,
  programSettingsSchema,
  weatherOperations,
  weatherSettingsSchema,
  type WeatherOperation,
} from '@aria/shared';
import { personaAction } from './persona-actions';
import { ChatService } from './chat-service';
import { Diagnostics } from './diagnostics/service';
import { diagnosticConfigSchema, diagnosticFilterSchema } from '@aria/shared';
import { DesktopMemory } from './memory/service';
import { WorkingContext } from './memory/working-context';
import { LoopRecovery } from './loop-recovery';
import { DesktopRuntime } from './runtime/controller';
import { localShellSupported } from './runtime/local-shell';
import { ComputerRuntime } from './runtime/computer';
import { VirtualComputer } from './runtime/virtual-computer';
import { LocalComputer } from './runtime/local-computer';
import { openAIRuntimeFeatureSchema, runtimeSettingsSchema } from '@aria/shared';
import { MediaStorage, referencedAssets } from './media-storage';
import { captureDisplay, chooseDisplay } from './screen-capture';
import { OperationApproval } from './operation-approval';
import { MediaService, liveRequestSchema } from './media-service';
import { DesktopUpdates } from './updates';
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
process.on('uncaughtExceptionMonitor', () => {
  diagnostics?.log('fatal', 'desktop', 'lifecycle', 'process.uncaught_exception');
});
if (process.platform === 'win32' && app.isPackaged)
  app.setAppUserModelId('io.github.manaplatform.aria');
app.commandLine.appendSwitch('disable-quic');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'aria-embedding-pack',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'aria-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
if (process.env.ARIA_TEST_DATA_DIR) {
  mkdirSync(process.env.ARIA_TEST_DATA_DIR, { recursive: true });
  app.setPath('userData', path.resolve(process.env.ARIA_TEST_DATA_DIR));
}
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
let proactive: ProactiveService | undefined;
let mainWindow: BrowserWindow | null = null;
let appTray: Tray | null = null;
let appIcon: NativeImage | undefined;
let dataDirectory = '';
let storage: LocalStorage;
let webSettings: WebSettingsStorage;
let weather: WeatherService;
let capabilities: CapabilityStorage;
let browser: BrowserController;
let provider: ProviderStorage;
let chat: ChatService;
let assets: MediaStorage;
let executionRuntime: DesktopRuntime;
let computerRuntime: ComputerRuntime;
let virtualComputer: VirtualComputer;
let localComputer: LocalComputer;
let localSelection: AbortController | undefined;
let media: MediaService;
let memory: DesktopMemory;
let loopRecovery: LoopRecovery;
let approvals: OperationApproval;
let connectors: ConnectorRegistry;
const activeMessages = new Map<string, ChatMessage>();
const workingContext = new WorkingContext();
const temporaryConversations = new Set<string>();
const pendingChatProjects = new Map<string, string | null>();
let drainingMemory = false;
let diagnostics: Diagnostics | undefined;
let diagnosticSubscribed = false;

function syncTray(enabled: boolean): boolean {
  if (!enabled || !appIcon) {
    appTray?.destroy();
    appTray = null;
    return !enabled;
  }
  if (appTray) return true;
  try {
    const icon = appIcon.resize({ width: 18, height: 18 });
    appTray = new Tray(icon);
    appTray.setToolTip('Aria');
    appTray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: 'Open Aria',
          click: () => {
            if (!mainWindow || mainWindow.isDestroyed()) createWindow(appIcon);
            else {
              if (mainWindow.isMinimized()) mainWindow.restore();
              mainWindow.show();
              mainWindow.focus();
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Quit Aria',
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ]),
    );
    appTray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow(appIcon);
      else if (mainWindow.isVisible()) mainWindow.focus();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch {
    diagnostics?.log('warn', 'desktop', 'tray', 'tray.unavailable');
    appTray = null;
    return false;
  }
  return true;
}

async function pathBytes(target: string): Promise<number> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await fs.readdir(target, { withFileTypes: true });
    const sizes = await Promise.all(
      entries.map((entry) =>
        entry.isFile()
          ? fs.lstat(path.join(target, entry.name)).then((s) => s.size).catch(() => 0)
          : entry.isDirectory()
            ? pathBytes(path.join(target, entry.name))
            : 0,
      ),
    );
    return sizes.reduce((sum, n) => sum + n, 0);
  } catch {
    return 0;
  }
}

function personalizationContext(): UserPersonalization | undefined {
  const prefs = initial?.data?.preferences;
  if (!prefs) return undefined;
  const profileName = prefs.profileName?.trim();
  const profileBio = prefs.profileBio?.trim();
  const responseStyle = prefs.responseStyle;
  const communicationLanguage = prefs.communicationLanguage?.trim();
  const payload: UserPersonalization = {
    ...(profileName && profileName !== 'You' ? { profileName } : {}),
    ...(profileBio ? { profileBio } : {}),
    persona: prefs.persona ?? {},
    ...(responseStyle && responseStyle !== 'balanced' ? { responseStyle } : {}),
    ...(communicationLanguage && communicationLanguage !== 'auto' ? { communicationLanguage } : {}),
  };
  return Object.keys(payload).length ? payload : undefined;
}

function notifyBackground(kind: 'task' | 'background', title: string, body: string) {
  const prefs = initial?.data?.preferences.notifications;
  if (!prefs?.enabled || !Notification.isSupported()) return;
  if (kind === 'task' && !prefs.taskCompletion) return;
  if (kind === 'background' && !prefs.backgroundExecution) return;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused() && !mainWindow.isMinimized())
    return;
  try {
    const note = new Notification({ title, body, silent: !prefs.sound });
    note.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) createWindow(appIcon);
      else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
    });
    note.show();
  } catch {
    // Ignore notification errors on unsupported desktop environments.
  }
}

async function drainMemoryOutbox() {
  if (drainingMemory || !storage.memoryOutbox.length) return;
  drainingMemory = true;
  try {
    const accepted = await memory.ingest(storage.memoryOutbox);
    if (accepted.length) {
      const ids = new Set(accepted);
      storage.memoryOutbox = storage.memoryOutbox.filter(({ id }) => !ids.has(id));
    }
  } catch {
    // The outbox remains on disk for recovery when memory storage is available.
  } finally {
    drainingMemory = false;
  }
}

function purgeMemoryOutbox() {
  if (!storage.hasPersistedOutbox) return Promise.resolve();
  saving = saving.catch(() => undefined).then(async () => {
    const { data } = initial;
    const eligible = memory.outbox(storage.memoryOutbox, data.chat.messages, data.chat.conversations);
    await storage.save(data, eligible);
  });
  return saving;
}

function proactiveArtifactIds() {
  if (!executionRuntime.store.exists()) return [];
  return executionRuntime.store.db.prepare('SELECT id FROM proactive_artifacts').all().map(({ id }) => String(id));
}

function savedConversation(id: string): ChatConversation | undefined {
  return initial.data.chat.conversations.find((item) => item.id === id);
}

function registeredMemoryProject(id: string) {
  if (!initial.data.workspaces.some((workspace) => workspace.id === id))
    throw new Error('Choose a registered project folder.');
  storage.root(id);
  return id;
}
let saving = Promise.resolve();
let configuring = false;
let shutdownComplete = false;
let shutdown: Promise<void> | undefined;
let updates: DesktopUpdates;
let installUpdate: (() => void) | undefined;
let initial: Awaited<ReturnType<LocalStorage['load']>>;
const string = z.string().max(8000);
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const devLauncher = devServerUrl && process.env.ARIA_DEV_LAUNCHER === '1';
let closeFlushEnabled = false;
let closePending = false;
let quitting = false;
if (devLauncher) {
  process.once('disconnect', () => {
    if (media) app.quit();
  });
}
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
  chat.assertIdle(true);
  media.assertIdle();
  configuring = true;
  try {
    await chat.interruptProactive();
    const saved = await save();
    await chat.restart();
    return saved;
  } finally {
    configuring = false;
    proactive?.wake();
  }
}

async function changeRuntimeSettings<T>(save: () => Promise<T>) {
  if (configuring) throw new Error('Wait for settings to finish saving.');
  chat.assertIdle(true);
  media.assertIdle();
  configuring = true;
  try {
    await chat.interruptProactive();
    return await save();
  } finally {
    configuring = false;
    proactive?.wake();
  }
}

function nativeProof(registry: RuntimeRegistry, image = false) {
  for (const connection of registry.connections) {
    const model = connection.models.find(
      (item) => item.enabled && modelReference(connection.id, item.id) === registry.primary,
    );
    if (
      model &&
      connection.apiKey &&
      (image || new URL(connection.baseUrl).origin === 'https://api.openai.com')
    ) {
      return createHash('sha256')
        .update(
          JSON.stringify([
            connection.baseUrl,
            model.id,
            connection.apiKey,
            image ? 'computer-image/1' : 'responses',
          ]),
        )
        .digest('hex');
    }
  }
}

function runtimePolicy(registry?: RuntimeRegistry) {
  return capabilities.policy(
    registry && nativeProof(registry),
    registry && nativeProof(registry, true),
  );
}

const toolList = z
  .array(
    z.strictObject({
      id: capabilityId,
      namespace: z.string().max(100),
      name: z.string().max(200),
      description: z.string().max(1024),
      version: z.string().max(100),
      provenance: z.string().max(100),
      effect: effectSchema,
      permission: z.string().max(200),
      available: z.boolean(),
      reason: z.string().max(200).optional(),
      programmatic: z.array(z.enum(['managed', 'openai-responses'])).max(2).optional(),
      output: z.enum(['text', 'image', 'audio', 'file', 'sources', 'data']).optional(),
      availability: toolAvailabilitySchema.optional(),
      health: toolHealthSchema.optional(),
      settingsSection: z.string().max(120).optional(),
      tags: z.array(z.string().max(60)).max(16).optional(),
      constraints: z
        .strictObject({
          timeoutMs: z.number().int().positive().optional(),
          modes: z.array(z.enum(['direct', 'programmatic'])).max(2).optional(),
          parallelRead: z.boolean().optional(),
          parallelDelegate: z.boolean().optional(),
          citations: z.boolean().optional(),
          artifacts: z.boolean().optional(),
          budget: webBudgetKeySchema.optional(),
          requiredModelCapabilities: z.array(z.string().max(40)).max(8).optional(),
          mechanism: z.enum(['native_api', 'web_search', 'web_content', 'browser', 'connected_service', 'local', 'model']).optional(),
          network: z.enum(['required', 'optional', 'none']).optional(),
          cost: z.enum(['free', 'may_incur_cost', 'unknown']).optional(),
          latency: z.enum(['low', 'network', 'variable']).optional(),
        })
        .optional(),
      inputHint: z
        .strictObject({
          required: z.array(z.string().max(60)).max(16),
          optional: z.array(z.string().max(60)).max(16),
          summary: z.string().max(400),
        })
        .optional(),
    }),
  )
  .max(1024);

async function toolSettings() {
  const registry = await provider.resolve().catch(() => undefined);
  const policy = runtimePolicy(registry);
  const response = await chat.http('chat/tools', { signal: AbortSignal.timeout(11_000) });
  return {
    discovery: policy.discovery,
    nativeVerified: policy.nativeVerified ?? false,
    programming: policy.programming,
    nativeProgramVerified: policy.nativeProgramVerified,
    tools: toolList.parse(await response.json()),
    skills: capabilities.skills(),
  };
}

async function changeCapabilities(
  change: () => Promise<unknown>,
  read: () => Promise<unknown> = toolSettings,
) {
  if (configuring) throw new Error('Wait for settings to finish saving.');
  configuring = true;
  try {
    await chat.interruptAll();
    await media.close();
    await change();
    await chat.restart();
    return await read();
  } finally {
    configuring = false;
  }
}

async function exportDiagnosticReport(filter: import('@aria/shared').DiagnosticFilter): Promise<boolean> {
  if (!diagnostics || !mainWindow || mainWindow.isDestroyed()) return false;
  const destination = await dialog.showSaveDialog(mainWindow, {
    title: 'Export sanitized diagnostics',
    defaultPath: `aria-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (destination.canceled || !destination.filePath) return false;
  const events: import('@aria/shared').DiagnosticEvent[] = [];
  let cursor = 0;
  do {
    const page = await diagnostics.query({ ...filter, cursor, limit: 500 }, false);
    events.push(...page.events);
    cursor = page.nextCursor ?? -1;
  } while (cursor >= 0 && events.length < 20_000);
  const ids = new Map<string, string>();
  const pseudonym = (value: string) => {
    if (!ids.has(value)) ids.set(value, `id-${ids.size + 1}`);
    return ids.get(value)!;
  };
  const config = diagnostics.status().config;
  const errorSummary: Record<string, number> = {};
  for (const event of events) if (event.level === 'error' || event.level === 'fatal')
    errorSummary[event.event] = (errorSummary[event.event] ?? 0) + 1;
  const [toolSnapshot, memoryStatus] = await Promise.all([
    toolSettings().catch(() => undefined), memory?.status().catch(() => undefined),
  ]);
  const exportedEvents = events.map((entry) => ({ ...entry, context: Object.fromEntries(Object.entries(entry.context)
    .map(([key, value]) => [key, typeof value === 'string' ? pseudonym(value) : value])) }));
  const timelines: Record<string, string[]> = {};
  for (const event of [...exportedEvents].reverse()) {
    const correlation = event.context.correlationId;
    if (typeof correlation === 'string') (timelines[correlation] ??= []).push(event.id);
  }
  const report = {
    version: 1, exportedAt: new Date().toISOString(),
    app: { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node,
      platform: process.platform, osRelease: os.release(), arch: process.arch, packaged: app.isPackaged },
    diagnostics: { dropped: diagnostics.status().dropped, truncated: cursor >= 0,
      config: { level: config.level, debug: config.debug, trace: config.trace,
        retentionDays: config.retentionDays, maxBytes: config.maxBytes } },
    errorSummary, timelines,
    memory: memoryStatus && { state: memoryStatus.state, embedding: memoryStatus.embedding, records: memoryStatus.records, pending: memoryStatus.pending, failures: memoryStatus.failures },
    tools: toolSnapshot && { available: toolSnapshot.tools.filter((tool) => tool.available).length,
      total: toolSnapshot.tools.length, enabledSkills: toolSnapshot.skills.filter((skill) => skill.enabled).length },
    executionHistory: executionRuntime?.history().slice(0, 25).map(({ state, elapsed, exitCode }) => ({ state, elapsed, exitCode })),
    chatService: chat ? { state: chat.getStatus().state, configured: chat.getStatus().configured } : undefined,
    events: exportedEvents,
  };
  const temporary = `${destination.filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, destination.filePath);
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  return true;
}

function registerIpc(): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      validateSender(event);
      try { return await fn(...args); }
      catch (error) {
        if (!channel.startsWith('aria:diagnostic')) diagnostics?.log('warn', 'desktop', 'ipc', 'ipc.failed', {}, { capability: channel }, false, error);
        throw error;
      }
    });
  handle('aria:diagnostic-status', () => {
    if (!diagnostics) throw new Error('Diagnostics are unavailable.');
    return diagnostics.status();
  });
  handle('aria:diagnostic-configure', async (value) => {
    if (!diagnostics) throw new Error('Diagnostics are unavailable.');
    const status = await diagnostics.configure(diagnosticConfigSchema.parse(value));
    chat?.configureDiagnostics(status.config);
    return status;
  });
  handle('aria:diagnostic-query', (value) => {
    if (!diagnostics) throw new Error('Diagnostics are unavailable.');
    return diagnostics.query(diagnosticFilterSchema.parse(value));
  });
  handle('aria:diagnostic-subscribe', (value) => { diagnosticSubscribed = z.boolean().parse(value); });
  handle('aria:diagnostic-renderer-error', () => diagnostics?.log('error', 'renderer', 'application', 'renderer.error'));
  handle('aria:diagnostic-clear', async () => {
    if (!diagnostics || !mainWindow || mainWindow.isDestroyed()) throw new Error('Diagnostics are unavailable.');
    const result = await dialog.showMessageBox(mainWindow, { type: 'warning', message: 'Clear all diagnostic logs?',
      detail: 'Local diagnostic events will be permanently removed.', buttons: ['Cancel', 'Clear logs'],
      defaultId: 0, cancelId: 0, noLink: true });
    if (result.response === 1) await diagnostics.clear();
  });
  handle('aria:diagnostic-open', async () => {
    if (!diagnostics) throw new Error('Diagnostics are unavailable.');
    const error = await shell.openPath(diagnostics.directory);
    if (error) throw new Error('The logs directory could not be opened.');
  });
  handle('aria:diagnostic-export', (value) => exportDiagnosticReport(diagnosticFilterSchema.parse(value)));
  handle('aria:connectors', (input) => connectors.command(connectorCommand.parse(input)));
  handle('aria:connector-activity', (id) => connectors.history(githubAccountId.parse(id)));
  handle('aria:proactive', async (input) => {
    const result = await proactive?.handle(input);
    if (result?.kind === 'accepted') syncTray(Boolean(initial.data.preferences.minimizeToTray) || Boolean(proactive?.background()));
    return result ?? { kind: 'error', code: 'unavailable', message: 'The proactive runtime is unavailable.' };
  });
  handle('aria:update-state', () => updates.snapshot);
  handle('aria:update-command', (input) => {
    const command = z.union([
      z.object({ action: z.literal('channel'), channel: z.enum(['stable', 'beta']) }),
      z.object({ action: z.enum(['check', 'download', 'install', 'open-installer', 'open-release']) }),
    ]).parse(input);
    return updates.command(command, (perform) => {
      installUpdate = perform;
      app.quit();
    });
  });
  handle('aria:enable-close-flush', () => {
    closeFlushEnabled = true;
  });
  handle('aria:close-ready', async () => {
    await media.close();
    await browser.flush();
    mainWindow?.destroy();
    if (quitting) app.quit();
  });
  handle('aria:close-failed', (error) => {
    closePending = false;
    quitting = false;
    installUpdate = undefined;
    updates.installCancelled();
    proactive?.show();
    dialog.showErrorBox('Local changes could not be saved', string.parse(error));
  });
  handle('aria:load', () => ({
    ...initial,
    data: {
      ...initial.data,
      chat: {
        ...initial.data.chat,
        messages: initial.data.chat.messages.map((message) => {
          if (message.role !== 'assistant') return message;
          const projection = activeMessages.get(message.id);
          const current = projection?.conversationId === message.conversationId ? projection : message;
          if (chat.activeTurn(current)) return current;
          if (!['pending', 'streaming', 'interrupted', 'failed'].includes(current.status)) return current;
          const execution = loopRecovery.snapshot(current.conversationId, current.id);
          if (execution)
            return { ...current, status: 'interrupted', execution, retryConfirmed: false,
              error: 'This execution was interrupted. Review its activity before resuming.', activity: endActivity(current.activity) };
          if (['pending', 'streaming'].includes(current.status))
            return { ...current, status: 'interrupted', retryConfirmed: false,
              error: 'This response was interrupted. You can send it again.', activity: endActivity(current.activity) };
          return current;
        }),
      },
    },
  }));
  handle('aria:active-chat-messages', () => [...activeMessages.values()].filter((message) =>
    savedConversation(message.conversationId)));
  const presentationMessage = (conversationId: string, messageId: string) => {
    if (!savedConversation(conversationId)) return undefined;
    const projected = activeMessages.get(messageId);
    return projected?.conversationId === conversationId ? projected
      : initial.data.chat.messages.find((message) => message.id === messageId && message.conversationId === conversationId);
  };
  handle('aria:persona-action', async (input) => {
    if (!mainWindow) throw new Error('Open the conversation to use this action.');
    const parsed = presentationActionRequest.parse(input);
    const started = performance.now();
    const message = presentationMessage(parsed.conversationId, parsed.messageId);
    let status = 'rejected';
    try {
      const theme = initial.data.preferences.theme;
      const result = await personaAction(parsed, presentationMessage, mainWindow,
        theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors));
      status = result.kind;
      return result;
    } finally {
      if (message && savedConversation(message.conversationId))
        diagnostics?.log('debug', 'chat', 'persona', 'persona.action', {
          conversationId: message.conversationId, requestId: message.requestId,
          executionId: message.execution?.executionId, generation: message.execution?.generation,
        }, { status, durationMs: performance.now() - started }, temporaryConversations.has(message.conversationId));
    }
  });
  handle('aria:persona-render', (id, input, timing) => {
    const messageId = identifier.parse(id);
    const status = z.enum(['rendered', 'failed']).parse(input);
    const durationMs = z.number().min(0).max(30_000).parse(timing);
    const message = activeMessages.get(messageId) ?? initial.data.chat.messages.find((item) => item.id === messageId);
    if (message?.presentation?.length && savedConversation(message.conversationId))
      diagnostics?.log('debug', 'renderer', 'persona', 'persona.render', {
        conversationId: message.conversationId, requestId: message.requestId,
        executionId: message.execution?.executionId, generation: message.execution?.generation,
      }, { status, durationMs }, temporaryConversations.has(message.conversationId));
  });
  handle('aria:communication-preferences', () => memory.communicationPreferences());
  handle('aria:review-communication-preference', (id, accept) =>
    memory.reviewCommunicationPreference(z.string().regex(/^[0-9a-f]{64}$/).parse(id), z.boolean().parse(accept)));
  handle('aria:memory-status', () => memory.status());
  handle('aria:memory-diagnostics', () => memory.diagnosticSnapshot());
  handle('aria:save-memory-settings', (input, rawConsent) => {
    const parsed = memorySettingsSchema.parse(input);
    const allowAutoRecall = z.boolean().optional().parse(rawConsent);
    let next = parsed;
    if (allowAutoRecall === true) {
      const providerKey = chat.executionIdentity();
      if (!providerKey || !chat.getStatus().configured)
        throw new Error('Configure a primary model before enabling automatic memory recall.');
      next = {
        ...parsed,
        recallConsent: parsed.enabled ? { providerKey, grantedAt: Date.now() } : undefined,
      };
    } else if (allowAutoRecall === false || !parsed.enabled) {
      next = { ...parsed, recallConsent: undefined };
    } else {
      next = { ...parsed, recallConsent: memory.settings.recallConsent };
    }
    return memory.saveSettings(next);
  });
  handle('aria:remember-chat-message', (conversationInput, messageInput, categoryInput) => {
    const conversation = savedConversation(identifier.parse(conversationInput));
    const messageId = identifier.parse(messageInput);
    const category = memoryCategory.parse(categoryInput);
    const message = initial.data.chat.messages.find((item) =>
      item.id === messageId && item.conversationId === conversation?.id && item.role === 'user' &&
      item.status === 'completed' && !item.liveSessionId);
    if (!conversation || !message || conversation.temporary)
      throw new Error('Choose a saved user message.');
    if (conversation.projectId) registeredMemoryProject(conversation.projectId);
    return memory.rememberSource(conversation, message, category);
  });
  handle('aria:memory-evidence', async (conversationInput, recordInput) => {
    const conversationId = identifier.parse(conversationInput);
    const id = z.string().uuid().parse(recordInput);
    const owner = savedConversation(conversationId);
    if (!owner || owner.temporary || !memory.settings.enabled ||
      !(memory.canInspect(conversationId, id) ||
        initial.data.chat.messages.some((message) => message.conversationId === conversationId && message.memoryReferences?.includes(id))))
      return null;
    return await memory.client.call('read', id, { conversationId, projectId: owner.projectId }, true) ?? null;
  });
  handle('aria:search-memories', (input) => memory.search(memoryManagementSearch.parse(input)));
  handle('aria:edit-memory', (input) => memory.edit(memoryOperations['memory.update'].parse(input)));
  handle('aria:delete-memory', (input) => memory.forget(memoryOperations['memory.forget'].parse(input)));
  handle('aria:clear-memories', async (input) => {
    const filter = memoryClear.parse(input);
    if (filter.projectId) registeredMemoryProject(filter.projectId);
    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'warning', message: 'Delete the selected saved memories?',
      detail: 'Chat history has its own controls.',
      buttons: ['Cancel', 'Delete memories'], cancelId: 0, defaultId: 0, noLink: true,
    });
    return response === 1 ? memory.clear(filter) : 0;
  });
  handle('aria:export-memories', async () => {
    const destination = await dialog.showSaveDialog(mainWindow!, {
      title: 'Export saved memories', defaultPath: 'aria-memories.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (destination.canceled || !destination.filePath) return false;
    const temporary = `${destination.filePath}.${randomUUID()}.tmp`;
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile('{"version":1,"memories":[');
      const revision = (await memory.client.call('status')).revision;
      let cursor = '';
      let separator = '';
      for (;;) {
        const records = await memory.client.call('exportPage', cursor);
        if (!records.length) break;
        await file.writeFile(separator + records.map((record) => JSON.stringify(record)).join(',\n'));
        cursor = records.at(-1)!.id;
        separator = ',\n';
        if ((await memory.client.call('status')).revision !== revision)
          throw new Error('Memories changed during export. Try again.');
      }
      await file.writeFile(']}\n');
      await file.sync();
      await file.close();
      await fs.rename(temporary, destination.filePath);
      return true;
    } finally {
      await file.close().catch(() => undefined);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  handle('aria:start-temporary-chat', (input) => {
    const id = z.string().uuid().parse(input);
    if (!memory.settings.temporaryChats || temporaryConversations.size >= 20 || savedConversation(id))
      throw new Error('Temporary chat is unavailable.');
    temporaryConversations.add(id);
  });
  handle('aria:attach-chat-project', (conversation, project) => {
    const id = z.string().uuid().parse(conversation);
    const projectId = z.string().nullable().parse(project);
    if (projectId) registeredMemoryProject(projectId);
    if (temporaryConversations.has(id) ||
      initial.data.chat.messages.some((item) => item.conversationId === id))
      throw new Error('Choose a project before sending the first message.');
    if (!savedConversation(id)) throw new Error('Save the conversation before choosing its project.');
    pendingChatProjects.set(id, projectId);
  });
  handle('aria:save', async (data) => {
    const parsed = localDataSchema.parse(data);
    saving = saving
      .catch(() => undefined)
      .then(async () => {
        const previous = initial.data;
        for (const item of parsed.chat.conversations) {
          const previousConversation = savedConversation(item.id);
          const expectedProject = pendingChatProjects.has(item.id)
            ? pendingChatProjects.get(item.id) ?? undefined
            : previousConversation?.projectId;
          if (Boolean(item.temporary) !== temporaryConversations.has(item.id) || item.projectId !== expectedProject)
            throw new Error('The conversation mode or project was not authorized.');
        }
        const previousMessages = new Map(previous.chat.messages.map((item) => [item.id, item]));
        for (const item of parsed.chat.messages) {
          const old = previousMessages.get(item.id);
          const projected = activeMessages.get(item.id);
          const trusted = projected?.requestId === item.requestId && projected.conversationId === item.conversationId
            ? projected : old?.requestId === item.requestId && old.conversationId === item.conversationId ? old : undefined;
          item.presentation = item.role === 'assistant' ? trusted?.presentation?.filter((part) => part.offset <= item.content.length) : undefined;
          if (!item.presentation?.length) item.presentationState = undefined;
          if (!item.memoryReferences?.length) continue;
          const permitted = item.memoryReferences.filter((id) =>
            old?.memoryReferences?.includes(id) || memory.canInspect(item.conversationId, id, item.id));
          item.memoryReferences = permitted.length ? permitted : undefined;
        }
        const seenWorkspaces = new Set(parsed.workspaces.map((item) => item.id));
        const mergedData = {
          ...parsed,
          workspaces: [
            ...parsed.workspaces,
            ...previous.workspaces.filter((item) => !seenWorkspaces.has(item.id)),
          ],
        };
        const outbox = memory.outbox(storage.memoryOutbox, mergedData.chat.messages, mergedData.chat.conversations);
        await storage.save(mergedData, outbox);
        initial = { data: mergedData };
        syncTray(Boolean(mergedData.preferences.minimizeToTray) || Boolean(proactive?.background()));
        for (const message of parsed.chat.messages) {
          const projection = activeMessages.get(message.id);
          if (projection?.requestId !== message.requestId || projection.conversationId !== message.conversationId) continue;
          if (message.sequence >= projection.sequence && !chat.activeTurn(message)) activeMessages.delete(message.id);
          else if (message.presentationState && projection.presentation?.length)
            activeMessages.set(message.id, { ...projection, presentationState: message.presentationState });
        }
        for (const { id } of parsed.chat.conversations) pendingChatProjects.delete(id);
        void drainMemoryOutbox();
        browser.pruneConversations(parsed.chat.conversations);
        const retained = new Set(parsed.chat.conversations.map(({ id }) => id));
        for (const { id } of previous.chat.conversations)
          if (!retained.has(id)) {
            temporaryConversations.delete(id);
            diagnostics?.discardTemporary(id);
            pendingChatProjects.delete(id);
            workingContext.clear(id);
            for (const [messageId, message] of activeMessages) if (message.conversationId === id) {
              activeMessages.delete(messageId);
              void chat.cancel(message.requestId);
            }
            executionRuntime.store.deletePrograms(id);
            proactive?.removeConversation(id);
            void memory.removeConversation(id).catch(() => undefined);
          }
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
    const previousCount = initial.data.workspaces.length;
    initial.data = {
      ...initial.data,
      workspaces: [...initial.data.workspaces.filter((w) => w.id !== workspace.id), workspace],
    };
    if (previousCount !== initial.data.workspaces.length && !configuring) {
      return await changeCapabilities(async () => undefined, async () => workspace);
    }
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
  handle('aria:browser-state', () => browser.state());
  handle('aria:browser-command', (input) => browser.command(browserCommandSchema.parse(input)));
  handle('aria:browser-layout', (input) => {
    const previous = browser.activeConversation();
    const next = browserLayoutSchema.parse(input);
    browser.setLayout(next.conversationId && temporaryConversations.has(next.conversationId)
      ? { ...next, conversationId: null, bounds: null } : next);
    if (previous && previous !== browser.activeConversation()) computerRuntime.leave(previous);
  });
  handle('aria:computer-sessions', (conversation) =>
    computerRuntime.states(identifier.parse(conversation)),
  );
  handle('aria:computer-preview', (conversation, id) =>
    computerRuntime.preview(identifier.parse(conversation), z.string().uuid().parse(id)),
  );
  handle('aria:computer-supervise', (conversation, command) =>
    computerRuntime.supervise(identifier.parse(conversation), computerSupervision.parse(command)),
  );
  handle('aria:computer-user-input', (conversation, value) => {
    const request = computerUserInput.parse(value);
    return computerRuntime.userInput(
      identifier.parse(conversation),
      request.sessionId,
      request.action,
    );
  });
  handle('aria:probe-virtual-computer', () =>
    changeCapabilities(() => virtualComputer.verify(AbortSignal.timeout(30_000))),
  );
  handle('aria:local-computer-supported', () => localComputer.supported());
  handle('aria:local-desktop-access', (value) => {
    const requestPermission = z.boolean().default(false).parse(value);
    if (requestPermission && !mainWindow?.isFocused())
      throw new Error('Focus Aria before requesting desktop permissions.');
    return localComputer.access(AbortSignal.timeout(10_000), requestPermission);
  });
  handle('aria:select-local-computer', async (value, rawTarget, rawStanding) => {
    const target = z.enum(['window', 'screen']).default('window').parse(rawTarget);
    const standing = target === 'screen' && z.boolean().default(false).parse(rawStanding);
    const owner = standing ? identifier.nullable().parse(value) ?? '' : identifier.parse(value);
    const window = mainWindow;
    if (!window?.isFocused()) throw new Error('Focus Aria before selecting desktop access.');
    if (localSelection || configuring) throw new Error('Wait for the current settings change.');
    const selection = new AbortController();
    localSelection = selection;
    const checkSelection = () => {
      selection.signal.throwIfAborted();
      const active = browser.activeConversation();
      if (
        mainWindow !== window || window.isDestroyed() || window.isMinimized() ||
        (!standing && (initial.data.chat.selectedId !== owner || (active !== null && active !== owner)))
      )
        throw new Error('Keep Aria open and select the conversation that will use the local desktop.');
    };
    try {
      checkSelection();
      let display: Awaited<ReturnType<typeof chooseDisplay>>;
      let standingProvider: string | undefined;
      if (target === 'screen') {
        let detail = 'Aria can ask to share screenshots, open a supported app, or use the mouse on this display. Each action requires your approval.';
        if (standing) {
          const identity = chat.runtimeIdentity();
          if (!identity || !chat.getStatus().configured)
            throw new Error('Configure a primary model before allowing ongoing display access.');
          standingProvider = identity.key;
          detail = `Allow Aria to send screenshots of the selected display to ${identity.model} at ${new URL(identity.endpoint).origin} and use its mouse controls and built-in desktop shortcuts from any active chat. Aria asks before opening other installed apps. Access continues after restart until you click Revoke.`;
        }
        display = await chooseDisplay(window, 'Select a full screen', detail, true);
        if (!display || selection.signal.aborted) return false;
      }
      return await changeCapabilities(async () => {
        checkSelection();
        const signal = AbortSignal.any([selection.signal, AbortSignal.timeout(85_000)]);
        if (display) await localComputer.prepareScreen(owner, display, signal, standingProvider, checkSelection);
        else await localComputer.prepare(owner, signal, checkSelection);
        await computerRuntime.closeLocalSessions();
      }, async () => true);
    } finally {
      if (localSelection === selection) localSelection = undefined;
    }
  });
  handle('aria:revoke-local-computer', async () => {
    localSelection?.abort();
    localComputer.revoke();
    if (configuring) {
      await computerRuntime.closeLocalSessions();
      return;
    }
    await changeCapabilities(() => computerRuntime.closeLocalSessions(), async () => undefined);
  });
  handle('aria:web-settings', () => webSettings.get());
  handle('aria:weather-settings', () => weather.settings());
  handle('aria:save-weather-settings', (input) => {
    const parsed = weatherSettingsSchema.parse(input);
    return parsed.enabled !== weather.settings().enabled || parsed.provider !== weather.settings().provider
      ? changeCapabilities(() => weather.configure(parsed), async () => weather.settings())
      : weather.configure(parsed);
  });
  handle('aria:clear-weather-cache', () => weather.clearCache());
  handle('aria:save-web-settings', async (input) => {
    const parsed = webSettingsInputSchema.parse(input);
    const previous = webSettings.get();
    const immediate =
      (previous.enabled && !parsed.enabled) || (previous.aiBrowser && !parsed.aiBrowser);
    if (configuring) throw new Error('Wait for settings to finish saving.');
    if (!immediate) {
      chat.assertIdle();
      media.assertIdle();
    }
    configuring = true;
    try {
      if (immediate) {
        await chat.cancelAll();
        await media.close();
      }
      await webSettings.save(parsed);
      try {
        await browser.applyPolicy(previous);
      } finally {
        await chat.restart();
      }
      return webSettings.get();
    } finally {
      configuring = false;
    }
  });
  handle('aria:tool-settings', toolSettings);
  handle('aria:set-tool-enabled', (id, enabled) => {
    const tool = capabilityId.parse(id);
    const value = z.boolean().parse(enabled);
    return changeCapabilities(async () => {
      if (!(await toolSettings()).tools.some((item) => item.id === tool))
        throw new Error('This tool is no longer registered.');
      await capabilities.setEnabled(tool, value);
    });
  });
  handle('aria:set-tool-discovery', (input) => {
    const mode = toolDiscoverySchema.parse(input);
    return changeCapabilities(async () => {
      let proof: string | undefined;
      if (mode === 'openai-responses') {
        proof = nativeProof(await provider.resolve());
        if (!proof) throw new Error('Select an official OpenAI primary model in AI Models first.');
        const response = await chat.http('providers/verify-tool-search', {
          method: 'POST',
          signal: AbortSignal.timeout(22_000),
        });
        z.strictObject({ verified: z.literal(true) }).parse(await response.json());
      }
      await capabilities.setDiscovery(mode, proof);
    });
  });
  handle('aria:set-program-settings', (input) => {
    const settings = programSettingsSchema.parse(input);
    return changeCapabilities(async () => {
      let proof: string | undefined;
      if (settings.backend === 'managed') {
        if (!settings.image) throw new Error('Enter the immutable Aria program runner image ID.');
        await executionRuntime.verifyProgramImage(settings.image, AbortSignal.timeout(16_000));
      } else if (settings.backend === 'openai-responses') {
        proof = nativeProof(await provider.resolve());
        if (!proof) throw new Error('Select an official OpenAI primary in AI Models first.');
        const policy = capabilities.policy(proof);
        if (policy.discovery === 'openai-responses' && !policy.nativeVerified)
          throw new Error('Verify OpenAI Tool Search before enabling this combination.');
        const response = await chat.http('providers/verify-programmatic', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ continuation: settings.continuation, discovery: policy.discovery }),
          signal: AbortSignal.timeout(45_000),
        });
        z.object({ verified: z.literal(true) }).parse(await response.json());
      }
      await capabilities.setProgramming(settings, proof);
    });
  });
  handle('aria:preview-skill', async (input) => {
    const kind = z.enum(['directory', 'zip']).parse(input);
    if (configuring || !mainWindow) throw new Error('Wait for settings to finish saving.');
    const selected = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose an Agent Skill bundle',
      properties: [kind === 'zip' ? 'openFile' : 'openDirectory'],
      ...(kind === 'zip' && { filters: [{ name: 'Skill archive', extensions: ['zip'] }] }),
    });
    const [file] = selected.filePaths;
    if (selected.canceled || !file) return null;
    return capabilities.preview(file, kind);
  });
  handle('aria:approve-skill', (token) => {
    const parsed = z.string().uuid().parse(token);
    return changeCapabilities(() => capabilities.approve(parsed));
  });
  handle('aria:manage-skill', (ref, action) => {
    const parsed = skillRefSchema.parse(ref);
    const command = z.enum(['enable', 'disable', 'remove']).parse(action);
    return changeCapabilities(() => capabilities.manage(parsed, command));
  });
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
  handle('aria:submit-chat', async (input) => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    const parsed = chatRequestSchema.parse(input);
    if (chat.getStatus().state === 'failed') await chat.start();
    media.assertIdle();
    const conversation = savedConversation(parsed.conversationId);
    if (!conversation) throw new Error('Save this conversation before sending.');
    if (conversation.projectId) registeredMemoryProject(conversation.projectId);
    const messages = initial.data.chat.messages.filter(
      (message) => message.conversationId === parsed.conversationId,
    );
    const assistant = messages.at(-1);
    const latest = messages.at(-2);
    if (
      assistant?.role !== 'assistant' ||
      !['pending', 'streaming'].includes(assistant.status) ||
      assistant.id !== parsed.assistantMessageId ||
      assistant.requestId !== parsed.requestId ||
      latest?.role !== 'user' ||
      latest.content !== parsed.messages.at(-1)?.content
    )
      throw new Error('Save this conversation before sending its latest turn.');
    if (
      parsed.attachmentIds?.some(
        (id) =>
          !latest.assets?.some((asset) => asset.id === id) &&
          !latest.operation?.assetIds.includes(id),
      )
    )
      throw new Error('Attach the files to this turn before sending them.');
    const context = selectChatContext(messages, chat.getStatus().revision ?? '');
    if (loopRecovery.snapshot(conversation.id, assistant.id))
      throw new Error('Resume the interrupted execution from its activity before retrying the turn.');
    const options = memory.admit(conversation, latest, assistant);
    const contextHints = await memory.selectiveContext(
      conversation,
      latest.content,
      assistant.id,
      parsed.requestId,
    );
    const workingSummary = conversation.temporary ? undefined :
      workingContext.capture(conversation.id, messages, context.messages.length, memory.cutoff);
    try {
      const personalization = personalizationContext();
      activeMessages.set(assistant.id, assistant);
      chat.submit({
        ...parsed,
        execution: { executionId: randomUUID(), generation: 1, userMessageId: latest.id },
        activeProjectId: conversation.projectId,
        availableProjects: initial.data.workspaces.map(({ id, name, branch }) => ({
          id,
          name,
          branch,
        })),
        memory: {
          ...options,
          workingSummary,
          privateHistory: context.memoryPrivate || contextHints.length > 0,
          ...(contextHints.length && { contextHints }),
        },
        programPrivateHistory: context.privateContent,
        ...(personalization && { personalization }),
        messages: context.messages,
      });
    } catch (error) {
      activeMessages.delete(assistant.id);
      memory.event({ ...parsed, sequence: 1, type: 'stopped' });
      throw error;
    }
  });
  handle('aria:execution-history', () => executionRuntime.history());
  handle('aria:runtime-settings', () => executionRuntime.settings());
  handle('aria:save-runtime-settings', (value) =>
    changeRuntimeSettings(async () => {
      const current = executionRuntime.settings();
      const next = runtimeSettingsSchema.parse(value);
      await executionRuntime.configure(next);
      if (current.engineSocket !== next.engineSocket || current.desktopImage !== next.desktopImage ||
          JSON.stringify(current.loop) !== JSON.stringify(next.loop)) {
        await computerRuntime.shutdown();
        await chat.restart();
      }
      return executionRuntime.settings();
    }),
  );
  handle('aria:save-embedding-target', (value) =>
    changeRuntimeSettings(() =>
      executionRuntime.saveEmbeddingTarget(runtimeSettingsSchema.shape.embeddingTarget.parse(value)),
    ),
  );
  const nativeRuntimeModes = async () => runtimePolicy(await provider.resolve()).nativeRuntime ?? [];
  handle('aria:native-runtime-modes', nativeRuntimeModes);
  handle('aria:set-native-runtime', (raw, enabled) => {
    const feature = openAIRuntimeFeatureSchema.parse(raw);
    const verify = z.boolean().parse(enabled);
    return changeCapabilities(async () => {
      if (!verify) return capabilities.verifyNativeRuntime(feature);
      const proof = nativeProof(await provider.resolve(), feature === 'computer-image');
      if (!proof) throw new Error('Configure a compatible primary model first.');
      const response = await chat.http('providers/verify-native-runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature }),
        signal: AbortSignal.timeout(45_000),
      });
      z.object({ feature: z.literal(feature), verified: z.literal(true) }).parse(
        await response.json(),
      );
      return capabilities.verifyNativeRuntime(feature, proof);
    }, nativeRuntimeModes);
  });
  handle('aria:probe-runtime', () => executionRuntime.inspect(AbortSignal.timeout(10_000), 'managed'));
  handle('aria:local-embeddings', () => executionRuntime.embeddings.available());
  handle('aria:install-local-embeddings', async () => {
    chat.assertIdle();
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select the verified embedding pack',
      properties: ['openDirectory'],
    });
    if (selection.canceled) return executionRuntime.embeddings.available();
    chat.assertIdle();
    await executionRuntime.embeddings.install(selection.filePaths[0]);
    return true;
  });
  handle('aria:remove-local-embeddings', async () => {
    chat.assertIdle();
    await executionRuntime.embeddings.remove();
  });
  handle('aria:knowledge-collections', () => executionRuntime.library.list());
  handle('aria:manage-knowledge', async (value) => {
    const id = z.string().uuid();
    const input = z
      .discriminatedUnion('operation', [
        z.strictObject({ operation: z.literal('create'), name: z.string().trim().min(1).max(100) }),
        z.strictObject({ operation: z.literal('enable'), id, enabled: z.boolean() }),
        z.strictObject({ operation: z.literal('add'), id }),
        z.strictObject({ operation: z.literal('remove'), id }),
        z.strictObject({ operation: z.literal('remove-file'), id, fileId: id }),
      ])
      .parse(value);
    chat.assertIdle();
    const library = executionRuntime.library;
    switch (input.operation) {
      case 'create':
        library.create(input.name);
        break;
      case 'enable':
        library.enable(input.id, input.enabled);
        break;
      case 'add': {
        const selected = await dialog.showOpenDialog(mainWindow!, {
          title: 'Add documents to this library',
          properties: ['openFile', 'multiSelections'],
        });
        chat.assertIdle();
        if (!selected.canceled) await library.add(input.id, selected.filePaths);
        break;
      }
      case 'remove':
        await library.remove(input.id);
        break;
      case 'remove-file':
        await library.remove(input.id, input.fileId);
        break;
    }
    return library.list();
  });
  handle('aria:preview-document', (conversation, id) =>
    executionRuntime.preview(identifier.parse(conversation), z.string().uuid().parse(id)),
  );
  handle('aria:remove-artifact', async (conversation, id) => {
    chat.assertConversationIdle(identifier.parse(conversation));
    await executionRuntime.removeArtifact(
      identifier.parse(conversation),
      z.string().uuid().parse(id),
    );
  });
  handle('aria:document-evidence', (conversationId, evidenceId) =>
    executionRuntime.evidence(
      z.string().uuid().parse(evidenceId),
      identifier.parse(conversationId),
    ),
  );
  handle('aria:cancel-chat', (id) => chat.cancel(identifier.parse(id)));
  handle('aria:control-execution', async (value) => {
    const command = loopCommandSchema.parse(value);
    if (!await chat.control(command)) return;
    if (command.action === 'pause' || command.action === 'resume')
      approvals.suspend(command.requestId, command.action === 'pause');
    if (command.action === 'steer' || command.action === 'answer') {
      approvals.revokeExecution(command.requestId);
      executionRuntime.revokeExecution(command.requestId);
    }
  });
  handle('aria:resume-execution', async (value) => {
    const scope = loopRecoveryRequestSchema.parse(value);
    if (configuring) throw new Error('Wait for Settings to finish saving.');
    media.assertIdle();
    const conversation = savedConversation(scope.conversationId);
    if (!conversation || conversation.temporary) throw new Error('Choose a saved conversation.');
    if (conversation.projectId) registeredMemoryProject(conversation.projectId);
    const messages = initial.data.chat.messages.filter((message) => message.conversationId === scope.conversationId);
    const assistant = messages.at(-1);
    const user = messages.at(-2);
    if (assistant?.id !== scope.assistantMessageId || assistant.role !== 'assistant' || user?.role !== 'user')
      throw new Error('Resume the latest execution in this conversation.');
    chat.assertExecutionCapacity(conversation.id);
    if (chat.getStatus().state === 'failed') await chat.start();
    if (!chat.getStatus().configured) throw new Error('Connect to the original primary in AI Models.');
    const requestId = randomUUID();
    const execution = await loopRecovery.restore(scope, user.id, requestId, () => {
      chat.assertExecutionCapacity(conversation.id);
      return !configuring && initial.data.chat.messages.filter((item) => item.conversationId === conversation.id).at(-1)?.id === assistant.id;
    });
    const context = selectChatContext(messages, chat.getStatus().revision ?? '');
    const seed: ChatMessage = { ...assistant, execution: {
      executionId: execution.executionId, generation: scope.generation, state: 'recovering', durability: 'saved',
      iteration: execution.recovery?.iteration ?? 0,
    } };
    activeMessages.set(assistant.id, seed);
    const memoryOptions = memory.admit(conversation, user, { ...assistant, requestId });
    try {
      const personalization = personalizationContext();
      chat.submit({
        execution, requestId, conversationId: conversation.id, assistantMessageId: assistant.id,
        expectedRevision: chat.getStatus().revision, messages: context.messages,
        attachmentIds: user.assets?.map(({ id }) => id) ?? user.operation?.assetIds ?? [],
        memory: { ...memoryOptions, privateHistory: context.memoryPrivate },
        programPrivateHistory: context.privateContent || execution.recovery?.privateContent || execution.recovery?.memoryContent,
        ...(personalization && { personalization }),
      });
    } catch (error) {
      activeMessages.delete(assistant.id);
      throw error;
    }
  });
  handle('aria:supervise-program', (request, conversation, id, paused) => {
    const requestId = identifier.parse(request);
    const conversationId = identifier.parse(conversation);
    if (!chat.activeTurn({ requestId, conversationId }))
      throw new Error('The program is no longer active in this conversation.');
    executionRuntime.programs.supervise(requestId, conversationId, z.string().uuid().parse(id), z.boolean().parse(paused));
  });
  handle('aria:inspect-program-result', (conversation, id) =>
    executionRuntime.inspectProgramResult(identifier.parse(conversation), z.string().uuid().parse(id)),
  );
  handle('aria:recover-stored-response', async (conversation, message, request) => {
    const conversationId = identifier.parse(conversation);
    const messageId = identifier.parse(message);
    const requestId = identifier.parse(request);
    const eligible = () => initial.data.chat.messages.some((item) =>
      item.conversationId === conversationId && item.id === messageId &&
      item.requestId === requestId && item.status === 'interrupted' && item.run?.storedResponses);
    if (!eligible()) throw new Error('The stored response does not belong to an interrupted turn.');
    chat.assertConversationIdle(conversationId);
    const result = await executionRuntime.recoverStoredResponse(conversationId, messageId, requestId);
    if (!eligible()) throw new Error('The interrupted turn changed during recovery.');
    return result;
  });
  async function importFiles(filenames: string[], kind: 'image' | 'audio' | 'text' | 'any') {
    if (filenames.length > 4 || filenames.some((file) => !path.isAbsolute(file)))
      throw new Error('Choose up to four files from your device.');
    const imported = [];
    try {
      for (const filename of filenames) imported.push(await assets.import(filename, kind));
      return imported;
    } catch (error) {
      await Promise.allSettled(imported.map((asset) => assets.remove(asset.id)));
      throw error;
    }
  }
  handle('aria:import-dropped-files', (files) =>
    importFiles(z.array(z.string().min(1).max(16000)).max(4).parse(files), 'any'),
  );
  handle('aria:capture-screen', async () => {
    if (!mainWindow?.isFocused()) throw new Error('Focus Aria before capturing your screen.');
    const bytes = await captureDisplay(mainWindow);
    return bytes ? [await assets.put(bytes, 'Screen capture.jpg', 'image/jpeg')] : [];
  });
  handle('aria:choose-media', async (kind) => {
    const parsed = z.enum(['image', 'audio', 'text', 'any']).parse(kind);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Attach files to this message',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Documents, data, images, and audio',
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
            'pdf',
            'docx',
            'xlsx',
            'pptx',
            'zip',
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
    return importFiles(result.filePaths, parsed);
  });
  handle('aria:export-media', async (id) => {
    const knownId = z.string().uuid().parse(id);
    if (!referencedAssets(initial.data).has(knownId) && !chat.recentlyPublished(knownId))
      throw new Error('This file is unavailable.');
    const { asset, bytes } = await assets.get(knownId);
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: asset.name });
    if (!result.canceled && result.filePath) await fs.writeFile(result.filePath, bytes);
  });
  handle('aria:start-live', async (input) => {
    if (configuring) throw new Error('Wait for settings to finish saving.');
    chat.assertIdle(true);
    const request = liveRequestSchema.parse(input);
    if (temporaryConversations.has(request.conversationId))
      throw new Error('Live voice is unavailable in temporary chat.');
    await media.startLive(request);
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
  handle('aria:system-behavior', () => {
    const loginSupported = app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
    const loginReason = !loginSupported
      ? process.platform === 'linux'
        ? 'System login item configuration is available on macOS and Windows.'
        : 'Launch at system startup is available in packaged Aria desktop builds.'
      : undefined;
    return {
      openAtLogin: loginSupported ? app.getLoginItemSettings().openAtLogin : false,
      loginSupported,
      loginReason,
      minimizeToTray: Boolean(initial?.data?.preferences.minimizeToTray),
      traySupported: Boolean(appIcon),
    };
  });
  handle('aria:set-system-behavior', async (raw) => {
    const patch = systemBehaviorInputSchema.parse(raw);
    const loginSupported = app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
    if (patch.openAtLogin !== undefined) {
      if (!loginSupported)
        throw new Error(
          process.platform === 'linux'
            ? 'Launch at system startup is not supported on Linux.'
            : 'Launch at system startup requires a packaged Aria build.',
        );
      app.setLoginItemSettings({ openAtLogin: patch.openAtLogin });
    }
    if (patch.minimizeToTray !== undefined) {
      const previousTray = Boolean(initial.data.preferences.minimizeToTray);
      if (patch.minimizeToTray && !syncTray(true)) throw new Error('The system tray could not be initialized on this desktop.');
      saving = saving.catch(() => undefined).then(async () => {
        const next = {
          ...initial.data,
          preferences: { ...initial.data.preferences, minimizeToTray: patch.minimizeToTray },
        };
        await storage.save(next);
        initial = { data: next };
        syncTray(Boolean(patch.minimizeToTray) || Boolean(proactive?.background()));
      });
      try {
        await saving;
      } catch (error) {
        syncTray(previousTray);
        throw error;
      }
    }
    return {
      openAtLogin: loginSupported ? app.getLoginItemSettings().openAtLogin : false,
      loginSupported,
      loginReason: !loginSupported
        ? process.platform === 'linux'
          ? 'System login item configuration is available on macOS and Windows.'
          : 'Launch at system startup is available in packaged Aria desktop builds.'
        : undefined,
      minimizeToTray: Boolean(initial?.data?.preferences.minimizeToTray),
      traySupported: Boolean(appIcon),
    };
  });
  handle('aria:test-notification', () => {
    if (!Notification.isSupported())
      throw new Error('Desktop notifications are not supported in this environment.');
    const sound = initial?.data?.preferences.notifications?.sound ?? true;
    const note = new Notification({
      title: 'Aria Desktop',
      body: 'Desktop notifications are working.',
      silent: !sound,
    });
    note.on('click', () => mainWindow?.focus());
    note.show();
  });
  handle('aria:remove-workspace', async (rawId) => {
    const id = identifier.parse(rawId);
    chat.assertIdle();
    const workspace = initial.data.workspaces.find((item) => item.id === id);
    if (!workspace) return false;
    if (initial.data.chat.conversations.some((conversation) => conversation.projectId === id))
      throw new Error('This directory is attached to saved conversations. Remove those conversations before revoking access.');
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Open Aria to confirm directory removal.');
    if (mainWindow && !mainWindow.isDestroyed()) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: `Remove authorized directory “${workspace.name}”?`,
        detail: 'Aria will stop accessing files in this folder. Local files on disk are never deleted.',
        buttons: ['Cancel', 'Remove directory'],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
      });
      if (response !== 1) return false;
    }
    chat.assertIdle();
    if (initial.data.chat.conversations.some((conversation) => conversation.projectId === id))
      throw new Error('This directory is attached to saved conversations. Remove those conversations before revoking access.');
    media.assertIdle();
    await changeCapabilities(async () => {
      saving = saving.catch(() => undefined).then(async () => {
        await storage.unregister(id);
        initial = {
          data: {
            ...initial.data,
            workspaces: initial.data.workspaces.filter((item) => item.id !== id),
            preferences: {
              ...initial.data.preferences,
              activeWorkspaceId:
                initial.data.preferences.activeWorkspaceId === id
                  ? null
                  : initial.data.preferences.activeWorkspaceId,
            },
          },
        };
      });
      await saving;
    }, async () => undefined);
    return true;
  });
  handle('aria:storage-info', async () => {
    const dir = dataDirectory;
    const [
      dataFileBytes,
      providerBytes,
      webBytes,
      browserStateBytes,
      capabilitiesBytes,
      runtimeBytes,
      runtimeWalBytes,
      mediaBytes,
      memoryBytes,
      memoryWalBytes,
      skillsBytes,
      dispatchBytes,
      libraryBytes,
      embeddingsBytes,
      cacheBytes,
    ] = await Promise.all([
      pathBytes(path.join(dir, 'aria-v3.json')),
      pathBytes(path.join(dir, 'provider-v2.json')),
      pathBytes(path.join(dir, 'web-settings-v1.json')),
      pathBytes(path.join(dir, 'browser-state-v1.json')),
      pathBytes(path.join(dir, 'capabilities-v1.json')),
      pathBytes(path.join(dir, 'runtime.sqlite')),
      pathBytes(path.join(dir, 'runtime.sqlite-wal')),
      pathBytes(path.join(dir, 'media')),
      pathBytes(path.join(dir, 'memory.sqlite')),
      pathBytes(path.join(dir, 'memory.sqlite-wal')),
      pathBytes(path.join(dir, 'approved-skills')),
      pathBytes(path.join(dir, 'tool-dispatch')),
      pathBytes(path.join(dir, 'library')),
      pathBytes(path.join(dir, 'runtime-model')),
      session.fromPartition('persist:aria-web-personal').getCacheSize().catch(() => 0),
    ]);
    const areas: StorageAreaUsage[] = [
      {
        id: 'conversations',
        label: 'Conversations & preferences',
        bytes: dataFileBytes + providerBytes + webBytes + browserStateBytes + capabilitiesBytes,
      },
      { id: 'media', label: 'Attachments & generated media', bytes: mediaBytes },
      { id: 'memory', label: 'Persistent memory database', bytes: memoryBytes + memoryWalBytes },
      {
        id: 'library',
        label: 'Knowledge libraries & local embeddings',
        bytes: libraryBytes + embeddingsBytes,
      },
      {
        id: 'runtime',
        label: 'Conductor journal & approved skills',
        bytes: runtimeBytes + runtimeWalBytes + skillsBytes + dispatchBytes,
      },
      { id: 'browser-cache', label: 'Browser HTTP cache', bytes: cacheBytes },
    ];
    return {
      dataDir: dir,
      totalBytes: areas.reduce((sum, area) => sum + area.bytes, 0),
      areas,
    };
  });
  handle('aria:open-storage-folder', async () => {
    const failure = await shell.openPath(dataDirectory);
    if (failure) throw new Error('Could not open the storage directory.');
  });
  handle('aria:prune-media-cache', async () => {
    chat.assertIdle();
    const before = await pathBytes(assets.directory);
    const names = await fs.readdir(assets.directory).catch(() => [] as string[]);
    const beforeCount = names.filter((name) => !name.endsWith('.json') && !name.endsWith('.tmp')).length;
    await assets.pruneUnreferenced(initial.data, proactiveArtifactIds());
    const after = await pathBytes(assets.directory);
    const afterNames = await fs.readdir(assets.directory).catch(() => [] as string[]);
    const afterCount = afterNames.filter((name) => !name.endsWith('.json') && !name.endsWith('.tmp')).length;
    return {
      removed: Math.max(0, beforeCount - afterCount),
      freedBytes: Math.max(0, before - after),
    };
  });
  handle('aria:clear-browser-cache', async () => {
    await session.fromPartition('persist:aria-web-personal').clearCache();
  });
  handle('aria:os-permissions', () => ({
    platform: process.platform,
    microphone:
      process.platform === 'darwin' || process.platform === 'win32'
        ? systemPreferences.getMediaAccessStatus('microphone')
        : 'unsupported',
    screen:
      process.platform === 'darwin' || process.platform === 'win32'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'unsupported',
    notificationsSupported: Notification.isSupported(),
  }));
  handle('aria:clear-chat-history', async () => {
    chat.assertIdle();
    media.assertIdle();
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Open Aria to confirm clearing chat history.');
    if (mainWindow && !mainWindow.isDestroyed()) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: 'Clear all saved conversations and chat history?',
        detail: 'Saved memories, API connections, and authorized directories are preserved.',
        buttons: ['Cancel', 'Clear chat history'],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
      });
      if (response !== 1) return false;
    }
    chat.assertIdle();
    media.assertIdle();
    if (configuring) throw new Error('Wait for settings to finish saving.');
    configuring = true;
    try {
      saving = saving.catch(() => undefined).then(async () => {
        const previous = initial.data;
        const next = {
          ...previous,
          chat: { conversations: [], messages: [], selectedId: null, newDraft: '', newAttachments: [] },
        };
        await storage.save(next, []);
        initial = { data: next };
        for (const { id } of previous.chat.conversations) {
          temporaryConversations.delete(id);
          diagnostics?.discardTemporary(id);
          pendingChatProjects.delete(id);
          workingContext.clear(id);
          executionRuntime.store.deletePrograms(id);
          proactive?.removeConversation(id);
        }
        browser.pruneConversations([]);
        await assets.pruneUnreferenced(next, proactiveArtifactIds());
      });
      await saving;
      return true;
    } finally {
      configuring = false;
    }
  });
  handle('aria:clear-legacy-data', async () => {
    chat.assertIdle();
    media.assertIdle();
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Open Aria to confirm clearing legacy data.');
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning', message: 'Clear local legacy workspace data?',
      detail: 'This removes local legacy drafts, tasks, and plans. Authorized folders, files, chat history, and data in external services are preserved.',
      buttons: ['Cancel', 'Clear local legacy data'], cancelId: 0, defaultId: 0, noLink: true,
    });
    if (response !== 1) return false;
    chat.assertIdle();
    media.assertIdle();
    if (configuring) throw new Error('Wait for settings to finish saving.');
    configuring = true;
    try {
      saving = saving.catch(() => undefined).then(async () => {
        const next = { ...initial.data, conversations: [], tasks: [], plans: [] };
        await storage.save(next);
        initial = { data: next };
      });
      await saving;
      return true;
    } finally {
      configuring = false;
    }
  });
  handle('aria:export-diagnostics', () => exportDiagnosticReport({}));
  handle('aria:reset-configuration', async (rawScope) => {
    const scope = resetConfigurationScopeSchema.parse(rawScope);
    chat.assertIdle();
    media.assertIdle();
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Open Aria to confirm resetting settings.');
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning', message: `Reset ${scope} settings?`,
      detail: 'Provider credentials and conversation history will be preserved.',
      buttons: ['Cancel', 'Reset settings'], cancelId: 0, defaultId: 0, noLink: true,
    });
    if (response !== 1) return false;
    chat.assertIdle();
    media.assertIdle();
    if (scope === 'preferences') {
      saving = saving.catch(() => undefined).then(async () => {
        const defaults = defaultPreferences();
        const next = {
          ...initial.data,
          preferences: {
            ...defaults,
            activeWorkspaceId: initial.data.preferences.activeWorkspaceId,
          },
        };
        await storage.save(next);
        initial = { data: next };
        syncTray(false);
      });
      await saving;
      return true;
    }
    if (scope === 'web') {
      chat.assertIdle();
      media.assertIdle();
      const previous = webSettings.get();
      await webSettings.save(defaultWebPolicy);
      await browser.applyPolicy(previous);
      await chat.restart();
      return true;
    }
    await changeCapabilities(() => capabilities.resetPolicy());
    return true;
  });
  handle('aria:about-info', async () => {
    const distDir = path.join(__dirname, '../dist');
    const rootDir = path.resolve(__dirname, '../../..');
    const readFirst = async (paths: string[]) => {
      for (const candidate of paths) {
        try {
          return await fs.readFile(candidate, 'utf8');
        } catch {
          // Try next candidate path.
        }
      }
      return '';
    };
    const mitLicense = await readFirst([
      path.join(distDir, 'LICENSE'),
      path.join(rootDir, 'LICENSE'),
    ]);
    const thirdPartyNotices = await readFirst([
      path.join(distDir, 'third-party', 'THIRD_PARTY_NOTICES.md'),
      path.join(rootDir, 'THIRD_PARTY_NOTICES.md'),
    ]);
    let thirdPartyInventory: { name: string; version: string; license: string | null }[] = [];
    const inventoryRaw = await readFirst([path.join(distDir, 'third-party', 'inventory.json')]);
    if (inventoryRaw) {
      try {
        thirdPartyInventory = JSON.parse(inventoryRaw);
      } catch {
        thirdPartyInventory = [];
      }
    }
    return {
      version: app.getVersion(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      repositoryUrl: 'https://github.com/manaplatform/Aria',
      releaseNotesUrl: 'https://github.com/manaplatform/Aria/releases',
      mitLicense,
      thirdPartyNotices,
      thirdPartyInventory,
    };
  });
  handle('aria:open-devtools', () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });
}
function showAria(target?: NonNullable<ProactiveEvent['target']>) {
  proactive?.show();
  const route = target ? (target.kind === 'automation' ? '/automations/' : target.kind === 'job' ? '/agenda/jobs/' : '/agenda/tasks/') + target.id : undefined;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow(appIcon, route);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (target) proactive?.changed(target);
}

function notifyProactive(target: NonNullable<ProactiveEvent['target']>) {
  if (!Notification.isSupported()) return false;
  const preferences = initial.data.preferences.notifications;
  const note = new Notification({ title: 'Aria', body: 'Open Aria to view a proactive update.', silent: preferences?.sound === false });
  note.on('click', () => showAria(target));
  note.show();
  return true;
}

function createWindow(icon: NativeImage | undefined, route?: string): void {
  closeFlushEnabled = false;
  closePending = false;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#101116',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  browser.attach(mainWindow);
  mainWindow.webContents.on('render-process-gone', () => {
    diagnosticSubscribed = false;
    diagnostics?.log('error', 'renderer', 'lifecycle', 'renderer.process_gone');
    closeFlushEnabled = false;
    closePending = false;
    browser.resetRenderer();
    void media.close();
  });
  mainWindow.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) {
      browser.resetRenderer();
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
    void browser.detach();
    void media.close();
    void chat.interruptAll(true);
    mainWindow = null;
    if (!proactive?.background()) proactive?.suspend();
  });
  mainWindow.on('close', (event) => {
    if (!quitting && initial?.data?.preferences.minimizeToTray && appTray) {
      event.preventDefault();
      mainWindow?.hide();
      return;
    }
    if (!closeFlushEnabled) return;
    event.preventDefault();
    if (!closePending) {
      closePending = true;
      mainWindow?.webContents.send('aria:before-close');
    }
  });
  if (devServerUrl) void mainWindow.loadURL(route ? new URL('#' + route, devServerUrl).href : devServerUrl);
  else void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'), route ? { hash: route } : undefined);
}
app
  .whenReady()
  .then(async () => {
    if (!ownsProfile) return;
    const iconDirectory = devServerUrl ? '../public' : '../dist';
    const image = nativeImage.createFromPath(path.join(__dirname, iconDirectory, 'aria-icon.png'));
    const icon = image.isEmpty() ? undefined : image;
    appIcon = icon;
    if (icon) app.dock?.setIcon(icon);
    const connectorConfig = githubProviderConfig(app.isPackaged, process.env);
    if (!app.isPackaged) {
      try {
        process.loadEnvFile(path.resolve(__dirname, '../../..', '.env'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const directory = process.env.ARIA_TEST_DATA_DIR || app.getPath('userData');
    dataDirectory = directory;
    diagnostics = new Diagnostics(directory, app.getVersion(), (events) => {
      if (diagnosticSubscribed && mainWindow && !mainWindow.webContents.isDestroyed())
        mainWindow.webContents.send('aria:diagnostic-events', events);
    }, () => diagnosticSubscribed);
    await diagnostics.initialize();
    diagnostics.log('info', 'desktop', 'lifecycle', 'startup.started');
    updates = new DesktopUpdates(directory, (state) => {
      if (mainWindow && !mainWindow.webContents.isDestroyed())
        mainWindow.webContents.send('aria:update-state-changed', state);
    });
    await updates.load();
    storage = new LocalStorage(directory);
    initial = await storage.load();
    await diagnostics.initialize(initial.data.preferences.logLevel);
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
    const cipher = {
      available: async () =>
        (await safeStorage.isAsyncEncryptionAvailable()) &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encrypt: (value: string) => safeStorage.encryptStringAsync(value),
      decrypt: (value: Buffer) => safeStorage.decryptStringAsync(value),
    };
    provider = new ProviderStorage(directory, cipher);
    capabilities = new CapabilityStorage(directory);
    await capabilities.load();
    approvals = new OperationApproval(async (message, detail, signal, allowExecution) => {
      signal.throwIfAborted();
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message,
        detail,
        buttons: allowExecution ? ['Decline', 'Allow once', 'Allow for this execution'] : ['Decline', 'Allow once'],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
        signal,
      });
      return signal.aborted ? false : response === 2 && allowExecution ? 'execution' : response === 1;
    }, {
      begin: (scope, fingerprint) => capabilities.runtimeStore.beginApproval(scope, fingerprint),
      finish: (id, decision) => capabilities.runtimeStore.finishApproval(id, decision),
    }, (scope, decision) => {
      const execution = chat?.executionForTurn(scope.request);
      if (!execution) return;
      const temporary = chat.temporaryForTurn(scope.request);
      if (temporary && !temporaryConversations.has(scope.conversation)) return;
      diagnostics?.log('info', 'permissions', 'approval', 'permission.decision', {
        conversationId: scope.conversation, requestId: scope.request, correlationId: scope.request,
        executionId: execution.executionId, generation: execution.generation, operationId: scope.step,
      }, { capability: scope.operation, status: decision }, temporary);
    });
    const approve = approvals.approve.bind(approvals);
    loopRecovery = new LoopRecovery(capabilities.runtimeStore, cipher, () => chat.executionIdentity(),
      (id, conversation) => {
        try { return Boolean(executionRuntime.evidence(id, conversation)); }
        catch { return false; }
      });
    executionRuntime = new DesktopRuntime(
      directory,
      assets,
      capabilities,
      (conversationId) =>
        new Set(
          initial.data.chat.messages
            .filter((message) => message.conversationId === conversationId)
            .flatMap((message) => (message.assets ?? []).map((asset) => asset.id)),
        ),
      approve,
      () => chat.executionIdentity(),
      () => provider.resolve(),
      cipher,
      (requestId) => chat.restrictedLocalShellContext(requestId),
      () => initial.data.workspaces,
    );
    connectors = new ConnectorRegistry(connectorConfig, executionRuntime.store, cipher, {
      open: (url) => shell.openExternal(url),
      copy: (code) => clipboard.writeText(code),
      identity: () => chat?.runtimeIdentity(),
      approve: async (message, detail, signal) => Boolean(await approve(message, detail, signal)),
      changed: () => {
        if (mainWindow && !mainWindow.webContents.isDestroyed())
          mainWindow.webContents.send('aria:connectors-changed', connectors.snapshot());
        proactive?.connectorChanged();
      },
      artifact: async (request, bytes, name, signal) => {
        signal.throwIfAborted();
        const asset = await assets.put(bytes, path.basename(name), 'application/octet-stream');
        await executionRuntime.adoptArtifact(asset, request.conversationId, request.requestId, { stepId: request.stepId }, signal);
        return { id: asset.id, name: asset.name, mimeType: asset.mimeType, size: asset.size, storage: 'desktop' };
      },
    });
    memory = new DesktopMemory(directory, executionRuntime.embeddings, () => provider.resolve(),
      (_kind, title, detail, signal) => approve(title, detail, signal),
      (request) => { void chat.cancel(request); }, (id) => {
        const result = savedConversation(id);
        if (result?.projectId && !initial.data.workspaces.some((project) => project.id === result.projectId))
          return undefined;
        return result;
      },
      (conversation) => workingContext.get(conversation),
      (project) => initial.data.tasks.filter((task) => task.workspaceId === project &&
        ['idle', 'pending', 'running', 'blocked'].includes(task.status)).slice(0, 8)
        .map(({ id, title, status, dependencies, revision }) => ({
          id, title, status, dependencies: dependencies.slice(0, 8), revision,
        })),
      () => { workingContext.clear(); proactive?.invalidateMemory(); }, purgeMemoryOutbox, () => chat.executionIdentity(),
      (event, detail) => diagnostics?.log(event.includes('failed') || event.includes('timed_out') || event.includes('exited') ? 'error'
        : event.startsWith('worker.') ? 'info' : 'debug', 'memory', 'worker', `memory.${event}`,
        {}, { capability: detail?.method, durationMs: detail?.durationMs }),
      () => resolvePersona(initial.data.preferences.persona).learnPreferences);
    void memory.start().then(drainMemoryOutbox);
    const memoryDrainTimer = setInterval(() => void drainMemoryOutbox(), 4000);
    memoryDrainTimer.unref();
    app.once('will-quit', () => clearInterval(memoryDrainTimer));
    if (!initial.warning) {
      try {
        const previous = initial.data;
        const messages = await executionRuntime.recoverArtifacts(previous.chat.messages);
        if (messages !== previous.chat.messages) {
          const recovered = { ...previous, chat: { ...previous.chat, messages } };
          await storage.save(recovered);
          initial = { data: recovered };
        }
        await assets.pruneUnreferenced(initial.data, proactiveArtifactIds());
      } catch {
        // Keep files for reconciliation on the next successful load.
      }
    }
    webSettings = new WebSettingsStorage(directory);
    await webSettings.load();
    weather = new WeatherService(directory, (event, metadata, context) =>
      diagnostics?.log(event === 'validation_failed' ? 'warn' : 'debug', 'desktop', 'weather', `weather.${event}`, context, metadata));
    await weather.load();
    browser = new BrowserController(directory, () => webSettings.get(), approve, () => diagnostics?.log('error', 'browser', 'lifecycle', 'browser.renderer_gone'));
    await browser.load();
    virtualComputer = new VirtualComputer(() => executionRuntime.settings(), directory);
    localComputer = new LocalComputer(executionRuntime.store, () => chat.executionIdentity());
    screen.on('display-removed', (_event, display) => {
      if (localComputer.disconnectDisplay(display.id)) void computerRuntime.closeLocalSessions();
    });
    computerRuntime = new ComputerRuntime(
      executionRuntime.store,
      [
        {
          environment: 'managed-browser',
          ready: () => browser.computerAvailable(),
          targetAlive: (...args) => browser.computerTargetAlive(...args),
          wait: (...args) => browser.waitForComputerTab(...args),
          open: async (owner, id, { tabId: tab }, signal) => {
            if (!tab) throw new Error('Missing browser tab.');
            await browser.claimComputerTab(owner, tab, id, signal);
            return tab;
          },
          observe: (...args) => browser.observeComputerTab(...args),
          restore: (owner, id, _target, url, signal) => {
            if (!url)
              throw new Error('The previous browser destination cannot be restored safely.');
            return browser.restoreComputerTab(owner, id, url, signal);
          },
          restoreUrl: (...args) => browser.computerRestoreUrl(...args),
          navigate: async (owner, id, input, signal) => {
            if (input.target === 'url')
              return browser.restoreComputerTab(owner, id, input.url, signal);
            if (input.target !== 'tab')
              throw new Error('Missing validated navigation destination.');
            return browser.selectComputerTab(owner, input.tabId, id, signal);
          },
          authenticate: (...args) => browser.authenticateComputerTab(...args),
          authenticationSite: (...args) => browser.computerAuthenticationSite(...args),
          input: (owner, target, id, observation, action, signal) =>
            browser.actComputerTab(owner, target, id, observation, action, signal),
          owner: (...args) => browser.setComputerOwner(...args),
          close: (...args) => browser.closeComputerTab(...args),
          downloadTarget: (...args) => browser.computerDownloadTarget(...args),
          uploadTarget: (...args) => browser.computerUploadTarget(...args),
        },
        virtualComputer,
        localComputer,
      ],
      () => chat.executionIdentity(),
      (owner) => browser.computerForeground(owner),
      approve,
      (state) => mainWindow?.webContents.send('aria:computer-session-update', state),
      {
        read: (...args) => executionRuntime.computerInput(...args),
        adopt: (...args) => executionRuntime.adoptComputerArtifact(...args),
        script: (...args) => executionRuntime.computerScript(...args),
      },
      () => executionRuntime.settings(),
    );
    let locked = false;
    let sleeping = false;
    const updateDesktopAvailability = () => {
      const suspended = locked || sleeping;
      localComputer.setSuspended(suspended);
      if (suspended) {
        localSelection?.abort();
        void computerRuntime.closeLocalSessions();
      }
    };
    powerMonitor.on('lock-screen', () => {
      locked = true;
      updateDesktopAvailability();
    });
    powerMonitor.on('unlock-screen', () => {
      locked = false;
      updateDesktopAvailability();
      proactive?.event('desktop.unlocked');
    });
    powerMonitor.on('suspend', () => {
      sleeping = true;
      updateDesktopAvailability();
      proactive?.suspend();
    });
    powerMonitor.on('shutdown', () => {
      proactive?.suspend();
      app.quit();
    });
    powerMonitor.on('resume', () => {
      sleeping = false;
      updateDesktopAvailability();
      proactive?.resume();
    });
    chat = new ChatService(
      provider,
      (env) =>
        utilityProcess.fork(app.isPackaged
          ? path.join(process.resourcesPath, 'aria-api', 'dist', 'main.js')
          : path.join(__dirname, 'api', 'dist', 'main.js'), [], {
          env: env as Record<string, string>,
          stdio: 'ignore',
          serviceName: 'Aria Chat API',
        }),
      (event) => {
        const temporary = chat.temporaryForTurn(event.requestId);
        const retainDiagnostic = !temporary || temporaryConversations.has(event.conversationId);
        const context = { conversationId: event.conversationId, requestId: event.requestId,
          correlationId: event.requestId, operationId: event.requestId, executionId: event.executionId, generation: event.generation };
        if (retainDiagnostic && ['started', 'completed', 'failed', 'stopped'].includes(event.type)) {
          diagnostics?.log(event.type === 'failed' ? 'error' : 'info', 'chat', 'execution',
            `chat.${event.type}`, context, {}, temporary);
        }
        const references = memory.event(event);
        const visible = event.type === 'completed' ? {
          type: event.type, requestId: event.requestId, conversationId: event.conversationId,
          assistantMessageId: event.assistantMessageId, sequence: event.sequence,
          executionId: event.executionId, generation: event.generation,
          partial: event.partial, run: event.run, suggestions: event.suggestions,
          ...(references?.length && { memoryReferences: references }),
        } : event;
        const message = activeMessages.get(event.assistantMessageId);
        if (message) activeMessages.set(message.id, projectChatEvent(message, visible));
        if (activeMessages.size > 12) for (const [id, item] of activeMessages) {
          if (activeMessages.size <= 12) break;
          if (!chat.activeTurn(item)) activeMessages.delete(id);
        }
        if (mainWindow && !mainWindow.webContents.isDestroyed())
          mainWindow.webContents.send('aria:chat-event', visible);
        if (visible.type === 'completed') {
          notifyBackground('task', 'Aria finished your response', 'Return to Aria to view the result.');
        } else if (visible.type === 'failed') {
          notifyBackground('background', 'Aria response failed', 'Return to Aria for details.');
        } else if (visible.type === 'activity' && visible.activity.status === 'approval') {
          notifyBackground('background', 'Aria needs your approval', 'Return to Aria to review the request.');
        }
      },
      (status) => {
        proactive?.wake();
        proactive?.changed();
        diagnostics?.log(status.state === 'failed' ? 'error' : 'info', 'desktop', 'service', 'service.state_changed', {}, { status: status.state });
        if (mainWindow && !mainWindow.webContents.isDestroyed())
          mainWindow.webContents.send('aria:chat-status-update', status);
      },
      assets,
      {
        runtime: () => webSettings.runtime(),
        revision: () => webSettings.revision,
        open: (authorize) =>
          openBrowserBridge(
            browser,
            (request) => {
              const signal = authorize(request);
              if (!signal) return;
              if (chat.proactiveForTurn(request.requestId)) return proactive?.authorizeBrowser(request);
              const turn = initial.data.chat.messages.find(
                (message) =>
                  message.id === chat.assistantForTurn(request.requestId) &&
                  message.conversationId === request.conversationId &&
                  message.role === 'assistant',
              );
              return turn ? signal : undefined;
            },
            (request, fingerprint, signal) => {
              const assistantId = chat.assistantForTurn(request.requestId);
              return assistantId
                ? capabilities.reserve(
                    request.conversationId,
                    assistantId,
                    request.requestId,
                    fingerprint,
                    signal,
                    { id: `browser.${request.op}`, stepId: request.stepId,
                      callId: request.operationId, revision: webSettings.revision },
                    () => !chat.proactiveForTurn(request.requestId) ||
                      Boolean(proactive?.supervisor.live(request.requestId, request.conversationId)),
                  )
                : Promise.resolve(false);
            },
            (request, work) => approvals.within({
              conversation: request.conversationId, request: request.requestId, step: request.stepId,
              operation: request.op, binding: [webSettings.revision, request.args],
            }, work),
            {
              approve: (request, fingerprint, message, signal) =>
                proactive?.approveBrowser(request, fingerprint, message, signal) ?? Promise.resolve(false),
              result: (request, result, fingerprint) => {
                if (!chat.proactiveForTurn(request.requestId)) return;
                proactive?.observations(request, result);
                if (fingerprint && proactive?.supervisor.live(request.requestId, request.conversationId))
                  executionRuntime.store.settleDispatch(request.conversationId, request.conversationId,
                    request.requestId, fingerprint, result.ok ? 'completed' : 'uncertain');
              },
            },
          ),
      },
      {
        policy: (registry) => ({
          ...runtimePolicy(registry),
          desktopRuntime: true,
          weatherEnabled: weather.settings().enabled,
          dockerConfigured: Boolean(executionRuntime.settings().engineSocket.trim()),
          localShell: localShellSupported,
          workspacesCount: initial.data.workspaces.length,
          connectors: [
            {
              id: 'coding.mana_agent',
              name: 'Mana-Agent',
              description: 'External coding agent connector for autonomous repository workflows.',
              availability: 'unconfigured',
              health: 'unavailable',
              reason: 'No Mana-Agent connector is registered in this installation.',
              settingsSection: 'Tools',
            },
          ],
          loop: executionRuntime.settings().loop,
          computerBrowser: browser.computerAvailable(),
          computerVirtual: virtualComputer.ready(),
          computerLocal: localComputer.configured(),
        }),
        artifact: (id, conversation, request) =>
          executionRuntime.resolveArtifact(id, conversation, request),
        adoptArtifact: (asset, conversation, request, execution, signal) =>
          executionRuntime.adoptArtifact(asset, conversation, request, execution, signal),
        release: (request) => {
          connectors.release(request);
          approvals.release(request);
          executionRuntime.release(request);
          computerRuntime.release(request);
        },
        cancelExecution: (request) => executionRuntime.store.cancelLoop(request),
        availableAssets: (conversation) =>
          [
            ...new Map(
              initial.data.chat.messages
                .filter((message) => message.conversationId === conversation)
                .flatMap((message) => message.assets ?? [])
                .map((asset) => [asset.id, asset]),
            ).values(),
          ].slice(-12),
        open: (revision, authorize) =>
          openCapabilityBridge(
            capabilities,
            revision,
            (request) => {
              if (chat.proactiveForTurn(request.requestId) &&
                  !proactive?.supervisor.live(request.requestId, request.conversationId)) return;
              return request.type === 'runtime'
                ? authorize(request) && chat.authorizeRuntime(request)
                : request.voiceSessionId
                  ? media.authorizeCapability(request)
                  : authorize(request);
            },
            (request, signal, progress) => {
              const job = chat.proactiveForTurn(request.requestId);
              const live = job && proactive?.supervisor.live(request.requestId, job.jobId);
              if (job && !live) throw new Error('The background execution is no longer active.');
              if (githubPublicOperation.safeParse(request.operation).success) {
                if (job || savedConversation(request.conversationId)?.temporary)
                  throw new Error('Use a saved foreground chat to inspect public GitHub repositories.');
                return connectors.dispatchPublic(request, signal, {
                  live: () => Boolean(chat.authorizeRuntime(request)), network: () => progress('dispatch'),
                });
              }
              if (githubOperation.safeParse(request.operation).success) {
                const grant = live && live.prepared.scope.connector;
                if (job && !grant || !job && savedConversation(request.conversationId)?.temporary)
                  throw new Error('GitHub is outside the authorized execution scope.');
                return approvals.within({
                  conversation: request.conversationId, request: request.requestId, step: request.stepId,
                  operation: request.operation, binding: [request.revision, request.primary, request.input, grant],
                }, () => connectors.dispatch(request, signal, {
                  job: grant || undefined,
                  approval: () => progress('approval'), network: () => progress('dispatch'),
                  ...(grant && { approve: (fingerprint: string, message: string) =>
                    proactive?.approveAction(request, fingerprint, message, signal) ?? Promise.resolve(false) }),
                  live: () => Boolean(chat.authorizeRuntime(request) &&
                    (!job || proactive?.supervisor.live(request.requestId, request.conversationId))),
                })).then(async (result) => {
                  if (result.privateContent) chat.markPrivateRuntimeContent(request.requestId, true);
                  if (job && result.privateContent) proactive?.markPrivate(job.jobId);
                  const evidence = githubResult.safeParse(result.data);
                  if (job && evidence.success && evidence.data.verified)
                    await proactive?.observeGithub(request, evidence.data);
                  return result;
                });
              }
              if (Object.hasOwn(proactiveOperations, request.operation)) {
                const conversation = !job && savedConversation(request.conversationId);
                const instruction = conversation && initial.data.chat.messages.filter((message) =>
                  message.conversationId === conversation.id && message.role === 'user' &&
                  message.id === chat.executionForTurn(request.requestId)?.userMessageId).at(-1)?.content;
                if (!proactive || !job && (!conversation || conversation.temporary))
                  throw new Error('Use a saved chat or Agenda to manage proactive responsibilities.');
                return proactive.dispatch(request, signal, live || undefined, instruction || undefined);
              }
              if (job) {
                if (live?.prepared.scope.memory && (request.operation === 'memory.search' || request.operation === 'memory.read'))
                  return memory.proactiveRecall(request.operation, request.input, signal).then((result) => {
                    if (result.privateContent) proactive?.markPrivate(job.jobId);
                    return result;
                  });
                throw new Error('This operation is outside the background grant.');
              }
              if (Object.hasOwn(weatherOperations, request.operation)) {
                if (request.programId || chat.temporaryForTurn(request.requestId) || chat.privateContextForTurn(request.requestId))
                  throw new Error('Weather is unavailable for this execution or private context.');
                const started = Date.now();
                const execution = chat.executionForTurn(request.requestId);
                const context = { conversationId: request.conversationId, requestId: request.requestId, operationId: request.stepId,
                  ...(execution && { executionId: execution.executionId, generation: execution.generation }) };
                diagnostics?.log('info', 'desktop', 'weather', 'weather.execution_started', context, { capability: request.operation, provider: 'met_norway' });
                return weather.dispatch(request.operation as WeatherOperation, request.input, signal, context).then((data) => {
                  diagnostics?.log('info', 'desktop', 'weather', 'weather.execution_completed', context, { capability: request.operation, durationMs: Date.now() - started });
                  return { data };
                }, (error: unknown) => {
                  diagnostics?.log('warn', 'desktop', 'weather', 'weather.execution_failed', context, { capability: request.operation, durationMs: Date.now() - started, status: signal.aborted ? 'cancelled' : 'failed' });
                  throw error;
                });
              }
              if (request.programId)
                executionRuntime.store.assertProgramChild(request, chat.executionIdentity());
              return approvals.within({
                conversation: request.conversationId, request: request.requestId, step: request.stepId,
                operation: request.operation,
                binding: [request.revision, request.primary, request.input, request.programId],
              }, () => {
                const result = request.operation.startsWith('memory.') ? memory.dispatch(request, signal)
                  : request.operation.startsWith('computer.') ? computerRuntime.dispatch(request, signal)
                  : executionRuntime.dispatch(request, signal, () => progress('approval'));
                return result.then((value) => {
                  if (value.privateContent)
                    chat.markPrivateRuntimeContent(request.requestId, request.operation.startsWith('memory.'));
                  return value;
                });
              });
            },
            (request, signal) => {
              if (chat.proactiveForTurn(request.requestId)) return proactive?.checkpoint(request, signal) ?? Promise.resolve(false);
              const active = chat.executionForTurn(request.requestId);
              const conversation = savedConversation(request.conversationId);
              if (!active || request.checkpoint.executionId !== active.executionId ||
                  request.checkpoint.generation !== active.generation ||
                  request.checkpoint.userMessageId !== active.userMessageId ||
                  !conversation || conversation.temporary)
                return Promise.resolve(false);
              return loopRecovery.save(request, signal);
            },
            (listener) => connectors.subscribe(listener),
          ),
      },
    );
    if (diagnostics) chat.configureDiagnostics(diagnostics.status().config);
    chat.onDiagnostic = (entry, temporary) => {
      if (!temporary || entry.context.conversationId && temporaryConversations.has(entry.context.conversationId))
        diagnostics?.acceptRemote(entry, temporary);
    };
    media = new MediaService(chat, assets, (event) =>
      mainWindow?.webContents.send('aria:live-event', event),
    );
    proactive = new ProactiveService(new ProactiveStore(executionRuntime.store, cipher), {
      identity: () => {
        const status = chat.getStatus();
        const key = chat.executionIdentity();
        return !configuring && status.state === 'ready' && status.configured && status.revision && key
          ? { provider: key, revision: status.revision } : undefined;
      },
      run: (request, signal, event) => {
        browser.openJob(request.jobId, (url) => {
          const live = proactive?.supervisor.live(request.attemptId, request.jobId);
          return !!live && !!proactive?.canVisit(live, url);
        });
        return chat.runProactive(request, signal, event);
      },
      changed: (event) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('aria:proactive-event', event);
      },
      notify: (_category, target) => notifyProactive(target),
      verifyConnector: (grant, provider) => connectors.verifyJob(grant, provider),
      connectorValid: (grant, provider) => connectors.jobValid(grant, provider),
      saveMemory: (source, content, observedAt, authorize) => memory.rememberJob(source, content, observedAt, authorize),
      exportArtifact: async (id) => {
        const { asset, bytes } = await assets.get(id);
        if (!mainWindow || mainWindow.isDestroyed()) return false;
        const result = await dialog.showSaveDialog(mainWindow, { title: 'Save job artifact', defaultPath: asset.name });
        if (result.canceled || !result.filePath) return false;
        await fs.writeFile(result.filePath, bytes);
        return true;
      },
      closeJob: (id) => browser.closeJob(id),
      removeArtifact: (id) => assets.remove(id),
    });
    proactive.start();
    app.on('second-instance', () => showAria());
    registerIpc();
    if (devLauncher && !process.connected) {
      app.quit();
      return;
    }
    syncTray(Boolean(initial.data.preferences.minimizeToTray) || Boolean(proactive?.background()));
    createWindow(icon);
    updates.startAutomaticChecks();
    void chat.start().then(() => executionRuntime.cleanHostedResources());
    app.on('activate', () => {
      if (!mainWindow) showAria();
    });
  })
  .catch((error) => {
    diagnostics?.log('fatal', 'desktop', 'lifecycle', 'startup.failed', {}, {}, false, error);
    void diagnostics?.flush();
    dialog.showErrorBox('Aria could not start', String(error));
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !proactive?.background() && !BrowserWindow.getAllWindows().length) app.quit();
  else if (process.platform === 'darwin' && !proactive?.background()) proactive?.suspend();
});
app.on('before-quit', (event) => {
  quitting = true;
  connectors?.cancelAuthorization();
  proactive?.suspend();
  appTray?.destroy();
  appTray = null;
  // The window close handshake flushes renderer state before this final shutdown.
  if (!mainWindow && chat && !shutdownComplete) {
    event.preventDefault();
    shutdown ??= Promise.resolve(proactive?.close())
      .then(() => media.close())
      .then(() => chat.close())
      .then(() => computerRuntime.shutdown())
      .then(() => localComputer.reset())
      .then(() => memory.close())
      .then(() => executionRuntime.close())
      .then(async () => {
        diagnostics?.log('info', 'desktop', 'lifecycle', 'shutdown.completed');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([diagnostics?.close(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); })]); }
        finally { if (timer) clearTimeout(timer); }
      })
      .then(() => {
        browser.close();
        shutdownComplete = true;
        const perform = installUpdate;
        installUpdate = undefined;
        if (perform) perform();
        else app.quit();
      }, () => {
        browser.close();
        shutdownComplete = true;
        if (installUpdate) dialog.showErrorBox('Update paused', 'Aria could not complete shutdown. Open Aria and try the update again.');
        installUpdate = undefined;
        app.quit();
      });
  }
});
