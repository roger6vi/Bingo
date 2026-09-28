import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEventStore } from './event-store';
import { drawManual, drawDigital } from './event-core';
import { initializeCurrentEvent } from './event-persistence';
import { createOperatorGuard, registerEventIpc } from './event-ipc';
import { createThemeStore } from './theme-store';
import { registerThemeIpc } from './theme-ipc';
import { createPublicEventDelivery } from './public-event-delivery';
import { createWindowLifecycle } from './window-lifecycle';
import { planOperatorWindow, planPublicWindow } from './window-plan';
import { createPublicWindowMover } from './window-placement';

const htmlPath = (name: 'operator.html' | 'public.html') => path.join(__dirname, 'renderer', name);
const preload = path.join(__dirname, 'preload.js');
const publicPreload = path.join(__dirname, 'public-preload.js');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else app.whenReady().then(() => {
  let store: ReturnType<typeof createEventStore>;
  try {
    const databasePath = path.join(app.getPath('userData'), 'current-event.sqlite');
    ({ store } = initializeCurrentEvent(createEventStore(databasePath)));
    app.once('before-quit', () => store.close());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox('Could not open current event',
      `The event database could not be initialized. Existing event data was not reset.\n\n${detail}`);
    app.quit();
    return;
  }

  const primary = screen.getPrimaryDisplay();
  const operator = new BrowserWindow({
    ...planOperatorWindow(primary.workArea),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false },
  });
  const operatorPath = htmlPath('operator.html');
  const operatorFrame = () => operator.webContents.mainFrame;
  const operatorUrl = pathToFileURL(operatorPath).href;
  // Theme storage is separate from event data; if it cannot open, render the default and fail saves.
  let themeStore: Pick<ReturnType<typeof createThemeStore>, 'load' | 'save'>;
  try {
    const opened = createThemeStore(path.join(app.getPath('userData'), 'theme.sqlite'));
    app.once('before-quit', () => opened.close());
    themeStore = opened;
  } catch {
    const unavailable = () => { throw new Error('Theme storage unavailable'); };
    themeStore = { load: unavailable, save: unavailable };
  }
  // The public window is only attached after theme IPC is registered below.
  const publicDelivery = createPublicEventDelivery(store, () => theme.current());
  const theme = registerThemeIpc(ipcMain, themeStore,
    createOperatorGuard(operator.webContents, operatorFrame, operatorUrl), publicDelivery.publishTheme);
  registerEventIpc(ipcMain, store, { drawManual, drawDigital }, Math.random,
    operator.webContents, operatorFrame, operatorUrl, publicDelivery.publishCommitted);
  void operator.loadFile(operatorPath);

  const lifecycle = createWindowLifecycle<BrowserWindow>({
    displays: () => screen.getAllDisplays(),
    primaryId: () => screen.getPrimaryDisplay().id,
    planPublic: planPublicWindow,
    createPublic: (plan) => {
      const window = new BrowserWindow({
        ...plan.bounds,
        fullscreen: plan.fullscreen,
        webPreferences: { preload: publicPreload, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      const contents = window.webContents;
      contents.on('did-finish-load', () => publicDelivery.attachAfterLoad(contents));
      window.on('closed', () => {
        publicDelivery.detachIfCurrent(contents);
        lifecycle.publicClosed(window);
      });
      void window.loadFile(htmlPath('public.html'));
      return window;
    },
    movePublic: createPublicWindowMover<BrowserWindow>(),
    notify: (pauseSuggested) => {
      if (!operator.isDestroyed()) operator.webContents.send('public-status', pauseSuggested);
    },
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
}).catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox('Could not start application', detail);
  app.quit();
});

app.on('window-all-closed', () => app.quit());
