# Bingo

An offline 90-ball bingo application for community events, with a private operator view and a separate public display. Development starts on macOS with one Electron + TypeScript codebase; Windows support is planned for later.

## Current status

This repository contains a **desktop feasibility prototype, not a playable bingo game**. It opens operator and public windows, can play a bundled local video, and persists one current 90-ball event in a SQLite database under Electron's user-data directory (`current-event.sqlite`). Startup loads that event or explicitly creates it when absent. Invalid or unreadable data causes a visible startup error, not a reset. The operator window displays and reloads the persisted current event, its ordered called numbers, and the remaining count. It supports manual draws (integer 1–90) and digital draws; the visible history changes only after a successful persisted acknowledgement. Failed requests retain the last acknowledged history, warn that it may be stale, and offer reload. The public window shows the persisted ordered calls and latest draw read-only, receiving post-commit updates through a fixed receive-only sandbox preload. Opening or reopening it loads the current persisted event. Tickets, claims, and prizes are not implemented. Two generated visual shells are registered: pixel-classic (default) and high-contrast. The operator's **Display theme** selector saves one allow-listed theme id alongside the current event in `current-event.sqlite` (schema v3 adds a `theme` column with a migration from earlier versions); both windows switch only after that save commits, a failed save keeps the last committed theme, and the public window receives the theme read-only on open and on every change. Pages stay hidden until a theme is applied. If the committed theme has not reached the public window within two seconds, it reveals the default pixel-classic theme and switches as soon as the committed theme arrives. An unreadable theme value falls back to pixel-classic without being overwritten. The storage layer keeps multiple events and one active event pointer (`events`, `active_event` tables, schema v4); creating, listing, and selecting events is implemented at the storage level only, with no UI yet.

## Run the prototype

Requires Node.js 24 and npm on macOS. From the repository root:

```sh
npm ci
npm test
npm start
```

`npm start` builds the TypeScript main process and preloads as CommonJS in `dist/`, bundles both Lit/Vite renderer pages and local assets into `dist/renderer/`, then opens the operator window. Draw manually with a number from 1 to 90 or draw digitally; use **Reload event** to fetch the persisted event after an error. Use **Open / reopen public window** to show the read-only public event display. Closing and reopening loads persisted history again. On a Mac with a second screen it opens fullscreen there; with one screen it opens as a preview. A separate feasibility/media section contains a one-second sample video with manual playback controls; it is not event state. `npm run build` generates the two Style Dictionary/DTCG theme stylesheets in ignored `src/generated/` before Vite bundles both pages; it does not require committed generated CSS. `npm run build:tokens` regenerates just the tokens and `npm run test:tokens` checks the reference/semantic contracts. `npm run test:build` validates the generated pages, offline resources, themes, and sibling preloads after a build. `npm test` runs source tests without requiring `dist/`. An isolated Electron 41/macOS smoke confirmed both built `file://` pages, Lit/CSP loading, local MP4 readiness, manual and digital updates, public close/reopen, and app relaunch recovery; packaged builds remain unverified. Persistence uses built-in `node:sqlite` (`DatabaseSync`), which requires the bundled Electron/Node runtime to support this experimental API; host Node tests alone do not validate Electron startup or quit/reopen recovery.

## Continuous integration

GitHub Actions runs one Ubuntu job on pull requests targeting `main` and pushes to `main`. It uses Node.js 24, `npm ci`, and these checks in order:

```sh
npm test
npm run test:tokens
npm run build
npm run test:build
npm run test:components
```

The runner installs Chromium's Linux system dependencies with `npx playwright install-deps chromium`; `npm run test:components` installs Chromium itself before running Web Test Runner. The single job keeps token-generated CSS and build artifacts sequential. To reproduce the checks locally, use Node.js 24, run `npm ci`, provision Playwright's Chromium system dependencies on Linux, then run the commands above in order. CI tests source, token contracts, built artifacts, and browser components; it does not launch Electron, package the application, or validate macOS or Windows runtime/packaging. Hosted CI results require a published branch or PR; required-check branch protection is not configured here.

## Next work

The first production steps are tracked as GitHub issues:

1. [Testable 90-ball event core](https://github.com/roger6vi/Bingo/issues/1)
2. [SQLite event persistence and recovery](https://github.com/roger6vi/Bingo/issues/2)
3. [Operator controls and validated IPC](https://github.com/roger6vi/Bingo/issues/3)
4. [Read-only public draw display](https://github.com/roger6vi/Bingo/issues/4)

Electron 41/macOS checks confirmed the public display, video with audio, secondary-display fallback/reselection, and isolated operator error/reload behavior. An isolated integrated two-window smoke confirmed manual and digital draws, exact ordered public updates, public close/reopen, and app quit/reopen recovery from SQLite. A separate isolated smoke verified both generated theme shells on the built operator and public `file://` pages, including computed high-contrast colors and reduced-motion behavior. Physical display disconnect/reconnect was not repeated for this public-event candidate. An isolated Electron smoke under Xvfb confirmed theme selection syncing to the open public window, rejection of invalid theme values over IPC, a locked-database write failure keeping the committed theme, public close/reopen, and app relaunch recovery of high-contrast in both windows. Ticket claims, prizes, Windows runtime, and packaged-app behavior remain outside this prototype.
