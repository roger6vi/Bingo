# Bingo design system

Bingo's operator and public windows are built from one set of Lit components styled only through
semantic CSS custom properties. Themes change token values, never components. This document is the
contract future UI work follows: token architecture, naming rules, the three themes, the contrast
contract, and a catalog of every component (implemented or specified).

Stored theme ids are persisted per event. The retired `pixel-classic` id is migrated to `jules` by a
self-contained event-schema migration (`migrateThemeAllowList` in `src/event-store.ts`); unknown
stored values still fail closed.

## Token architecture

There are exactly **two token layers**. There are no component tokens.

| Layer | Source | Emitted as | Who may read it |
| --- | --- | --- | --- |
| Reference (primitive) | `tokens/reference.json` | `--bingo-reference-*` (default theme file only) | Semantic tokens only |
| Semantic | `tokens/semantic/<theme>.json` | `--bingo-*` under `[data-theme="<id>"]` | Components and `src/screen.css` |

- Sources are [DTCG](https://www.designtokens.org/) JSON (`$type`, `$value`, optional `$description`).
  Style Dictionary (`npm run build:tokens`) writes one stylesheet per theme to the ignored
  `src/generated/` directory. The default theme's file also carries every reference variable and the
  `:root` fallback; other theme files only rebind semantic variables.
- Reference values are raw (`#09051c`, `0.25rem`, `[0.2, 0, 0, 1]`). Semantic values are always a
  single alias to a reference token of the same `$type` (`{color.indigo-950}`).
- Every theme defines the **same semantic keys with the same types**. A theme differs only in which
  reference tokens it aliases.
- `rendering.*` uses `$type: "string"` for the CSS `image-rendering` keyword; DTCG has no type for it.

### Reference scales

| Group | Tokens |
| --- | --- |
| `color` | Ramps `neutral-0…1000`, `indigo-950/900`, `violet-900…300` (plus `-translucent` variants), `lavender-200/100`, `pink`, `yellow`, `cyan`, `blue`, `red`, `green`, `orange` |
| `space` | `none`, `xxs` 0.125rem, `xs` 0.25rem, `sm` 0.35rem, `md` 0.7rem, `base` 1rem, `lg` 1.5rem, `xl` 2rem, `xxl` 3rem, `xxxl` 4rem |
| `size` | `content` 70rem |
| `font` | Families `family-system`, `family-mono` (bundled Roboto Mono Variable); sizes `size-sm…xl`, `size-display`; weights `weight-regular/medium/bold`; line heights `line-tight/normal`; letter spacing `tracking-normal/wide/wider` |
| `radius` | `none` 0, `sm` 0.25rem, `md` 0.5rem |
| `border-width` | `thin` 1px, `thick` 2px, `heavy` 4px |
| `elevation` | Hard pixel-shadow offsets `flat`, `sm`, `md` |
| `motion` | Durations `instant/fast/normal/slow`; easings `ease-standard`, `ease-linear` (cubicBezier) |
| `layer` | z-index `base`, `raised`, `overlay`, `modal` |
| `opacity` | `muted` 0.65, `scrim` 0.8, `opaque` 1 |
| `rendering` | `smooth` (`auto`), `pixelated` |

### Semantic set

Variable names are `--bingo-<group>-<name>`, e.g. `color.call-latest` → `--bingo-color-call-latest`.

| Group | Keys | Purpose |
| --- | --- | --- |
| Surfaces | `color.canvas`, `surface`, `surface-raised`, `surface-sunken`, `overlay`, `shadow` | Page, panels, dialogs, inputs/wells, modal scrim (with `opacity.scrim`), hard shadows |
| Text | `color.text`, `muted`, `on-accent` | Body text, secondary text, text on accent fills |
| Borders | `color.border`, `border-strong` | Decorative separators; boundaries that must meet non-text contrast |
| Accent & interaction | `color.accent`, `accent-hover`, `accent-active`, `disabled`, `disabled-surface`, `focus` | Primary emphasis, hover/pressed fills, disabled treatment, focus ring |
| Status | `color.info`, `success`, `warning`, `error` | Foregrounds on `surface` or `canvas` |
| Board number states | `color.call-uncalled(-surface)`, `call-called(-surface)`, `call-latest(-surface)` | Foreground/background pairs for each number state |
| Celebration & prizes | `color.celebration`, `on-celebration`, `prize` | Celebration fill and its text; prize accent on `surface` |
| Tie draw | `color.tie-1` red, `tie-2` blue, `tie-3` yellow, `tie-4` violet, `tie-5` green, `tie-6` orange, `tie-7` cyan, `tie-8` pink; `on-tie` | Fixed order; labels on any tie colour use `on-tie` |
| Space | `space.layout`, `section`, `inset-compact`, `inset-inline`, `small`, `list-indent`, `wide` | Page padding, section rhythm, control insets, list indent, content max width |
| Type | `font.body`, `size`, `size-small`, `size-large`, `display`, `line`, `tight`, `regular`, `emphasis`, `tracking` | Family, sizes, line heights, weights, uppercase-label letter spacing |
| Shape | `radius.surface`, `radius.control`, `border-width.default`, `strong`, `focus`, `elevation.raised` | Corners, stroke widths, pixel-shadow offset |
| Motion | `motion.fast`, `normal`, `slow`, `easing` | Always disabled under `prefers-reduced-motion: reduce` |
| Layers | `layer.raised`, `overlay`, `modal`; `opacity.disabled`, `scrim` | Stacking and translucency |
| Imagery | `rendering.image` | `image-rendering` for pixel-art media |

## Naming rules

1. Semantic names describe **role**, never a component: `color.call-latest`, not `color.board-latest`.
   The contract rejects whole hyphen segments `button`, `panel`, `dialog`, `status`, `number`, `icon`,
   `shell`, `board`, `controls`, `checking-state`, `prize-banner`, `event-summary` and `component`.
2. Foreground/background pairs share a stem: `call-called` on `call-called-surface`, `on-accent` on
   `accent`, `on-celebration` on `celebration`.
3. Reference names describe **value**: hue plus a lightness step (`violet-600`), a t-shirt size
   (`space.lg`), or a keyword (`rendering.pixelated`). Every path segment starts with a letter.
4. Components and `screen.css` read only `--bingo-*` semantic variables. They never read
   `--bingo-reference-*`, never redefine `--bingo-color-*`, and never write literal colours
   (hex, `rgb()`, named colours, `currentColor`, gradients, colour filters).
5. Adding a semantic key means adding it to **every** theme in the same change.

## Themes

Exactly three themes are registered. Components are identical across them.

| Id | Intent | Character |
| --- | --- | --- |
| `jules` (default) | Evening events and projection with brand character | Original work inspired by the visual language of jules.google: near-black indigo canvas `#09051c`, deep violet surfaces `#1d0245`, lavender accent `#d0b9ff`, translucent violets `#642cc2`/`#7f4cd6`, highlights in pink `#ff79c6`, yellow `#ffd236` and cyan `#00d2ef`; Roboto Mono Variable throughout; square corners; `image-rendering: pixelated`. No copied assets or logos. |
| `light` | Bright rooms and daytime projection | Near-white canvas, white surfaces, navy text, blue accent, system UI font, soft radii. |
| `high-contrast` | Accessibility and difficult projectors | Black canvas and surfaces, white text, yellow accent, cyan focus; AAA text contrast; square corners. |

Fonts are bundled locally (`@fontsource-variable/roboto-mono`, OFL-1.1) and never fetched at runtime.

## Contrast contract

`npm run test:tokens` (`scripts/token-contract.mjs`) validates, for every theme:

- identical semantic keys and types, alias-only semantic values, raw reference values;
- no component tokens, no extra layers, and a pairwise difference between every two themes;
- `src/screen.css` consumes only semantic colours, with a small border/shadow grammar;
- every declared contrast pair (`contrastPairs`) meets its minimum WCAG 2.2 ratio.

| Role | Minimum | `high-contrast` | Pairs |
| --- | --- | --- | --- |
| `text` | 4.5:1 | 7:1 | text/muted on canvas and surfaces, `on-accent` on accent states, status on surface, number states, celebration, prize, `on-tie` on each tie colour |
| `ui` | 3:1 | 4.5:1 | focus and `border-strong` on canvas/surface, accent on surface, `call-called-surface` against `call-uncalled-surface` |

Translucent backgrounds are composited over `color.canvas`, translucent foregrounds over their
background. Disabled controls are exempt from WCAG contrast; they additionally use `opacity.disabled`.

## Component catalog

Every component is a Lit element in `src/components/`, uses shadow DOM styles built only from the
semantic variables listed, honours `prefers-reduced-motion`, and keeps state changes driven by
committed persistence snapshots (presentation never acknowledges its own intent).

### `bingo-shell`
- **Purpose:** public page frame that constrains content width. **Anatomy:** a default slot.
- **Properties:** none. **States:** normal.
- **Accessibility:** no role; landmarks live in the page.
- **Tokens:** consumed through `screen.css`: `space.wide`, `space.layout`, `space.list-indent`.

### `bingo-app-shell`
- **Purpose:** full-viewport operator frame; the document never scrolls. **Anatomy:** header (brand, tabs, active event), content row, optional status bar slots.
- **Properties:** none (`hasStatus` is internal). **States:** normal, with/without status bar.
- **Accessibility:** regions come from the slotted page landmarks.
- **Tokens:** `color.canvas`, `color.text`.

### `bingo-tabs`
- **Purpose:** WAI-ARIA tablist with automatic activation; `bingo-tab-panel` hosts each panel. **Anatomy:** light-DOM `role="tab"` children naming panels via `aria-controls`.
- **Properties:** `label`; `canLeave(current, next)` may veto or defer a switch. **States:** normal, selected, focus, pending (decision open), vetoed (focus returns).
- **Accessibility:** roving tabindex, arrow/Home/End keys, `aria-selected` on tabs.
- **Tokens:** `border-width.focus`, `color.focus`.

### `bingo-panel`
- **Purpose:** titled content region. **Anatomy:** `section[aria-labelledby]` → `h2` heading → slot.
- **Properties:** `heading`, `compact`. **States:** normal, empty (heading only).
- **Accessibility:** section is named by its heading.
- **Tokens:** `border-width.default`, `border-width.strong`, `color.border`, `color.muted`, `color.shadow`, `color.surface`, `elevation.raised`, `font.body`, `font.emphasis`, `font.line`, `font.size`, `font.tracking`, `radius.surface`, `space.inset-inline`, `space.layout`, `space.section`.

### `bingo-side-rail`
- **Purpose:** labelled vertical rail beside a dominant zone. **Anatomy:** `aside` with stacked sections and a pinned `footer` slot.
- **Properties:** `label`. **States:** normal, overflowing (scrolls inside the rail).
- **Accessibility:** `aside` named by `label`.
- **Tokens:** `border-width.default`, `color.border`, `color.surface`, `radius.surface`.

### `bingo-button`
- **Purpose:** the single action control. **Anatomy:** native `button` → slot label.
- **Properties:** `disabled`, `type` (`button`/`submit`/`reset`), `variant` (`primary`), `block`. **States:** normal, hover, active, focus, disabled, pending (owner disables while a request is outstanding).
- **Accessibility:** native button semantics and keyboard activation; form-associated submit/reset; visible focus ring.
- **Tokens:** `border-width.default`, `border-width.focus`, `border-width.strong`, `color.accent-active`, `color.accent-hover`, `color.accent`, `color.border-strong`, `color.border`, `color.disabled-surface`, `color.disabled`, `color.focus`, `color.on-accent`, `color.shadow`, `color.surface`, `color.text`, `font.emphasis`, `motion.easing`, `motion.normal`, `opacity.disabled`, `radius.control`, `space.inset-compact`, `space.inset-inline`, `space.small`.

### `bingo-field` and `bingo-text-field` and `bingo-date-field` and `bingo-select-field`
- **Purpose:** labelled, form-associated operator fields sharing one base. **Anatomy:** label with required marker, native control in the shadow root, hint, announced error with an icon.
- **Properties:** `label`, `name`, `value`, `hint`, `error`, `required`, `disabled`, `pending`; date `min`/`max`; select mirrors light-DOM `<option>`s. **States:** normal, focus, disabled, pending (pixel busy indicator, static under reduced motion), error.
- **Accessibility:** `aria-invalid`, `aria-describedby` hint/error wiring, `aria-busy`; the error never relies on colour.
- **Tokens:** `border-width.default`, `border-width.focus`, `color.accent`, `color.border-strong`, `color.disabled-surface`, `color.disabled`, `color.error`, `color.focus`, `color.muted`, `color.surface`, `color.text`, `font.body`, `font.emphasis`, `font.line`, `font.size`, `font.tight`, `font.tracking`, `motion.normal`, `radius.control`, `space.inset-compact`, `space.inset-inline`, `space.small`.

### `bingo-form-actions`
- **Purpose:** the action row that ends a form. **Anatomy:** `status` slot, secondary actions, then the `primary` slot.
- **Properties:** `sticky`, `pending`. **States:** normal, sticky, pending.
- **Accessibility:** reading order matches visual order; the primary action comes last.
- **Tokens:** `border-width.default`, `color.border`, `color.canvas`, `font.size`, `space.inset-inline`, `space.small`.

### `bingo-number`
- **Purpose:** one called number, large or compact. **Anatomy:** a `span` chip.
- **Properties:** `value` (number or `null`), `emptyLabel`, `compact`, `latest` (set by its list). **States:** empty (label), called, latest.
- **Accessibility:** plain text; announcements belong to `bingo-latest-draw`.
- **Tokens:** `border-width.strong`, `color.accent`, `color.call-called-surface`, `color.call-called`, `color.call-latest-surface`, `color.call-latest`, `color.shadow`, `elevation.raised`, `font.body`, `font.display`, `font.emphasis`, `font.line`, `font.size`, `font.tight`, `radius.control`, `space.inset-compact`.

### `bingo-number-board`
- **Purpose:** public ordered list of committed calls. **Anatomy:** empty text and `ol` of `li > bingo-number`; the last item has `aria-current="true"`.
- **Properties:** `calledNumbers`, `loaded`. **States:** loading ("Waiting for draw"), empty, populated, latest, stale (owner keeps the last committed list).
- **Accessibility:** named list; no live region, no focusable content.
- **Tokens:** `border-width.strong`, `color.accent`, `space.inset-compact`, `space.list-indent`, `space.section`, `space.small`.

### `bingo-call-history`
- **Purpose:** operator list of committed calls; with `limit`, a compact strip of the latest calls. **Anatomy:** heading, empty text, `ol` of chips; the last has `aria-current="true"`.
- **Properties:** `calledNumbers`, `limit`. **States:** empty, populated, latest, stale.
- **Accessibility:** named list; no live region, no focusable content.
- **Tokens:** `border-width.default`, `color.border`, `color.call-latest-surface`, `color.call-latest`, `color.muted`, `color.surface`, `color.text`, `font.emphasis`, `radius.control`.

### `bingo-operator-board`
- **Purpose:** the operator 1–90 board, ten numbers per row. **Anatomy:** legend, state badge, `role="grid"` of number cells with an "Última" badge on the latest.
- **Properties:** `calledNumbers`, `loaded`, `readonly` (digital mode), `disabled`, `pending`, `stale`. **States:** uncalled, hover, called, latest, disabled, pending (request in flight), stale, focus, readonly.
- **Accessibility:** roving grid focus (arrows, Home/End, PageUp/PageDown), cells named "Número 42, cantado", latest call announced politely; state never relies on colour alone.
- **Tokens:** `border-width.default`, `border-width.focus`, `border-width.strong`, `color.accent`, `color.border`, `color.call-called-surface`, `color.call-called`, `color.call-latest-surface`, `color.call-latest`, `color.call-uncalled-surface`, `color.call-uncalled`, `color.disabled-surface`, `color.disabled`, `color.error`, `color.focus`, `color.muted`, `color.surface`, `color.text`, `font.body`, `font.emphasis`, `font.tracking`, `motion.normal`, `radius.control`, `radius.surface`.

### `bingo-latest-draw`
- **Purpose:** polite announcement of each new committed draw. **Anatomy:** slot + visually hidden `aria-live="polite"` span.
- **Properties:** `latest`, `loaded`. **States:** empty, announced.
- **Accessibility:** announces only distinct non-null values.
- **Tokens:** none (layout only).

### `bingo-operator-summary`
- **Purpose:** last confirmed call with called/remaining counts. **Anatomy:** labels and `output`s.
- **Properties:** `latest`, `count`, `remaining`. **States:** empty, populated, stale.
- **Accessibility:** remaining count is `aria-live="polite"`.
- **Tokens:** `color.muted`, `color.text`, `font.emphasis`.

### `bingo-status`
- **Purpose:** single status line. **Anatomy:** `p` with `role=status` or, for errors, `role=alert`.
- **Properties:** `message`, `tone` (`info`, `success`, `warning`, `error`). **States:** info (checking phases), success, warning (stale data), error.
- **Accessibility:** tone is conveyed by text as well as colour.
- **Tokens:** `color.error`, `color.success`, `color.text`, `color.warning`, `font.emphasis`.

### `bingo-draw-controls`
- **Purpose:** draw mode switch plus manual entry and draw/reload actions. **Anatomy:** manual/digital segmented radios, labelled number input, `bingo-button`s.
- **Properties:** `mode`, `manualDisabled`, `digitalDisabled`, `reloadDisabled`. **States:** manual, digital, pending (disabled), error/stale (reload enabled), focus.
- **Accessibility:** radio group for the mode; labelled native input with 1–90 validity; dispatches `mode-change`.
- **Tokens:** `border-width.default`, `border-width.focus`, `color.border`, `color.canvas`, `color.disabled-surface`, `color.focus`, `color.muted`, `color.surface`, `color.text`, `font.emphasis`, `radius.control`.

### `bingo-event-list`
- **Purpose:** committed events with an activation intent. **Anatomy:** `ul` of rows with an "active" badge or a `bingo-button`.
- **Properties:** `events`, `disabled`, `loaded`. **States:** not loaded, empty, populated, active (`aria-current`), pending (disabled).
- **Accessibility:** named list; the active row is `aria-current="true"`.
- **Tokens:** `border-width.default`, `color.accent`, `color.border`, `color.muted`, `color.on-accent`, `font.emphasis`, `font.tracking`, `radius.control`.

### `bingo-dialog`
- **Purpose:** modal confirmation. **Anatomy:** native `dialog` with heading, slot and action buttons.
- **Properties:** `label`, `actions` (`{ action, label, signal }[]`). **States:** closed, open, focus (returns to opener), dismissed (Escape).
- **Accessibility:** modal `dialog` named by its heading; Escape always dismisses.
- **Tokens:** `border-width.strong`, `color.border-strong`, `color.overlay`, `color.shadow`, `color.surface-raised`, `color.text`, `elevation.raised`, `font.body`, `font.emphasis`, `font.line`, `font.size`, `opacity.scrim`, `radius.surface`, `space.layout`, `space.section`.

### Specified, not implemented

These entries fix the contract for roadmap components; they are not built yet.

| Component | Purpose | States | Accessibility | Tokens |
| --- | --- | --- | --- | --- |
| Celebration overlay | Full-screen moment after a committed line/bingo declaration | hidden, celebrating, reduced-motion (static) | `role=status` announcement; never traps focus on the public window | `color.celebration`, `on-celebration`, `overlay`, `opacity.scrim`, `layer.overlay`, `motion.slow`, `motion.easing`, `font.display` |
| Prize panel | Shows the prize for the current phase | empty, normal, celebration, stale | Named region; text, not colour, identifies the prize | `color.prize`, `surface`, `border`, `radius.surface`, `elevation.raised` |
| Tie-draw wheel | Randomly resolves ties among claimants | idle, spinning, result, reduced-motion (instant result), error | Result announced politely; segments labelled in text | `color.tie-1…8`, `on-tie`, `border-strong`, `motion.slow`, `motion.easing` |
| Dialog variants | Destructive confirm, unsaved changes, info | closed, open, pending, error | As `bingo-dialog`; destructive action never default | `color.error`, `surface-raised`, `overlay`, `opacity.scrim`, `layer.modal` |
| Simulator frame | 16:9 scaled public preview in Configuración | loading, live, stale | Inert iframe with a title; not in tab order | `color.border`, `canvas`, `muted`, `radius.surface`, `border-width.strong` |

## Adding or changing UI

1. Need a new visual decision? Add a reference token if the raw value is new, then a semantic key in
   **all three** theme files, and a contrast pair if it is text or a UI boundary.
2. Run `npm run test:tokens`, `npm run build`, `npm run test:build` and `npm run test:components`.
3. Update this catalog entry (tokens consumed, states, accessibility) in the same change.
