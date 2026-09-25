# Bingo

An offline 90-ball bingo application for community events, with a private operator view and a separate public display. Development starts on macOS with one Electron + TypeScript codebase; Windows support is planned for later.

## Current status

This repository contains a **desktop feasibility prototype, not a playable bingo game**. It opens operator and public windows, can play a bundled local video, and persists one current 90-ball event in a SQLite database under Electron's user-data directory (`current-event.sqlite`). Startup loads that event or explicitly creates it when absent. Invalid or unreadable data causes a visible startup error, not a reset. The event core and store support ordered draw history, but operator draw controls, tickets, prizes, and themes are not implemented yet.

## Run the prototype

Requires Node.js 24 and npm on macOS. From the repository root:

```sh
npm ci
npm test
npm start
```

`npm start` builds the TypeScript code and opens the operator window. Use **Open / reopen public window** to show the public display. On a Mac with a second screen it opens fullscreen there; with one screen it opens as a preview. The public view contains a one-second sample video with manual playback controls. `npm run build` checks the TypeScript build without launching Electron. Persistence uses built-in `node:sqlite` (`DatabaseSync`), which requires the bundled Electron/Node runtime to support this experimental API; host Node tests alone do not validate Electron startup or quit/reopen recovery.

## Next work

The first production steps are tracked as GitHub issues:

1. [Testable 90-ball event core](https://github.com/roger6vi/Bingo/issues/1)
2. [SQLite event persistence and recovery](https://github.com/roger6vi/Bingo/issues/2)
3. [Operator controls and validated IPC](https://github.com/roger6vi/Bingo/issues/3)
4. [Read-only public draw display](https://github.com/roger6vi/Bingo/issues/4)

Earlier Electron 41/macOS feasibility checks confirmed the public display, video with audio, and secondary-display fallback/reselection. SQLite-backed Electron quit/reopen recovery still needs a separate interactive smoke check. These are prototype checks, not a production bingo validation; Windows runtime and packaged-app behavior remain untested.
