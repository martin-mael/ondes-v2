# ADR 0036: Fixed-time markers: a log item that times the item after it

- Status: accepted
- Date: 2026-10-27
- Issue: #52 (epic #49). Builds on ADR 0003 (hard-start spike), 0026 (log generator), 0030
  (regeneration), 0031 (hard starts), 0024 (islands on air) and 0029 (log vs as-run).

## Context
A station needs exact times that aren't show starts: the top-of-hour ID, the news at :30, an
ID "not before :45". The issue asks for three behaviours (hard, soft, not-before), shown on
the timeline, enforced by the generator and the feeder, and measured on the real engine.

Most of the plumbing already existed:
- clocks have `marker` slots with a timing, an offset and a soft cap (#39, ADR 0020);
- the generator plans them as zero-length `marker` log items with `timing`, `anchorAt` and
  `capMs` (ADR 0026), and back-timing ends the music before hard and soft markers on time
  (ADR 0031);
- the log api already accepts `marker` items (#100).

What was missing was the runtime. The feeder treated a marker as a timing point only: a hard
marker was re-planned but never cut by the engine, a soft marker's cap had no backstop, and a
not-before item could start up to 5 s early. #46's engine cut (`POST /v1/schedule`) only
applied to an anchored item that plays audio, and a marker plays none.

## Decision

### Storage: the existing `marker` log item, no new table
A marker stays a `log_item` of kind `marker`, with `timing`, `anchor_at`, `cap_ms` and `title`
(its label). Nothing is added to the schema or the contracts, and there is no migration.
- A separate table was rejected: the log is the one ordered list the feeder, the timeline,
  regeneration and the as-run matching all read. A marker in it keeps its place among the
  items, moves and deletes like one, and needs no join.
- A timing field on the next item was rejected as the stored form: deleting or replacing
  that item would lose the marker, and the generator would have to know which slot follows
  which marker. The marker stays its own item, and the timing moves at runtime (below).

### What a marker times: the item right after it
A marker times **the item after it**: the first item the feeder pushes, passing over items
that can't play. It times nothing (and stays a plain timing point, as before) when another
marker, a live slot, or an item with its own anchor comes first. A show starting at the
marker's time keeps its own policy.

`resolveMarkers` (`packages/scheduling/src/markers`) does this, pure. The feeder runs it on
its entries before planning (`toEntries`). It moves each marker's `timing`, `anchorAtMs` and
cap onto its item, and makes the marker `flow`. From there the planner and the engine cut
treat the marker's item like any anchored item, through #46's machinery: the tail re-plan,
`stretchTail`, `absorb`, `POST /v1/schedule` and the soft cap's backstop. There is no
parallel mechanism. The timeline mirrors the rule (`markerTarget`, `apps/web/.../markers.ts`)
without the feeder's view of what can't play.

### Semantics

| Timing | At T | Early music | Late music |
|---|---|---|---|
| `hard` | The item starts at T; what is on air fades out under it (engine cut). | The tail stretches toward T; the engine cut covers the rest. | The tail is trimmed or dropped, then the engine cuts what's on air at T. |
| `soft` | The item on air ends first, then the marker's item starts, at most `capMs` after T. | The tail stretches to just past T; a gap over 5 s holds the item until T. | Queued items that would start at or after T are skipped. Past `T + cap`, the engine cuts the item on air there. |
| `not_before` | Never before T. Never cut, nothing skipped. | The tail stretches to just past T. What it can't cover waits: the safety source plays, and the item is pushed at T. | It starts when the music before ends. |

Two changes to the planner (`plan.ts`) make not-before mean "never early":
- the tail stretches toward the anchor first (it only waited before);
- any gap left holds the item, not only gaps over 5 s, and a held not-before item is pushed
  at its anchor, not `pushLeadMs` before it. It airs a push's latency late, never early.

The tail aims `cutOverlapMs` (500 ms) past a not-before anchor, as it already did for a soft
one. The prediction is a frame or two off either way, and aiming at T started the item 40 ms
early on the engine.

Every `not_before` item gets these changes, generator holes included (ADR 0026): the contract
already said "never before `anchorAt`".

### Generator and regeneration
- **Back-timing** (`isBackTimed`): not-before *markers* are now back-timed like hard and soft
  ones, so the music ends at T instead of leaving a wait. Other not-before items (a flow item
  after a hole) wait on purpose and stay as they are.
- **Fix in `DayBuilder.place`:** when `beforeAnchor` re-plans a run, the cursor now follows
  the new run's end. A not-before item started at the old cursor (the overrun end before
  back-timing). Hard and soft items start at their anchor, so they never showed it.
- **Same output without markers:** a hash of the generator's output (the generator fixture
  and the hard-start fixture, back-timing on and off, October and March DST weeks, markers on
  and stripped) is identical to main. The fixtures' markers are all soft, so even their output
  is unchanged. `GENERATOR_VERSION` stays `2`. Both `*.bench.test.ts` pass unchanged.
