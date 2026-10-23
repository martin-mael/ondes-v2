# Log feeder (#29)

Keeps each station's engine queue a few items ahead of air, following the published log
(ADR 0002 "Just-in-time feeding", ADR 0003 "Feeder"). Decision record:
`docs/adr/0012-log-feeder.md`.

| Piece | File | Role |
|---|---|---|
| Planner | `plan.ts` | Pure. Engine state + log around now → which entries to have queued, in order, with their trims; `diffQueue` compares that with the engine queue. |
| Hard starts | `hardstart.ts` | Pure (#46, ADR 0031). `slotFit`: a flexible item plays to its log slot (back-timing's cut) and may stretch back; `stretchTail`: the tail lengthens toward an anchor; `scheduleBody` / `scheduleAction`: what to send `POST /v1/schedule`. `hardstart.sim.test.ts` plays two weeks of generated logs through the feeder into a model of the engine. |
| Push bodies | `push.ts` | Pure. One log item (or segment, or island chain) + its media → `POST /v1/queue` / `POST /v1/segment` body: cache path, biased cue points, fades, crossfades, gain, ICY metadata, voice overlay. |
| Islands | `islands.ts` | Pure. The window's islands (#57, ADR 0024) → which air as chains (`A body, island, B body`) and which fall back to a crossfade with their voices laid over it. |
| Repo | `repo.ts` | The log around now (published days only) and, in one query, each asset's playout file, cues, loudness and cache state. `loadFeedIslands`: the islands the window's segues call for now, their render's cache state, the voices' media. `feeder_push`: what was pushed to the current boot. |
| Feeder | `feeder.ts` | One station: `sync()` reads the state and the log, plans, removes and pushes. Alerts, urgent fetches, `feeder.item.passed_over`. |
| Leases | `leases.ts` | One feeder per station across replicas: a session-level advisory lock per station on one reserved connection. |
| Service, plugin | `service.ts`, `plugin.ts` | `app.feeder`: lease rounds, the tick, fanout events → the right feeder. |

## How a sync works

1. `GET /v1/state`: boot id, item on air, queue.
   - A new boot id (or a feeder taking over the station) loads what was pushed to that boot from
     `feeder_push`: each entry's body fingerprint, trim, and whether it aired.
   - Without it, a new feeder couldn't tell a matching queue from a stale one and would re-push
     it all, and it would mispredict the on-air item's end (its trim). Rows of other boots are
     pruned.
2. The log from 3 h back to the lookahead (45 min) + 1 h ahead, published days only.
3. **Where to start.** The log's item on air, found by its `item_id` / `segment_id`.
   - Its predicted end chains from `elapsed`, so drift shows against the anchors.
   - When the log isn't on air (boot, safety, live), it starts from the first item planned less
     than `joinLateMs` (60 s) ago that didn't air during this boot. It airs as soon as it's
     pushed (the queue takes over from safety right away).
   - Unless the entry planned over now started before that (a live slot with the DJ on air or
     safety filling it, an episode half-way through): then what follows waits for its planned
     end, like any hold. The log stays on its plan instead of airing the next hour's items
     during a show.
4. **How far.** At least `minItems` (2) entries and `minAheadMs` (10 min) of audio queued past the
   item on air, at most `maxItems` (8).
5. **What's skipped.**
   - Uncached items, files the engine refused (422) and items with no playout file are passed
     over; the next playable item takes their place.
   - Markers push nothing. A live slot pushes nothing and holds what follows until its end.
6. **Anchors** (`timing`), within the lookahead (#46, ADR 0031):
   - A flexible item (song, bed, fill) plays to its log slot: when back-timing cut it in the log
     (a shortened last song, a bed sized to the gap), it is pushed trimmed, with a fade-out, and
     may play up to that much longer again (`slotFit`).
   - Overruns are absorbed in the tail since the previous anchor only: whole flexible entries
     that fit in it first, then trims of the flexible ones (to no less than 30 s), and only then
     whole other entries (a VT, a jingle), from the tail backwards.
   - `hard`: an overrun is absorbed; a gap stretches the tail's flexible entries back toward
     their media's length, the last one first (`stretchTail`).
     - When the engine has `POST /v1/schedule`, the hard item is never queued: it is scheduled
       with the engine as soon as it enters the window (again after a restart, or when its body
       or time changes, except in its last 5 s; cancelled when the log stops starting it hard),
       and the plan stops there. The engine holds a schedule posted while the previous hard
       item plays until that one ends. The tail aims `cutOverlapMs` (500 ms) past the anchor;
       the engine starts the item on its own audio timeline and fades out what's on air under
       it. Nothing is `late`.
     - Without it, a gap over `holdGapMs` (5 s) holds the item until its anchor, and what the
       tail can't absorb is logged as `late`.
   - `soft`: entries that would start at or after the anchor are dropped, and the tail is cut
     (else dropped) down to `anchor + cap`. A gap stretches the tail like a hard one's, aiming
     `cutOverlapMs` past the anchor, and one over `holdGapMs` holds the item until its anchor.
     When the item on air itself runs past the cap, the engine cuts it there (the soft item is
     scheduled at `anchor + cap`); without the engine cut, that's `late`.
   - `not_before`: held until its anchor (gap over 5 s).
7. **Diff.** Keep the longest queued prefix that matches the plan: same entry, same body
   fingerprint, trim within 250 ms. Remove the rest (`DELETE /v1/queue/:id`, or clear when it's
   everything), re-read the state, then push what's missing. The item on air is never in the
   queue, so it's never touched.

## Per-item push data

- **`uri`**: `playoutPath({ sha256, ext })`, with `ext` from the playout file's storage key (#31).
- **Cue points**: in samples (log overrides, else the asset's cues), sent as seconds biased by
  half a sample (spike #12). With a cue-in: `(n − ½)/sr` on both ends. Without one:
  `cue_out = (n + ½)/sr`.
- **Segment parts**: cue-ins are floored to the playout copy's FLAC block grid.
- **Fades**: `fade_in` / `fade_out` from the cues, in seconds. A trimmed item gets at least a
  3 s fade-out.
- **Crossfades**:
  - `cross_out` = the log's `crossOutMs`, else `cueOut − crossStartNext`, else unset (station
    default).
  - `cross_in` = the log's `crossInMs`, else the previous entry's `cross_out`.
  - The overlap is the min of the two (ADR 0002).
- **`amplify_db`**: `getPlayoutGain` (#19), omitted at 0. Segments carry it per part.
  - The log's `gainDb` goes in as the override, even when the asset's normalisation is off
    (someone set it on this item).
  - It gets the same true-peak ceiling, rounding and bounds as every gain, so a log edit can't
    push an item past the ceiling.
- **Title, artist**: the item's title, else the asset's; artists joined with `, `.

## Islands (#57, ADR 0024)

- Every sync re-derives the islands of the items from 30 min back on (`deriveIslandsFor`): a
  render airs only if it has the hash the inputs give now.
- **Chain**: render `ready` and cached, every covered item playable, the items after the head
  `flow`. The items become one entry under the head's id, pushed as one segment
  (`buildPushChain`): A's cue-in moved up to the FLAC grid, cue-out at the head join; the island
  at 0 dB with no cues (`item_id` `island:<hash>`); B from the tail join; half-sample bias on
  every cue. Consecutive islands join one chain.
- **Fallback** otherwise: plain items and crossfade, the island's voices in the head's
  `overlay` (start relative to A's end, own trim and gain, the music ducked to A's envelope
  there). A voice file not cached is fetched urgently and left out meanwhile.
- An item on air or aired in this boot never starts a chain; the chain on air keeps its pushed
  shape (`feeder_push.parts`), so B never airs twice.
- `feeder_push.parts`: each request's engine id, its length inside the chain and its
  transition, for the as-run.

## Cache, alerts, as-run

- **Miss at plan time**: the feeder skips the item and calls
  `playoutCache.requestUrgentFetch(scope, fileId)`, at most once a minute per file. The cache
  raises `cache.item_missing` itself.
- **422 at push time**: the file is skipped for 60 s, fetched urgently, and
  `playoutCache.requestSync(scope)` reconciles the cache table with the disk.
- **Alerts** (`app.alerts`), raised and resolved on change only. A new feeder first reads
  which feeder alerts are open, so a boot neither re-raises nor resolves for nothing:
  - `feeder.items_skipped` (warning, one per station): the window has items that can't be
    played; `details.items`.
  - `feeder.log_empty` (warning, critical after 15 min): nothing queued, to push or held. The
    safety playlist plays (#34 owns it; the feeder never clears or skips to hand over).
- **`feeder.item.passed_over`** (real-time event, `engine:read`): published once a later item
  went on air, per passed-over item (every part of a passed-over segment), with its reason.
  Deterministic id per (station, item, boot).
  - It is not as-run's `skipped` outcome (an item that aired under 5 s). As-run (#30) records
    only what aired and doesn't consume this event; the log-vs-as-run view (#53) can.
  - The event is transient: nothing stores the reason yet.

## Triggers and replicas

- **Triggers**:
  - The service syncs each feeder it owns every 5 s.
  - `engine.track.started` / `track.ended` / `booted` / `up` and `log.updated` from the fanout
    sync the station right away.
  - Fanout events are hints only: every sync re-reads the state and the log, so a missed event
    costs at most a tick.
- **One feeder per station**:
  - Every 10 s, each replica tries `pg_try_advisory_lock(hashtextextended('ondes.feeder:<id>', 0))`
    on its reserved connection for every station whose engine should run.
  - The holder feeds the station. The lock dies with the session, so another replica takes over
    within a lease round.
  - Before every engine mutation (each remove, clear and push), the feeder checks that it wasn't
    stopped and that its session (and so its lock) is still alive. Otherwise it aborts the run.
- The engine adapter comes from `engineLifecycle.adapterFor(stationId)`, which works on any
  replica.

## Tests

- `pnpm vitest run apps/api/src/modules/engine/feeder`: unit tests.
  - The planner: how far ahead, the start point, skips, anchors, re-planning after an edit,
    the diff, and two DST days of the Europe/Paris fixture log.
  - The push bodies.
  - The feeder loop against an in-memory engine, including a handover through the push store
    and a feeder stopped mid-run.
- `feeder.int.test.ts` (integration project `engine`): a real Liquidsoap running the station
  template, a real database (log, library, cache table, `feeder_push`), sine tones in the
  engine's cache.
  - Its own compose project per run, `ondes-engine-feeder-it-<run id>`, on free host ports,
    with its own rendered script and cache directory. Parallel runs and worktrees don't collide.
  - Plays the log in order and skips the uncached item.
  - Edits the item after next and checks it airs while the item on air plays out.
  - A second feeder takes the station over and removes or re-pushes nothing.
  - Restarts the engine and checks the log comes back.
- `leases.int.test.ts`: two replicas compete for stations; locks are handed over on release,
  close and when a session dies.
- `islands.test.ts`: chains and fallbacks from real derived islands; the chain's cues against
  Liquidsoap's `ceil(out·sr) − ceil(in·sr)`.
- `islands.int.test.ts` (integration project `engine`): a real Liquidsoap and database with
  two VT segues, one rendered and cached (airs `A, island, B` as one segment), one pending (the
  fallback, the voice in C's overlay); the as-run recorder then records the island's transition.
  The splice itself (no seam) is the template test's (`pnpm test:engine:template`).
