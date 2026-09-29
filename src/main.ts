import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEventStore } from './event-store';
import { drawManual, drawDigital } from './event-core';
import { initializeCurrentEvent } from './event-persistence';
import { createOperatorGuard, registerEventIpc } from './event-ipc';
import { registerEventCatalogIpc } from './event-catalog-ipc';
import { registerThemeIpc } from './theme-ipc';
import { registerTongoIpc } from './tongo-ipc';
import { registerPrizeIpc } from './prize-ipc';
import { createPublicEventDelivery } from './public-event-delivery';
import { createWindowLifecycle } from './window-lifecycle';
import { planOperatorWindow, planPublicWindow } from './window-plan';
import { createPublicWindowMover } from './window-placement';

const htmlPath = (name: 'operator.html' | 'public.html') => path.join(__dirname, 'renderer', name);
const preload = path.join(__dirname, 'preload.js');
const publicPreload = path.join(__dirname, 'public-preload.js');

// Resolve Node's lazy performance global before any protocol request: Electron compiles undici for the
// first protocol.handle request and undici reads performance at load, which was intermittently undefined
// when that first request raced startup, failing the simulator frame with ERR_UNEXPECTED.
void globalThis.performance;

// The sandboxed simulator needs a standard origin to load its bundled modules. A distinct local-only
// scheme keeps it cross-origin from the operator, so framed public code cannot reach the operator bridge.
protocol.registerSchemesAsPrivileged([{ scheme: 'bingo-public', privileges: { standard: true, secure: true,
  supportFetchAPI: true, corsEnabled: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else app.whenReady().then(() => {
  const rendererRoot = path.join(__dirname, 'renderer');
  protocol.handle('bingo-public', (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(rendererRoot, relative);
    if (url.hostname !== 'simulator' || (!target.startsWith(`${rendererRoot}${path.sep}`) && target !== rendererRoot)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(target).href);
  });

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
  // The public window is only attached after theme IPC is registered below.
  const activeMeta = () => {
    const active = store.listEvents().find((event) => event.active);
    return active === undefined ? null : { name: active.name, date: active.date, place: active.place };
  };
  const activePrizes = () => store.loadPrizes()?.prizes ?? null;
  const publicDelivery = createPublicEventDelivery(store, () => theme.current(), activeMeta, activePrizes);
  const operatorOnly = createOperatorGuard(operator.webContents, operatorFrame, operatorUrl);
  const theme = registerThemeIpc(ipcMain, { load: store.loadTheme, save: store.saveTheme },
    operatorOnly, publicDelivery.publishTheme);
  registerEventCatalogIpc(ipcMain, store, operatorOnly, () => publicDelivery.publishActive(theme.reload()),
    publicDelivery.publishMeta);
  const tongo = registerTongoIpc(ipcMain, store, { authorize: operatorOnly, publish: publicDelivery.publishPresentation });
  registerPrizeIpc(ipcMain, store, operatorOnly, publicDelivery.publishPrizes);
  registerEventIpc(ipcMain, store, { drawManual, drawDigital }, Math.random,
    operator.webContents, operatorFrame, operatorUrl, publicDelivery.publishCommitted, tongo.playing);
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
