# ADR 0018: Island renderer

- Status: accepted
- Date: 2026-10-22
- Issue: #56 (epic #54). Builds on ADR 0002 and spike #12 (island joins), 0004 (playout cache),
  0006 (job queue) and 0017 (segues and islands). Consumers: the engine (#57), the segue
  editor's preview (#58).

## Context
ADR 0017 derives islands as content-addressed specs (`IslandSpec`, hashed) and leaves them
`pending`. Something has to turn a spec into the FLAC the engine splices between A's body and
B's body, sample-exactly, fast enough that an edit made minutes before air still airs as
designed, and so that the editor's preview sounds like what airs.

## Decision

### One gain model, shared
`packages/shared/src/segues/gain.ts` is the only gain math, pure and platform-free:
- `dbToAmplitude` (10^(dB/20), what `liq_amplify` applies; ≤ −90 dB is exactly 0) and
  `envelopeGainAt` (linear in amplitude between points, holding outside) moved there from
  `island.ts`;
- `sourceGainAt(source, at)`: static gain × product of envelopes, the renderer's reference;
  `fillSourceGain` fills a block with exactly the same values (bit for bit, tested);
- `envelopeAutomation(points)`: the same envelope as Web Audio automation (`setValueAtTime`, then
  `linearRampToValueAtTime` per point). The editor (#58) chains a GainNode at the static gain and
  one per envelope; start mid-envelope with `clipEnvelope` so no event lies in the past.

**Tolerance between the two paths.** Node has no `OfflineAudioContext`, so the tests evaluate
the automation with the Web Audio spec's AudioParam formula in float32. Per envelope the preview
is within 2^-21 of `envelopeGainAt`, a static × envelopes chain within 2^-20, and a whole mix
within 2^-24 (24-bit rounding) + 2^-20 of the render per sample, with the residual more than
120 dB under the signal (`gain.test.ts`, `island-render/mix.test.ts`). Inaudible: the preview is
what airs.

### The job
`island-render` (`apps/worker/src/jobs/island-render`), **high** lane, payload
`{ orgId, stationId, hash }` (`islandRenderJobPayloadSchema`).

**Keying.** The job is keyed by the island hash, through the payload: it has no explicit
idempotency key, so the queue derives one from a hash of name + payload, in `in_flight` mode.
Two enqueues of one hash while a render runs collapse into it; an enqueue after it finished
runs again. An explicit key (`once` mode) would be wrong here: a spec that goes A → B → A must
render A again if A's render was dropped meanwhile, and a failed hash must be retryable. Doing
the work once is the data's job:
- `claimIslandRender` is a compare-and-set on the hash: nothing claimed means nothing to do;
- the claim is held by the job's id (`island.render_claim`), which is stable across the queue's
  retries of one enqueue, so a retry re-claims the rows its earlier attempt holds (for example
  after a crash between the claim and the render);
- the object key is the spec hash (`islandStorageKey`), so a render already stored (a retry,
  another station of the org) is downloaded, hashed against its recorded SHA-256 and recorded
  without rendering; an object that doesn't check out is rendered again and overwritten.

1. Download each source's playout copy (`files`), hashing it on the way: it must be the exact
   file the spec pins, never the master (spike #12: a different file shows the codec difference
   at the joins).
2. Decode each source's range `[from, to)` with ffmpeg to 32-bit PCM, cut with `atrim` on sample
   counts (sample-exact whatever the packet grid; ranges are already snapped to it by the
   derivation, ADR 0017).
3. Mix in float64 (`mixIsland`, `packages/shared/src/segues/mix.ts`, pure): each source at `at`, times `fillSourceGain`; mono plays on both
   channels; quantise to 24 bits with rounding, clipping counted and logged. **No
   micro-crossfade**: the 10 ms handles at both ends are plain A × gain and plain B × gain, and
   the engine butt-splices on them.
4. Encode FLAC 44.1 kHz, stereo, 24-bit, fixed 1024-sample blocks, bit-exact; check STREAMINFO
   (length, block size); upload with the file's SHA-256 as metadata.
5. When this worker keeps a playout cache, place the file there (cache-sync's `fetchOne`: lock,
   checks, `playout_cache_file` row). It is a head start, not a condition of `ready`.
6. `markIslandRendered` with the file's own hash and size, new nullable columns
   `island.file_sha256` / `file_size_bytes` (`island.file` in the DTOs, `rendered.file` in
   `deriveIslandsFor`): the engine plays it from the cache as `playoutPath({ sha256, ext: 'flac' })`.

Each state change publishes `island.updated` (`rendering`, then `ready` or `failed`) after it
commits. Publishing is best-effort, like every event in Ondes: a failed publish is logged and
never fails or rolls back the render (the state is in the database, and neither the sweep nor
`GET …/islands` needs the event). We add no separate `island.rendered` event: `island.updated`
with `ready` already says it, with the hash.

**Failures.**
- *Input* (a source whose whole object hashes to something else than the spec pins, a file
  that isn't FLAC or isn't 44.1 kHz, a decode ffmpeg rejects, a spec that fails its schema or
  its hash): final. `failed` with the reason and no `retry_at`; the next spec change renders it
  again.
- *Transient* (S3, Postgres, local I/O, a short download, a killed ffmpeg, and a source object
  not found, which may still be landing): the job's rows become `failed` with
  `retry_at = now + 1, 2, 4 … 60 min` (by attempts), and the job throws, so the queue retries it
  (each retry claims the rows again). Once the queue gives up, the sweep re-enqueues the island at
  `retry_at`. `island.render_attempts` counts claims of the current hash (reset with the hash);
  at 8 the island stays `failed` without `retry_at`.

**Stale claims.** A `rendering` claim untouched for 10 minutes is taken over (a worker died
mid-render). If the first job was only slow, both finish: `markIslandRendered` marks every row of
the hash `ready` whichever job finishes (the render is bit-exact and content-addressed, so either
file is the right one), and `markIslandFailed` only touches rows the failing job still holds, so
a superseded job can't fail the live render.

### Re-render on change
The api enqueues one job per hash a sync leaves `pending`, after commit, from every sync: the
segue routes and the durable consumer of log, library and station events
(`apps/api/src/modules/segues/render.ts`). The worker's 5-minute sweep (`sweep.ts`) re-enqueues
`pending` islands older than 2 minutes (a lost enqueue) and takes over `rendering` claims
untouched for 10 minutes (a worker that died mid-render: `claimIslandRender(…, { staleAfterMs })`,
`listIslandsToRender`).

### Speed
The under-2 s target holds **with a native ffmpeg**, which is what production runs (the worker
image installs it): a 5 s voice-track island (three sources) renders in about 0.2 s, most of it
the decode of A up to its end. Under the docker wrapper the integration tests use
(`apps/worker/test/bin`), every ffmpeg spawn is a `docker run`, and the same render measured
2.4 s; that figure is the wrapper's overhead, not the renderer's.

### Grid snapping
Spike #12's rules are all followed, but one of them is not the renderer's to apply.
- B's join (the tail item's cue-in after the island) is snapped up to B's 1024-sample grid by
  the derivation (ADR 0017), and the island's length absorbs the difference.
- A's join is a cue-out and needs no snapping.
- A's own **cue-in** (where A's body starts, before the island) must be on A's grid too: the
  engine seeks there packet-granularly and then plays `cue_out − cue_in`, so an unsnapped cue-in
  moves A's end, and with it the A → island join (the splice test's `-unsnapped` cases). That
  value is not in the island: the island starts at A's join and never contains A's cue-in
  (when A has no body left, the island renders A from its cue-in, with no seek). So it is the
  feeder's to send (#57): `liq_cue_in` = A's effective cue-in moved up to the next 1024-sample
  boundary, as the spike's metadata table says, and the same for every seek into a body,
  island or not. Moving it up by less than 23 ms only shortens A's body, never the island.

