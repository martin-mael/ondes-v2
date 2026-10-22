# ADR 0025: Recording voice tracks in the browser

- Status: accepted
- Date: 2026-10-22
- Issue: #59 (epic #54). Builds on ADR 0017 (segues and islands), 0019 (one gain model),
  0011 (autocue), the upload api (#18) and the loudness pipeline (#19).

## Context
A presenter voice-tracks a transition by talking over the end of song A and the start of B. The
segue editor (#58) places and ducks a voice that already exists in the library; #59 makes the
voice itself in the browser: pick a mic, watch its level, record while hearing the music
(pre-roll), retake, trim, and send the take to the library as a `vt` asset, so a presenter goes
from "record" to "on air" without leaving the app. Four questions need an answer that the
renderer, the editor and ingest agree on: where loudness normalisation happens, which format
the take travels in, how a take recorded over the music lands at the right place on the
segue axis, and who may upload it.

## Decision

### Normalisation stays at ingest and playout, like every asset
The take is uploaded as recorded. Ingest measures it (EBU R128 integrated loudness and true
peak, the `loudness` job), and the playout gain (`getPlayoutGain`) brings it to the station's
target, which is what the engine applies to bodies and what the island renderer applies to a
voice lane (ADR 0019). The "VT target" is the station's loudness target: one target for music
and voice keeps a VT at the level of the songs it sits between, and the segue's envelopes and
the voice's gain trim handle the balance of a talk-over.

The browser does not normalise, compress or limit the take: a second, browser-specific gain
stage would make the island differ from what ingest measured, and the editor's preview already
plays the voice at its playout gain once the take is measured (`asset.updated` refetches the
lanes' media). The recorder only warns, calmly and without blocking, when the kept part clips
(peak ≥ −0.5 dBFS) or is very quiet (peak < −30 dBFS: the playout gain would raise its noise).

### Format: mono 24-bit PCM WAV at the device's rate
- The mic is opened raw: `echoCancellation`, `noiseSuppression` and `autoGainControl` off.
  They pump and colour a voice, and echo cancellation fights the pre-roll. The recorder asks
  for headphones instead.
- Samples are captured by an AudioWorklet in the recorder's own `AudioContext`, as float blocks
  stamped with their context frame, not with `MediaRecorder`: its codecs (Opus/AAC) are lossy
  and its timing is not tied to the context clock that plays the pre-roll.
- The context runs at the device's rate (Firefox can't connect a mic to a context at another
  rate). The trimmed take is encoded as mono 24-bit WAV: lossless, so ingest's measurement and
  its 44.1 kHz FLAC playout copy come from what was recorded, and 24 bits keep a quiet take's
  detail when the playout gain raises it. A 3-minute take is about 26 MB at 48 kHz.
- Trimming happens in the browser before the upload: the asset is the voice, not the silence
  around it. The recorder suggests a trim (from 150 ms before the first sound above −45 dBFS
  to 300 ms after the last) on a full-page waveform.

### Placement: the take's axis start, by the clock that played the music
The pre-roll is the editor's own preview player (`SeguePlayer`, ADR 0019) created on the
recorder's context, so the music and the capture share one clock. It plays the segue's clips
(the editor's unsaved draft, handed over in memory) from `transitionStart − pre-roll`. The take
keeps the frames captured from the context time the music starts. The presenter speaks over
what they hear: a captured frame entered the mic `inputLatency` before the context saw it,
and the music heard then was scheduled `baseLatency + outputLatency` earlier. So:

    take.axisStart = preroll.from − round((inputLatency + baseLatency + outputLatency) × 44 100)
    voice.start    = take.axisStart + trim.from × 44 100 / take.sampleRate

`inputLatency` is the track's `latency` setting where the browser reports it (0 otherwise);
anything left is a small constant offset the presenter nudges in the editor.

Back in the editor the take becomes a new voice lane at `voice.start` with `cueIn: 0`. An
explicit cue-in matters: a VT's asset cue-in may later be set by autocue (leading silence),
and the lane would otherwise play from there and shift the voice off the words it was spoken
over. The new lane is an undoable edit of the draft; the presenter shapes it and saves the
segue, which re-derives the island (ADR 0017). A standalone take (no pre-roll, e.g. a promo for
#60) is recorded from `voice-tracks/record` and only goes to the library.

### Permissions
Presenters hold `voice_track:write_own` but not `library:write`. The upload routes' guard now
also accepts a `vt` upload from a signed-in caller with `voice_track:write_own` (or
`voice_track:write`), and the later calls on an upload they started, as it already did for
episode uploads with `show:write_own`. The asset is an ordinary library asset; segue writes keep
their own `write_own` check.

## Consequences
- A take's island is renderable once ingest made its playout copy (the segue is `waiting`
  before). Loudness arrives a little later and re-syncs the island through `asset.updated`, so
  a segue saved right after recording may render twice: once at 0 dB, then at its playout gain.
- No in-browser loudness meter: the recorder shows peak level only. A short-term LUFS meter
  could come later; it would only inform, never change the take.
- Latency compensation is as good as the browser's latency report. A per-device offset setting
  is possible later if presenters see a consistent drift.
- The editor's draft hand-over is in memory: reloading the recorder page drops it (the editor
  then starts from the saved segue; an uploaded take stays in the library).
