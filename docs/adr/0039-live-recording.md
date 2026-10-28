# ADR 0039: Live recording into episodes

- Status: accepted
- Date: 2026-10-27
- Issue: #67 (epic #62). Builds on ADR 0004 (playout cache), 0006 (jobs and event transport),
  0014 (episodes), 0022 (missing-episode fallbacks), 0027 (harbor pool, live sessions), 0028
  (reruns) and 0033 (live slots: sessions bound to what they air). Lives next to #66 (DJ
  handover, ADR 0038) and #68 (live metadata, ADR 0040), which edit the same template and
  live module.

## Context
Every live show should be archived, and Vandale reruns its shows constantly (ADR 0028). Until
#67 a live episode (ADR 0033) had no audio: the show aired and was gone, and a rerun slot of it
fell back to an older episode. The issue asks for:
- the engine to record the program output during live sessions, to its cache, then S3;
- the recording attached to the episode, trimmed to the session boundaries, with a waveform,
  usable for reruns;
- a DJ who disconnects and reconnects within the slot to end up in the same episode, joined;
- a retention policy per station;
- acceptance: a 2-hour live show is a rerun-ready episode within minutes of the end.

## Decision

### The engine records the final mix, one FLAC file per live session
A block of its own in `engine/templates/station.liq` ("Live recording … BEGIN/END"), after the
processing chain, so the file is what listeners heard (compressor and limiter included):
- `output.file(%flac(44.1 kHz, 16-bit, stereo))` on a `switch` that takes the final mix only
  while a DJ is on air (`live_on_air != 0`). Automation between two sessions is not recorded.
- **From the end of the takeover's 1 s crossfade.** The automation fading out under the DJ
  isn't part of the show; recorded, it put a second of the interrupted song at the start of the
  episode and at every reconnect. A handover keeps a DJ on air, so it skips nothing.
- **One file per session.** The session on air is the `ondes_live_session` tag of the final
  mix (what the as-run reads, ADR 0027). When it changes (a handover, a reconnect), the output
  reopens on that frame (`reopen_when`), so every file is exactly one session's on-air span and
  consecutive files join with no gap and no overlap: the trim to session boundaries is the
  engine's frame-accurate cut, not a timestamp match in Node. Matching Node's `started_at` /
  `ended_at` was rejected: a session starts in Node before the engine takes the air (the DJ may
  still be buffering, ADR 0027), so timestamps would put seconds of one DJ into the other's
  episode.
  - Only a change of session reopens the file: the live branch also carries now-playing
    metadata (#68, ADR 0040) on every track change of the DJ, all with the same session.
  - With #66's handover crossfade (ADR 0038), the new session's tag arrives as the crossfade
    starts, so the outgoing DJ's fade-out tail is at the head of the incoming DJ's file. Within
    one episode the parts join seamlessly anyway; across two shows the next episode opens with
    up to the crossfade length (2 s by default) of the previous DJ fading out.
  - Liquidsoap's `reopen_on_metadata` was tried first: on this chain it never saw the session
    tag (the switch only forwards the mix's metadata at track boundaries), so the handover's two
    sessions landed in one file. `radio.on_metadata` does see it, like the as-run callback.
- Files are `live-<boot>-<n>.flac` in `/recordings`. The engine announces each one with
  `live.recording.started {file, session_id, started_at}` and
  `live.recording.closed {file, session_id, started_at, ended_at}` when it closes it. Additive
  wire events (`engine.ts`), mapped to `engine.live.recording.*`.
- **Announced once open.** `started` goes out on the file's first frame with a session (from
  `reopen_when`, which Liquidsoap only calls on frames it is writing), not when the file is
  named. A file the engine can't open (the directory not writable yet) is never announced:
  Liquidsoap retries the open every 10 s (`reopen_on_error`, logged) without calling
  `reopen_when`, so no part waits forever for a file that doesn't exist (review of #191: before,
  every retry announced a new file that never closed, and the build waited on them). A write
  error mid-file isn't announced either; the reopen's first frame announces the file again (a
  no-op for Node), and if Liquidsoap opens a new file instead, Node interrupts the old one when
  the new one starts (below).
