# ADR 0029: Log vs as-run: how plan and aired rows are matched

- Status: accepted
- Date: 2026-10-22
- Issue: #53. Builds on ADR 0015 (as-run), 0012 (log feeder), 0017 (segues and islands) and
  0022 (missing-episode fallbacks).

## Context
The log is the plan; the as-run (ADR 0015) is what aired. For a past day, programmers want to
see both at once: what aired on time, late, cut, or not at all, what took the place of what,
and when the engine fell back on its own (safety playlist, emergency file) or a DJ went live.
The as-run is append-only and keeps snapshots of the plan (`planned_start`,
`planned_duration_ms`), but the log can be edited or regenerated after the fact, and some audio
(safety, emergency, live) has no log item at all.

## Decision
- **Matched on the server**, in a pure function (`apps/api/src/modules/asrun/overlay.ts`),
  behind `GET /api/v1/stations/:stationId/asrun/overlay?date=YYYY-MM-DD` (`log:read`, like the
  as-run). The web view only groups and renders. One request per station-local day (23–25 h);
  no pagination (a day is a few hundred rows).
- **Rows**, in air order: one per as-run entry, plus one per plan item that has none. Each row
  has a `status`, the plan item as the log has it now (or null) and the entry (or null).
- **Matching, in order:**
  1. **By log item id.** The recorder keeps `logItemId` only when it was the station's own
     item when it aired, so the match is exact. An island part matches its part; an entry that
     names the segment itself (a rendered island reported as one item) matches the segment.
     A plan item with several entries (aired again after an engine restart) gets a row per
     entry; later ones are `repeat`.
  2. **Live by time.** A `live` entry with no log item takes the `live_slot` it overlaps.
  3. **Everything else is off-plan:** `live` (outside any slot), `safety`, `emergency`, or
     `unplanned` (from the log, but no item of the current plan matches it: the day was
     regenerated or the item deleted; the entry's plan snapshot still says when it was due).
- **A plan item with no entry** is `pending` while its slot hasn't ended (against the api's
  clock, returned as `now`), `replaced` when off-plan audio overlapped its slot by more than
  the as-run tolerance (2 s, `AS_RUN_TOLERANCE_MS`; a crossfade tail doesn't count), with the
  ids of those entries in `replacedBy`, and `missed` otherwise. The feeder's reason for passing
  an item over (#29) is a transient event, not stored, so it isn't shown.
- **A matched item** is `fallback` when the entry says it aired as a missing episode's fallback
  (ADR 0022), `live` for a live slot, `replaced` when the entry's asset isn't the plan's, else
  `aired`. Cut, skipped and interrupted stay the entry's `outcome` (ADR 0015), shown next to
  the status.
- **The day is the plan's day.** Plan items are those starting in the local day (markers are
  left out: they never air). Entries are read 3 h either side of it, so an item planned at
  23:59 that aired at 00:01 stays with its day; off-plan entries outside the day are dropped.
- **Drift** is the entry's own `driftMs` (`startedAt − plannedStart` as planned when it aired),
  not recomputed against today's plan.
- **Station time only** in the view (ADR 0009 and CLAUDE.md): times are formatted in the
  station's IANA zone; hours are real hours, so the October DST day has two `02:00`, told apart
  by their offset.

## Assumptions about work landing in parallel
- **Islands (#57).** Whether the engine reports an island as one item (the segment) or one per
  part, both match (rule 1). A segment counts as aired as soon as any of its parts did; parts
  never get rows of their own when nothing aired.
- **Live (#64).** Expected: one `source = live` entry per session (connect to disconnect), with
  `liveSessionId`. A live entry per metadata change also works (each takes the slot it
  overlaps). Extra fields (DJ name, show) would only add to what the row shows.

## Consequences
- The contract adds `asRunOverlay*` schemas to `contracts/asrun.ts` (additive).
- Past days open on the overlay in the log timeline (#51); today and the future open on the
  plan, with a tab to switch. The view is read-only, so it needs no unsaved-changes guard.
- `pnpm dev:seed` writes a fixture as-run for yesterday (only when that day has none), so the
  view has data locally (`deploy/dev/seed/asrun-fixture.ts`).
- Matching by time for anything but live was rejected: the recorder already ties entries to
  log items, and time-based guesses go wrong exactly when the day went wrong (drift, overruns).
