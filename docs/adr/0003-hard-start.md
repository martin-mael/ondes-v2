# ADR 0003: Hard starts: re-plan the tail, cut on the engine's audio clock

- Status: accepted
- Date: 2026-10-20
- Issue: #14 (spike). Consumers: #29 (feeder), #46 (back-timing), #52 (markers), #27 (template), #28 (adapter).

## Context
A pre-recorded episode must start at its slot time, HH:00:00, and the music before it must end cleanly (spec #1, epic #43). Node owns the log and feeds each station's Liquidsoap 2.4.6 just in time (ADR 0002). We needed to know how precisely an item can start at T, where the error comes from, and which correction to build.

Everything below was measured by `engine/spikes/hardstart`: one engine per lane (scenario × strategy), the same playlist of 14 songs (FLAC, MP3, AAC, 48 kHz FLAC, WAV, crossfades from 0 to 6 s) into a seeded-noise episode, driven by a Node feeder. The episode's first sample is located in the recorded output by cross-correlation (sample-exact, correlation 1.00). Numbers and method are in `engine/spikes/hardstart/RESULTS.md`.

## What we measured

### 1. `time()` is a noisy clock; the audio timeline is not
Liquidsoap computes each 20 ms frame some time after its nominal instant. With 15 engines on one Docker VM the delay was 46–78 ms at the median and up to 131 ms, and it jitters from frame to frame. The audio itself is a steady stream: frame *n* plays at `origin + n × 20 ms`, plus the output's constant latency (encoder, Icecast and player buffers, which nothing on our side controls and which is the same for every item).

So "when did the episode start" must be answered on the **audio timeline**. Anything keyed on `time()` inherits the jitter:

| reference | episode start vs T, same engine-timed cut |
|---|---|
| gate on the audio timeline | **−0.2 to +1.5 ms** |
| gate on `time()` at frame computation | −57 to −98 ms (early: frames computed late look "on time" too soon) |
| as-run `at` from `time()` in the callback | +7 to +210 ms vs the audio, depending on load |

Also: `json.stringify` prints floats with 12 significant digits, so the event envelope's `at` (epoch seconds) has **10 ms resolution** in 2.4.6.

### 2. The natural chain is late by exactly one frame per crossfade
Played back to back with no correction, each song started **20.0 ms (±0.5) later than planned per transition**, in every lane, whatever the queue depth (1 or 3 items ahead). It's deterministic: the crossfade hands over on the frame after the planned one. Cue rounding and decoder effects stay below that (FLAC playout copies, spike #12). Over a 14-song hour that is ≈ 0.28 s. It's systematic, so the planning model can absorb it: **add one frame per crossfaded transition**. (Measured on FLAC and on an MP3 played to its natural end; the full matrix of formats and the 0 s overlap is in RESULTS.md.)

### 3. Correction strategies
Episode start minus T, measured in the recorded audio. "Late" = 10 s more music than time; "early" = 25 s too little (the smoke matrix, `dev4`); see RESULTS.md for the full-length runs.

| Strategy | Late | Early | What it sounds like |
|---|---|---|---|
| None | +10.06 s | −24.94 s | whatever upstream got wrong, in full |
| Re-plan the tail (re-push the last song with a new cue-out; bed when early) | **+59.8 ms** | **+45.0 ms** | music ends on its own fade into the episode |
| Time-stretch the last song (`soundtouch`, ±4 %) | – | +53.4 ms (1 s gap) | works, but only for small gaps and every item goes through soundtouch |
| Hard, Node-timed: clear the queue, `POST /v1/skip` at T | −59.8 ms (+40 ms in another run) | – | abrupt cut of the song on air |
| Soft: let the item on air finish, cut at T + cap | +4.94 s (cap 5 s) | – | lateness up to the cap by design |
| Hard, engine-timed: `POST /v1/schedule {at: T}`, cut with a 1 s fade-out | **+0.6 ms** | −0.2 ms (long bed under it) | song fades out under the episode |
| **Combined: re-plan + engine-timed cut** | **+1.0 ms** | **+1.5 ms** | music ends on its own; the cut only absorbs the residual |

The re-plan residual (+40 to +60 ms) is the one-frame-per-transition lag after the last re-plan (two or three transitions); with the planning model of §2 it drops to the frame level.

Other measurements:
- Push 12 ms median (max 50 ms), remove 3 ms (max 21 ms), schedule 6 ms. A re-plan (remove + re-push of the tail) costs < 0.1 s and never disturbed the item on air.
- Re-planning on every `track.started` converges: after the first big correction, each later one moved the cue-out by one frame (19–20 ms).
- The scheduled request is prepared on the frame where the gate opens; for a local FLAC this cost nothing measurable (the same +20.0 ms with or without fetching it ahead).
- The switch takes effect **one frame after** its predicate first holds (+20.0 ms on every lane before compensation), hence a one-frame lead in the gate.
- Queue depth 1 vs 3 changed nothing in timing. The push deadline (how late the feeder may push the next item) is in RESULTS.md.
- A failing `output.file` (permission denied) **kills the engine** in 2.4.6. Any recorder or archive output in #27 must not be able to stop the station.

## Decision

**Target accuracy: ≤ 20 ms on the audio timeline (one frame), measured ≤ 2 ms.** The ≤ 1 s goal of #14 is met by every strategy except none and soft; the ≤ 100 ms goal by re-plan, Node-timed cut and engine-timed cut; only the engine-timed cut is load-independent.

Use **both** mechanisms, each for what it's good at:

1. **Back-timing + runtime re-plan** makes the music *arrive* at T: the last song before a hard start is flexible (a cue-out range), a filler bed covers what it can't, and the feeder re-plans on every `track.started` from the as-run audio-timeline time. This is what makes it sound right.
2. **An engine-timed cut** makes the episode *start* at T regardless of what went wrong (a skip, a live overrun, a wrong duration, a Node outage): Node schedules the episode ahead, the engine opens the gate on its own audio clock and fades out whatever is on air. This is what makes it exact.

Rejected:
- **Node-timed skip** as the mechanism: ±60 ms, load-dependent (Node timer + frame delay), and a dead engine adapter at T means no start at all.
- **Soft as the default**: it's a policy (late by up to the cap), not a timing mechanism. It stays available per slot (#46/#52), implemented with the same engine cut at T + cap.
- **Time-stretch** as a default: `soundtouch` must sit on the whole queue path, only ±3–4 % is inaudible (≈ ±8 s on a 4-minute song), and the bed plus cue-out re-plan covers the same cases. Keep it as a possible later refinement.

## Consequences

### Engine (#27 template, #28 adapter): contract additions (`contract:` PR first)
- **`POST /v1/schedule {item_id, uri, at, fade_out?}`** → 201 like a push. The engine holds the item in a `scheduled` `request.queue` behind a `switch` gate, above the automation fallback and below live. `at` is wall-clock epoch seconds. Replaces any previous schedule; `DELETE /v1/schedule` cancels it.
- **Gate on the audio timeline**, not `time()`: keep `clock_origin = min(time() − source.time(radio))` and `frame_pos = source.time(radio)` in an `on_frame(before=true)` callback; open when `clock_origin + frame_pos ≥ at − frame_duration − frame_duration/2` (one frame of switch latency, then the nearest frame).
- On taking the air: fade out the automation over `fade_out` (default 1 s) while the scheduled item plays at full level from its first sample, then `skip()` the interrupted automation so it doesn't resume after the episode. The fallback back to automation after the episode uses the normal transition.
- **Events carry the audio-timeline time**: `at` becomes `clock_origin + frame_pos` (millisecond precision: send it as integer milliseconds or a string, since 2.4.6 prints epoch floats with 10 ms resolution), and every event gets `audio_pos`. The callback time stays available for debugging.
- `source: "scheduled"` joins `engineSourceSchema`; `track.started` for the scheduled item is the as-run of the hard start.
- Reference implementation: `engine/spikes/hardstart/station.liq` (`HARDSTART` blocks).

### Feeder (#29)
- Push hard-start items with `POST /v1/schedule` as soon as they enter the feeding window (and again after any engine restart: a new `boot_id` loses the schedule).
- On every `track.started` before a hard start: predict the episode's start (as-run time of the item on air + planned slots of the rest), and if it's off by more than a frame, re-plan the flexible tail: remove the queued items from the first changed one on, re-push them in order with the new cue-out / bed length. Never touch the item on air.
- Slot model: `slot = (cue_out − cue_in) / tempo − overlap(next) + 1 frame` per crossfaded transition (overlap = min(cross_out, next cross_in), ADR 0002).
- When the episode's `track.started` arrives: `DELETE /v1/queue` and push the post-episode items.

### Back-timing (#46)
- Before a hard start, end the hour on a **flexible last song** (a cue-out range: its autocue cue-out down to a minimum length, with a fade-out), followed if needed by a **filler bed** sized at runtime. The generator targets the middle of that range so the re-plan can absorb drift either way.
- Policy per slot: **hard** (engine cut at T, default) or **soft** (let the item on air finish, at most T + cap; see Markers for how the feeder does it).
- Acceptance over 2 weeks of as-run: episode start within one frame (20 ms) of T on the audio timeline, measured with the audio-timeline `at`.

### Markers (#52)
- **Hard** = engine schedule at T (fade the item on air).
- **Soft** = at T the feeder removes the intervening queued items. It knows when the item on air ends: if that's before T + cap, it pushes the marker item next in the queue (it starts on the item's natural end); otherwise it schedules it with the engine at T + cap.
- **Not-before** = the feeder holds the item until its predicted start is ≥ T and fills before it; no engine cut.
- Engine integration tests: reuse this spike's recorder + correlation method (`engine/spikes/hardstart/spike.ts`).
