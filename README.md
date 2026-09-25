# Desktop feasibility harness

A minimal macOS-first Electron + TypeScript harness for checking public-display placement, local media linkage, and sample-state recovery. The same screen API and coordinate-based window plan are intended to work on Windows, but Windows has not been tested. This is not the bingo product.

## Local commands

Requires Node 24 (tested with Node 24.11.0) and npm. Install dependencies with `npm ci` before launching Electron. The prototype was built and exercised on macOS; Windows and packaged-app execution have not been tested.

```sh
npm test
npm run build
npm start
```

`npm test` uses Node's built-in runner and built-in TypeScript stripping; it needs no dependency install. `npm start` compiles TypeScript to `dist/` and launches Electron using the two HTML pages in `src/`. Run from the project root. Do not move only `dist/` without the HTML pages.

The app starts with only the operator window, clamped to the primary work area. Use **Open / reopen public window** to show public output: fullscreen on the first secondary display, or a windowed primary work-area preview when alone. Closing public leaves operator running; open it again with the same button. On secondary disconnect, the existing public window is moved to primary preview and the operator shows a pause reminder (no game engine or automatic pause exists). Reconnecting does not move it back: use **Move public window to secondary display**. That button does nothing if public is closed or no secondary exists.

The operator window shows a **Recovered sample count** from `sample-state.json` in Electron's `app.getPath('userData')`. Click **Increment sample count**, quit, and reopen to check recovery on a real machine. A missing or invalid/unsupported JSON file displays zero; a non-missing read error or failed write is reported. Writes use a same-directory temporary file and rename. This tiny single-process feasibility sample is **not SQLite**, a durable transactional database, or production event storage; corrupt-file recovery discards the invalid count on the next increment. Node tests use an in-memory filesystem for missing/corrupt files and write failures, plus a real temporary directory and a fresh Node process for sample-count recovery. The user also observed count 2 after quitting Electron with ⌘Q and reopening it on macOS. None of this validates SQLite, crash durability, or recovery of a production bingo event.

The public window contains a self-generated, one-second H.264/AAC MP4 at `assets/sample.mp4`, referenced as `../assets/sample.mp4` from `src/public.html`. Use its explicit player controls; it does not autoplay. The resource test verifies the local path and markup; the user additionally observed video and audio playback in the Electron public window on macOS. No downloaded or licensed media is included.

## Feasibility results and limits

Final independent checks passed: `npm test` (19/19), `npm run build`, and `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 assets/sample.mp4` (`duration=1.000000`). The user observed the operator and public windows, video and audio playback, and sample count 2 restored after quitting and reopening Electron on macOS. With a secondary monitor connected, the user saw the public window fullscreen there; disconnecting moved that window to a primary-display preview while the operator stayed open. After reconnecting, the preview remained on the primary display until the operator explicitly returned it to fullscreen on the secondary.

These are tests of this source-tree prototype, not of a packaged application. The sample counter is not a bingo game or production persistence; ticket/claim/prize rules, SQLite event recovery, Windows runtime, and packaging remain unimplemented or untested. The first proposed production work units are listed in `planning/initial-issues.md`. Detailed internal feasibility notes remain in the separate private archive and are not part of this public snapshot.
