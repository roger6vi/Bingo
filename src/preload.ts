import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  openPublic: () => ipcRenderer.send('open-public'),
  readSample: (): Promise<{ count: number }> => ipcRenderer.invoke('sample-read'),
  incrementSample: (): Promise<{ count: number }> => ipcRenderer.invoke('sample-increment'),
  movePublicToSecondary: () => ipcRenderer.send('move-public-to-secondary'),
  onPublicStatus: (callback: (pauseSuggested: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pauseSuggested: boolean) => callback(pauseSuggested);
    ipcRenderer.on('public-status', listener);
    return () => ipcRenderer.removeListener('public-status', listener);
  },
}));
