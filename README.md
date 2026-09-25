# Bingo

An offline 90-ball bingo application for community events, with a private operator view and a separate public display. Development starts on macOS with one Electron + TypeScript codebase; Windows support is planned for later.

## Current status

This repository contains a **desktop feasibility prototype, not a playable bingo game**. It opens operator and public windows, can play a bundled local video, and saves a sample counter between launches. The counter is a technical sample, not event storage; the real application will use SQLite. Draws, tickets, prizes, themes, and event recovery are not implemented yet.

## Run the prototype

Requires Node.js 24 and npm on macOS. From the repository root:

```sh
npm ci
npm test
npm start
```

`npm start` builds the TypeScript code and opens the operator window. Use **Open / reopen public window** to show the public display. On a Mac with a second screen it opens fullscreen there; with one screen it opens as a preview. The public view contains a one-second sample video with manual playback controls. `npm run build` checks the TypeScript build without launching Electron.

## Next work

The first production steps are tracked as GitHub issues:

1. [Testable 90-ball event core](https://github.com/roger6vi/Bingo/issues/1)
2. [SQLite event persistence and recovery](https://github.com/roger6vi/Bingo/issues/2)
3. [Operator controls and validated IPC](https://github.com/roger6vi/Bingo/issues/3)
4. [Read-only public draw display](https://github.com/roger6vi/Bingo/issues/4)

With Electron 41 on macOS, the operator visually confirmed the public display, video with audio, sample count 5 restored after restarting, and the fullscreen secondary display falling back to the primary on disconnect, staying there after reconnect, then returning to secondary only on operator command. Automated tests (19/19), build, and dependency audit also passed. These are prototype checks, not a production bingo validation; Windows runtime and packaged-app behavior remain untested.
