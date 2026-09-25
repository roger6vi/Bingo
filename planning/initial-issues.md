# Initial production issue drafts

These are **local drafts**, not published GitHub issues. Review their boundaries and acceptance criteria before creating them. The feasibility prototype establishes a Mac desktop baseline, not production bingo functionality. Proposed order reflects dependencies, not a release commitment.

## 1. Define a testable 90-ball event core

**Outcome:** An offline event can track the set and order of called numbers (1–90), independently of Electron and storage. An operator can record a manually drawn number or request a digital draw from the remaining numbers.

**Acceptance criteria**
- A new event starts with no called numbers; no number outside 1–90 or duplicate can be recorded.
- A manual draw accepts a valid remaining number and preserves draw order.
- A digital draw selects only from remaining numbers; after 90 draws, no further draw succeeds.
- Injected randomness makes draw behavior deterministic in tests; failed actions leave the event unchanged.
- Strict RED → GREEN → REFACTOR evidence and unit tests cover limits, duplicates, and exhaustion.

**Boundary:** No ticket generation, claims, prizes, SQLite, UI, or rules for validating a winning card. Those require their own decisions and issues. This core records draws; it does not decide when a prize may be claimed.

## 2. Persist and recover a local event with SQLite

**Outcome:** An event's called-number state survives quitting and reopening on the same computer without silently losing or resetting an existing event.

**Acceptance criteria**
- Create, load, and update a local event in SQLite; the database path is under Electron's user data or another explicit local application data location.
- A newly opened process can recover the exact ordered draw history and current state.
- An invalid draw or failed write does not persist a partial event transition; an existing event is not replaced with an empty one on read/schema errors.
- Schema version and unsupported-data handling are explicit and tested against a real temporary database and a fresh process.
- Strict TDD evidence and a restart check demonstrate recovery; no network is required.

**Boundary:** Replace the prototype's JSON sample counter for real event persistence; do not mistake `sample-state.json` for the product database. Backup/export policy and multi-computer synchronization are not part of this issue. Depends on issue 1.

## 3. Connect the operator to the event

**Outcome:** The operator can start or reopen an event and perform manual or digital draws from the private window, with persisted state and actionable error feedback.

**Acceptance criteria**
- The operator window displays the current event and ordered/remaining draw state after reopening.
- Draw actions cross a narrow, validated preload/IPC boundary; malformed or duplicate requests are rejected without changing the event.
- Persisted state is acknowledged to the operator only after a successful write; storage errors are visible and do not masquerade as success.
- Tests exercise the event-to-IPC boundary and operator state; an interactive Mac smoke covers the basic path.

**Boundary:** The prototype's sample counter is not an event control. This issue does not add ticket claims, prize rules, media import, theming, or Windows packaging. Depends on issues 1–2.

## 4. Show authoritative draws on the public display

**Outcome:** The public window reflects the current event's called numbers and latest draw without gaining the ability to change game state.

**Acceptance criteria**
- Opening or reopening the public window shows the current persisted event snapshot; new draws update it in order.
- The public renderer has no draw or write API, and malformed incoming state cannot create a draw.
- Display disconnect/reconnect follows the already tested Mac window lifecycle: fallback to primary preview, no automatic return, operator-initiated return to secondary fullscreen.
- Tests cover initial state, update ordering, reopen and display transitions; an interactive Mac check verifies both screens.

**Boundary:** The sample MP4 proves local playback but is not the final public UI. Prize animations, ticket validation, themes, and Windows validation belong to later issues. Depends on issues 1–3.

## Before publishing

- Agree on the titles, issue order and product boundaries; do not invent house rules for cards or prizes.
- Refresh `README.md`: its 18-test and unobserved-GUI/second-display statements predate the completed Mac tests (19 tests plus user-observed playback, recovery and display behavior).
- Check the actual GitHub issue policy, forms, labels and duplicates in the newly created target before publishing. These drafts alone do not authorize issue creation or a push.
