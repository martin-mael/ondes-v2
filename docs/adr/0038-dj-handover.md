# ADR 0038: DJ handover: crossfade between inputs, scheduled handovers, mute

- Status: accepted
- Date: 2026-10-27
- Issue: #66 (epic #62). Builds on ADR 0023 (DJ identities, revocation), 0027 (harbor pool,
  live sessions, switching), 0033 (live slots and events) and 0035 (pre-listen). Read by
  live recording (#67, ADR 0039), live metadata (#68, ADR 0040) and dashboard quick actions
  (#72).

## Context
At an event several DJs play one after another. #64 already let the next DJ connect to a free
input of the pool and wait while the current one is on air, and `PUT …/live/on-air` hands the
air over with the input switch's fixed 1 s crossfade. #71 added pre-listen of each input. Left
for #66:
- the crossfade was fixed and linear: two unrelated DJ mixes summed with linear fades dip 3 dB
  in the middle;
- a handover only happened when someone clicked at the right second;
- a manager could disconnect a DJ (#64's kick) but not silence them without hanging up;
- a DJ handed the air during a slot or event with no slot of their own (a guest, the next DJ of
  the night) got an unbound session: the as-run and the recording (#67) lost the show and the
  episode halfway through it;
- no UI for any of it.

## Decision

### The crossfade between DJs (engine)
The `live_inputs` switch (ADR 0027) gets its own transition, `live_handover`, separate from the
gate's 1 s takeover and return fades:
- **Length per handover.** `POST /v1/live` takes an optional `fade` (seconds, 0–10; 400
  beyond). It sets a ref the transition reads when it runs; absent, the last value stays (1 s at
  boot, the pre-#66 behaviour). `0` is a cut. Node always sends one: the api's `fadeMs`, default
  `LIVE_HANDOVER_FADE_MS_DEFAULT` (2 s). The rejected alternative was a station engine setting:
  a manager wants a cut at one changeover and a long blend at the next, and changing a setting
  restarts the engine.
- **Equal power.** In² + out² = 1, so the level stays flat while two unrelated signals overlap.
  Liquidsoap's `sin` fade is an S-curve (in + out = 1, the same −3 dB dip as linear: the first
  recording measured a 2.5 s audible overlap for a 3 s fade); `log` with curve 6,
  ln(1 + 6x) / ln 7, keeps in² + out² within 0.15 dB of 1 across the fade. Measured on the real
  engine: −9.3 ± 0.2 dBFS all through a 3 s crossfade of two −9 dBFS DJs, overlap 3.0 s.
- **Only from a DJ on air.** The input switch also changes input when the gate opens on another
  input than the last show's; that one is covered by the gate's own fade, and the input it leaves
  isn't on air, so the transition is a cut whenever `live_on_air` is 0. Before #66 the new DJ
  faded in twice there (gate and input switch).
- ADR 0027's guarantee is unchanged: the switch waits for the new DJ to be ready (buffered), the
  DJ on air stays on air meanwhile, under their own session.

### Mute (engine)
Each input's audio goes on air through a gain (`amplify`, the DJ's own `liq_amplify` metadata
ignored) that ramps to 0 or 1 over 100 ms, so muting never clicks: at most one 100 ms window
between full level and silence on each side. `POST /v1/live/mute {input, muted}`; the state's
`inputs[]` gains `muted`; the engine emits `live.muted` (domain `engine.live.muted`). The DJ
stays connected, and on air if they were: silence until unmuted. It's for a moment (a mic left
open, a bad feed while someone calls the DJ); a longer silence is the blank detector's, and
"take them off" is back to automation or the kick. Pre-listen taps the input before the gain,
so a manager hears the muted DJ and knows when to unmute. A mute never carries over to the next
DJ on the input: the engine resets it when a DJ connects and when one hangs up, and refuses
(409) to mute an input nobody is connected on, as does the api (`live_input_not_connected`),
which checks the engine's state first and maps the engine's refusal when the DJ hung up in
between. Unmuting an empty input is a harmless no-op. Rejected: muting by closing the gate (that is a
return to automation, which ends the session and plays the return file).

### Kick
Unchanged from ADR 0027 (`POST …/live/inputs/:input/disconnect`, the engine's `stop()`): #66
adds the UI, behind a confirmation, since it hangs up the DJ's software.

### A handover keeps the show, episode or event it happens in
`goLive` binds a session to the incoming DJ's own running slot or event (ADR 0033). When they
have none, and the session they take the air from is bound to a slot or event that is still
running (`scheduled_end_at` in the future), the new session takes that binding: same show,
occurrence and episode (`startLiveEpisode` returns the episode already aired), or the same
event, title and end. So a night of three DJs in one slot is three `live_session` rows ending
`handover`, all with the slot's `episode_id`: the as-run shows one programme, #67 records one
episode (it groups by episode, else event), and the slot never counts as missed. The trigger
stays `manual`: ADR 0033's takeover never takes the air back from a DJ put on air by hand, and a
DJ whose own slot starts later is bound in place as before (`bind`). The same goes for a DJ
approved ad hoc (ADR 0027's request) while a slot or event of someone else runs: the approval is
the manager handing them the air within that programme, so the session (trigger `ad_hoc`)
carries the slot's show and episode or the event, exactly like a DJ put on by hand; an ad-hoc DJ
with an unlisted event of their own keeps that one. Past the slot's end nothing
is carried over. `bindingOfSession` rebuilds the binding from the row; the occurrence's start
isn't stored on the session and isn't read by anything that reopens a binding, so the session's
start stands in for it.

### One switch at a time per station
`goLive` (by hand, an approval, the slot takeover or a scheduled handover, on any replica) runs
under a per-station Postgres advisory lock (`pg_advisory_xact_lock` on `live-switch:<station>`),
held by a transaction for the whole switch: the database writes (committed on their own before
the engine is told, as in ADR 0027) and the engine call, and its undo. Without it, a handover
firing while a member puts someone on air could commit one session last and leave the engine on
the other's input. The lock goes with the transaction, or with the connection if the replica
dies. A switch that waits more than 30 s (`lock_timeout`) gets a 409 `live_switch_busy` rather
than queueing forever.

### Scheduled handovers (`apps/api/src/modules/live/handover.ts`)
`live_handover` (new schema file `live-handover.ts`): station, streamer (composite key, so never
another tenant's DJ; deleting the streamer deletes them, so the list never shows a handover to
nobody), `at`, `fade_ms` (0–10 000), `status`
(`pending` → `running` → `done` | `failed` | `cancelled`), `reason`, the `session_id` it opened,
`created_by`, `claimed_at`, `ended_at`.
- **The target is a DJ, not an input.** At its time the api looks for the input that streamer
  is connected on: the next DJ may not be connected when the handover is planned, and may pick
  any free mount.
- **On time, once.** Every replica's switch sweep (5 s) arms a timer for each pending handover
  due within 10 s; scheduling one due sooner arms it at once. Whichever timer fires first claims
  the row (`update … where status = 'pending'`); the other replicas find it claimed. Then
  `goLive(input, 'manual', fadeMs)` as the system actor `live-handover`, and the row ends `done`
  with the session, or `failed` with a reason (a failure of the switch only: once the DJ is on
  air nothing turns it into a failure): `not_connected`, `streamer_not_allowed`
  (disabled or expired since), `engine_unavailable`, `error` (logged). A DJ already on air on
  that input is `done` with their session, nothing switched. Rejected: scheduling in the engine
  (`POST /v1/schedule` style, as hard starts do): Node must create the session first and check
  the streamer at the time, and a timer plus a claim keeps it to one Node-side path.
- **Never late by surprise.** More than a minute late (no api was running at its time), it fails
  `missed` rather than switching at a time nobody chose. The replica carrying one out renews its
  claim every 15 s while the switch runs (it may wait for another switch, or a slow engine); a
  claim not renewed for a minute (its replica died) fails `interrupted`. Every write is scoped to
  the station.
- **Not only a handover.** With nobody on air at its time, the DJ simply goes on air: a planned
  start for an event DJ who isn't listed.
- Routes: `GET …/live/handovers` (`live:read`; pending, running and those that ended in the last
  24 h), `POST …/live/handovers {streamerId, at, fadeMs?}` (`engine:control`; `at` in the
  future and within 24 h), `DELETE …/live/handovers/:id` (`engine:control`; cancels a pending one,
  409 once it ran). Audited `live_handover.create|cancel|run|fail`. Real-time
  `live.handover.changed {handoverId, status}` (`engine:read`).

### Api
- `PUT …/live/on-air` gains optional `fadeMs` (0–10 000).
- `PUT …/live/inputs/:input/mute {muted}` (`engine:control`), audited `live.input.mute` with the
  input's state before (from the engine) and after; 409 for an input nobody is connected on.
- `live.session.start` audits record the crossfade asked (`fadeMs`).
- `GET …/live/status` inputs gain `muted`.
- `LiveSwitchEngine` gains `muteLive`; the engine adapter gains `muteLive` and `fadeMs` on
  `setLive` (sent in seconds).

### UI (`apps/web/src/features/live/handover.tsx`)
Self-contained components that take the station id and the live status, so #72's quick actions
can reuse them: `LiveInputActions` (put on air, or "Hand over" when another DJ is on, with the
chosen crossfade; back to automation for the DJ on air; mute/unmute; disconnect with a
confirmation), `HandoverFadeSelect` (cut, 1, 2, 3, 5, 8 s) and `ScheduledHandovers` (the list in
station time with cancel, and a dialog to schedule one, typed in station time, guarded against
unsaved changes). The list shows the day as well as the time (it spans up to 48 h). All render
nothing without `engine:control`. The dashboard's live sources
panel (#71) mounts them under its pre-listen buttons, with a "Muted" badge, and refetches on
`engine.live.muted`.

## Consequences
- Contract changes are additive: optional `fade` on `POST /v1/live`, a new engine route and
  event, optional `muted` in the engine state and the live status, optional `fadeMs` on
  `PUT on-air`, new routes, a new real-time event and a new contract file
  (`contracts/live-handover.ts`).
- Migration `*_live-handover` (new table only). No new engine setting, so no new template
  combo; every station's engine restarts once to pick up the new template.
- Template changes stay in blocks marked `DJ handover (#66, ADR 0038)`: the gain in
  `live_input_of`, the `live_handover` transition before `with_live`, the `fade` field of
  `handle_live` and `handle_live_mute`. #67 records `radio` while `live_on_air` is set and
  reopens its file per session, so a handover splits the recording at the new session's first
  frame (mid-crossfade) and a mute is recorded as silence. #68's tags ride on the input switch
  above the gain, which passes metadata through.
- Tests: `live/live-handover.engine.int.test.ts` (engine project) records the real template's
  output, driven by the real switcher and scheduled handovers on a throwaway database (a stub of
  the harbor auth callback names each DJ): two DJs connected, a scheduled 3 s handover found on
  DJ 2's input and run by its timer (overlap 3 ± 0.3 s, total level within 1 dB of the
  DJs' through it, no window under −40 dBFS), a 2 s mute (silent on air, 100 ms ramps, the DJ
  still connected and pre-listen still streaming), a cut back (no gap, no overlap), a fade over
  10 s refused, and a mute refused once the DJ hung up, the input unmuted. `live/handover.int.test.ts`: the crossfade asked of the engine, the binding
  carried over (and not past the slot, and on an ad-hoc approval), mute (never carried over, the
  audit's real `from`), two replicas switching at once (the engine ends on the session the
  database has open), scheduled handovers (on time, two replicas, the sweep's timers, a slow
  switch keeping its claim, not connected, disabled, missed, interrupted, cancel, another
  station, validation).
  `live.int.test.ts`: routes, permissions, audit. `features/live/handover.test.tsx`: the panel's
  actions, the schedule dialog in station time (with the DST changes of March and October in Paris),
  contract-shaped answers, nothing for a presenter.
