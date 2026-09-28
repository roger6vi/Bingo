import { contextBridge, ipcRenderer } from 'electron';

// Sandbox preloads cannot import local modules; keep these literals aligned with public-event-delivery.
const PUBLIC_EVENT_CHANNEL = 'public:event-state';
const PUBLIC_THEME_CHANNEL = 'public:theme';

contextBridge.exposeInMainWorld('publicEvent', Object.freeze({
  subscribe: (callback: (result: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on(PUBLIC_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(PUBLIC_EVENT_CHANNEL, listener);
  },
}));

contextBridge.exposeInMainWorld('publicTheme', Object.freeze({
  subscribe: (callback: (theme: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, theme: unknown) => callback(theme);
    ipcRenderer.on(PUBLIC_THEME_CHANNEL, listener);
    return () => ipcRenderer.removeListener(PUBLIC_THEME_CHANNEL, listener);
  },
}));
