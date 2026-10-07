# Public line lot playback

Use this guide to understand when the public screen shows the known lot winner for a line, and how to preview it.

## Public contract

- The winner is stored before it is displayed. The durable line award (`p#line-award`) always shows it; the
  transient line (`p#line-lot-playback`) only repeats it for 4000 ms.
- It never replays or rerolls. Startup, hydration, reads, reconnects and recovery show the durable award only.
- A fresh, accepted live signal plays once for 4000 ms. A reduced-motion preference starts no transient and no timer.
- Each signal id burns on first sight. A signal that overlaps a running one is dropped, never queued. The line is cancelled
  by an unhealthy frame, an event change, a replaced award or disposal.
- A signal is `{ id, participantNumber, colorId }`. The number and colour must match the confirmed winner. The `id` is an
  opaque transient UUID, not a durable identifier.
- A frame carries no `eventId`; the award has an `eventId` but it is local context only.
- The line has no role, live region, audio or interaction.

## Lifecycle

1. The award is persisted, then delivered, then shown statically.
2. The healthy frame confirms it. Only then can a matching live signal start the 4000 ms line.
3. The timer, not CSS, decides visibility. CSS only adds a short emphasis (at most 4 iterations of 400 ms) while the line is
   not `[hidden]`, and none under reduced motion.

## Privacy

The line shows a participant number and a colour only: no names, cards, list, cap or enumeration. The private API
stays private; the public bridge is read-only, and `ok: true` means acceptance, not that anything was visible.

## Preview in Storybook

`Screens/Public display` has two stories: `Lot winner · live 4 s` (one fresh signal once connected, never repeated)
and `Lot winner · reduced motion (static)`. The winner is the largest safe integer, `9007199254740991` (16 digits), in red,
to exercise wrapping. The fixture options are `lotWinner`, `lotPlayback` (`static`, `live`, `reduced`), plus the optional
ports `onLotHydrated(emit)` and `root.disposeLotFixture()` for tests. It stops on disposal, canvas removal or replacement.

## Fixture limits

It is a presentation fixture using the production adapter; it is not production-entry coverage (the page script is
removed, so `public-ui.mjs` does not run). It proves no layout, paint, Electron or build behaviour. Only the colour red is
previewed here; all six colours are covered by the component and entry tests.

## Checks

| Check | Result |
| --- | --- |
| E2 historical (observed earlier) | Node 711, browser 146 plus 2 probe |
| E3 token and Storybook source contracts | 21 pass: 18 existing plus 3 new |
| E3 fixture and public-entry browser files | 152 pass across 10 files: 146 existing plus 6 new |
| E3 full Node, all browser, layout, Electron, build | pending, not claimed |
