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
| `ui` | 3:1 | 4.5:1 | focus and `border-strong` on canvas/surface, accent on surface and on `call-called-surface` |

Translucent backgrounds are composited over `color.canvas`, translucent foregrounds over their
background. Disabled controls are exempt from WCAG contrast; they additionally use `opacity.disabled`.

## Component catalog

Every component is a Lit element in `src/components/`, uses shadow DOM styles built only from the
semantic variables listed, honours `prefers-reduced-motion`, and keeps state changes driven by
committed persistence snapshots (presentation never acknowledges its own intent).

### `bingo-shell`
- **Purpose:** page frame that constrains content width. **Anatomy:** a default slot.
- **Properties:** none. **States:** normal. **Accessibility:** no role; landmarks live in the page.
- **Tokens:** consumed through `screen.css`: `space.wide`, `space.layout`, `space.list-indent`.

### `bingo-app-shell`
- **Purpose:** the operator's full-viewport frame (header row, content row, optional status bar)
  pinned to the window, so the document itself never scrolls; content that does not fit scrolls
  inside its own panel. **Anatomy:** `slot="header"` → default slot → `slot="status"` (hidden
  while empty).
- **Properties:** none. **States:** normal, with/without a status bar.
- **Accessibility:** no role of its own; landmarks live in the slotted header/main/footer.
- **Tokens:** `color.text`, `color.canvas`.

### `bingo-tabs`
- **Purpose:** WAI-ARIA tabs with automatic activation and a roving tabindex. The host is the
  tablist; light-DOM `[role="tab"]` children name their panel through `aria-controls`, usually a
  `bingo-tab-panel` (defined in the same module: a focusable, hidden-while-inactive panel that fills
  its grid cell). `canLeave(current, next)` may veto or defer a switch (e.g. unsaved edits): it
  returns `true` to switch now, or a promise of a boolean; while a decision is open the current tab
  stays selected, and a veto returns focus to it.
- **Properties:** `label` (string), `canLeave` (function). **States:** normal, deciding (pending veto).
- **Accessibility:** `role="tablist"`; arrow keys, Home and End move focus and selection.
- **Tokens:** `color.focus`.

### `bingo-panel`
- **Purpose:** titled content region. `compact` is the dense operator variant (thin border, a header
  bar with an "actions" slot); `fill` takes its grid cell's full height and scrolls only its body.
  **Anatomy:** `section[aria-labelledby]` → `header` (`h2` heading, optional `actions` slot) → `.body`
  slot.
- **Properties:** `heading` (string), `compact` (reflected boolean), `fill` (reflected boolean).
  **States:** normal, empty (heading only), compact, fill.
- **Accessibility:** section is named by its heading.
- **Tokens:** `color.surface`, `color.border`, `color.shadow`, `color.muted`, `border-width.strong`,
  `radius.surface`, `elevation.raised`, `space.layout`, `space.section`, `space.inset-inline`,
  `font.body`, `font.size`, `font.line`, `font.emphasis`, `font.tracking`.

### `bingo-button`
- **Purpose:** the single, form-associated action control. Inside a form, `type="submit"`/`"reset"`
  acts on the owning form; `variant="primary"` marks the one main action of a form or dialog; `block`
  stretches the button to fill its container. **Anatomy:** native `button[type=button]` → slot label.
- **Properties:** `disabled` (reflected boolean), `type`, `variant` (reflected), `block` (reflected).
  **States:** normal, hover, active, focus, disabled, pending (owner sets `disabled` while a request
  is outstanding).
- **Accessibility:** native button semantics and keyboard activation; visible focus ring.
- **Tokens:** `color.text`, `color.surface`, `color.border`, `color.canvas`, `color.accent`,
  `color.muted`, `color.focus`, `font.emphasis`, `radius.surface`, `space.inset-compact`,
  `space.inset-inline`, `space.small`, `motion.normal`.

### `bingo-number`
- **Purpose:** one called number, large or compact. **Anatomy:** a `span` chip.
- **Properties:** `value` (number or `null`), `emptyLabel`, `compact`, `latest` (set by its list).
- **States:** empty (label), called, latest.
- **Accessibility:** plain text; announcements belong to `bingo-latest-draw`.
- **Tokens:** `color.call-called`, `color.call-called-surface`, `color.call-latest`,
  `color.call-latest-surface`, `color.accent`, `color.shadow`, `border-width.strong`, `radius.control`,
  `elevation.raised`, `space.inset-compact`, `font.body`, `font.display`, `font.size`, `font.line`,
  `font.tight`, `font.emphasis`.

### `bingo-number-board` (public) and `bingo-call-history` (operator)
- **Purpose:** ordered list of committed calls. The public board shows the full history (heading,
  empty text, `ol` of `li > bingo-number`; the last item has `aria-current="true"` and passes
  `latest` to its chip). The operator's `bingo-call-history` renders the same full list when
  `limit` is unset, or (with `limit`, in the side rail) a compact strip of only the last calls,
  as plain chips with the latest one highlighted.
