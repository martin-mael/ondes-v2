# Spike #14: hard-start timing, results

Liquidsoap 2.4.6 (`savonet/liquidsoap:v2.4.6`), 20 ms frames, 44.1 kHz. Method and lanes:
`README.md`. Decision: `docs/adr/0003-hard-start.md`. Raw reports: `results/*.json`
(regenerate the tables with `node engine/spikes/hardstart/report.ts <report>`).

All "error" figures are **episode start − T**, on the engine's audio timeline, from the
episode's first sample in the recorded output (cross-correlation 1.00 in every lane unless
noted). The as-run `track.started` on the audio timeline agreed with the audio to within
one frame in every lane.

## Runs

| Run | What | Songs | Late / early offset |
|---|---|---|---|
| `hour` | the full hour, every song played whole | 14 (58 min) | 45 s / 95 s (stretch: 6 s) |
| `tail40` | compressed hour: the last 40 s of every song, so every transition, format and natural end is kept | 14 | 10 s / 25 s (stretch: 1 s) |
| `tail40-lag` | `tail40` with the planning model's one-frame-per-transition lag | 14 | 10 s / 25 s |
| `jit` | push deadline: depth 0, each item pushed N s before the end of the one on air | 6 (last 40 s) | – |
| `dev4` | smoke run, 3 songs capped at 40 s | 3 | 10 s / 25 s |

15 engines ran at once on one Docker Desktop VM (10 CPUs, 8 GB), plus a second project for
`jit` / `tail40-lag` during the hour.

## The full hour (`hour`)

58 minutes of whole songs (13 transitions), then the episode. Late = 45 s more music than
time; early = 95 s too little.

| lane | offset (s) | **audio (ms)** | as-run, audio timeline (ms) | as-run, `time()` (ms) | re-plans |
|---|---|---|---|---|---|
| `ontime-none` | 0 | **+239.6** | +238.9 | +352.5 | 0 |
| `ontime-depth1` | 0 | **+239.5** | +238.9 | +319.0 | 0 |
| `late-none` | −45 | **+45 239.8** | +45 239.1 | +45 334.4 | 0 |
| `late-replan` | −45 | **+40.2** | +39.4 | +112.3 | 13 |
| `late-node` | −45 | **+20.0** | +19.4 | +115.4 | 0 |
| `late-soft` (cap 30 s) | −45 | **+30 019.4** | +30 018.9 | +30 117.8 | 0 |
| `late-engine` | −45 | **+0.7** | −0.5 | +25.8 | 0 |
| `late-engine-wall` | −45 | **−61.2** | −61.9 | +47.8 | 0 |
| `late-combined` | −45 | **−0.5** | −1.2 | +42.4 | 13 |
| `early-none` | +95 | **−94 760.0** | −94 760.7 | −94 730.0 | 0 |
| `early-replan` (+ 37 s bed) | +95 | **+19.4** | +18.7 | +73.3 | 14 |
| `early-bed-engine` | +95 | **−0.0** | −0.6 | +106.3 | 0 |
| `early-combined` | +95 | **−0.6** | −1.4 | +19.0 | 14 |
| `early-stretch` (tempo 0.9756) | +6 | **+20.6** | −21.5 | +111.2 | 12 |

- **Natural drift:** +219 ms at the last song (12 transitions at +20 ms, the 0 s overlap at
  −20 ms), identical in the four uncorrected lanes to 0.4 ms. Per-transition table below.
- **Clock:** the audio timeline drifted −0.7 to +0.7 ms against the wall clock over 3 490 s
  in every lane (least delayed frame in the first vs the last 10 minutes, from 5 s samples).
  The committed `hour.json` keeps one sample in three to stay under Biome's 1 MiB limit, and
  gives −1.6 to +2.0 ms from them. No drift to correct.
- **Frame computation delay:** p50 45–60 ms, p99 105–131 ms, isolated maxima up to 781 ms
  (one frame, `late-soft`), with 15 engines plus a second 14-engine project for part of the
  hour on the same VM. The audio-timeline measurements didn't move.
