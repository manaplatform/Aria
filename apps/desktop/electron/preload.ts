import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BrowserState,
  ChatEvent,
  ChatServiceStatus,
  DesktopBridge,
  LiveEvent,
} from '@aria/shared';

const bridge: DesktopBridge = {
  platform: process.platform,
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
  selectLocalComputer: (conversation) =>
    ipcRenderer.invoke('aria:select-local-computer', conversation),
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
  saveWebSettings: (input) => ipcRenderer.invoke('aria:save-web-settings', input),
  toolSettings: () => ipcRenderer.invoke('aria:tool-settings'),
  executionHistory: () => ipcRenderer.invoke('aria:execution-history'),
  runtimeSettings: () => ipcRenderer.invoke('aria:runtime-settings'),
  saveRuntimeSettings: (settings) => ipcRenderer.invoke('aria:save-runtime-settings', settings),
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
  submitChat: (request) => ipcRenderer.invoke('aria:submit-chat', request),
  cancelChat: (id) => ipcRenderer.invoke('aria:cancel-chat', id),
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
};
contextBridge.exposeInMainWorld('aria', bridge);
