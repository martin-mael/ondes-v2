# ADR 0011: Automatic cue points from loudness-relative thresholds

- Status: accepted
- Date: 2026-10-21
- Issue: #20. Builds on ADR 0002 (engine control, sample positions) and 0006 (job queue).

## Context
Segues need sensible defaults without manual work: where the sound starts and stops, and
where the next track may start over the ending. Moonbase59's MIT-licensed
[autocue](https://github.com/Moonbase59/autocue) (`cue_file`) is the reference approach for
Liquidsoap. It sets levels relative to the track's integrated loudness I, with cue-in and
cue-out at I − 42 LU and the next track's start at I − 8 LU, plus a long-tail rule and a
sustained-ending rule. It measures with ffmpeg `ebur128`. Our cue points are integer sample
positions on the playout copy (ADR 0002), and person-set points must never be overwritten.

## Decision
Port autocue's logic, not its script: `apps/worker/src/jobs/autocue/detect.ts` is a pure
detector over a 100 ms frame-loudness series. One ffmpeg pass on the playout copy measures
the series (`asetnsamples`, `astats`, `ebur128=metadata=1`). The thresholds and rules are
autocue's, with these deliberate differences:

- **Cue-out is the end of the last loud frame**, not its start: autocue's choice can clip a
  tenth of a second off an ending. Per-frame sample peaks also refine cue-in and cue-out
  inside the 400 ms momentary window, so a soft attack is not cut.
- **Blank skip is on by default (10 s)**; autocue has it off. On a radio, a hidden track
  after minutes of silence is dead air; a station that wants it played sets
  `blankSkipSeconds: 0`. A pause shorter than the threshold is kept.
- **The sustained-ending drop is measured in perceived loudness**, `1 − 2^(Δ LU / 10)`
  (sones, halving every 10 LU), against autocue's 40 % default. autocue divides the two LUFS
  means instead, so a plain fade from −22 to −56 LUFS counts as "sustained" (36 %) and the
  next track starts too late into it.
- **Fades and markers are derived** (autocue reserves them but doesn't compute them):
  - `fadeIn`/`fadeOut` are the lengths of the audio's own fades, or null;
  - `introEnd`/`outroStart` mark quieter opening or closing parts of at least
    `minIntroSeconds`.
- **A silent file gets its whole length** and nothing else, instead of failing.
- **Person-set cue points bound the result.** The detector never moves a manual or locked
  cue-in or cue-out; the detected points fit inside them. `setAutoCues` fits them again
  under the row lock, against the cues as they are when it writes.

Thresholds are per station, in `station.engine_settings.autocue`
(`packages/shared/src/contracts/autocue.ts`). Each result stores an analyzer version:
`autocue/<algorithm>`, plus a hash of the thresholds when they aren't the defaults. A new
algorithm or new thresholds means a new version, which the backfill
(`pnpm --filter @ondes/worker autocue:backfill`) re-analyses.

## Consequences
- Positions sit on the 100 ms frame grid (multiples of 4410 samples at 44.1 kHz). That is
  enough for segues; island splices use their own sample-exact positions (#54).
- Changing the defaults, or the detection, means bumping `AUTOCUE_ALGORITHM_VERSION` and
  running the backfill.
- Thresholds can only be set in storage for now: no api or UI writes `engine_settings`
  yet. That is a follow-up for the station settings screens.
- A playout copy that can't be measured stores the version with no points, so the engine
  uses its defaults and the backfill doesn't retry it forever.
