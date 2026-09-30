# macOS packaging (#40)

Bingo is packaged with [electron-builder](https://www.electron.build/) from `electron-builder.json`,
the default config used for macOS and Linux. Windows packaging (#41) keeps its own
[`electron-builder.win.yml`](../electron-builder.win.yml); see
[docs/windows-packaging.md](windows-packaging.md). The package contains only `package.json` and the
built `dist/` tree inside `app.asar`: the CommonJS main process, both preloads, the two Vite renderer
pages with their bundled Lit code, and the Style Dictionary theme CSS generated during `npm run build`. The jules theme's Roboto Mono Variable font is bundled from
`@fontsource-variable/roboto-mono` (OFL-1.1) as local `.woff2` files inside `dist/renderer/`; the light
and high-contrast themes use system font stacks and ship no font files. SQLite is Electron's built-in
`node:sqlite`, so there is no native module to rebuild or unpack (`npmRebuild: false`). Source files,
source maps, and `node_modules` are excluded.

## Build

Requires macOS, Node.js 24 and npm. From the repository root:

```sh
npm ci
npm run package:mac          # unsigned (ad-hoc signed), dmg + zip for arm64 and x64
npm run test:build           # built renderer checks
npm run test:package         # packaged-app smoke, temporary --user-data-dir
```

Output goes to the ignored `release/` directory, for example `release/Bingo-0.1.0-arm64.dmg` and
`release/mac-arm64/Bingo.app`. Every package script runs `npm run build` first, so the package never
contains stale renderer output.

The **macOS package** workflow (`.github/workflows/macos-package.yml`) runs these steps on a
GitHub-hosted Apple silicon runner (`macos-15`) for every pull request, pushes to `main`, and manual
dispatch. It verifies the ad-hoc signature, runs the packaged-app smoke, and uploads the dmg and zip
files as the `bingo-macos-unsigned-<sha>` artifact for 14 days. It uses no secrets. The x64 build is
packaged but only the arm64 app is smoke-tested.

On Linux, `npm run package:dir` produces `release/linux-unpacked/bingo`. `xvfb-run -a npm run
test:package` runs the same packaged smoke against it (resolved by default from `BINGO_PACKAGED_APP` or
the platform's `release/` output path), which checks the asar layout and runtime behaviour but not
macOS specifics.

## Packaged smoke

`verification/packaged-smoke.mjs` launches the packaged executable, never `electron .`, with a fresh
temporary `--user-data-dir` that it deletes afterwards. Pass an explicit executable path as the first
argument, or set `BINGO_PACKAGED_APP`; with neither, it resolves the default `release/` output path for
the current platform (`mac-arm64`/`mac` on macOS, `linux-unpacked` on Linux). With no profile argument
it creates its own temporary profile and runs both phases back to back. It verifies:

- the renderer loads from `app.asar` with an isolated profile and `current-event.sqlite` is created in
  the temporary profile on first run;
- a committed digital draw reaching the sandboxed, receive-only public window, whose only globals are
  the five receive-only `subscribe` bridges (`publicEvent`, `publicTheme`, `publicEventMeta`,
  `publicEventPrizes`, `publicPresentation`; no `desktop`, no `require`);
- with a single display the public window opens as a windowed primary preview; with a second display
  it asserts the public window is fullscreen with bounds equal to the first non-primary display;
- the public presentation shows 90 board cells, the latest call, two prize rows, and no video;
- the Configuración simulator loads over the `bingo-public:` protocol from inside the asar, and saving
  name, place and the high-contrast theme reaches the public window;
- after quit and relaunch, the event, its history and the theme are restored;
- emulating `prefers-reduced-motion: reduce` removes the packaged button transition;
- a profile whose `current-event.sqlite` is unreadable keeps the startup error on screen and leaves the
  file byte-for-byte unchanged (no reset).

## Manual release check on a Mac

Automated checks cannot cover Gatekeeper, a physical second display, or assistive technology. Before a
release, on a Mac with two displays, use a temporary profile so real event data is never touched:

```sh
profile=$(mktemp -d)
open -n /Applications/Bingo.app --args --user-data-dir="$profile"
```

1. Install from the dmg by dragging Bingo to Applications. Open it: signed and notarized builds open
   directly. Unsigned builds are blocked by Gatekeeper; allow them in **System Settings → Privacy &
   Security → Open Anyway**.
2. Draw numbers, open the public window, and confirm it goes fullscreen on the second display.
   Disconnect and reconnect that display and confirm the pause warning and **Move public window to
   secondary display**.
3. Switch themes, turn on **Reduce motion** and VoiceOver, and check
   both windows.
4. Quit with ⌘Q, reopen with the same profile, and confirm the active event, archived events, and theme
   are restored.
5. Delete the temporary profile with `rm -rf "$profile"`.

Record the macOS version, architecture, and results in the pull request.

## User data and upgrades

The packaged app stores its data in `~/Library/Application Support/Bingo/current-event.sqlite`. The
directory name comes from `extraMetadata.productName` and must never change, or upgraded installs will
not find their events. Installing a newer version over an older one keeps this file. On open, older
schema versions are migrated in a transaction, and data that is unreadable or from a newer schema stops
startup with an error dialog. The data is never reset. Downgrading to a version that does not know the
schema therefore fails safely rather than losing events.

Development runs (`npm start`) use the package name,
`~/Library/Application Support/bingo-desktop-feasibility/`, and the packaged app does not import from
it. To carry prototype data over, quit both apps and copy `current-event.sqlite` into the `Bingo`
directory.

## Signing and notarization

Cloud sessions and the unsigned workflow hold no Apple credentials. A maintainer with an Apple Developer
Program membership signs and notarizes with `npm run package:mac:signed`. It sets `forceCodeSigning`, so
a missing identity fails the build instead of producing an unsigned app. The hardened runtime is
enabled. electron-builder's default entitlements apply: `allow-jit`, `allow-unsigned-executable-memory`,
and `disable-library-validation`.

Required secrets, stored as GitHub Actions secrets or local environment variables:

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded `.p12` export of the **Developer ID Application** certificate and private key |
| `CSC_KEY_PASSWORD` | Password of that `.p12` |
| `APPLE_API_KEY` | Path to the App Store Connect API key file (`AuthKey_<id>.p8`). In CI, store the file contents as a secret and write them to a temporary file |
| `APPLE_API_KEY_ID` | The API key's ID |
| `APPLE_API_ISSUER` | The issuer ID from App Store Connect → Users and Access → Integrations |

With `mac.notarize: true`, electron-builder notarizes and staples the `.app` (the dmg and zip wrap the
stapled app) whenever the three `APPLE_API_*` variables are present. As an alternative to an API key,
you can set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Verify a signed build with:

```sh
codesign --verify --deep --strict --verbose=2 release/mac-arm64/Bingo.app
spctl --assess --type execute --verbose release/mac-arm64/Bingo.app   # "source=Notarized Developer ID"
xcrun stapler validate release/mac-arm64/Bingo.app
```

A signed release workflow is intentionally not committed. Add it only as a separate, manually dispatched
workflow once the secrets exist. Electron fuses are not yet configured, because the packaged smoke
drives the app through Node's inspector.
