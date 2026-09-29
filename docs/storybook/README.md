# Storybook

Storybook (`@storybook/web-components-vite` 10) shows every shared Lit component in every state and every
registered theme, plus the operator and public screens, without launching Electron. It is a development tool:
nothing under `src/` imports it, it builds to `storybook-static/` (ignored, never `dist/`), and the renderer
bundle, its CSP and the Electron build are unchanged.

```sh
npm run storybook          # dev server on http://localhost:6006 (no browser auto-open, no update check, no telemetry)
npm run storybook:build    # static site in storybook-static/
npm run storybook:verify   # after a build: coverage, axe, console errors and offline check in headless Chromium
```

Both scripts run `build:tokens` first, because the theme CSS is generated. Everything works offline from local
dependencies; `storybook:verify` fails if any request leaves the local server.

## Layout

| Path | Purpose |
| --- | --- |
| `.storybook/main.mjs` | Framework, addons (docs, a11y, pseudo-states), own Vite config, theme list from the token pipeline |
| `.storybook/preview.mjs` | Global CSS (`src/screen.css` + every `src/generated/*.css`), theme toolbar, viewports, sorting |
| `.storybook/manager.mjs` | Manager chrome coloured from `tokens/reference.json`, compact sidebar and panel |
| `.storybook/lib/` | `themes.mjs` (toolbar + side-by-side decorator), `kit.mjs` (state matrix, `forceState`), `fixtures.mjs` (deterministic data), `screens.mjs` (page mounting) |
| `.storybook/verify.mjs` | Headless verification used by `storybook:verify` |
| `src/components/*.stories.mjs` | One story file per registered component, next to it (shared bases such as `bingo-field.mjs` are covered by the fields built on them) |
| `src/bingo-shell.stories.mjs` | The public window's page frame |
| `src/stories/foundations/` | Token swatches and tables, all themes side by side |
| `src/stories/screens/` | Operator (Eventos, Configuración, Bingo) on the full-viewport three-tab shell, and the public display, from the real HTML |

## Themes and viewports

The **Theme** toolbar lists `sourcePaths.themes` from `scripts/token-contract.mjs`, the same list
`build:tokens` generates, and sets `<html data-theme>` like the app. Labels come from `THEME_LABELS`
(`src/theme-controller.mjs`) and fall back to the title-cased id, so a theme appears as soon as the token pipeline
registers it. Today that is Jules (default), Light and High contrast. **All themes, side by side** renders a component story once per theme.

Viewports: *Operator laptop 1280×720*, *Operator laptop 1366×768*, *Public reference 1920×1080*.

## Writing stories

- Per component: stories for each meaningful state (normal, hover/focus, disabled, pending, error, stale, empty,
  populated) plus an **All states** matrix via `stateMatrix()`. Force `:hover` / `:focus-visible` inside shadow DOM
  with `forceState('hover', …)` (several states in one story) or `parameters.pseudo` (whole story).
- Screens mount `src/operator.html` / `src/public.html` markup and set component properties the way
  `operator-ui.mjs`, `settings-ui.mjs` and `public-ui.mjs` render them, with the same Spanish copy
  (`operator-copy.mjs`). The workspace tabs are live, including the unsaved-changes guard on Configuración. Layout changes to the pages show up automatically; new or
  renamed ids need the setters in `.storybook/lib/screens.mjs` updated.
- The Configuración simulator frames the matching `Screens/Public display` story at the draft theme, scaled from
  1920×1080 like the app.

## Relation to the component gallery

`npm run gallery` (#88) stays as it is: a single static page, rendered by the Vite dev server with the app's CSP, that
`test:components` checks. Storybook is the interactive workbench on top: controls, per-state stories, docs, a11y
panel and the screens. Both are development-only and neither is part of `npm run build` or the packages.

## CI follow-up (not done here)

`.github/workflows/ci.yml` is unchanged by this work. To gate Storybook in CI, add after
`npm run test:components` (Chromium and its system dependencies are already installed by then):

```yaml
    - name: Build Storybook
      run: npm run storybook:build
    - name: Verify Storybook
      run: npm run storybook:verify
```

`tests/ci-workflow.test.ts` pins the current step list and would need the same two commands.

## Screenshots

`screenshots/` holds reference captures of the Storybook UI in Chromium at the two reference browser sizes
(1280×720 and 1920×1080). `npm run storybook:verify -- --screenshots <dir>` captures every story in every theme.