### Verification
- `island-render.int.test.ts`: renders from playout copies in Garage, decodes the stored file and
  nulls it against a mix of the decoded inputs with a gain written out independently in the test
  (10^(dB/20) and a plain lerp, not the shared code): every sample within ½ LSB. Also covered:
  idempotency, a moved-on spec, bad input, transient retries and the attempt cap, own-claim
  re-claims, a superseded job, a failed publish, and a corrupt stored object.
- The splice test (`pnpm test:engine:splice`, CI's `--quick`) now renders its FLAC islands with
  this renderer (`renderIslandWithRenderer` in `engine/tests/splice/island.ts`) and plays them in
  the pinned Liquidsoap: shift 0 at both joins, residual −127 dB (tone) / −116.5 dB (noise).
  Lossy cases keep the ffmpeg reference renderer (production plays FLAC only). CI's `engine`
  path filter now includes the renderer.

## Consequences
- **Engine (#57):** snap A's cue-in (above); play `rendered.file` from the cache; ADR 0004's horizon must add island
  files (by `file_sha256`) so cache-sync keeps them and the urgent fetch can fetch one (today it
  takes an asset file id). Until then a render placed by this job stays until the cache needs
  room.
- **Editor (#58):** previews with the shared gain model; previewing the derived spec itself
  (`deriveIslands`) is the strictest "what you preview is what airs".
- Island objects are content-addressed and not reference-counted: a GC can drop keys no island
  row references.
- Clipping is logged, not prevented: the mix is what the presenter shaped. A limiter, if ever
  wanted, belongs in the spec (and its hash), not in the renderer alone.
