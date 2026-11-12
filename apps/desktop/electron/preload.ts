import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '@aria/shared';

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
};
contextBridge.exposeInMainWorld('aria', bridge);
