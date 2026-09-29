import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', Object.freeze({
  openPublic: () => ipcRenderer.send('open-public'),
  movePublicToSecondary: () => ipcRenderer.send('move-public-to-secondary'),
  getCurrentEvent: () => ipcRenderer.invoke('event:get'),
  drawManual: (number: number) => ipcRenderer.invoke('event:draw-manual', number),
  drawDigital: () => ipcRenderer.invoke('event:draw-digital'),
  listEvents: () => ipcRenderer.invoke('events:list'),
  createEvent: (meta: { name: string; date: string; place: string }) => ipcRenderer.invoke('events:create', meta),
  selectEvent: (id: string) => ipcRenderer.invoke('events:select', id),
  updateEvent: (id: string, meta: { name: string; date: string; place: string }) =>
    ipcRenderer.invoke('events:update', id, meta),
  getPrizes: () => ipcRenderer.invoke('prizes:get'),
  updatePrizes: (id: string, prizes: { line: { amount: number; lot: string }; bingo: { amount: number; lot: string } }) =>
    ipcRenderer.invoke('prizes:update', id, prizes),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme: string) => ipcRenderer.invoke('theme:set', theme),
  playTongo: () => ipcRenderer.invoke('tongo:play'),
  getLineAward: () => ipcRenderer.invoke('line:get'),
  awardLine: (id: string, winners: number) => ipcRenderer.invoke('line:award', id, winners),
  onPublicStatus: (callback: (pauseSuggested: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pauseSuggested: boolean) => callback(pauseSuggested);
    ipcRenderer.on('public-status', listener);
    return () => ipcRenderer.removeListener('public-status', listener);
  },
}));
