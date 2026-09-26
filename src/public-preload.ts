import { contextBridge, ipcRenderer } from 'electron';

// Sandbox preloads cannot import local modules; keep this literal aligned with PUBLIC_EVENT_CHANNEL.
const PUBLIC_EVENT_CHANNEL = 'public:event-state';

contextBridge.exposeInMainWorld('publicEvent', Object.freeze({
  subscribe: (callback: (result: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: unknown) => callback(result);
    ipcRenderer.on(PUBLIC_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(PUBLIC_EVENT_CHANNEL, listener);
  },
}));
