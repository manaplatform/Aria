import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BrowserState,
  ChatEvent,
  ChatServiceStatus,
  DesktopBridge,
  DiagnosticEvent,
  LiveEvent,
  ProactiveEvent,
  UpdateState,
} from '@aria/shared';

window.addEventListener('unhandledrejection', () => {
  void ipcRenderer.invoke('aria:diagnostic-renderer-error').catch(() => undefined);
});

const bridge: DesktopBridge = {
  platform: process.platform,
  proactive: (input) => ipcRenderer.invoke('aria:proactive', input),
  onProactiveEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: ProactiveEvent) => callback(value);
    ipcRenderer.on('aria:proactive-event', listener);
    return () => ipcRenderer.removeListener('aria:proactive-event', listener);
  },
  updateState: () => ipcRenderer.invoke('aria:update-state'),
  updateCommand: (command) => ipcRenderer.invoke('aria:update-command', command),
  onUpdateState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: UpdateState) => callback(state);
    ipcRenderer.on('aria:update-state-changed', listener);
    return () => ipcRenderer.removeListener('aria:update-state-changed', listener);
  },
  onBeforeClose: (callback) => {
    const listener = () => {
      void callback()
        .then(() => ipcRenderer.invoke('aria:close-ready'))
        .catch((error) => ipcRenderer.invoke('aria:close-failed', String(error)));
    };
    ipcRenderer.on('aria:before-close', listener);
    void ipcRenderer.invoke('aria:enable-close-flush');
    return () => {
      ipcRenderer.removeListener('aria:before-close', listener);
    };
  },
  load: () => ipcRenderer.invoke('aria:load'),
  save: (data) => ipcRenderer.invoke('aria:save', data),
  chooseWorkspace: () => ipcRenderer.invoke('aria:choose-workspace'),
  repository: (id) => ipcRenderer.invoke('aria:repository', id),
  listFiles: (id, directory) => ipcRenderer.invoke('aria:list-files', id, directory),
  readFile: (id, file) => ipcRenderer.invoke('aria:read-file', id, file),
  chooseFiles: (id) => ipcRenderer.invoke('aria:choose-files', id),
  health: (url) => ipcRenderer.invoke('aria:health', url),
  copy: (text) => ipcRenderer.invoke('aria:copy', text),
  openExternal: (url) => ipcRenderer.invoke('aria:open-external', url),
  browserState: () => ipcRenderer.invoke('aria:browser-state'),
  browserCommand: (command) => ipcRenderer.invoke('aria:browser-command', command),
  browserLayout: (layout) => ipcRenderer.invoke('aria:browser-layout', layout),
  computerSessions: (conversation) => ipcRenderer.invoke('aria:computer-sessions', conversation),
  computerPreview: (conversation, id) =>
    ipcRenderer.invoke('aria:computer-preview', conversation, id),
  probeVirtualComputer: () => ipcRenderer.invoke('aria:probe-virtual-computer'),
  localComputerSupported: () => ipcRenderer.invoke('aria:local-computer-supported'),
  selectLocalComputer: (conversation, target, standing) =>
    ipcRenderer.invoke('aria:select-local-computer', conversation, target, standing),
  localDesktopAccess: (requestPermission) => ipcRenderer.invoke('aria:local-desktop-access', requestPermission),
  revokeLocalComputer: () => ipcRenderer.invoke('aria:revoke-local-computer'),
  superviseComputer: (conversation, command) =>
    ipcRenderer.invoke('aria:computer-supervise', conversation, command),
  sendComputerInput: (conversation, sessionId, action) =>
    ipcRenderer.invoke('aria:computer-user-input', conversation, { sessionId, action }),
  onComputerSession: (callback) => {
    const listener: Parameters<typeof ipcRenderer.on>[1] = (_event, state) => callback(state);
    ipcRenderer.on('aria:computer-session-update', listener);
    return () => ipcRenderer.removeListener('aria:computer-session-update', listener);
  },
  onBrowserState: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState) => callback(state);
    ipcRenderer.on('aria:browser-state-update', listener);
    return () => ipcRenderer.removeListener('aria:browser-state-update', listener);
  },
  webSettings: () => ipcRenderer.invoke('aria:web-settings'),
  weatherSettings: () => ipcRenderer.invoke('aria:weather-settings'),
  saveWeatherSettings: (input) => ipcRenderer.invoke('aria:save-weather-settings', input),
  clearWeatherCache: () => ipcRenderer.invoke('aria:clear-weather-cache'),
  saveWebSettings: (input) => ipcRenderer.invoke('aria:save-web-settings', input),
  toolSettings: () => ipcRenderer.invoke('aria:tool-settings'),
  setProgramSettings: (settings) => ipcRenderer.invoke('aria:set-program-settings', settings),
  superviseProgram: (request, conversation, id, pause) =>
    ipcRenderer.invoke('aria:supervise-program', request, conversation, id, pause),
  inspectProgramResult: (conversation, id) => ipcRenderer.invoke('aria:inspect-program-result', conversation, id),
  recoverStoredResponse: (conversation, message, request) =>
    ipcRenderer.invoke('aria:recover-stored-response', conversation, message, request),
  executionHistory: () => ipcRenderer.invoke('aria:execution-history'),
  runtimeSettings: () => ipcRenderer.invoke('aria:runtime-settings'),
  saveRuntimeSettings: (settings) => ipcRenderer.invoke('aria:save-runtime-settings', settings),
  saveEmbeddingTarget: (target) => ipcRenderer.invoke('aria:save-embedding-target', target),
  nativeRuntimeModes: () => ipcRenderer.invoke('aria:native-runtime-modes'),
  setNativeRuntime: (mode, enabled) => ipcRenderer.invoke('aria:set-native-runtime', mode, enabled),
  probeRuntime: () => ipcRenderer.invoke('aria:probe-runtime'),
  localEmbeddings: () => ipcRenderer.invoke('aria:local-embeddings'),
  installLocalEmbeddings: () => ipcRenderer.invoke('aria:install-local-embeddings'),
  removeLocalEmbeddings: () => ipcRenderer.invoke('aria:remove-local-embeddings'),
  knowledgeCollections: () => ipcRenderer.invoke('aria:knowledge-collections'),
  manageKnowledge: (input) => ipcRenderer.invoke('aria:manage-knowledge', input),
  previewDocument: (conversationId, id) =>
    ipcRenderer.invoke('aria:preview-document', conversationId, id),
  removeArtifact: (conversationId, id) =>
    ipcRenderer.invoke('aria:remove-artifact', conversationId, id),
  documentEvidence: (conversationId, id) =>
    ipcRenderer.invoke('aria:document-evidence', conversationId, id),
  setToolEnabled: (id, enabled) => ipcRenderer.invoke('aria:set-tool-enabled', id, enabled),
  setToolDiscovery: (mode) => ipcRenderer.invoke('aria:set-tool-discovery', mode),
  previewSkill: (kind) => ipcRenderer.invoke('aria:preview-skill', kind),
  approveSkill: (token) => ipcRenderer.invoke('aria:approve-skill', token),
  manageSkill: (skill, action) => ipcRenderer.invoke('aria:manage-skill', skill, action),
  chatStatus: () => ipcRenderer.invoke('aria:chat-status'),
  registrySettings: () => ipcRenderer.invoke('aria:registry-settings'),
  saveRegistry: (settings) => ipcRenderer.invoke('aria:save-registry', settings),
  discoverModels: (connection) => ipcRenderer.invoke('aria:discover-models', connection),
  verifyModel: (connection, id) => ipcRenderer.invoke('aria:verify-model', connection, id),
  importRegistryEnvironment: () => ipcRenderer.invoke('aria:import-registry-environment'),
  restartChatService: () => ipcRenderer.invoke('aria:restart-chat-service'),
  importDroppedFiles: (files) =>
    ipcRenderer.invoke(
      'aria:import-dropped-files',
      files.slice(0, 5).map((file) => webUtils.getPathForFile(file)),
    ),
  chooseMedia: (kind) => ipcRenderer.invoke('aria:choose-media', kind),
  captureScreen: () => ipcRenderer.invoke('aria:capture-screen'),
  exportMedia: (id) => ipcRenderer.invoke('aria:export-media', id),
  startLive: (request) => ipcRenderer.invoke('aria:start-live', request),
  sendLiveAudio: (id, audio) => ipcRenderer.send('aria:live-audio', id, audio),
  muteLive: (id, muted) => ipcRenderer.invoke('aria:mute-live', id, muted),
  endLive: () => ipcRenderer.invoke('aria:end-live'),
  onLiveEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: LiveEvent) => callback(event);
    ipcRenderer.on('aria:live-event', listener);
    return () => ipcRenderer.removeListener('aria:live-event', listener);
  },
  connectors: (input) => ipcRenderer.invoke('aria:connectors', input),
  connectorActivity: (id) => ipcRenderer.invoke('aria:connector-activity', id),
  onConnectorsChanged: (callback) => {
    const listener: Parameters<typeof ipcRenderer.on>[1] = (_event, state) => callback(state);
    ipcRenderer.on('aria:connectors-changed', listener);
    return () => ipcRenderer.removeListener('aria:connectors-changed', listener);
  },
  personaAction: (input) => ipcRenderer.invoke('aria:persona-action', input),
  personaRender: (id, status, duration) => ipcRenderer.invoke('aria:persona-render', id, status, duration),
  communicationPreferences: () => ipcRenderer.invoke('aria:communication-preferences'),
  reviewCommunicationPreference: (id, accept) => ipcRenderer.invoke('aria:review-communication-preference', id, accept),
  memoryStatus: () => ipcRenderer.invoke('aria:memory-status'),
  memoryDiagnostics: () => ipcRenderer.invoke('aria:memory-diagnostics'),
  saveMemorySettings: (settings, allowAutoRecall) =>
    ipcRenderer.invoke('aria:save-memory-settings', settings, allowAutoRecall),
  rememberChatMessage: (conversation, message, category) => ipcRenderer.invoke('aria:remember-chat-message', conversation, message, category),
  memoryEvidence: (conversation, id) => ipcRenderer.invoke('aria:memory-evidence', conversation, id),
  searchMemories: (query) => ipcRenderer.invoke('aria:search-memories', query),
  editMemory: (record) => ipcRenderer.invoke('aria:edit-memory', record),
  deleteMemory: (record) => ipcRenderer.invoke('aria:delete-memory', record),
  clearMemories: (filter) => ipcRenderer.invoke('aria:clear-memories', filter),
  exportMemories: () => ipcRenderer.invoke('aria:export-memories'),
  startTemporaryChat: (id) => ipcRenderer.invoke('aria:start-temporary-chat', id),
  attachChatProject: (conversation, project) => ipcRenderer.invoke('aria:attach-chat-project', conversation, project),
  submitChat: (request) => ipcRenderer.invoke('aria:submit-chat', request),
  cancelChat: (id) => ipcRenderer.invoke('aria:cancel-chat', id),
  controlExecution: (command) => ipcRenderer.invoke('aria:control-execution', command),
  resumeExecution: (scope) => ipcRenderer.invoke('aria:resume-execution', scope),
  activeChatMessages: () => ipcRenderer.invoke('aria:active-chat-messages'),
  onChatEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: ChatEvent) => callback(event);
    ipcRenderer.on('aria:chat-event', listener);
    return () => {
      ipcRenderer.removeListener('aria:chat-event', listener);
    };
  },
  onChatStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: ChatServiceStatus) =>
      callback(status);
    ipcRenderer.on('aria:chat-status-update', listener);
    return () => {
      ipcRenderer.removeListener('aria:chat-status-update', listener);
    };
  },
  systemBehavior: () => ipcRenderer.invoke('aria:system-behavior'),
  setSystemBehavior: (patch) => ipcRenderer.invoke('aria:set-system-behavior', patch),
  testNotification: () => ipcRenderer.invoke('aria:test-notification'),
  removeWorkspace: (workspaceId) => ipcRenderer.invoke('aria:remove-workspace', workspaceId),
  storageInfo: () => ipcRenderer.invoke('aria:storage-info'),
  openStorageFolder: () => ipcRenderer.invoke('aria:open-storage-folder'),
  pruneMediaCache: () => ipcRenderer.invoke('aria:prune-media-cache'),
  clearBrowserCache: () => ipcRenderer.invoke('aria:clear-browser-cache'),
  osPermissions: () => ipcRenderer.invoke('aria:os-permissions'),
  clearChatHistory: () => ipcRenderer.invoke('aria:clear-chat-history'),
  clearLegacyData: () => ipcRenderer.invoke('aria:clear-legacy-data'),
  exportDiagnostics: () => ipcRenderer.invoke('aria:export-diagnostics'),
  diagnosticStatus: () => ipcRenderer.invoke('aria:diagnostic-status'),
  diagnosticConfigure: (config) => ipcRenderer.invoke('aria:diagnostic-configure', config),
  diagnosticQuery: (filter) => ipcRenderer.invoke('aria:diagnostic-query', filter),
  diagnosticClear: () => ipcRenderer.invoke('aria:diagnostic-clear'),
  diagnosticOpenDirectory: () => ipcRenderer.invoke('aria:diagnostic-open'),
  diagnosticExport: (filter) => ipcRenderer.invoke('aria:diagnostic-export', filter),
  diagnosticRendererError: () => ipcRenderer.invoke('aria:diagnostic-renderer-error'),
  onDiagnosticEvents: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, events: DiagnosticEvent[]) => callback(events);
    ipcRenderer.on('aria:diagnostic-events', listener);
    void ipcRenderer.invoke('aria:diagnostic-subscribe', true);
    return () => { ipcRenderer.removeListener('aria:diagnostic-events', listener); void ipcRenderer.invoke('aria:diagnostic-subscribe', false); };
  },
  resetConfiguration: (scope) => ipcRenderer.invoke('aria:reset-configuration', scope),
  aboutInfo: () => ipcRenderer.invoke('aria:about-info'),
  openDevTools: () => ipcRenderer.invoke('aria:open-devtools'),
};
contextBridge.exposeInMainWorld('aria', bridge);
