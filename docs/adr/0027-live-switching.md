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
- **A handover never drops the air.** The input switch lets through the selected input once it
  is *ready* (buffered); while the new DJ is still buffering, the DJ on air stays on air, tagged
  with their own (previous) session, and the switch crosses over when the new one is ready.
  Without this, `PUT on-air` right after a DJ connected fell to automation: the interrupted
  item was dropped and the return jingle played in the middle of a show.
- The gate switch doesn't replay metadata (`replay_metadata=false`) and the takeover inserts
  fresh tags: reopening the gate on the input of the previous show would otherwise replay that
  show's session id.
- `POST /v1/live/disconnect {input}` (additive) calls the input's `stop()`: the real disconnect
  ADR 0023 left to #64.
- `live.connected` forwards only the headers that describe the client and its stream
  (`user-agent`, `content-type`, `ice-*`, `icy-*`), never `Authorization` or anything else the DJ
  software sends: the event is readable with `engine:read`.
- `GET /v1/state` `live` gains `selected`, `on_air`, `session_id` and `inputs[]` (mount,
  connected, ready, streamer_id). All additive and optional in the contract.

### Return to automation: cut what live interrupted, the return file, then the log at now
When the gate hands the air back (gate closed, or the DJ on air hung up), on the clock thread:
1. the queue's segment that live interrupted is marked aborted (its remaining requests are
   released by `next_segment`, like a skip);
2. the interrupted track is skipped **before the crossfade**, with a zero end duration set on it
   at the takeover (`liq_cross_end_duration=0`, `liq_fade_out=0`, inserted while it is still the
   current track). Skipped as is, the crossfade faded it out over the next one: the first
   recording had 0.9 s of it back on air. Set at the return instead, the override landed on the
   return file, which the fallback switches to in the same frame;
3. what comes back (return file or the log's next item) starts at full level (`liq_fade_in=0`,
   no start overlap): when the DJ hung up there is nothing to fade out over, and a fade-in from
   silence measured under −40 dBFS for 100 ms;
4. the return file (`live.returnFile`, optional) is armed: a one-shot request at the head of the
   automation fallback, annotated with no fade-in and no start overlap, its metadata dropped but
   for the `liq_*` keys. It's a track of the automation chain like any other, so the station
   crossfade joins it to the log's next item; the DJ fades out over it;
5. the queue then plays what the feeder queued **for now**.

**A manual return holds for the rest of the slot.** The takeover rule below would otherwise put
a DJ who is still connected in their slot back on air within one sweep (5 s) of
`DELETE …/live/on-air`. A session that ended `returned` (a manual return, or a gate closed by
hand) during the current live slot of that streamer suppresses the automatic takeover until the
slot ends **or the DJ logs in again** (`streamer.last_connected_at` later than the return: they
hung up and reconnected, which is how a DJ asks to be back). A manager can still put them on air
by hand. It is read from `live_session` and `streamer`, so every replica's sweep agrees.

The feeder needs no change for "resume at now" (we agreed with #57 to keep it out of this PR):
while live is on air the engine's `on_air.source` is `live`, so the feeder already plans as if
the log weren't on air (ADR 0012): it starts at the first item planned less than `joinLateMs`
ago that didn't air, holds what follows a running live slot until its end, and keeps the engine
queue matching that plan on every tick. Missed items are passed over (`feeder.item.passed_over`);
the queue is never reordered; the interrupted item aired (as-run has it) and is never pushed
again. So after the show the log continues at the current time with no replay.

Without a return file the log's next item comes straight in, at full level, under the DJ's
fade-out (or right after a hang-up). The lifecycle points `returnFile` at
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
  before opening the gate"). The DJ may still be buffering: the engine holds the selection until
  they are ready, without leaving the DJ on air. One transaction closes the open session
  (`handover`), inserts the new one and audits both; **then**, after the commit, `POST /v1/live`.
  If the engine refuses, a compensating transaction deletes the new session and reopens the
  previous one (audited `live.session.start_failed`). Calling the engine inside the transaction
  was rejected: a rollback after the engine accepted would leave a DJ on air with no session.
- **Same input, other DJ.** An open session is reused only for the same input *and* the same
  streamer; a different DJ on that input (missed disconnect and reconnect) gets a session of their
  own, so `live_session.streamer_id` and the as-run's `live_streamer_id` never name the wrong DJ.
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
  closes a session the engine no longer reports (gate closed, input empty, other session id, or
  another streamer on its input, in which case it closes the gate too), but not in its first
  10 s, while the engine call of a new session may still be on the way.
- **Kick** (`POST …/live/inputs/:input/disconnect`, `engine:control`).
- `GET …/live/status` (`live:read`): the pool with streamer names, the input on air, the open
  session.
- Real-time events `live.session.started` / `live.session.ended` (`engine:read` in
  `realtimeEventPermissions`), next to the engine's own `engine.live.*` events, which now carry
  `input` and `streamerId`.

**Connect/disconnect and the as-run.** As-run still records only what aired: one entry per live
session and input (keyed `live:<session>:<input>`, so the DJ's title updates don't split it),
with `live_session_id`. For a past day a consumer (the log-vs-as-run overlay, #53) reads:
- **on air**: the as-run entries with `source = 'live'`, joined to `live_session` on
  `live_session_id` for the DJ (`streamer_id` → `streamer.display_name`), the input, what started
  it (`trigger`) and why it ended (`end_reason`: `disconnected` is the DJ hanging up while on air);
- **connected but not on air** (a DJ waiting, a soundcheck): not stored. The engine's
  `engine.live.connected` / `disconnected` events are real-time only; the audit log keeps accepted
  logins (`streamer.connect`, at most one per streamer per 10 minutes, ADR 0023) and revocations.
  A table of connections can be added when a screen needs them.

### Revocation (ADR 0023, completed)
With the pool the engine says which streamer holds each input. Disabling, expiring or deleting a
streamer, in this order: ends their session (`revoked`; first, so the sweep can't record it as a
plain return once the gate is closed), closes the gate if it lets their input through, and hangs
up every input they hold, carrying on past a hang-up that fails (logged as an error). The
switcher's sweep checks every connected streamer's status on each run and revokes again any who
may no longer be on (`onNotAllowed`): it retries a failed hang-up every 5 s, and catches an expiry
the expiry sweep missed. A retry that changes nothing isn't audited again. An engine rendered before #64 (no `inputs` in its state) keeps ADR 0023's
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
  real template with two stand-in DJs and records the final mix, each source its own tone.
  `switching.int.test.ts` covers sessions, takeover rules, the manual return holding, the replica
  race, another DJ on the same input, the engine refusing a handover, disconnects, restarts and
  revocation (including a failed hang-up and its retry) against a real database.
- The recorded test runs two shows: A → DJ 1 → DJ 2 (handover asked before DJ 2 is ready) →
  return jingle → B → DJ 2 → a missed item X is passed over → DJ 2 hangs up with no return file
  → C. It checks the tone order, no window under −40 dBFS from the first tone to the last, that
  A, B and X never come back (their own frequency stays under −30 dBFS; transitions leak −51 to
  −38 dBFS for one window), the as-run and the forwarded headers. `live-auth.engine.int.test.ts`
  checks streamer attribution on the real engine through the auth callback; `resume.test.ts`
  checks the feeder's plan while live is on air (resume at now, nothing replayed, order kept).
- Follow-ups: choosing the return file in the UI and syncing it into the cache (until then the
  log comes back at full level under the DJ's fade-out, no silence); the Live page's on-air
  controls (#72 dashboard, #66 handover UI build on these routes).
