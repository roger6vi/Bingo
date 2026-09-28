# Windows packaging and validation (#41)

Windows builds are unsigned, per-user NSIS installers for x64, produced and exercised on a GitHub
Actions `windows-latest` runner by [`windows-package.yml`](../.github/workflows/windows-package.yml).
That workflow is separate from `ci.yml` (Ubuntu checks, #72). The packaging config lives in
[`electron-builder.win.yml`](../electron-builder.win.yml), separate from macOS packaging (#40); shared
keys can move into a common base with `extends` once both exist.

## Build locally (on Windows)

```sh
npm ci
npm run package:win   # → release/windows/Bingo-Setup-<version>-x64.exe
```

The package contains only `dist/` (TypeScript main/preloads and the Vite-bundled renderers, generated
themes and sample MP4) plus `package.json`, in `app.asar`. No `node_modules` are shipped: Lit is
bundled by Vite and SQLite is Electron's built-in `node:sqlite`, so there is nothing native to rebuild.

## What the workflow verifies

Each run installs and drives the real packaged app, always with a temporary `--user-data-dir` under
`RUNNER_TEMP` that is deleted afterwards (the real `%APPDATA%` profile is never used):

1. `npm test`, `npm run build` and `npm run test:build` pass on Windows.
2. Installers for `0.1.0` and `0.1.1` are built from the same commit.
3. `0.1.0` is installed silently (`/S`); the uninstall registry entry reports that version.
   [`packaged-smoke.mjs`](../verification/packaged-smoke.mjs) `seed` then checks that:
   - the operator page loads from `resources\app.asar` and the database is created in the profile;
   - a committed digital draw reaches the sandboxed public window, whose only globals are the three
     receive-only `subscribe` bridges (no `desktop`, no `require`);
   - with the runner's single display the public window opens as a windowed primary preview;
   - the bundled MP4 loads metadata and decodes (duration and video width are non-zero);
   - the Configuración simulator loads over the `bingo-public:` protocol from inside the package, and
     saving name, place and the high-contrast theme reaches the public window;
   - after quit and relaunch the event, one-call history and theme are restored.
4. `0.1.1` is installed over it; exactly one entry remains and it reports `0.1.1`. `upgraded` checks
   the same profile still holds the saved event, history and theme; emulating
   `prefers-reduced-motion: reduce` removes the packaged button transition; and a profile whose
   `current-event.sqlite` is unreadable keeps the process on its modal startup error and leaves the
   file byte-for-byte unchanged (no reset).
5. The silent uninstaller removes the app and registry entry but not `current-event.sqlite`.
6. Both unsigned installers are uploaded as the `bingo-windows-unsigned` artifact (7 days).

`packaged-smoke.mjs` can also be run against any unpacked build with no profile argument; it then
creates, uses and deletes its own temporary profile. The same config built as a Linux `dir` target
passed all smoke steps under Xvfb.

## Platform differences

| Topic | Windows | Evidence |
| --- | --- | --- |
| Install location | Per-user `%LOCALAPPDATA%\Programs\Bingo\Bingo.exe`; no elevation | Registry `InstallLocation` read by `scripts/windows-installed.ps1` |
| Event data | `%APPDATA%\bingo-desktop-feasibility\current-event.sqlite` (from `name`; no `productName` is packaged) | Packaged `package.json`; Electron's `userData` default |
| Upgrade / uninstall | In-place NSIS upgrade; data kept on upgrade and uninstall (`deleteAppDataOnUninstall: false`) | Workflow steps 4–5 |
| Startup failure | `dialog.showErrorBox` is modal; the process stays alive until dismissed | `upgraded` asserts the process is still running after 5 s |
| Signing | Unsigned: SmartScreen shows "Windows protected your PC" until a code-signing certificate is added (`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`) | No signing secrets are configured |
| Icon | Default Electron icon (no `build/icon.ico`) | Config has no icon |

## Not verified

- Secondary-display fullscreen, move-to-secondary and display disconnect: runners have one display.
  Placement logic is covered by `window-plan`/`window-lifecycle` unit tests only.
- Audible output: the runner has no audio device; only decoding is checked.
- Screen-reader behavior and the visible text of the startup error box.
- Archived-event history: events are listed and selected at the storage level only, with no UI yet.
- ARM64 and per-machine installs.
