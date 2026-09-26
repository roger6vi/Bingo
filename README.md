# Bingo

An offline 90-ball bingo application for community events, with a private operator view and a separate public display. Development starts on macOS with one Electron + TypeScript codebase; Windows support is planned for later.

## Current status

This repository contains a **desktop feasibility prototype, not a playable bingo game**. It opens operator and public windows, can play a bundled local video, and persists one current 90-ball event in a SQLite database under Electron's user-data directory (`current-event.sqlite`). Startup loads that event or explicitly creates it when absent. Invalid or unreadable data causes a visible startup error, not a reset. The operator window displays and reloads the persisted current event, its ordered called numbers, and the remaining count. It supports manual draws (integer 1–90) and digital draws; the visible history changes only after a successful persisted acknowledgement. Failed requests retain the last acknowledged history, warn that it may be stale, and offer reload. The public window shows the persisted ordered calls and latest draw read-only, receiving post-commit updates through a fixed receive-only sandbox preload. Opening or reopening it loads the current persisted event. Tickets, claims, prizes, and themes are not implemented.

## Run the prototype

Requires Node.js 24 and npm on macOS. From the repository root:

```sh
npm ci
npm test
npm start
```

`npm start` builds the TypeScript main process and preloads as CommonJS in `dist/`, bundles both Lit/Vite renderer pages and local assets into `dist/renderer/`, then opens the operator window. Draw manually with a number from 1 to 90 or draw digitally; use **Reload event** to fetch the persisted event after an error. Use **Open / reopen public window** to show the read-only public event display. Closing and reopening loads persisted history again. On a Mac with a second screen it opens fullscreen there; with one screen it opens as a preview. A separate feasibility/media section contains a one-second sample video with manual playback controls; it is not event state. `npm run build` produces both outputs without launching Electron; `npm run test:build` validates the generated pages, offline resources, and sibling preloads after a build. `npm test` runs source tests without requiring `dist/`. An isolated Electron 41/macOS smoke confirmed both built `file://` pages, Lit/CSP loading, local MP4 readiness, manual and digital updates, public close/reopen, and app relaunch recovery; packaged builds remain unverified. Persistence uses built-in `node:sqlite` (`DatabaseSync`), which requires the bundled Electron/Node runtime to support this experimental API; host Node tests alone do not validate Electron startup or quit/reopen recovery.

## Next work

The first production steps are tracked as GitHub issues:

1. [Testable 90-ball event core](https://github.com/roger6vi/Bingo/issues/1)
2. [SQLite event persistence and recovery](https://github.com/roger6vi/Bingo/issues/2)
3. [Operator controls and validated IPC](https://github.com/roger6vi/Bingo/issues/3)
4. [Read-only public draw display](https://github.com/roger6vi/Bingo/issues/4)

Electron 41/macOS checks confirmed the public display, video with audio, secondary-display fallback/reselection, and isolated operator error/reload behavior. An isolated integrated two-window smoke confirmed manual and digital draws, exact ordered public updates, public close/reopen, and app quit/reopen recovery from SQLite. Physical display disconnect/reconnect was not repeated for this public-event candidate. Ticket claims, prizes, themes, Windows runtime, and packaged-app behavior remain outside this prototype; host Node tests alone do not verify these behaviors.