- **Stretch:** `soundtouch` delays the audio ~42 ms behind the metadata (as-run −21.5 ms,
  audio +20.6 ms), on top of the usual frame.
- HTTP from Node over the hour: push median 9 ms (max 142), remove 3 ms (max 40), schedule
  9 ms, skip 15 ms.

### Drift per transition, full hour (ms; the four uncorrected lanes agree to ±1 ms)

| into | from | from format | overlap (s) | from has cue-out | drift |
|---|---|---|---|---|---|
| m02 | m01 | FLAC | 3 | yes | +19 to +20 |
| m03 | m02 | MP3 | 2 | no (natural end) | +20 |
| m04 | m03 | FLAC | 4 | yes | +20 |
| m05 | m04 | FLAC 48 kHz | **0** | no | **−20** |
| m06 | m05 | FLAC | 5 | yes | +20 |
| m07 | m06 | AAC (.m4a) | 2 | no | +20 |
| m08 | m07 | FLAC | 3 | yes | +20 |
| m09 | m08 | WAV | 1 | no | +20 |
| m10 | m09 | MP3 | 3 | yes | +20 |
| m11 | m10 | FLAC | 6 | no | +20 |
| m12 | m11 | FLAC | 2 | yes | +20 |
| m13 | m12 | FLAC | 3 | yes | +20 |
| m14 | m13 | FLAC | 2 | yes | +20 |
| **total** | | | | | **+219** |

## Correction strategies, compressed hour (`tail40`)

| lane | offset (s) | **audio (ms)** | as-run, audio timeline (ms) | as-run, `time()` (ms) | re-plans |
|---|---|---|---|---|---|
| `ontime-none` | 0 | **+200.1** | +199.8 | +256.3 | 0 |
| `ontime-depth1` | 0 | **+199.0** | +198.8 | +252.5 | 0 |
| `late-none` | −10 | **+10 200.7** | +10 200.0 | +10 220.3 | 0 |
| `late-replan` | −10 | +200.5 (artefact, see below) | +199.1 | +312.0 | 13 |
| `late-node` | −10 | **−21.2** | −22.6 | +104.0 | 0 |
| `late-soft` (cap 5 s) | −10 | **+4 979.1** | +4 978.5 | +5 070.3 | 0 |
| `late-engine` | −10 | **−0.8** | −2.2 | +15.9 | 0 |
| `late-engine-wall` | −10 | **−60.0** | −60.8 | +47.3 | 0 |
| `late-combined` | −10 | **+0.6** | −0.7 | +69.1 | 13 |
| `early-none` | +25 | **−24 798.5** | −24 800.0 | −24 763.1 | 0 |
| `early-replan` | +25 | **+39.3** | +38.6 | +69.6 | 11 |
| `early-bed-engine` | +25 | **+0.2** | −0.6 | +12.1 | 0 |
| `early-combined` | +25 | **−0.0** | −1.0 | +88.0 | 11 |
| `early-stretch` | +1 | **+76.7** | +59.2 | +181.1 | 6 |

`late-replan` in this run hit the driver's 30 s floor for the shortened song (40 s − 10 s),
so it couldn't absorb the transition lag; fixed (`MIN_SONG`, 10 s) before the next runs.

### With the planning model (`tail40-lag`: +20 ms per transition)

| lane | **audio (ms)** | as-run, audio timeline (ms) | re-plans |
|---|---|---|---|
| `ontime-none` | **−79.8** | −80.0 | 0 |
| `late-replan` | **−19.4** | −20.0 | 4 |
| `early-replan` | **−19.3** | −20.0 | 4 |
| `late-combined` | **+0.6** | −0.1 | 4 |
| `early-combined` | **+0.3** | −0.1 | 4 |