- **Closed when the DJ goes**, including the day's last show with no session after it: the
  output reads a `switch` that is only available while a DJ is on air, and is `fallible=true`,
  so when the gate shuts the output stops, which closes the file and calls `on_close`. A
  handover or a reconnect closes it through `reopen_when` instead, and a clean shutdown too.
  The real-engine test covers the last-show case (a hang-up with nothing after it).
- **The recording never stops the air**: a file that can't be written is retried every 10 s and
  logged; the output is fallible.
- FLAC 16-bit rather than a high-bitrate lossy file: lossless, so ingest's loudness and
  autocue measure what aired, and about 4 MB per minute (2 h ≈ 0.5 GB). 24-bit was rejected:
  the mix is already limited at −1 dBFS and dithered to 16-bit for every output.
- Setting `live.recordDir` (absolute path, optional; unset = no recording), template constant
  `live_record_dir`. Combos: `live-record`, `live-record_pool-1_escaping`,
  `live-off_record-dir`.

### Where the files go: the station's `<cache>/recordings`, read-write
The playout cache is mounted read-only in the engine (ADR 0004) and stays so. The lifecycle adds
a second bind, `<ENGINE_CACHE_ROOT>/<station>/recordings` → `/recordings`, read-write, and sets
`live.recordDir` to it. The proxy guard allows exactly that bind (`<root>/<station>/recordings`
at `/recordings`, read-write) and nothing else writable, and only for the container's own
station: the station in both bind sources must be the one in the container's name. The worker, which keeps the caches on
the same host, reads the files there.
- **One user owns it: the engine runs as the api's user.** The lifecycle makes
  `<station>/recordings` itself, right before it creates the container, and runs the engine as
  its own `uid:gid` (container `User`, `HOME=/tmp`; `ENGINE_USER` overrides). The api and the
  worker images both run as `node` and see the cache root at the same host path, so the engine
  writes as the directory's owner and the worker deletes as the owner: mode **0750**, nothing
  world-writable. Left to Docker (`CreateMountpoint`), the directory is root's on Linux: the
  engine can't write to it, and neither the worker nor anything else running as a normal user
  can clean it up (the lifecycle integration test's cleanup failed on exactly that in CI).
  - Only when the engine can't run as the api's user (an api running as root, or an
    `ENGINE_USER` of someone else) does the lifecycle fall back to 0777 without the sticky bit,
    so the image's user can write and the worker delete. Chowning the directory to the image's
    user (uid 100) was rejected: the api runs unprivileged and can't chown, and the worker
    still couldn't delete the files.
  - The proxy guard allows `User` only as a numeric `uid:gid` that isn't root.
  - An api that can't see the host's cache root logs it and goes on; the worker's sweep also
    makes the directory (0750) every 10 min, and logs one it can't write to. The recording then
    just retries until the directory is there.
- Streaming the audio to Node over HTTP, or a tmpfs, were rejected: a 2-hour file doesn't fit
  in the engine's memory limits, and a network push makes the archive depend on the api being
  up for the whole show.

### Parts and recordings in Node (`apps/api/src/modules/live/recording`)
New schema file `packages/db/src/schema/live-recording.ts` (migration `*_live-recording`):
- `live_recording_part`: one row per engine file, unique per station and file name, with its
  session, boot, status (`recording`, `closed`, `interrupted`, `deleted`) and times.
- `live_recording`: what the parts are joined into. **One per episode**, else one per **event**
  (a handover inside an event keeps the event, ADR 0038), else one per (ad hoc) **session**.
  Partial unique indexes arbitrate each kind. `version` counts the parts closed into it.
  Plain columns to sessions and episodes, no foreign keys, like `live_session` (ADR 0033).
- `live_recording_settings`: per station, absent = defaults (`enabled: true`,
  `retentionDays: null`, kept for good).

The api's recorder reads the engine's events from a durable, single-active-consumer queue
(`live-recording`, like the as-run, ADR 0006): one replica at a time, in order per station:
- `started`: the part is assigned to its recording at once, which turns `recording` (so a build
  started by an earlier part waits for it);
- `closed`: the recording's version goes up; with no other part open it turns `pending` (or
  `skipped` when the station records nothing) and `live.recording.updated` is published;
