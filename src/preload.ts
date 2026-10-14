import { contextBridge, ipcRenderer } from 'electron';
import type { LineLotSnapshot } from './event-store';
import type { BingoLotSnapshot } from './event-store';

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
  beginLineSetup: () => ipcRenderer.invoke('line:begin'),
  readLineSetup: () => ipcRenderer.invoke('line:read'),
  cancelLineSetup: (sessionId: string, eventId: string) => ipcRenderer.invoke('line:cancel', sessionId, eventId),
  confirmLine: (sessionId: string, eventId: string, winnerCount: number) =>
    ipcRenderer.invoke('line:confirm', sessionId, eventId, winnerCount),
  readLegacyLineCheck: () => ipcRenderer.invoke('line:legacy-check:read'),
  cancelLegacyLineCheck: (eventId: string, auditSequence: number, lastTransitionAt: string) =>
    ipcRenderer.invoke('line:legacy-check:cancel', eventId, auditSequence, lastTransitionAt),
  beginBingoSetup: () => ipcRenderer.invoke('bingo:begin'),
  readBingoSetup: () => ipcRenderer.invoke('bingo:read'),
  cancelBingoSetup: (sessionId: string, eventId: string) => ipcRenderer.invoke('bingo:cancel', sessionId, eventId),
  confirmBingo: (sessionId: string, winnerCount: number) =>
    ipcRenderer.invoke('bingo:confirm', sessionId, winnerCount),
  readLegacyBingoCheck: () => ipcRenderer.invoke('bingo:legacy-check:read'),
  cancelLegacyBingoCheck: (eventId: string, auditSequence: number, lastTransitionAt: string) =>
    ipcRenderer.invoke('bingo:legacy-check:cancel', eventId, auditSequence, lastTransitionAt),
  retryBingoPresentation: (id: string) => ipcRenderer.invoke('bingo:retry-presentation', id),
  repeatBingoPresentation: (id: string) => ipcRenderer.invoke('bingo:repeat-presentation', id),
  onBingoPresentation: (callback: (award: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, award: unknown) => callback(award);
    ipcRenderer.on('bingo:presentation', listener);
    return () => ipcRenderer.removeListener('bingo:presentation', listener);
  },
  readLineLot: () => ipcRenderer.invoke('line:lot:read'),
  drawLineLot: (expected: { eventId: string; auditSequence: number; presentationId: string }) =>
    ipcRenderer.invoke('line:lot:draw', expected),
  presentLineLot: (snapshot: LineLotSnapshot) => ipcRenderer.invoke('line:lot:present', snapshot),
  readBingoLot: () => ipcRenderer.invoke('bingo:lot:read'),
  drawBingoLot: (expected: { eventId: string; auditSequence: number; presentationId: string }) =>
    ipcRenderer.invoke('bingo:lot:draw', expected),
  presentBingoLot: (snapshot: BingoLotSnapshot) => ipcRenderer.invoke('bingo:lot:present', snapshot),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme: string) => ipcRenderer.invoke('theme:set', theme),
  retryLinePresentation: (id: string) => ipcRenderer.invoke('line:retry-presentation', id),
  repeatLinePresentation: (id: string) => ipcRenderer.invoke('line:repeat-presentation', id),
  onLinePresentation: (callback: (award: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, award: unknown) => callback(award);
    ipcRenderer.on('line:presentation', listener);
    return () => ipcRenderer.removeListener('line:presentation', listener);
  },
  playTongo: () => ipcRenderer.invoke('tongo:play'),
  onPublicStatus: (callback: (pauseSuggested: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, pauseSuggested: boolean) => callback(pauseSuggested);
    ipcRenderer.on('public-status', listener);
    return () => ipcRenderer.removeListener('public-status', listener);
  },
}));
