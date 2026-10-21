# Log feeder (#29)

Keeps each station's engine queue a few items ahead of air, following the published log
(ADR 0002 "Just-in-time feeding", ADR 0003 "Feeder"). Decision record:
`docs/adr/0012-log-feeder.md`.

| Piece | File | Role |
|---|---|---|
| Planner | `plan.ts` | Pure. Engine state + log around now → which entries to have queued, in order, with their trims; `diffQueue` compares that with the engine queue. |
| Push bodies | `push.ts` | Pure. One log item (or segment) + its media → `POST /v1/queue` / `POST /v1/segment` body: cache path, biased cue points, fades, crossfades, gain, ICY metadata. |
| Repo | `repo.ts` | The log around now (published days only) and, in one query, each asset's playout file, cues, loudness and cache state. |
| Feeder | `feeder.ts` | One station: `sync()` reads the state and the log, plans, removes and pushes. Alerts, urgent fetches, `feeder.item.passed_over`. |
| Leases | `leases.ts` | One feeder per station across replicas: a session-level advisory lock per station on one reserved connection. |
| Service, plugin | `service.ts`, `plugin.ts` | `app.feeder`: lease rounds, the tick, fanout events → the right feeder. |

## How a sync works

1. `GET /v1/state`: boot id, item on air, queue. A new boot id forgets what was pushed.
2. The log from 3 h back to the lookahead (45 min) + 1 h ahead, published days only.
3. **Where to start.** The log's item on air, found by its `item_id` / `segment_id`.
   - Its predicted end chains from `elapsed`, so drift shows against the anchors.
   - When the log isn't on air (boot, safety, live), it starts from the first item planned less
     than `joinLateMs` (60 s) ago that didn't air during this boot. It airs as soon as it's
     pushed (the queue takes over from safety right away).
4. **How far.** At least `minItems` (2) entries and `minAheadMs` (10 min) of audio queued past the
   item on air, at most `maxItems` (8).
5. **What's skipped.**
   - Uncached items, files the engine refused (422) and items with no playout file are passed
     over; the next playable item takes their place.
   - Markers push nothing. A live slot pushes nothing and holds what follows until its end.
6. **Anchors** (`timing`), within the lookahead:
   - `hard`: an overrun drops whole queued entries that fit in it, then trims flexible ones
     (song, bed, fill) to no less than 30 s, from the tail backwards. A gap over `holdGapMs` (5 s)
     holds the item until its anchor.
   - `soft`: entries that would start at or after the anchor are dropped, plus the last one if it
     would end past `anchor + cap`.
   - `not_before`: held until its anchor (gap over 5 s).
   - What re-planning can't absorb is logged as `late`. The engine-timed cut (ADR 0003
     `POST /v1/schedule`) isn't on the engine yet.
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
- **`amplify_db`**: the log's `gainDb` override, else `getPlayoutGain` (#19); omitted at 0.
  Segments carry it per part.
- **Title, artist**: the item's title, else the asset's; artists joined with `, `.

## Cache, alerts, as-run

- **Miss at plan time**: the feeder skips the item and calls
  `playoutCache.requestUrgentFetch(scope, fileId)`, at most once a minute per file. The cache
  raises `cache.item_missing` itself.
- **422 at push time**: the file is skipped for 60 s, fetched urgently, and
  `playoutCache.requestSync(scope)` reconciles the cache table with the disk.
- **Alerts** (`app.alerts`), raised and resolved on change only:
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
  - Before every change to an engine queue, the feeder checks that its session (and so its
    lock) is still alive.
- The engine adapter comes from `engineLifecycle.adapterFor(stationId)`, which works on any
  replica.

## Tests

- `pnpm vitest run apps/api/src/modules/engine/feeder`: unit tests.
  - The planner: how far ahead, the start point, skips, anchors, re-planning after an edit,
    the diff, and two DST days of the Europe/Paris fixture log.
  - The push bodies.
  - The feeder loop against an in-memory engine.
- `feeder.int.test.ts` (integration project `engine`): a real Liquidsoap running the station
  template, a real database (log, library, cache table), sine tones in the engine's cache.
  - Its own compose project `ondes-engine-feeder-it`: control on 127.0.0.1:17380, events
    server on :17381. Override with `FEEDER_IT_CONTROL_PORT` / `FEEDER_IT_EVENTS_PORT`.
  - Plays the log in order and skips the uncached item.
  - Edits the item after next and checks it airs while the item on air plays out.
  - Restarts the engine and checks the log comes back.