- **Properties:** `calledNumbers` (array), `loaded` (board only), `limit` (call-history only).
  **States:** loading ("Waiting for draw", board only), empty, populated, latest, stale (owner keeps
  the last committed list).
- **Accessibility:** named list; no live region, no focusable content.
- **Tokens:** `color.accent`, `color.border`, `color.canvas`, `color.muted`, `color.surface`,
  `color.text`, `border-width.strong`, `font.emphasis`, `space.inset-compact`, `space.list-indent`,
  `space.section`, `space.small`.

### `bingo-side-rail`
- **Purpose:** a labelled vertical rail beside a workspace's dominant zone (e.g. the Bingo tab's
  board). Its sections stack and scroll inside the rail when they do not fit; children in the
  `"footer"` slot stay pinned to the bottom. **Anatomy:** `aside[aria-label]` → scrolling body slot →
  pinned footer slot.
- **Properties:** `label` (string). **States:** normal, scrolling body.
- **Accessibility:** the rail is a named region (`aria-label`).
- **Tokens:** `color.border`, `color.surface`, `radius.surface`.

### `bingo-operator-board`
- **Purpose:** the operator's 1–90 board: ten numbers per row in numeric order. It renders only the
  committed calls it is given and never marks a number called on its own. In manual mode (not
  `readonly`) activating an uncalled number dispatches `number-select`; the board changes only when
  the acknowledged snapshot arrives. **Anatomy:** a status bar with a legend, then a `role="grid"` of
  number cells.
- **Properties:** `calledNumbers`, `loaded` (reflected), `readonly` (reflected), `disabled`
  (reflected), `pending` (reflected), `pendingNumber`, `stale` (reflected).
- **States:** uncalled, called, latest, disabled, pending (request in flight, marked but not shown
  called), stale (history may be out of date).
- **Accessibility:** `role="grid"` with arrow-key navigation; each newly committed latest call is
  announced once via a polite live region; static under reduced motion.
- **Tokens:** `color.text`, `color.surface`, `color.muted`, `color.border`, `color.accent`,
  `color.canvas`, `color.error`, `color.focus`, `font.body`, `font.emphasis`, `motion.normal`,
  `radius.surface`.

### `bingo-field` (base), `bingo-text-field`, `bingo-date-field`, `bingo-select-field`
- **Purpose:** shared, form-associated Lit controls behind every operator text/date/select input:
  `bingo-field` renders a labelled native control in the shadow root, a hint, an announced error and
  a pending indicator, and implements form association through `ElementInternals`; the three
  subclasses add their own native control (`renderControl()`). `bingo-select-field` mirrors light-DOM
  `<option>` children into its shadow `<select>`. **Anatomy:** label row (label, required marker) →
  control (+ optional adornment: busy indicator or, for the date field, a themed calendar icon) →
  hint → announced error.
- **Properties:** `label`, `hint`, `error`, `name`, `value`, `required` (reflected), `disabled`,
  `pending` (reflected); `bingo-date-field` adds `min`/`max`; `bingo-text-field` adds `maxlength`,
  `minlength`, `autocomplete`, `placeholder`.
- **States:** normal, focus, required, disabled, pending (busy indicator), invalid (announced error).
- **Accessibility:** native labelled control; the error region is `aria-live="polite"` and
  `aria-describedby`-linked; invalid state is `aria-invalid`, never color alone.