- **Regeneration** keeps what ADR 0030 keeps. Clock markers come back from the clock with the
  same identity (`kind|origin|title`). A marker before `frozenUntil` is kept as is (`past`).
  A marker added by hand is `origin: manual`, and the `manual` policy keeps it; back-timing
  plans the music up to it (`markers.test.ts`).
- **DST:** clock markers anchor on real hours, so the 23- and 25-hour days have 23 and 25 of
  each, at distinct instants. `markers.test.ts` checks them, the back-timing to each marker,
  and the resolution on the 25-hour day.

### Authoring: on clocks, and on the log timeline
- **Clocks** (existing, #39): the recurring markers of an hour, the common case.
- **The log timeline** (new): one-off markers, and edits to any marker of a day not yet aired.
  - "Add marker" in the day's toolbar, and "Edit marker…" in a marker's menu (it replaces
    "Replace…", which picks an asset), open one dialog with: the hour, `mm:ss`, the timing,
    the cap (soft only, 0–600 s, default 30 s) and a label.
  - The hour list is the day's real hours, so a DST day offers 02:00 twice, told apart by
    their offset.
  - The marker goes before the first item at or after its time, the item it then times. An
    edit that moves its time past other items also moves it.
  - A time that has passed is refused inline. The dialog is guarded by `useUnsavedChanges`.
  - FR + EN strings.
- **Display:** a marker row has a flag icon, its timing badge, the item it times
  ("Times: Station ID") or "Times nothing" for a plain timing point. Once that item has aired,
  the row shows how far from T it started ("Aired +2 s"), in red when the marker's rule was
  missed (by more than a second; soft: past its cap).

### Holds wake the feeder
The feeder service syncs a feeder when the item its plan holds is due, instead of at the next
5 s tick. Before, a held item went up to 5 s late. Real timers stay in the service
(`service.ts`), so the feeder and its simulation stay clock-free.

### Planner fix: never back before what aired
When the log isn't on air (safety, a dry queue), the planner restarted from the first item
planned within the last minute that hadn't aired. An item a soft marker skipped came back
that way once safety took over before a not-before marker. The planner now starts after the
last item that aired this boot, if that is later.

### Acceptance: the real engine (`engine/tests/markers`)
`markers.engine.int.test.ts` runs in the vitest `engine` project, in its own container. The
real feeder plays a log into the station template in the pinned Liquidsoap image, recorded
on its final mix. Every item plays its own tone, so the recording shows what aired when:

| Marker | Checked on the recording |
|---|---|
| Hard at T | The song on air is cut at T; the marker's jingle starts there; the song never returns. |
| Soft, cap 4 s, song still on air | The engine cuts the song at T + 4 s, where the jingle starts (±0.15 s against the first cut). |
| Soft, cap 10 s, song on air at T | The song plays to its end and the jingle follows it, within the cap. The song queued after T is skipped and never airs. |
| Not before, music can stretch | The song before plays past its log slot; the jingle starts at T + 0–0.7 s, never before. |
| Not before, music can't stretch | Safety plays in the gap; the jingle starts at T + 0–0.5 s. |

Times are measured from the first cut, which the engine gates on its audio timeline. This
early in an engine's life, two gated starts agree to about 0.1 s, as in
`hardstart.engine.int.test.ts`. The scenario starts 20 s after boot, so the clock origin has
settled. CI runs it with the engine integration job. Its path filters cover
`engine/tests/markers/**`.

## Consequences
- A marker's item is whatever follows it. Moving or deleting that item changes what the
  marker times; the timeline says which item that is.
- A soft marker can still start its item up to 5 s early when the music runs out, rather than
  air safety (ADR 0031's `holdGapMs`). Back-timing makes this rare. A not-before marker never
  starts early: the gap airs safety instead.
- **Known limit, the item after an engine cut (#192):** the entry queued after a scheduled
  item can be taken by the automation under it, lose its start, and be pushed again. The
  as-run may then show it twice. This is #46's template, and it affects hard and capped-soft
  markers' items as much as hard-start episodes. The engine test asserts the order of first
  starts and the marker items' times, and tolerates the double start until #192 is fixed.
  Two fixes were tried here and rejected (#192 has the details).
- No alert for a missed marker yet: the timeline shows it, the as-run has it.
- Follow-ups: #192; a "markers met" figure in the log vs as-run view (ADR 0029).
