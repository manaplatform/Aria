import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  screen,
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
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LocalStorage, localDataSchema } from './storage';
import { BrowserController } from './browser/controller';
import { openBrowserBridge } from './browser/bridge';
import { CapabilityStorage, openCapabilityBridge } from './capability-storage';
import { WebSettingsStorage } from './web-settings-storage';
import { ProviderStorage } from './provider-storage';
import {
  browserCommandSchema,
  capabilityId,
  effectSchema,
  modelReference,
  skillRefSchema,
  toolDiscoverySchema,
  type RuntimeRegistry,
  browserLayoutSchema,
  computerSupervision,
  computerUserInput,
  webSettingsInputSchema,
  connectionInputSchema,
  endActivity,
  identifier,
  modelCapabilitySchema,
  registryInputSchema,
  programSettingsSchema,
} from '@aria/shared';
import { ChatService } from './chat-service';
import { DesktopRuntime } from './runtime/controller';
import { ComputerRuntime } from './runtime/computer';
import { VirtualComputer } from './runtime/virtual-computer';
import { LocalComputer } from './runtime/local-computer';
import { openAIRuntimeFeatureSchema, runtimeSettingsSchema } from '@aria/shared';
import { MediaStorage, referencedAssets } from './media-storage';
import { captureDisplay, chooseDisplay } from './screen-capture';
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
let mainWindow: BrowserWindow | null = null;
let storage: LocalStorage;
let webSettings: WebSettingsStorage;
let capabilities: CapabilityStorage;
let browser: BrowserController;
let provider: ProviderStorage;
let chat: ChatService;
let assets: MediaStorage;
let executionRuntime: DesktopRuntime;
let computerRuntime: ComputerRuntime;
let virtualComputer: VirtualComputer;
let localComputer: LocalComputer;
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
    await chat.cancelAll();
    await media.close();
    await change();
    await chat.restart();
    return await read();
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
    await browser.flush();
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
        browser.pruneConversations(parsed.chat.conversations);
        const retained = new Set(parsed.chat.conversations.map(({ id }) => id));
        for (const { id } of previous.chat.conversations)
          if (!retained.has(id)) executionRuntime.store.deletePrograms(id);
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
  handle('aria:browser-state', () => browser.state());
  handle('aria:browser-command', (input) => browser.command(browserCommandSchema.parse(input)));
  handle('aria:browser-layout', (input) => {
    const previous = browser.activeConversation();
    browser.setLayout(browserLayoutSchema.parse(input));
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
  handle('aria:select-local-computer', async (value, rawTarget) => {
    const owner = identifier.parse(value);
    const target = z.enum(['window', 'screen']).default('window').parse(rawTarget);
    const checkForeground = () => {
      const active = browser.activeConversation();
      if (
        initial.data.chat.selectedId !== owner ||
        (active !== null && active !== owner) ||
        !mainWindow ||
        mainWindow.isDestroyed() ||
        mainWindow.isMinimized()
      )
        throw new Error('Open the conversation that will use the local desktop.');
    };
    checkForeground();
    let display: Awaited<ReturnType<typeof chooseDisplay>>;
    if (target === 'screen') {
      if (!mainWindow?.isFocused()) throw new Error('Focus Aria before selecting a display.');
      display = await chooseDisplay(
        mainWindow,
        'Select a full screen',
        'Aria can ask to share screenshots, open a supported app, or move and click the mouse on this display. Each action requires your approval.',
        true,
      );
      if (!display) return false;
    }
    return changeCapabilities(async () => {
      checkForeground();
      const signal = AbortSignal.timeout(85_000);
      if (display) await localComputer.prepareScreen(owner, display, signal);
      else await localComputer.prepare(owner, signal);
      await computerRuntime.closeLocalSessions();
      try {
        checkForeground();
      } catch (error) {
        localComputer.revoke();
        throw error;
      }
    }, async () => true);
  });
  handle('aria:revoke-local-computer', () =>
    changeCapabilities(async () => {
      localComputer.revoke();
      await computerRuntime.closeLocalSessions();
    }, async () => undefined),
  );
  handle('aria:web-settings', () => webSettings.get());
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
  handle('aria:submit-chat', (input) => {
    if (configuring) throw new Error('Wait for connection settings to finish saving.');
    const parsed = chatRequestSchema.parse(input);
    media.assertIdle();
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
    const blockedHistory = new Set(
      messages
        .filter(
          (message) =>
            message.id !== assistant.id &&
            message.run?.revision !== chat.getStatus().revision &&
            message.activity?.some((step) => step.privateContent),
        )
        .map((message) => message.content),
    );
    chat.submit({
      ...parsed,
      programPrivateHistory: messages.some((message) =>
        message.id !== assistant.id && message.activity?.some((step) => step.privateContent) &&
        !blockedHistory.has(message.content) &&
        parsed.messages.some((item) => item.role === 'assistant' && item.content === message.content)),
      messages: parsed.messages.filter(
        (item, index) =>
          index === parsed.messages.length - 1 ||
          item.role !== 'assistant' ||
          !blockedHistory.has(item.content),
      ),
    });
  });
  handle('aria:execution-history', () => executionRuntime.history());
  handle('aria:runtime-settings', () => executionRuntime.settings());
  handle('aria:save-runtime-settings', async (value) => {
    chat.assertIdle();
    media.assertIdle();
    const current = executionRuntime.settings();
    const next = runtimeSettingsSchema.parse(value);
    await executionRuntime.configure(next);
    if (current.engineSocket !== next.engineSocket || current.desktopImage !== next.desktopImage) {
      await computerRuntime.shutdown();
      await chat.restart();
    }
    return executionRuntime.settings();
  });
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
  handle('aria:probe-runtime', () => executionRuntime.inspect(AbortSignal.timeout(10_000)));
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
  browser.attach(mainWindow);
  mainWindow.webContents.on('render-process-gone', () => {
    closeFlushEnabled = false;
    closePending = false;
    browser.resetRenderer();
    void chat.cancelAll();
    void media.close();
  });
  mainWindow.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) {
      browser.resetRenderer();
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
    void browser.detach();
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
    const approve = async (message: string, detail: string, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message,
        detail,
        buttons: ['Decline', 'Allow once'],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
        signal,
      });
      return response === 1 && !signal.aborted;
    };
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
    );
    webSettings = new WebSettingsStorage(directory);
    await webSettings.load();
    browser = new BrowserController(directory, () => webSettings.get(), approve);
    await browser.load();
    virtualComputer = new VirtualComputer(() => executionRuntime.settings(), directory);
    localComputer = new LocalComputer();
    screen.on('display-removed', (_event, display) => localComputer.disconnectDisplay(display.id));
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
          input: (...args) => browser.actComputerTab(...args),
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
      {
        runtime: () => webSettings.runtime(),
        revision: () => webSettings.revision,
        open: (authorize) =>
          openBrowserBridge(
            browser,
            (request) => {
              const signal = authorize(request);
              if (!signal) return;
              const turn = initial.data.chat.messages.find(
                (message) =>
                  message.requestId === request.requestId &&
                  message.conversationId === request.conversationId &&
                  message.role === 'assistant' &&
                  ['pending', 'streaming'].includes(message.status),
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
                  )
                : Promise.resolve(false);
            },
          ),
      },
      {
        policy: (registry) => ({
          ...runtimePolicy(registry),
          desktopRuntime: true,
          computerBrowser: browser.computerAvailable(),
          computerVirtual: virtualComputer.ready(),
          computerLocal: localComputer.ready(),
        }),
        artifact: (id, conversation, request) =>
          executionRuntime.resolveArtifact(id, conversation, request),
        adoptHostedArtifact: (asset, conversation, request, execution, signal) =>
          executionRuntime.adoptHostedArtifact(asset, conversation, request, execution, signal),
        release: (request) => {
          executionRuntime.release(request);
          computerRuntime.release(request);
        },
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
            (request) =>
              request.type === 'runtime'
                ? authorize(request) && chat.authorizeRuntime(request)
                : request.voiceSessionId
                  ? media.authorizeCapability(request)
                  : authorize(request),
            (request, signal) => {
              if (request.programId)
                executionRuntime.store.assertProgramChild(request, chat.executionIdentity());
              return request.operation.startsWith('computer.')
                ? computerRuntime.dispatch(request, signal)
                : executionRuntime.dispatch(request, signal);
            },
          ),
      },
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
      .then(() => computerRuntime.shutdown())
      .then(() => localComputer.revoke())
      .then(() => executionRuntime.close())
      .finally(() => {
        browser.close();
        shutdownComplete = true;
        app.quit();
      });
  }
});