- **Tokens:** `color.text`, `color.muted`, `color.surface`, `color.canvas`, `color.accent`,
  `color.error`, `color.focus`, `font.body`, `font.size`, `font.line`, `font.tight`, `font.emphasis`,
  `radius.surface`, `space.small`, `space.inset-compact`, `space.inset-inline`, `motion.normal`
  (from `bingo-field`'s shared styles; the subclasses' own styles add nothing beyond
  `space.inset-inline`, already listed, for `bingo-date-field`'s calendar-icon slot).

### `bingo-form-actions`
- **Purpose:** the action row that ends a form: an optional status (`slot="status"`) at the start,
  then secondary actions (default slot) and the primary action (`slot="primary"`) last, at the end.
  `sticky` keeps the row visible at the bottom of a scrolling form; `pending` marks it busy.
  **Anatomy:** status slot → secondary-actions slot → primary-action slot.
- **Properties:** `sticky` (reflected), `pending` (reflected). **States:** normal, sticky, pending.
- **Accessibility:** the row is `role="group"`, with `aria-busy` while pending.
- **Tokens:** `color.border`, `color.canvas`, `font.size`, `space.inset-inline`, `space.small`.

### `bingo-latest-draw`
- **Purpose:** polite announcement of each new committed draw. **Anatomy:** slot + visually hidden
  `aria-live="polite"` span. **Properties:** `latest`, `loaded`. **States:** empty, announced.
- **Accessibility:** announces only distinct non-null values. **Tokens:** none (layout only).

### `bingo-operator-summary`
- **Purpose:** last confirmed call with called/remaining counts. **Anatomy:** `bingo-number`, two
  labelled `output`s ("Cantadas", "Quedan"). **Properties:** `latest`, `count`, `remaining`.
  **States:** empty, populated, stale.
- **Accessibility:** remaining count is `aria-live="polite"`; called count is `aria-live="off"`.
- **Tokens:** `color.text`, `color.muted`, `font.emphasis`.

### `bingo-status`
- **Purpose:** single status line. **Anatomy:** `p` with `role=status` or, for errors, `role=alert`.
- **Properties:** `message`, `tone` (`info`, `success`, `warning`, `error`). **States:** info, success,
  warning (stale data), error.
- **Accessibility:** tone is conveyed by text as well as colour.
- **Tokens:** `color.text` (info), `color.success`, `color.warning`, `color.error`, `font.emphasis`.

### `bingo-draw-controls`
- **Purpose:** the side rail's draw controls: a manual/digital mode toggle, manual number entry with a
  "Cantar número" action, a digital "Sacar bola" action, and a "Recargar evento" action.
  **Anatomy:** `fieldset` mode toggle (two radios) → manual or digital `bingo-button` group →
  reload `bingo-button`. **Properties:** `mode` (reflected), `manualDisabled`, `digitalDisabled`,
  `reloadDisabled`.
- **States:** manual, digital, pending (disabled), error/stale (reload enabled), focus.
- **Accessibility:** labelled radio group for the mode; labelled native input with 1–90 validity;
  native button activation; Enter in the number field acts like the manual draw button.
- **Tokens:** `color.text`, `color.surface`, `color.canvas`, `color.border`, `color.muted`,
  `color.focus`, `font.emphasis`, `radius.surface`.

### `bingo-event-list`
- **Purpose:** committed events with an activation intent. **Anatomy:** `ul` of `li` rows, each with
  its name/date/place and either an "Evento activo" marker or an activating `bingo-button`.
  **Properties:** `events`, `disabled`, `loaded`.
- **States:** not loaded, empty, populated, active (`aria-current`), pending (disabled).
- **Accessibility:** named list; the active row is `aria-current="true"`.
- **Tokens:** `color.border`, `color.accent`, `color.canvas`, `color.muted`, `font.emphasis`,
  `radius.surface`.

### `bingo-dialog`
- **Purpose:** modal confirmation. **Anatomy:** native `dialog` with heading, slot and action buttons.
- **Properties:** `label`, `actions` (`{ action, label, signal }[]`). **States:** closed, open, focus
  (returns to opener), dismissed (Escape).
- **Accessibility:** modal `dialog` named by its heading; Escape always dismisses.
- **Tokens:** `color.text`, `color.surface-raised`, `color.border-strong`, `color.overlay`, `color.shadow`,
  `opacity.scrim`, `border-width.strong`, `radius.surface`, `elevation.raised`, `space.layout`,
  `space.section`, `font.body`, `font.size`, `font.line`, `font.emphasis`.

### Specified, not implemented

These entries fix the contract for roadmap components; they are not built yet.

| Component | Purpose | States | Accessibility | Tokens |
| --- | --- | --- | --- | --- |
| Celebration overlay | Full-screen moment after a committed line/bingo declaration | hidden, celebrating, reduced-motion (static) | `role=status` announcement; never traps focus on the public window | `color.celebration`, `on-celebration`, `overlay`, `opacity.scrim`, `layer.overlay`, `motion.slow`, `motion.easing`, `font.display` |
| Prize panel | Shows the prize for the current phase | empty, normal, celebration, stale | Named region; text, not colour, identifies the prize | `color.prize`, `surface`, `border`, `radius.surface`, `elevation.raised` |
| Tie-draw wheel | Randomly resolves ties among claimants | idle, spinning, result, reduced-motion (instant result), error | Result announced politely; segments labelled in text | `color.tie-1…8`, `on-tie`, `border-strong`, `motion.slow`, `motion.easing` |
| Tabs | Operator section switcher (today plain buttons in `screen.css`) | normal, hover, selected, focus, disabled | `tablist`/`tab`/`tabpanel`, roving focus | `color.accent`, `on-accent`, `border`, `focus`, `border-width.strong` |
| Form fields | Text/date/select with label and error | normal, focus, disabled, error, pending | Label association, `aria-invalid`, `aria-describedby` error | `color.surface-sunken`, `text`, `border-strong`, `error`, `focus`, `radius.control` |
| Dialog variants | Destructive confirm, unsaved changes, info | closed, open, pending, error | As `bingo-dialog`; destructive action never default | `color.error`, `surface-raised`, `overlay`, `opacity.scrim`, `layer.modal` |
| Simulator frame | 16:9 scaled public preview in Configuración | loading, live, stale | Inert iframe with a title; not in tab order | `color.border`, `canvas`, `muted`, `radius.surface`, `border-width.strong` |

## Adding or changing UI

1. Need a new visual decision? Add a reference token if the raw value is new, then a semantic key in
   **all three** theme files, and a contrast pair if it is text or a UI boundary.
2. Run `npm run test:tokens`, `npm run build`, `npm run test:build` and `npm run test:components`.
3. Update this catalog entry (tokens consumed, states, accessibility) in the same change.
