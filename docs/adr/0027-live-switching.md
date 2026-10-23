# ADR 0027: Harbor input pool and live switching

- Status: accepted
- Date: 2026-10-23
- Issue: #64 (epic #62). Builds on ADR 0002 (engine control, live gate), 0007 (station
  template), 0008 (engine lifecycle, live port pool), 0012 (log feeder), 0015 (as-run) and
  0023 (DJ identities, harbor auth callback). Built on by: live slots and ad-hoc live (#65),
  DJ handover (#66), live recording (#67), live metadata (#68), dashboard quick actions (#72).

## Context
Until #64 a station had one `input.harbor` behind a gate Node opened and closed (ADR 0002).
That left four gaps:
- the next DJ couldn't connect while the current one was on air: harbor takes one source per
  mount;
- Node didn't know who was connected (ADR 0023 guessed "the latest accepted login");
- when live ended, the automation picked up **where it stopped**: the track live interrupted
  played on (Liquidsoap doesn't pull a source that isn't selected, so the crossfade and the
  queue's segment stay frozen mid-track for the whole show);
- revoking a streamer only closed the gate; the source stayed connected.

## Decision

### A pool of harbor inputs, one mount each
`live.inputs` (engine setting, 1–4, default 2) creates that many `input.harbor` on the live
port, mounts `<mount>`, `<mount>-2`, … One DJ per mount; the connection page lists them ("if
`live` is taken, use `live-2`"). The auth callback (ADR 0023) runs per input:
- it refuses a login on an input that already has a DJ, before asking Node (harbor would refuse
  it anyway, and this keeps the input's "who" from being overwritten);
- it sends `input` in the webhook body, and Node answers `200 {streamer_id}`; the template keeps
  that id for the input's `live.connected` / `live.disconnected` events and `GET /v1/state`.

Rejected: one mount for everyone with the second source queued (harbor can't), per-DJ mounts
(mounts are fixed when the script is rendered; streamers come and go at runtime), and a port per
input (one published port per station, ADR 0008).

### The selector: Node opens the gate on one input
`POST /v1/live {enabled, input?, session_id?}` (additive): opening names the input to put on
air (absent: the first ready one, the pre-#64 behaviour) and the **live session** id Node
created. The template tags the live branch with `ondes_live_input`, `ondes_live_session` and
`ondes_live_streamer`; as-run keys live tracks on `live:<session>:<input>`, so a handover is a
new as-run entry and `track.started` carries `live_session_id`, `live_streamer_id`,
`live_input` (as-run already stores `live_session_id`, #30).

Source chain:
```
live_1 ┐                                      ┌ (gate open on a ready input) → live, tagged
live_2 ├ switch(selected input, 1 s fades) ───┤
…      ┘                                      │ switch(track_sensitive=false, 1 s fades)
return file ┐                                 │
queue       ├ fallback → crossfade ───────────┘ (otherwise) → processing → as-run → outputs
safety      │
emergency   ┘
```
- The tag goes **above** the input switch: harbor inputs are active sources, their track starts
  when the DJ connects, not when they go on air, so tagging per input never re-tags on a
  handover.
- The gate is a `switch` on `live_enabled`, not a `fallback` over a gated source: closing the
  gate must leave the DJ available for the 1 s fade-out. With the gate inside the live branch,
  the branch vanished at once and the recording showed 40 ms of silence, then the automation
  fading in from zero.
- Takeover and return are `track_sensitive=false`: immediate (ADR 0002 measured 146 ms).
- `POST /v1/live/disconnect {input}` (additive) calls the input's `stop()`: the real disconnect
  ADR 0023 left to #64.
- `GET /v1/state` `live` gains `selected`, `on_air`, `session_id` and `inputs[]` (mount,
  connected, ready, streamer_id). All additive and optional in the contract.

### Return to automation: cut what live interrupted, the return file, then the log at now
When the gate hands the air back (gate closed, or the DJ on air hung up), on the clock thread:
1. the queue's segment that live interrupted is marked aborted (its remaining requests are
   released by `next_segment`, like a skip);
2. `liq_cross_end_duration=0` and `liq_fade_out=0` are inserted into the automation's stream
   **before the crossfade**, then that stream is skipped. Skipped as is, the crossfade would fade
   the interrupted track out over the next one: the first recording had 0.9 s of it back on air;
3. the return file (`live.returnFile`, optional) is armed: a one-shot request at the head of the
   automation fallback, annotated with no fade-in and no start overlap, its metadata dropped but
   for the `liq_*` keys. It's a track of the automation chain like any other, so the station
   crossfade joins it to the log's next item; the DJ fades out over it;
4. the queue then plays what the feeder queued **for now**.

The feeder needs no change for "resume at now" (we agreed with #57 to keep it out of this PR):
while live is on air the engine's `on_air.source` is `live`, so the feeder already plans as if
the log weren't on air (ADR 0012): it starts at the first item planned less than `joinLateMs`
ago that didn't air, holds what follows a running live slot until its end, and keeps the engine
queue matching that plan on every tick. Missed items are passed over (`feeder.item.passed_over`);
the queue is never reordered; the interrupted item aired (as-run has it) and is never pushed
again. So after the show the log continues at the current time with no replay.

Without a return file the log's next item comes straight in under the DJ's fade-out (with its
own fade-in, or the station default). The lifecycle points `returnFile` at
`<cache>/live-return.flac`; picking that file in the UI and syncing it into the cache is a
follow-up (the safety module owns the fallback files).

### Live sessions and switching in Node (`apps/api/src/modules/live/switching.ts`)
`live_session` (new table): station, streamer (null for the shared password or a deleted
streamer), input, `trigger` (`slot` | `manual`), `started_at`, `ended_at`, `end_reason`
(`returned`, `handover`, `disconnected`, `revoked`, `engine_restarted`). A **partial unique index
on open sessions per station** arbitrates between api replicas: every replica receives the engine
events and runs the sweep; one opens the session, the others hit the index and back off. Closing
is idempotent (`where ended_at is null`).

- **Go live** (`PUT …/live/on-air {input}`, `engine:control`, or automatically): the input must
  have a DJ, and its streamer must still be enabled and not expired (ADR 0023's "check the holder
  before opening the gate"). In one transaction: close the open session (`handover`), insert the
  new one, audit `live.session.start`, and call `POST /v1/live` — if the engine refuses, nothing
  is recorded.
- **Instant takeover in a slot**: on `engine.live.connected` (fanout) and on a 5 s sweep of every
  running station, if no session is open and a connected DJ's streamer has a **live** slot of an
  allowed show running now (`startsAt ≤ now < endsAt`, reruns excluded), it goes on air with
  `trigger: slot`. The sweep covers a DJ who connected early (ADR 0023's 15 min window) and a
  missed event. Any-time streamers outside a slot wait: ad-hoc live, grace periods and
  early-connect policy are #65's.
- **Return** (`DELETE …/live/on-air`): closes the gate, then the session (`returned`).
- **The DJ on air hangs up** (`engine.live.disconnected` for that input): the engine is already
  back on automation; Node closes the session (`disconnected`) and the gate, so whoever connects
  to that input next doesn't take the air by themselves. A DJ who reconnects within their slot
  is put back on air by the takeover rule, in a new session (#67 joins sessions into one
  episode).
- **Engine restart** (`engine.booted`): the session ends (`engine_restarted`). The sweep also
  closes a session the engine no longer reports (gate closed, input empty, other session id).
- **Kick** (`POST …/live/inputs/:input/disconnect`, `engine:control`).
- `GET …/live/status` (`live:read`): the pool with streamer names, the input on air, the open
  session.
- Real-time events `live.session.started` / `live.session.ended` (`engine:read` in
  `realtimeEventPermissions`), next to the engine's own `engine.live.*` events, which now carry
  `input` and `streamerId`. "Connect/disconnect → as-run" is the as-run entries' session id plus
  the `live_session` rows (who, which input, when, why it ended); as-run itself still records only
  what aired.

### Revocation (ADR 0023, completed)
With the pool the engine says which streamer holds each input. Disabling, expiring or deleting a
streamer closes the gate if they are on air, hangs up every input they hold, and ends their
session (`revoked`). An engine rendered before #64 (no `inputs` in its state) keeps ADR 0023's
fallback: the latest accepted login, gate closed. The expiry sweep no longer requires the
streamer to be the latest login: with a pool, a later login doesn't mean they left.

### Shoutcast (ICY) sources
`live.icy` (default off) opens harbor's ICY port (`port + 1`, container port 8006) on the first
input. The lifecycle publishes it on its **own** host port from the pool (`engine_port` purpose
`live_icy`), not the live port + 1, which may belong to another station. Shoutcast clients
connect to the port they're given plus one, so the connection page shows `icy port − 1`. A
station that turns ICY off keeps its reserved port until its engine is removed.

## Consequences
- Contract changes are additive: optional fields on `POST /v1/live`, the state, `live.*` and
  `track.started` events, the auth webhook (`input`) and its answer (`streamer_id`); a new route
  `POST /v1/live/disconnect`; new domain events; `mounts` in the connection info.
- New settings `live.inputs`, `live.icy`, `live.returnFile` (template combos added). Every
  station's engine restarts once to pick up the new template (its config version changes).
- New table `live_session` (migration `*_live-switching`); `engine_port.purpose` gains
  `live_icy` (TypeScript enum only, no migration).
- Each api replica asks every running engine for its state every 5 s for the takeover sweep, like
  the feeder does.
- Tests: `apps/api/src/modules/live/live-switching.engine.int.test.ts` (engine project) runs the
  real template with two stand-in DJs and records the final mix: queue item A → DJ 1 (takeover)
  → DJ 2 (handover) → return jingle → item B, each source its own tone. It checks the tone order
  (A never returns), no window under −40 dBFS between the first and last tone, and the as-run
  and connection events. `switching.int.test.ts` covers sessions, takeover rules, the replica
  race, disconnects, restarts and revocation against a real database.
- Follow-ups: choosing the return file in the UI and syncing it into the cache; the Live page's
  on-air controls (#72 dashboard, #66 handover UI build on these routes).
