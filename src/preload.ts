import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  openPublic: () => ipcRenderer.send('open-public'),
  movePublicToSecondary: () => ipcRenderer.send('move-public-to-secondary'),
  getCurrentEvent: () => ipcRenderer.invoke('event:get'),
  drawManual: (number: number) => ipcRenderer.invoke('event:draw-manual', number),
  drawDigital: () => ipcRenderer.invoke('event:draw-digital'),
  onPublicStatus: (callback: (pauseSuggested: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pauseSuggested: boolean) => callback(pauseSuggested);
    ipcRenderer.on('public-status', listener);
    return () => ipcRenderer.removeListener('public-status', listener);
  },
}));
