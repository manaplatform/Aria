import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('aria', {
  platform: process.platform,
});
