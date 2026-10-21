# ADR 0003: Hard starts: re-plan the tail, cut on the engine's audio clock

- Status: accepted
- Date: 2026-10-21
- Issue: #14 (spike). Consumers: #29 (feeder), #46 (back-timing), #52 (markers), #27 (template), #28 (adapter).

## Context
A pre-recorded episode must start at its slot time, HH:00:00, and the music before it must end cleanly (spec #1, epic #43). Node owns the log and feeds each station's Liquidsoap 2.4.6 just in time (ADR 0002). We needed to know how precisely an item can start at T, where the error comes from, and which correction to build. Target from #14: ≤ 1 s, ideally ≤ 100 ms.

Everything below was measured by `engine/spikes/hardstart`: one engine per lane (scenario × strategy), all playing the same 58-minute hour of 14 songs (FLAC, MP3, AAC, 48 kHz FLAC and WAV; cue points on most, natural ends on some; crossfades from 0 to 6 s) into a seeded-noise episode, fed by a Node driver that plays the feeder. The episode's first sample is found in the recorded output by cross-correlation (sample-exact). Full tables, the compressed-hour and push-deadline runs: `engine/spikes/hardstart/RESULTS.md`.

## What we measured

### 1. Measure on the audio timeline, not with `time()`
Liquidsoap computes each 20 ms frame some time after its nominal instant: 45–60 ms at the median, 105–200 ms at p99, isolated spikes up to 0.8 s, varying frame to frame (15 engines on one Docker VM). The audio itself is a steady stream: frame *n* plays at `origin + n × 20 ms`, plus the output's constant latency (encoder, Icecast, player buffers). Over the hour that timeline drifted **≤ 2 ms** against the wall clock in every lane, so there is no clock drift to correct, only jitter to avoid.

Anything keyed on `time()` at callback or frame time inherits the jitter:
- an engine gate on `time()` started the episode **57–98 ms early** (a late-computed frame looks due too soon);
- as-run `at` from `time()` in the callback was 12–350 ms off the audio;
- the event envelope's `at` has **10 ms resolution** (2.4.6 prints epoch floats with 12 significant digits).

The as-run time on the audio timeline (`origin + frame position`) matched the recorded audio to within one frame in every lane.

### 2. The natural chain is late by one frame per transition
With no correction, songs land on a frame boundary: every transition is −1, 0 or +1 frame off the plan, nearly always +1. Over the full hour: **+219 ms at the last song** (12 transitions at +20 ms, the 0 s overlap at −20 ms), identical in four independent lanes to 0.4 ms and the same at queue depth 1 or 3. Decoder effects (MP3 padding, AAC priming, 48 kHz resampling, WAV) and seek rounding (spike #12) all stay inside that frame. It's systematic, so the planning model absorbs it: **+20 ms per transition**. This matches #27's finding that entry ends are frame-granular (ADR 0007).

### 3. Correction strategies
Episode start − T in the recorded audio, full hour (45 s late / 95 s early), and the compressed hour with the planning model (`tail40-lag`, 10 s late / 25 s early):

| Strategy | Late, hour | Early, hour | With +1 frame model | What it sounds like |
|---|---|---|---|---|
| None | +45.24 s | −94.76 s | – | the upstream error, in full |
| **Re-plan the tail**: re-push the last song with a new cue-out; a sized bed when it can't stretch far enough | +40.2 ms | +19.4 ms | **−19.4 / −19.3 ms** | music ends on its own fade into the episode |
| Time-stretch the last song (`soundtouch`, tempo 0.976) | – | +20.6 ms (6 s gap) | – | works for small gaps; audio lags its metadata by ~42 ms |
| Hard, Node-timed: clear the queue, `POST /v1/skip` at T | +20.0 ms | – | – | abrupt cut; −60 to +40 ms across runs, load-dependent |
| Soft: let the song on air finish, cut at T + cap (30 s) | +30.02 s | – | – | late by up to the cap, by design |
| **Hard, engine-timed**: `POST /v1/schedule {at: T}`, 1 s fade-out under the episode | **+0.7 ms** | −0.0 ms (bed under it) | – | the song on air fades out under the episode |
| **Combined: re-plan + engine-timed cut** | **−0.5 ms** | **−0.6 ms** | **+0.6 / +0.3 ms** | music ends on its own; the cut only absorbs the residual |

Also measured:
- Re-planning on every `track.started` converges: after the first correction each later one moved the cue-out by one frame. With the planning model, 4 re-plans per hour instead of 11–14.
- Push median 9 ms (max 142 ms), remove 3 ms, schedule 9 ms over the hour. A re-plan (remove + re-push of the tail) never disturbed the item on air.
- **Push deadline:** the next item must be queued before its crossfade window opens (`end − overlap`). Pushed later, the fallback plays the safety playlist and each miss costs about the overlap (+6 s for a 6 s crossfade). The ADR 0002 policy (2–3 items ahead) is far from it.
- The switch takes effect **one frame after** its predicate holds (+20.0 ms on every lane before compensating), so the gate opens one frame early.
- The scheduled request is prepared on the frame the gate opens; for a local FLAC that costs nothing measurable.
- A failing `output.file` (permission denied) **kills the engine** in 2.4.6.

## Decision

**Accuracy target: within one frame (≤ 20 ms) of T on the engine's audio timeline.** Measured: ≤ 1 ms with the engine-timed cut, ≤ 20 ms with re-planning alone.

Use **both** mechanisms, each for what it's good at:

1. **Back-timing + runtime re-plan** makes the music *arrive* at T. The last song before a hard start is flexible (a cue-out range), a filler bed covers what it can't, and the feeder re-plans on every `track.started` from the audio-timeline as-run time. This is what makes it sound right.
2. **An engine-timed cut** makes the episode *start* at T whatever went wrong (a skip, a live overrun, a wrong duration, a Node outage near T). Node schedules the episode ahead of time; the engine opens the gate on its own audio clock and fades out whatever is on air. This is what makes it exact.

Rejected:
- **Node-timed skip** as the mechanism: tens of ms off depending on load (Node timer + frame delay), an abrupt cut, and no start at all if the adapter is down at T.
- **Soft as the default**: it's a policy (late by up to the cap), not a timing mechanism. It stays available per slot.
- **Time-stretch**: `soundtouch` must sit on the whole queue path, it shifts the audio against its metadata, and only ±3–4 % is inaudible. The bed covers the same cases. Possible later refinement, not now.

## Consequences

### Engine (#27 template, #28 adapter): contract additions, in a `contract:` PR first
- **`POST /v1/schedule {item_id, uri, at, fade_out?}`** → `201` like a push, `422` if unresolvable. The engine holds the item in its own scheduled source (a `request.queue` in the spike; a one-segment source like the main queue in the ADR 0007 template) behind a `switch` gate, above the automation fallback and below live. `at` is wall-clock epoch seconds. A new schedule replaces the previous one; `DELETE /v1/schedule` cancels it. `GET /v1/state` reports it.
- **Gate on the audio timeline.** In an `on_frame(before=true)` callback on the final mix, keep `frame_pos = source.time(radio)` and `clock_origin = min(clock_origin, time() − frame_pos)` (Liquidsoap sleeps when ahead, so the least delayed frame is the true origin). Open when `clock_origin + frame_pos ≥ at − 1.5 × frame_duration`: one frame for the switch latency, half a frame to pick the nearest frame.
- On taking the air, fade out the automation over `fade_out` (default 1 s) while the scheduled item plays at full level from its first sample. Then `skip()` the interrupted automation so it doesn't resume after the episode.
- **Events carry the audio-timeline time.** The envelope's `at` becomes `clock_origin + frame_pos`, sent with millisecond precision (integer milliseconds or a string; 2.4.6 rounds epoch floats to 10 ms). Every event also gets `audio_pos`.
- `source: "scheduled"` joins `engineSourceSchema`. Its `track.started` is the as-run of the hard start.
- No output may be able to stop the station: a recorder or archive `output.file` that fails must not kill the engine.
- Reference implementation: the `HARDSTART` blocks in `engine/spikes/hardstart/station.liq`.

### Feeder (#29)
- Push a hard-start item with `POST /v1/schedule` as soon as it enters the feeding window, and again after an engine restart (a new `boot_id` has lost it).
- On every `track.started` before a hard start: predict the episode's start (audio-timeline as-run time of the item on air + the planned slots after it). If it's more than a frame off, re-plan the flexible tail: remove the queued items from the first changed one on and re-push them in order with the new cue-out or bed length. Never touch the item on air.
- Slot model: `slot = (cue_out − cue_in) − min(cross_out, next cross_in) + 20 ms`.
- Keep every item queued before `end − overlap` of the one before it, plus margin. The 2–3-items-ahead policy does this.
- When the scheduled item's `track.started` arrives: `DELETE /v1/queue` and push the post-episode items.

### Back-timing (#46)
- End the hour before a hard start on a **flexible last song**: a cue-out range from its autocue cue-out down to a minimum length, with a fade-out. Follow it if needed with a **filler bed** sized at runtime. Aim at the middle of the range so the re-plan can absorb drift either way. Plan with the slot model above.
- Policy per slot: **hard** (engine cut at T, default) or **soft** (let the item on air finish, at most T + cap; see Markers).
- Acceptance over two weeks of as-run data: every pre-recorded episode starts within one frame (20 ms) of T, measured with the audio-timeline `at`.

### Markers (#52)
- **Hard** = engine schedule at T (fade out the item on air).
- **Soft** = at T, the feeder removes the intervening queued items. It knows when the item on air ends: if that's before T + cap, it pushes the marker item next in the queue (it starts on the natural end); otherwise it schedules the item with the engine at T + cap.
- **Not-before** = the feeder holds the item until its predicted start is ≥ T and fills before it. No engine cut.
- Engine integration tests can reuse the spike's recorder + correlation method (`engine/spikes/hardstart/spike.ts`).

### For listeners
All figures are on the engine's output. Listeners hear the stream after a constant delay (encoder, Icecast, player buffer), the same for every item. If "HH:00:00 on the listener's clock" ever matters, shift T by a measured per-mount constant; no strategy changes.
