# ADR 0034: On-air view: one snapshot, refetched on events, counted on the engine's clock

- Status: accepted
- Date: 2026-10-23
- Issue: #70 (epic #69). Builds on ADR 0002 (engine events), 0003 (hard starts), 0012 (log
  feeder), 0015 (as-run), 0027 (live switching). Built on by: dashboard quick actions (#72).

## Context
The dashboard's on-air widget shows a big station clock, the mode (automation, pre-recorded
show, live with the DJ's name, safety, emergency), the item on air with elapsed/remaining and its
intro/outro markers, the next five items with estimated starts, a countdown to the next fixed
event and the show block with its episode number. It must stay real time over SSE without
polling, and its times must drift no more than 1 s from the engine.

The pieces existed in five places: the as-run (what is really on air, on the engine's clock), the
log (the plan), the show calendar, the live sessions (the DJ's name, only in `GET …/live/status`
with `live:read`) and the asset cues. Reading them from the browser would take five requests and
four permissions, and the next items' starts would still be the plan's, not re-chained from what
aired.

## Decision

### One internal read: `GET /api/v1/stations/:stationId/on-air` (`dashboard:read`)
`apps/api/src/modules/onair` assembles `onAirSchema` (`packages/shared/src/contracts/on-air.ts`):
- **current**: the station's open as-run entry (`getOnAir`, ADR 0015). Its `startedAt` is the
  engine's own `track.started` time, passed through untouched. Expected length: the log's plan,
  else the asset's cue-in to cue-out. Intro end and outro start come from the asset's cues,
  relative to cue-in (time 0 on air).
- **mode** from the entry's source: `live` (the DJ is the entry's live session's streamer, else the
  station's open session), `safety`, `emergency`, `show` when a log entry is an episode (as-run
  `episode`, or kind `episode`), else `automation`. With no open entry, `off_air`.
- **next**: the five log items after the one on air, in published days only, each re-estimated
  (`estimate.ts`, pure). The drift of the item on air (`startedAt − plannedStart`), and while it
  overruns its planned end, `now − plannedEnd`, carries over `flow` items. A `hard` or `soft` item
  starts at its anchor and resets the drift (ADR 0003). A `not_before` item starts at the later of
  its anchor and the chained time. Off the log (live, safety), the plan from now on.
  When a segment part is on air (an island chain: A's body, the island, B's body), the parts
  after it come first, then the items after the segment.
- **nextHardEvent**: the earlier of the first `hard` (`hard_start`) or `soft` (`soft_start`)
  item or marker after the one on air, parts included, and the next show occurrence's start,
  within 24 h.
- **show**: the occurrence now covers (the latest-starting one if two overlap), with its show's
  colour and artwork, and its episode: for a rerun, the episode aired again.

It stays internal and authenticated. The public now-playing API is #74, with its own shape and
caching.

Rejected: composing in the browser (five calls, four permissions, plan-only starts), and
exposing the feeder's in-memory plan. The feeder's plan is per replica, recomputed every 5 s
and tied to what was pushed (ADR 0012). The estimate here is the same rule applied to the log,
cheap and stateless.

### Real time: refetch on events, plus one timer at the snapshot's own boundaries
The snapshot carries no event of its own. The widget invalidates it on these events:
`asrun.started` / `asrun.ended`, `engine.track.started`, `engine.up` / `down` / `booted`,
`log.updated`, `log.item.changed`, `live.session.started` / `ended`, `feeder.item.passed_over`,
`asset.updated` (cue edits) and `station.updated` (timezone). It also refetches whenever the
stream opens, the first time included: on a cold load an event can land between the snapshot
and the stream, and on a reconnect events were missed. Events come in bursts (an edit fires
`log.item.changed` per item), so invalidations are debounced by 250 ms.

Two changes come with no event: a show block ending, and the next fixed event coming due. For
those the widget sets one `setTimeout` at the soonest of `show.endsAt` and `nextHardEvent.at`
(plus 1.5 s), taken from the snapshot itself. This isn't polling: it fires at an instant the
data named, once.

While the item on air overruns, the snapshot's estimates fall behind by a second a second.
The widget re-derives them on each tick (`withOverrun`): past the later of the item's expected
end and the snapshot's time, the `flow` items move by the overrun, up to the first anchored
item, which keeps its time. A marker among them moves with them, and so does the countdown.

Left without an event: edits to the show calendar (slots, exceptions, episodes, artwork) and
to a live session's DJ name. They show at the next refetch, which happens at least at every item
change. A `show.*` event would close the gap; it belongs to the shows module, not here.

### Time: the engine's clock is the api's; the browser counts on it, waking on boundaries
- The engine and the api run on the same host (one VPS, Docker containers share the kernel
  clock), so the engine's `track.started` times and the api's `server.clock` are one clock. Hosts
  are expected to run NTP. A split deployment would need the engine's offset measured (`GET
  /v1/state` time vs. the api's) and added to the snapshot.
- The browser takes its offset from the stream's `server.clock` events (sent on connect, then
  every 10 s): `offset = at − Date.now()`, kept by the connection (`useClockOffset`, app/sse), so a
  widget mounted after the stream synced has it at once. It never shows browser time, nor any
  zone but the station's: the clock shows dashes until the first `server.clock`, which arrives
  with the connection.
- Every counter is a whole number of seconds from an anchor: the wall clock (0), the item's
  `startedAt`, the next event's time. These anchors have different millisecond phases. A plain
  1 s interval would show each counter up to 1 s late. Instead the widget wakes at the soonest
  next second boundary of any anchor (`nextTickAt`), plus 2 ms. Each display therefore changes
  within a few ms of the engine's instant.
- The error left is the offset's: the one-way delivery delay of `server.clock` (tens of ms on a
  normal connection, re-measured every 10 s). That is well inside the 1 s budget.
  `on-air.test.tsx` checks it against an as-run `startedAt` with the server clock an hour off
  the browser's. `onair.int.test.ts` checks that the api passes the engine's start through to
  the millisecond.

## Consequences
- The dashboard needs only `dashboard:read` to show the air, viewers included. Its real-time
  refresh rides on `log:read` (`asrun.*`, `log.*`) and `engine:read` (`engine.*`, `live.*`) events;
  every role with `dashboard:read` has both (`rolePermissions`: `programmer` gets `log:*` through
  its station work).
- Artwork is the show's (`show.artworkUrl`). Assets have no artwork anywhere: no column, no
  embedded cover extracted at ingest, no endpoint. When they get some, it goes into `current`
  additively, with the show's as the fallback.
- The DJ's name comes from `streamer.display_name`. #65 adds event titles and ad-hoc sessions to
  `live_session`; the badge can show those additively.
- Estimated starts are as good as the log's durations. A skipped or passed-over item isn't
  removed from `next` until the as-run moves past it.
