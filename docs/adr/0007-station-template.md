# ADR 0007: Station script template: rendered from settings, segment queue, versioned config

- Status: accepted
- Date: 2026-10-20
- Issue: #27. Builds on ADR 0002 (engine control) and spike #12 (island splicing).

## Context
Each station runs one Liquidsoap 2.4.6 process. Spike #13 left a draft script that read its settings from environment variables. #27 turns it into a production template: generated per station from its settings, versioned, checked in CI for every settings combination, and able to play island chains (A body | island | B body) with no seam.

## Decision

### One template, two generated blocks
`engine/templates/station.liq` is the whole station script, with two marker lines:
- `# @ondes:config` becomes the station's constants (`station_id`, ports, paths, crossfade, blank detection, processing toggles and parameters, Icecast host).
- `# @ondes:outputs` becomes one `output.icecast` per output in the settings. Encoders are compile-time values in Liquidsoap (`%mp3(...)`), so they have to be generated.

Everything else, including the processing toggles and the live input switch, is ordinary Liquidsoap code branching on those constants. One template is easy to review, and every branch is type-checked in every rendering.

`apps/api/src/modules/engine/config` renders it: `stationEngineSettingsSchema` (zod, every field defaulted except the station id, name and outputs) and `renderStationScript(settings) → {script, version, settings}`. Every value reaches the script through `liqString` / `liqFloat` / `liqInt` / `liqBool`. Strings are written with `\xHH` escapes for anything outside a small safe set, `#` (interpolation) and quotes included, so settings can't inject code. Names that end up in URLs (mounts, station id, live mount) are restricted to `[A-Za-z0-9_.-]`.

### Secrets stay in the environment
The control token (`ENGINE_CONTROL_TOKEN`), the shared live password (`ENGINE_LIVE_PASSWORD`) and the Icecast source password (`ICECAST_SOURCE_PASSWORD`) are read from the container environment, never rendered. The rendered script can therefore be stored, diffed and logged.

### Config version
`version` = the first 16 hex digits of sha256(template, canonical settings JSON with defaults applied). It is baked into the script as `config_version` and reported by `GET /v1/health` and `GET /v1/state`. A settings change or a template change gives a new version. The adapter compares it with what it rendered to know that the engine runs a stale script and needs the safe restart (there is no reload command, ADR 0002).

### Main queue = segments (spike #12)
The draft's `request.queue` is replaced by a queue of **segments** played through `source.dynamic`:
- A segment is one log item (`POST /v1/queue`) or an island chain (`POST /v1/segment`, shape in `packages/shared/src/contracts/engine.ts`).
- Each segment plays as `sequence(merge=true, [...requests, source.fail()])`, every request wrapped in its own `amplify(override="liq_amplify")`. The station crossfade sees one track per segment and never an island join. Transition metadata (`liq_fade_*`, `liq_cross_*_duration`) goes on the segment's first part (in) and last part (out) only.
- Every request is resolved before the segment is queued: a 422 means nothing was queued.
- As-run stays keyed on the request id, so every part of a segment reports its own `track.started` with its `item_id` and the `segment_id`.
- Skip during a segment ends the whole segment. Removing any part removes the whole queued segment.

**Threads.** Liquidsoap 2.4.6 has no mutex in the script language, so the queue uses single-writer refs. Harbor handlers are the only writers of the segment list and of a segment's `aborted` flag. The clock thread is the only writer of the "started" cursor and of the current segment. Each side only reads what the other writes. The adapter sends commands one at a time.

### Processing
Built-in `compress` and `limit` on the program (live included), each toggleable per station with its parameters in the settings, before `mksafe`. No licensed component (Stereo Tool stays an opt-in plugin, per the spec).

### Tests
- `pnpm test:engine` renders every combination in `engine/tests/template/combos.ts` (live × compressor × limiter, every output format, escaping) and runs `liquidsoap --check` on each in the pinned image. Warnings fail the run.
- `pnpm test:engine:template` runs the rendered template for real (its own container), drives the control API, and checks with the splice test's seam detector that an island segment airs sample-exact (shift 0, residual about −115 dB on FLAC noise).

## Consequences
- The adapter (#28) renders the script with `renderStationScript`, writes it where the station's engine container reads it, and restarts the container when `version` changes. Restart orchestration is #28's and deploy's.
- **Measured: an entry's end at a normal crossfade boundary is frame-granular.** A B body with `cue_out` and `cross_out = 0` aired 441 samples (less than one 20 ms frame) past its cue-out. This isn't an island join, but as-run and back-timing shouldn't expect sample accuracy at entry ends.
- Icecast shows non-ASCII stream names garbled on MP3/AAC mounts (Ogg is fine): set the mount charset in the Icecast config (deploy).
- `engine/spikes/control` still runs the draft by its old path: it is a finished spike, and its compose file needs the old environment-driven script from git history (commit e08adbc) to run again.
