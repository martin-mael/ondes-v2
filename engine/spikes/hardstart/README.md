# Spike: hard-start timing accuracy (#14)

**Question:** how precisely can a pre-recorded episode start at HH:00:00 on Liquidsoap
2.4.6, and how should we correct drift?

The outcome is `docs/adr/0003-hard-start.md`. Measured numbers are in `RESULTS.md`; the raw
reports are in `results/`.

## Run it

```sh
# The full hour, all lanes at once (about 60 min).
docker compose -f engine/spikes/hardstart/compose.yml run --rm --use-aliases driver

# The compressed hour (about 10 min): the last 40 s of every song, smaller offsets.
TAIL=40 LATE=10 EARLY=25 STRETCH_EARLY=1 SOFT_CAP=5 RUN_NAME=tail40 \
  docker compose -f engine/spikes/hardstart/compose.yml run --rm --use-aliases driver

# The same with the planning model's one frame per transition.
TAIL=40 LATE=10 EARLY=25 TRANSITION_LAG=0.02 RUN_NAME=tail40-lag \
  docker compose -f engine/spikes/hardstart/compose.yml run --rm --use-aliases driver

# A 3-minute smoke run: the last 3 songs, capped at 40 s.
ITEMS=3 MAX_ITEM=40 LATE=10 EARLY=25 STRETCH_EARLY=1 SOFT_CAP=5 RUN_NAME=dev \
  docker compose -f engine/spikes/hardstart/compose.yml run --rm --use-aliases driver

# Push deadline: how late can the feeder push the next item? (reuses four engines)
LANES=jit-5,jit-2.5,jit-1,jit-0.3 ITEMS=6 TAIL=40 RUN_NAME=jit \
  docker compose -f engine/spikes/hardstart/compose.yml run --rm --use-aliases driver

docker compose -f engine/spikes/hardstart/compose.yml down -v
```

Keep the machine awake with the lid open: a sleeping Mac freezes Docker Desktop and voids
the run. Two runs can go at once under different project names (`-p ondes-spike-hardstart-jit`).

The project is self-contained (`ondes-spike-hardstart`, no published ports, no Icecast),
so it neither needs nor disturbs the shared `ondes-dev` stack. The first run generates the
audio with ffmpeg (about a minute). Each run writes `results/<RUN_NAME>.json` and prints a
table; it exits non-zero if a lane never located its episode.

## What's in here

| File | Role |
|---|---|
| `station.liq` | A copy of `engine/templates/station.liq` (spike #13 version) with spike additions marked `HARDSTART`: the engine-timed start (`POST /v1/schedule`), the audio-timeline clock (`at_nominal`, `audio_pos` on every event), an optional per-item `soundtouch` tempo, and a recorder (`POST /spike/record`) instead of Icecast. #27 owns the template; nothing here edits it. |
| `playlist.ts` | The hour: 14 songs (FLAC, MP3, AAC, 48 kHz FLAC, WAV), autocue-style cue points on most, natural ends on some, crossfades from 0 to 6 s. Then the episode (seeded white noise, so its first sample can be found exactly) and a filler bed. |
| `fixtures.ts` | Generates the audio with ffmpeg and ffprobes it into `catalog.json`: the durations ingest would store and Node plans with. |
| `spike.ts` | The driver. Plays the feeder (#29): feeds each engine just in time, aims the episode at T, applies the lane's correction, records ±40 s around T and finds the episode's first sample in the recording by cross-correlation. |
| `compose.yml` | One engine per lane, the fixtures job and the driver. |

## Lanes

Every lane plays the same hour into the same episode. T is set when the first song starts:
T = natural start of the episode + the lane's offset. "Late" lanes have 45 s more music
than time (an earlier show overran); "early" lanes have 95 s too little (a song was skipped).

| Lane | Scenario | Correction |
|---|---|---|
| `ontime-none` | on time | none: measures the natural drift of the chain |
| `ontime-depth1` | on time | none, queue kept 1 item ahead instead of 3 |
| `late-none`, `early-none` | late / early | none (reference) |
| `late-replan` | late | re-plan: re-push the last song with a shorter cue-out |
| `early-replan` | early | re-plan: lengthen the last song to its end, then a sized filler bed |
| `late-node` | late | hard, Node-timed: Node clears the queue up to the episode and calls `POST /v1/skip` at T |
| `late-soft` | late | soft: let the song on air finish, cut at T + 30 s |
| `late-engine` | late | hard, engine-timed: `POST /v1/schedule {at: T}`; the engine cuts at T with a 1 s fade-out |
| `late-engine-wall` | late | the same, gated on `time()` instead of the audio timeline |
| `early-bed-engine` | early | a long bed after the last song, cut by the engine at T |
| `late-combined`, `early-combined` | late / early | re-plan (+ bed) **and** the engine-timed cut as a backstop |
| `early-stretch` | 6 s early | re-plan by time-stretching the last song (`soundtouch`, ±4 % max) |

## How it measures

- **Audio timeline, not `time()`.** Liquidsoap computes each 20 ms frame some time after its
  nominal instant (median 43–62 ms here, up to ~200 ms), and that delay jitters. The audio
  itself is a steady stream, so the ground truth is the audio timeline: frame *n* plays at
  `origin + n × 20 ms` (plus the output's constant latency, which no engine controls). The
  engine estimates `origin` from the least delayed frame and stamps every event with
  `at_nominal` (and `audio_pos`).
- **Episode start, two ways:** the as-run `track.started` (`at_nominal`), and the episode's
  first sample found in the recording by cross-correlating its known noise (normalised
  correlation 1.00 in every run, sample-exact), mapped through the same origin.
- **Drift:** each song's as-run start vs its plan (anchored on the first song's start).
- `at` in the event envelope is rounded to 10 ms by Liquidsoap's JSON printer
  (12 significant digits on epoch seconds), so the spike also sends `at_us`.
