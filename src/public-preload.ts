import { contextBridge, ipcRenderer } from 'electron';

// Sandbox preloads cannot import local modules; keep these literals aligned with public-event-delivery.
const PUBLIC_EVENT_CHANNEL = 'public:event-state';
const PUBLIC_THEME_CHANNEL = 'public:theme';
const PUBLIC_META_CHANNEL = 'public:event-meta';
const PUBLIC_PRESENTATION_CHANNEL = 'public:presentation';

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

contextBridge.exposeInMainWorld('publicEventMeta', Object.freeze({
  subscribe: (callback: (meta: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, meta: unknown) => callback(meta);
    ipcRenderer.on(PUBLIC_META_CHANNEL, listener);
    return () => ipcRenderer.removeListener(PUBLIC_META_CHANNEL, listener);
  },
}));

contextBridge.exposeInMainWorld('publicPresentation', Object.freeze({
  subscribe: (callback: (presentation: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, presentation: unknown) => callback(presentation);
    ipcRenderer.on(PUBLIC_PRESENTATION_CHANNEL, listener);
    return () => ipcRenderer.removeListener(PUBLIC_PRESENTATION_CHANNEL, listener);
  },
}));
