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
import { registerLineIpc } from './line-ipc';
import { recoverBingoPresentations, registerBingoMainWiring, sharedSetupActive } from './bingo-main-wiring';
import type { StoredBingoAward } from './event-store';
import { registerLineLotPresentation } from './line-lot-presentation';
import { registerBingoLotPresentation } from './bingo-lot-presentation';
import { createPresentationWiring } from './presentation-wiring';
import { createPublicEventDelivery, PUBLIC_BINGO_RECEIPT_CHANNEL, PUBLIC_LINE_RECEIPT_CHANNEL } from './public-event-delivery';
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
    // A presentation still persisted as started belongs to a previous run: mark it interrupted exactly once, before
    // any window, delivery or IPC exists. Then a pending one that never reached a renderer becomes failed. Nothing
    // completes, replays or retries either; draws stay blocked and the operator retries manually.
    store.interruptStartedLinePresentations();
    store.failPendingLinePresentations();
    recoverBingoPresentations(store);
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
  const publicUrl = pathToFileURL(htmlPath('public.html')).href;
  // The public window is only attached after theme IPC is registered below.
  const activeMeta = () => {
    const active = store.listEvents().find((event) => event.active);
    return active === undefined ? null : { name: active.name, date: active.date, place: active.place };
  };
  const activePrizes = () => store.loadPrizes()?.prizes ?? null;
  const publicDelivery = createPublicEventDelivery(store, () => theme.current(), activeMeta, activePrizes,
    () => store.loadLineAward(), () => store.loadLineLotResult(), () => store.loadBingoAward());
  const operatorOnly = createOperatorGuard(operator.webContents, operatorFrame, operatorUrl);
  const theme = registerThemeIpc(ipcMain, { load: store.loadTheme, save: store.saveTheme },
    operatorOnly, publicDelivery.publishTheme);
  // The line and Bingo coordinators own every presentation state change and are mutually exclusive; main only supplies
  // the clock, timers, the public signal, the receipt authorization and the operator notification. The confirmation
  // helper starts only a freshly confirmed pending Bingo after refresh; reads and window attachment never play.
  const notifyBingo = (award: StoredBingoAward | null): void => {
    if (!operator.isDestroyed()) operator.webContents.send('bingo:presentation', award);
  };
  const presentations = createPresentationWiring(store, {
    now: Date.now,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    publish: publicDelivery.publishPresentation,
    notifyLine: (award) => { if (!operator.isDestroyed()) operator.webContents.send('line:presentation', award); },
    notifyBingo,
    acceptLineReceipt: (event, id) => publicDelivery.acceptLineReceipt(event, id, publicUrl),
    acceptBingoReceipt: (event, id) => publicDelivery.acceptBingoReceipt(event, id, publicUrl),
  });
  const presentation = presentations.line;
  const tongo = registerTongoIpc(ipcMain, store, { authorize: operatorOnly, publish: publicDelivery.publishPresentation,
    lineBusy: presentations.busy });
  const line = registerLineIpc(ipcMain, store, { authorize: operatorOnly, now: () => new Date(),
    publish: publicDelivery.publishCommitted, committed: presentation.begin, retry: presentation.retry,
    repeat: presentation.repeat, busy: presentations.busy, tongoPlaying: tongo.playing,
    otherSetupActive: () => bingo.active() });
  const bingo = registerBingoMainWiring(ipcMain, store, { authorize: operatorOnly, now: () => new Date(),
    otherSetupActive: line.active, tongoPlaying: tongo.playing, presentationBusy: presentations.busy,
    publishCommitted: publicDelivery.publishCommitted, notifyBingo,
    begin: presentations.bingo.begin, retry: presentations.bingo.retry, repeat: presentations.bingo.repeat });
  const setupActive = sharedSetupActive(line, bingo);
  // The manual lot draw plus its one-shot public handoff; any operator document or active-event change voids a pending one.
  const lotPresentation = registerLineLotPresentation(ipcMain, store, { authorize: operatorOnly, busy: presentations.busy,
    tongoPlaying: tongo.playing, publish: (signal) => publicDelivery.publishLineLot(signal, publicUrl),
    refresh: (lot) => { publicDelivery.refreshLineAward(lot.eventId); } });
  const bingoLotPresentation = registerBingoLotPresentation(ipcMain, store, { authorize: operatorOnly,
    busy: presentations.busy, tongoPlaying: tongo.playing, publish: (signal) => publicDelivery.publishBingoLot(signal, publicUrl),
    refresh: (lot) => { publicDelivery.refreshBingoAward(lot.eventId); } });
  operator.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) { lotPresentation.invalidate(); bingoLotPresentation.invalidate(); }
  });
  operator.on('close', () => { lotPresentation.invalidate(); bingoLotPresentation.invalidate(); });
  operator.webContents.once('destroyed', () => { lotPresentation.invalidate(); bingoLotPresentation.invalidate(); });
  registerEventCatalogIpc(ipcMain, store, operatorOnly, () => { lotPresentation.invalidate(); bingoLotPresentation.invalidate(); publicDelivery.publishActive(theme.reload()); },
    publicDelivery.publishMeta, setupActive, presentations.busy);
  registerPrizeIpc(ipcMain, store, operatorOnly, publicDelivery.publishPrizes, setupActive);
  registerEventIpc(ipcMain, store, { drawManual, drawDigital }, Math.random,
    operator.webContents, operatorFrame, operatorUrl, publicDelivery.publishCommitted, tongo.playing, setupActive,
    presentations.busy);
  // A start receipt counts only from the exact public main frame its signal was sent to, still current at the page URL,
  // and only on its own kind's channel.
  ipcMain.on(PUBLIC_LINE_RECEIPT_CHANNEL, (event, id: unknown) => { presentations.lineReceipt(event, id); });
  ipcMain.on(PUBLIC_BINGO_RECEIPT_CHANNEL, (event, id: unknown) => { presentations.bingoReceipt(event, id); });
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
      // Main-frame navigation start (reload included) detaches delivery and voids a pending receipt; subframe and
      // same-document navigations leave the document alone. The finished load re-attaches static state only.
      contents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument)
          publicDelivery.navigationStarted(contents);
      });
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
