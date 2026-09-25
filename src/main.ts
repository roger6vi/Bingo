import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createSampleState } from './sample-state';
import { createWindowLifecycle } from './window-lifecycle';
import { planOperatorWindow, planPublicWindow } from './window-plan';
import { createPublicWindowMover } from './window-placement';

const htmlPath = (name: string) => path.join(__dirname, '..', 'src', name);
const preload = path.join(__dirname, 'preload.js');

app.whenReady().then(() => {
  // Feasibility sample only: this JSON file is not production persistence or SQLite.
  const sample = createSampleState(path.join(app.getPath('userData'), 'sample-state.json'), fs);
  const primary = screen.getPrimaryDisplay();
  const operator = new BrowserWindow({
    ...planOperatorWindow(primary.workArea),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  void operator.loadFile(htmlPath('operator.html'));

  const lifecycle = createWindowLifecycle<BrowserWindow>({
    displays: () => screen.getAllDisplays(),
    primaryId: () => screen.getPrimaryDisplay().id,
    planPublic: planPublicWindow,
    createPublic: (plan) => {
      const window = new BrowserWindow({
        ...plan.bounds,
        fullscreen: plan.fullscreen,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      window.on('closed', () => lifecycle.publicClosed(window));
      void window.loadFile(htmlPath('public.html'));
      return window;
    },
    movePublic: createPublicWindowMover<BrowserWindow>(),
    notify: (pauseSuggested) => {
      if (!operator.isDestroyed()) operator.webContents.send('public-status', pauseSuggested);
    },
  });

  ipcMain.handle('sample-read', (event) => {
    if (event.sender !== operator.webContents) throw new Error('Unauthorized sample state read');
    return sample.read();
  });
  ipcMain.handle('sample-increment', (event) => {
    if (event.sender !== operator.webContents) throw new Error('Unauthorized sample state change');
    return sample.increment();
  });
  ipcMain.on('open-public', (event) => {
    if (event.sender !== operator.webContents) return;
    lifecycle.openPublic().focus();
  });
  ipcMain.on('move-public-to-secondary', (event) => {
    if (event.sender === operator.webContents) lifecycle.moveToSecondary();
  });
  screen.on('display-removed', () => lifecycle.displaysChanged());
  screen.on('display-metrics-changed', () => lifecycle.displaysChanged());
});

app.on('window-all-closed', () => app.quit());
