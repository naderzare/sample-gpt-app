import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, StreamEvent } from '../shared/types';
const api: DesktopAPI = {
  session: () => ipcRenderer.invoke('session'),
  login: (id, requestConsent) => ipcRenderer.invoke('login', id, requestConsent),
  cancelLogin: () => ipcRenderer.invoke('cancel-login'),
  select: id => ipcRenderer.invoke('select', id),
  logout: () => ipcRenderer.invoke('logout'),
  acknowledgeWelcome: () => ipcRenderer.invoke('welcome'),
  models: () => ipcRenderer.invoke('models'),
  ask: request => ipcRenderer.invoke('ask', request),
  cancel: () => ipcRenderer.invoke('cancel'),
  openUsage: () => ipcRenderer.invoke('usage'),
  onStream: callback => {
    const listener = (_event: Electron.IpcRendererEvent, data: StreamEvent) => callback(data);
    ipcRenderer.on('stream', listener);
    return () => ipcRenderer.removeListener('stream', listener);
  }
};
contextBridge.exposeInMainWorld('desktop', api);
