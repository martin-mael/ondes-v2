# ADR 0019: One gain model for the island renderer and the editor preview

- Status: accepted
- Date: 2026-10-22
- Issue: #58 (segue editor), with #56 (island renderer). Builds on ADR 0017 (segues and
  islands) and ADR 0002 (island joins).

## Context
ADR 0017 promises that "what you preview is what airs": the presenter shapes a transition in
the segue editor (#58), listens to it in the browser, and the renderer (#56) mixes the same
transition offline into a FLAC island that the engine splices sample-exactly. The two run on
different platforms: the renderer is Node code multiplying samples, the preview is WebAudio
nodes in a browser. If each implemented envelopes its own way (dB-linear vs amplitude-linear
ramps, hold rules, where the playout gain goes), a duck that sounds right in the editor would
air louder or softer than previewed, and no test would notice.

## Decision

### The model lives once, in `packages/shared/src/segues/gain.ts`
Pure functions, no platform API, imported by the worker and the web app alike:
- `dbToAmplitude(db)`: `10^(db/20)`, exactly 0 at or below −90 dB (`liq_amplify`'s formula).
- `envelopeGainAt(points, at)`: linear interpolation **in amplitude** between points, holding
  before the first and after the last, 1 when empty (ADR 0017).
- `sourceGainAt(source, at)` / `fillSourceGain`: a source's gain is
  `dbToAmplitude(gainDb) × Π envelopeGainAt(envelope, at)`, where `gainDb` is the asset's
  playout gain (with the log item's override) plus the lane's own trim. The renderer evaluates
  this per sample.
- `envelopeAutomation(points)`: the same envelope as AudioParam automation, a
  `setValueAtTime` at the first point and a `linearRampToValueAtTime` to each next one.

### The preview mirrors the renderer through that module
`apps/web/src/features/segue-editor/preview.ts` plays each lane as
`AudioBufferSourceNode → GainNode(dbToAmplitude(gainDb)) → GainNode(envelope) → destination`.
The envelope node is driven by `envelopeAutomation(clipEnvelope(envelope, −from, length))`,
so a playback starting mid-envelope begins at the envelope's value there and never schedules
into the past. Because envelopes interpolate linearly in amplitude, a WebAudio linear ramp is
the renderer's interpolation exactly, not an approximation. Positions are integer samples on
the segue axis; the preview converts them to context time as `t0 + samples / 44 100`.

The editor computes lanes ↔ sources with `clipsOf`, and checks a draft with the shared
`checkSegue` and `deriveIslands` before saving, so it flags what the api would mark `invalid`
and shows the island range the api will derive. It reads each lane's media (effective cues,
playout gain) from `GET …/segues/media`, which resolves them with the island sync's own code.

### Sample rate
Playout copies, islands and the segue axis are 44.1 kHz (ADR 0004, `PLAYOUT_SAMPLE_RATE`). The
preview asks for an `AudioContext` at 44.1 kHz so decoded buffers are not resampled. A browser
that runs the context at another rate still places every clip and ramp at the right time
(times are seconds computed from samples), but it resamples the audio: the preview is then
sample-accurate in time, not bit-exact. Islands are rendered by the worker, never by the
browser, so this only affects listening.

### Tolerance
The renderer works in float64, AudioParam in float32. `gain.test.ts` evaluates the automation
with the Web Audio spec's AudioParam formula in float32 and requires the result to stay within
2⁻²¹ of `envelopeGainAt` for one envelope and within 2⁻²⁰ for a static gain times envelopes
(about −120 dB relative error: inaudible). The editor's tests check that the gains its player
schedules on a fake AudioContext equal `sourceGainAt` at every point of a ducked transition.

## Consequences
- Changing how gains or envelopes behave means changing `gain.ts` (and bumping
  `ISLAND_SPEC_VERSION` when rendered audio changes). The renderer and the preview follow
  together, and the two test suites above catch a divergence.
- The preview adds no processing of its own (no limiter, no extra ducking): it is the island's
  mix. Loudness differences between preview and air can only come from the browser's output
  stage, not from the model.
- The preview decodes whole playout copies (about 60 MB of PCM for a 3-minute stereo song). The
  player keeps at most one decoded file per lane (A, B, four voices), drops the ones no lane
  plays after an edit, and releases everything when the editor closes. Decoding only the
  stretch around the transition is possible later without changing this decision.