- `engine.booted` (or the next event of a new boot): parts of earlier boots still open are
  `interrupted` and count as closed; the file is readable up to the crash.
- `started` of a newer file of the same boot: earlier parts of that boot still open are
  `interrupted` too. The engine writes one file at a time and announces a close before the next
  start, so such a part lost its close (a write error, a lost event) and would otherwise hold
  its recording's build forever.
Every write is idempotent (unique file per station; a closed part isn't counted twice), so a
redelivery changes nothing and republishes the same event id.

**Disconnect and reconnect.** A DJ who reconnects within their slot gets a new session on the
same episode (ADR 0033), so their new file is another part of the same recording, and the
episode's audio is rebuilt from all parts. The same holds for a handover (ADR 0038 binds the
incoming DJ to the outgoing session's episode). Parts are joined back to back in air order: the
automation that played between two sessions isn't in the episode.

### The build: a worker job (`apps/worker/src/jobs/live-recording`)
`live.recording.updated` with status `pending` → the `live-recording` job
`{recordingId, version}`, keyed `live-recording:<id>:<version>` (durable trigger queue
`worker.live-recording`). The job:
1. claims the recording for that version, or does nothing: a newer part came, a part is still
   being written, or the version is built already. **One build per recording at a time**: the
   claim is a random id with a time (`build_claim`, `build_claimed_at`) taken under the row
   lock; another build finding a live claim throws, so the queue retries it once the first is
   done (it never ends `succeeded`, which would make the `once` idempotency key drop the next
   enqueue). A claim older than 30 min (`LIVE_RECORDING_BUILD_LEASE_MS`) is a crashed worker's
   and is taken over. A failing attempt that will be retried lets go of its claim;
2. joins the parts with ffmpeg's concat demuxer, re-encoded to one FLAC (which also repairs an
   interrupted file's header), tagged with the show and episode number and the station-local
   date of the first part (`localDateOf`, so a show at 00:30 in Lyon is that day's). File names
   are checked against the engine's pattern before anything is opened. A `closed` part's file
   must be there; an `interrupted` one is joined if its file holds anything, else skipped.
   **Parts whose files the sweep took** (a day after a build) were all in that build, so they
   come first in air order and the build's master in the bucket stands in for them: a late part
   or a manual rebuild after the sweep still works. A late part that would belong before swept
   audio fails the build with that reason;
3. puts it in the bucket as a `queued` upload (one per version, found again on a retry) and runs
   **the same `ingest`** as a browser upload,
   inline: playout copy, dedupe by hash, `asset.ingested` → loudness, autocue and **peaks** (the
   waveform), so the recording is a normal episode asset (type `episode`; `other` for a session
   without episode, which stays in the library);
4. records the build and attaches the asset to the episode (audited as an episode update) in
   one transaction, **only if its claim still holds**: a build taken over (the lease ran out)
   records nothing, and its asset is deleted unless something uses it. So an older build that
   finishes last can't attach stale audio or delete the newer asset. A build of an older
   version that still holds the claim records its audio (better than none) and leaves the row
   `pending` for the newer version's build, announced again by the retention sweep if its
   event was lost. Then the asset of the previous build is deleted, unless a recording, an
   episode or the log (a rerun already planned with the old audio) still uses it.
   - **Other audio on the episode is never overwritten.** The build attaches its asset only to
     an episode with no audio or with the recording's previous build. An episode that has
     something else (a manual upload, an asset picked by hand) keeps it; the recording is
     `ready` with its asset in the library, and the episode dialog says so and offers "Use the
     recording" (`POST …/live/recordings/:id/attach`, `live:manage`, audited): the explicit
     choice. Overwriting silently was rejected: a host who uploads a cleaned-up master after
     the show would lose it to the next late part or rebuild.
A file that is gone fails the build at once (`failed`, with the reason); anything else is
retried by the queue, the last attempt marking it `failed`. `POST …/live/recordings/:id/rebuild`
(`live:manage`, audited) asks for another version of a `ready`, `failed` or `skipped`
recording; `recording`, `pending` and `processing` ones are building already and `expired`
ones have no audio left, so those answer 409 `live_recording_state`.

**High lane.** The acceptance is minutes after the show; a backlog of library uploads on the
bulk lane can't promise that. A build is seconds of CPU per hour of audio plus the transfers.

**Rerun-ready.** An `aired` episode with audio is rerunnable (ADR 0028): the attached asset is
all a rerun slot needs. Episode status is left as the as-run set it.

### Retention (`live-recording-cleanup`)
The worker sweeps every station every 10 min (making its recordings directory, above) and
enqueues one cleanup per station and hour (key `live-recording-cleanup:<station>:<hour>`):
- **Audio**: a recording whose last part ended more than `retentionDays` ago loses its asset
  (deleted like any asset, its objects released) and turns `expired`. The episode stays, without
  audio, so ADR 0028 no longer picks it; a `ready` episode turns `planned` through the
  `episode_asset_cleared` trigger in the same statement, so `episode_ready_asset_check` holds
  (tested). An asset the log plans to air later is kept until then.
- **Failed recordings** expire with the retention too, and after 30 days
  (`LIVE_RECORDING_FAILED_KEEP_MS`) when the station keeps recordings for good, so their files
  don't stay on the engine's disk forever. A month is time enough to fix and rebuild one.
- **Builds nothing is running** (`pending`, or `processing` under a stale claim, unchanged for
  longer than the lease) go back to `pending` and are announced again, so the trigger enqueues
  them: a lost event or a crashed worker doesn't strand a recording.
- **Local files**: deleted a day after their recording was built from them (a later build
  starts from that build's master instead), with their recording once it expired, a day after
  closing when nothing will build them (recording off, no session), and files the database
  doesn't know (a lost event) a day after their last write.
- Each recording and each file is its own step: one that fails (an asset that won't delete, a
  file that won't go) is logged and counted, and the rest of the sweep goes on.

### API and web
- `GET/PUT …/live/recording/settings` (`live:read` / `live:manage`, audited
  `live_recording.settings.update`); `GET …/shows/:showId/episodes/:episodeId/recording`
  (`show:read`); `POST …/live/recordings/:id/rebuild`; `POST …/live/recordings/:id/attach`. The
  episode response schema is shared (`episodeLiveRecordingSchema`).
- SSE `live.recording.updated` (`show:read`).
- Web: a settings page (`features/settings/live-recording`, nav "Live recording") with the
  on/off switch and the retention (for good, 30/90/180/365 days, or a number; an unfinished
  number never blocks the save), and a "Live recording" section in a live episode's dialog
  (`features/shows/episode-recording.tsx`, the shows feature's own): status, length, parts
  joined, when the retention deletes it, the build's error, a calm line when the recording
  can't be read, "Process again", and "Use the recording" when the episode kept other audio.

## Measurements
- `apps/worker/src/jobs/live-recording/live-recording.engine.int.test.ts` runs the real
  template with two stand-in DJs: DJ 1 → handover to DJ 2 → DJ 2 hangs up (automation) → DJ 2
  reconnects → return, three sessions on one episode. The engine writes three files, the
  recorder turns them into one recording at version 3 (a redelivery changes nothing), the build
  joins and ingests them and attaches the asset, and the peaks job stores the waveform. The
  joined audio is DJ 1 then DJ 2 with no silence and none of the automation. 12.5 s of audio
  built in 1–2 s, all of it fixed costs (four ffmpeg runs in the worker image, S3).
- The same test then has the engine fail to open its file (the recordings directory read-only
  when the DJ goes on air): nothing is announced until the directory is writable again and the
  10 s retry opens the file; the DJ then hangs up with no session after it (the day's last
  show), the one file closes, and it builds.
- **The 2-hour case**, measured by `apps/worker/src/jobs/live-recording/bench.ts`
  (`PATH=$PWD/apps/worker/test/bin:$PATH node apps/worker/src/jobs/live-recording/bench.ts 2 3`
  with `.env.example` loaded): the build's steps on 2 h of stereo pink noise (which compresses
  like a real mix, unlike a sine: 469 MB of FLAC in three 40-minute engine-like parts), with
  the worker image's ffmpeg 7.1 (Docker on an Apple M5 laptop) and the dev Garage:

  | Step | Measured |
  |---|---|
  | join 3 parts → one FLAC | 6.3 s |
  | ingest: playout copy (libsoxr) | 8.2 s |
  | one decode (peaks; loudness and autocue each do one too, after `asset.ingested`) | 8.0 s |
  | bucket: staging put, ingest's download, master and playout puts (≈ 1.9 GB, local Garage) | 3.3 s |
  | **total** | **26 s** |

  Measured: about **26 s for a 2-hour show**, of which 22 s of CPU. Estimated for a VPS, not
  measured: the same ≈ 1.9 GB over the network to a remote bucket is ≈ 40 s at 50 MB/s, and a
  small VPS's CPU takes 2–3× the CPU steps, so **1–2 minutes** after the show. Loudness and
  autocue (bulk lane, after `asset.ingested`) run after that and don't hold the rerun. A rerun
  then needs the playout copy in the engine's cache like any file (ADR 0004: ≈ 10 s at 50 MB/s).
- Disk: about 4 MB per minute, 0.5 GB per 2-hour show in `recordings/`, for a day after the build
  (a month for a failed one when recordings are kept for good).

## Consequences
- Additive contracts: wire events `live.recording.started|closed`, domain events
  `engine.live.recording.*` and `live.recording.updated`, `live-recording.ts` (settings, DTOs,
  job payloads). New setting `live.recordDir`; every station's engine restarts once (the
  template and its container spec change: a new mount).
- New schema file and migration `*_live-recording`; three tables, nothing changed elsewhere.
- Engines run as the api's user rather than the image's (every engine restarts once more for
  it). The api and the worker must run as the same user and see the cache root at the same
  host path; both images already do (`USER node`).
- The engine now writes to the host: one writable directory per station, allowed by the proxy
  guard. Sizing a station's disk must count a day of live shows.
- The ingest of a recording re-downloads the staging object it was just given (ingest reads
  only from S3). Inline ingest from the local file would save a transfer but fork the one
  ingest path every asset goes through; not worth it at ≈ 40 s.
- One upload per recording version, keyed by its staging key
  (`uploads/live-<recording>-v<version>`): a retried attempt resumes it (ingest continues a
  `processing` upload) rather than leaving one behind. Rebuilding the same parts ends as a
  `duplicate` of the asset already attached, so nothing changes.
- Tests: the real-engine test above (worker project: Docker, Garage, the worker image's
  ffmpeg; CI's worker job has all three); `live/recording/recording.int.test.ts` (recorder
  rules per episode, event and session, versions, redeliveries, an engine restart, a lost
  close, recording off; routes, permissions, audit, rebuild states, attach);
  `packages/db/src/live-recording.int.test.ts` (one build at a time, the lease, a stale build
  losing, attach never over other audio, stale builds reset);
  `live-recording/build.int.test.ts` (a busy recording, an empty interrupted part, a rebuild
  from the master after the sweep, a late part before swept audio, other audio kept);
  `live-recording-cleanup/cleanup.int.test.ts` (retention, planned reruns kept, a `ready`
  episode turning `planned`, failed recordings, stale builds, a failing step, local files and
  strays, a build whose file is gone); unit tests for the file-name guard, the event mapping,
  the station-local date across midnight and both DST changes, the container guard (own
  station, user) and spec; web tests for the settings page and the episode section.
- Follow-ups: unbound sessions (ad hoc, events) are archived as library assets with no screen
  of their own yet; a recordings list for the Live page; a per-station budget alert for the
  `recordings/` directory next to the cache budget (ADR 0004).
