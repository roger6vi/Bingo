# Review legacy line recovery as one feature chain

This chain adds explicit operator cancellation of a legacy `checking_line` state without resetting awards. See [issue #26](https://github.com/roger6vi/Bingo/issues/26).

## Review order

| Slice | Outcome |
| --- | --- |
| 1 | Atomic store recovery and identity-bound readback |
| 2 | Authorized IPC and preload endpoints |
| 3 | Controller freshness guards and recovery copy |
| 4 | Operator confirmation dialog and page coverage |
| 5 | Owned offline fixture seeding and lifecycle guards |
| 6 | Isolated Electron recovery scenario |

Review each slice against its immediate parent. The integration PR remains draft until all children are reviewed and integrated. No slice independently authorizes delivery.

## Acceptance boundary

Cancellation requires explicit confirmation and the current event, audit sequence, and phase identity. It appends one `reject_line_claim` transition to `drawing`, preserves calls, prizes, metadata and prior audit, and creates no winner or presentation. Startup never silently rewrites the legacy state.

Lost acknowledgements require authoritative readback rather than a second blind write. Stale replies cannot refresh or mutate a replacement operator context.

Local final verification observed 784 unit, 27 artifact, 161 browser tests and 11 isolated Electron scenarios passing. Remote CI is a separate gate. Windows application acceptance remains deferred until roadmap completion.

## Out of scope

`checking_bingo` recovery, award reset (#29/#112), broader completion of #14, real-user profile testing, and exhaustive crash or power-loss proof are not delivered here.

## Delivery

Use ordinary merges only after separate human authorization and exact-head required CI success. Close #26 only after final integration and acceptance confirmation.
