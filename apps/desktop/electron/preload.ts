import { contextBridge, ipcRenderer } from 'electron';
import type { ChatEvent, ChatServiceStatus, DesktopBridge } from '@aria/shared';

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
  chatStatus: () => ipcRenderer.invoke('aria:chat-status'),
  providerSettings: () => ipcRenderer.invoke('aria:provider-settings'),
  saveProviderSettings: (settings) => ipcRenderer.invoke('aria:save-provider-settings', settings),
  restartChatService: () => ipcRenderer.invoke('aria:restart-chat-service'),
  testProvider: () => ipcRenderer.invoke('aria:test-provider'),
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