The model removes the systematic lag: re-plan alone lands within one frame, and re-plans
drop from 11–13 to 4 per hour. `ontime-none` now runs 80 ms *early*: the four transitions
that were 0 or −20 ms instead of +20 (below).

## Natural drift per transition, compressed hour (`tail40`)

Song start vs plan, minus the previous song's, ms. Identical in the four uncorrected lanes
to ±1 ms, so it's a property of the files and cue points, not of load or queue depth.

| into | from | from format | overlap (s) | from has cue-out | drift (ms) |
|---|---|---|---|---|---|
| m02 | m01 | FLAC | 3 | yes | +20 |
| m03 | m02 | MP3 | 2 | no (natural end) | +20 |
| m04 | m03 | FLAC | 4 | yes | +20 |
| m05 | m04 | FLAC 48 kHz | **0** | no | **−20** |
| m06 | m05 | FLAC | 5 | yes | +20 |
| m07 | m06 | AAC (.m4a) | 2 | no | **0** |
| m08 | m07 | FLAC | 3 | yes | +20 |
| m09 | m08 | WAV | 1 | no | +20 |
| m10 | m09 | MP3 | 3 | yes | +20 |
| m11 | m10 | FLAC | 6 | no | **0** |
| m12 | m11 | FLAC | 2 | yes | +20 |
| m13 | m12 | FLAC | 3 | yes | +20 |
| m14 | m13 | FLAC | 2 | yes | +20 |
| **total** | | | | | **+180** |

Every transition is quantised to the frame: −1, 0 or +1 frame, mostly +1. The same
transition can land on a different frame depending on where it falls (m06 → m07 and
m10 → m11 were 0 here and +20 ms in the full hour); a 0 s overlap came out −1 frame both
times. Decoder effects
(MP3 padding, AAC priming, 48 kHz resampling, WAV) and seek rounding (spike #12) all stay
inside that frame. A model of "+1 frame per transition" leaves a residual of at most a few
frames over an hour, which the re-plan removes.

## Push deadline (`jit`)

Depth 0: the next item pushed `lead` seconds before the end of the one on air. Overlaps of
the six transitions: 3, 6, 2, 3, 2 s.

| lead | safety took the air | drift added |
|---|---|---|
| 5 s | once (into a 6 s overlap) | +6.0 s |
| 2.5 s | 3 times (3, 6 and 3 s overlaps) | +12.0 s |
| 1 s | every transition | +16 s |
| 0.3 s | every transition | +16 s |

The crossfade pulls the next track when its window opens (end − overlap). If the queue is
empty then, the fallback plays the safety playlist and the next push takes the air back
through a new crossfade: each miss costs about the overlap. **Deadline: the next item must
be queued before `end − overlap`, plus margin.** The ADR 0002 policy (2–3 items or 10 min
ahead) is far from it; depth 1 vs 3 made no difference to timing.

## Engine-side measurements

| What | Value |
|---|---|
| Frame computation delay vs the audio timeline (p50 / p99 / max, per lane) | 43–62 / 107–197 / 108–198 ms (`tail40`) |
| Switch latency, scheduled gate | exactly one frame (+20.0 ms on every lane of the run before the lead was added) |
| Gate on `time()` instead of the audio timeline | −57 to −98 ms (early) |
| Push / remove / schedule / skip (HTTP, from Node) | median 10 / 5 / 12 / 9 ms; max 88 / 18 / 25 / 9 ms (`tail40`) |
| `at` in the event envelope | 10 ms resolution (12 significant digits on epoch seconds) |
| Scheduled request prepared | on the frame the gate opens; no measurable cost for a local FLAC |
| A failing `output.file` (permission denied) | kills the engine (exit 2) |

## What these numbers mean for listeners

Everything above is on the engine's output. Listeners hear it after a constant delay
(MP3 encoder, Icecast burst and buffers, their player), the same for every item, so the
start is exact relative to the stream. If "HH:00:00 on the listener's clock" matters, shift
T by a measured constant per mount; it doesn't change any strategy.
