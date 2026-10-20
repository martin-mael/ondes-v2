# Island splice test

Checks that the engine plays `A body → island → B body` with no seam, on the pinned
Liquidsoap image (the `savonet/liquidsoap` tag in `deploy/compose.dev.yml`). The island is an
ffmpeg-rendered FLAC holding the end of A, the voice track and the start of B (epic #54).
Spike #12 produced this test; its exit report is in `engine/spikes/splice/RESULTS.md`.

## Running it

Requirements: Docker, and `ffmpeg` (with libmp3lame) on the host. The music case downloads
one track from Wikimedia Commons the first time it runs.

```sh
pnpm test:engine:splice                            # this test (full matrix)
sh engine/tests/splice/run.sh                      # detector unit tests + full matrix (~5 min)
sh engine/tests/splice/run.sh --quick              # FLAC, tone and noise only (~1 min)
node engine/tests/splice/run.ts --only noise-flac  # one subset of the matrix
pnpm test:engine:splice --quick                    # FLAC cases only (what CI runs)
```

Everything generated goes to `engine/tests/splice/.work/` (git-ignored): test material,
islands, playlists, the recorded `output.wav` and ideal `reference.wav` of every case, the
Liquidsoap log, and `results.json`. Listen to a failing case's `output.wav` there.

Environment knobs: `LIQUIDSOAP_IMAGE` (default: the compose pin), `SPLICE_HANDLE` (handle
length in samples, default 441 = 10 ms), `SPLICE_FRAME` (Liquidsoap frame duration),
`SPLICE_DECODER` (`flac`, `mad`, `faad`, `mp4` to prefer a native decoder over ffmpeg),
`SPLICE_LOG_LEVEL`.

## What it does

For each case of the matrix (signal × playout format × engine mode):

1. **Material** (`fixtures.ts`): 24-bit FLAC masters at 44.1 kHz. `tone`: steady sines (A 440 Hz,
   B 660 Hz, VT 1 kHz). `noise`: white noise (unambiguous sample alignment). `music`:
   "Scheming Weasel (faster)" by Kevin MacLeod, CC BY 4.0, downloaded and SHA-1 checked.
   Lossy playout copies are encoded from the masters (MP3 256k LAME, AAC 256k in .m4a).
2. **Island** (`island.ts`): rendered by ffmpeg from the playout copies (or the masters for
   the `-island-from-master` cases). A ducks to −12 dB then fades out, the VT plays, B fades
   in. Gains are applied per sample exactly as the engine applies `liq_amplify`
   (10^(dB/20)): A at −3.5 dB, B at −1.5 dB, the island at 0 dB.
3. **Engine** (`splice.liq`): Liquidsoap plays the three requests with their cue points and
   gains on an unsynced clock and records a 24-bit WAV.
4. **Detector** (`seam-detector.ts`): compares the output with the ideal splice computed
   offline (`reference()` in `island.ts`).

Cue points are deliberately odd sample positions. Engine modes:

| mode | how the joins are expressed |
|---|---|
| `sequence` | butt splice, no transition operator |
| `segment` | butt splice; A body, island and B body merged into one track (`sequence(merge=true)`), then the station `crossfade`: **the recommended setup** |
| `crossfade-off` | station `crossfade`, disabled per track with `liq_cross_duration=0`, `liq_fade_in/out=0` |
| `crossfade-micro` | station `crossfade`, 10 ms linear micro-crossfade through metadata |
| `cross-micro` | custom `cross` transition doing a 10 ms linear micro-crossfade |

Cases without `-unsnapped` put every cue-in on the playout copy's packet grid (see below).

## Pass criteria

The run fails if a FLAC case is not as expected:

- snapped `sequence` and `segment` cases must be clean: no click, no dropout, no lag change
  or unaligned stretch anywhere in the file, lag shift 0 at both joins, residual below −70 dB
  (relative to the reference RMS) at the joins, and the same length as the reference;
- every other FLAC case documents a known Liquidsoap 2.4 limitation and must keep showing a
  seam. If one turns clean after an upgrade, the run fails so these rules get revisited.

MP3 and AAC cases use the same criteria but are reported (`seam` / `ok`), not enforced. The
reference is built from the same playout copies the engine decodes, so a correct lossy
splice also matches to the 24-bit floor; the `-island-from-master` cases render the island
from the FLAC masters instead, so their joins show the codec difference.

## The seam detector

`seam-detector.ts` is dependency-free and works on `Float32Array`s, so the island renderer
(#56) can use it in CI. Event offsets are sample positions in the analysed output.

- `detectClicks(x, sampleRate)`: spectral splatter. An 8th-order Butterworth high-pass at
  8 kHz removes the test tones (≥ 144 dB down at 1 kHz), and any window whose RMS exceeds
  −90 dBFS and the median + 20 dB is a click. One dropped sample or a 0.5 dB gain step on a
  440 Hz tone is caught. Steady low tones only.
- `detectDropouts(x)`: runs of digital silence (≥ 8 samples below 1e-5) inside loud audio.
- `trackAlignment(output, reference)`: lag measured every 4096 samples by normalised
  cross-correlation; every change is a `gap` (samples inserted) or an `overlap` (samples
  dropped) with its size, and loud stretches that cannot be aligned at all are a `mismatch`.
  Needs noise or music; a tone's lag is only known modulo its period.
- `compareJoins(output, reference, joins)`: lag before and after each join (`shift`) and the
  worst residual around it relative to the reference RMS, plus the floor just before it.
  `joinEvents(reports, limitDb)` turns them into events.

Its unit tests (`seam-detector.test.ts`) inject known defects (dropped and inserted samples,
silence, gain steps) and check that each is found at the right offset.

## Engine rules this test enforces (Liquidsoap 2.4.6)

These are what the renderer (#56) and the feeder (#57) must follow. Details and
measurements are in `engine/spikes/splice/RESULTS.md`.

1. **Never let `cross` / `crossfade` see an island join.** `cross` works in whole frames:
   at a track boundary that does not fall on a frame boundary it drops or pads up to one
   frame (silence of 211–882 samples measured), whatever the metadata says. Merge the chain
   into one track first: `sequence(merge=true, [a, island, b, source.fail()])`. The trailing
   `source.fail()` is needed: `merge` does not apply when advancing to the last source.
2. **Apply `liq_amplify` per request, before merging.** `amplify` only reads its override on
   a new track; inside a merged segment the island would keep A's gain.
3. **Snap every cue-in to the playout copy's packet grid.** A seek lands on a packet
   boundary (FLAC and AAC: the next 1024-sample packet; MP3: the previous frame), and the
   track then plays `cue_out − cue_in` from wherever it landed, so the error carries over to
   the cue-out. Playout FLAC copies are encoded with a fixed block size
   (`-frame_size 1024`); the renderer moves A's cue-in up to the next block and extends the
   island by less than one block so B's cue-in lands on one.
4. **Send cue points biased by half a sample.** With a cue-in, Liquidsoap plays
   `ceil(out·sr) − ceil(in·sr)` samples; without one it stops at `floor(out·sr)`. `n/sr` is
   rarely exact in binary, so use `(n − ½)/sr` on a request with a cue-in and `(n + ½)/sr`
   otherwise (`liqSeconds()` in `island.ts`).
5. **No engine micro-crossfade.** With rules 1–4 the butt splice is sample-exact, so the
   micro-crossfade has nothing to hide, and on 2.4.6 the only way to do one (`cross`) breaks
   rule 1. Handles are still rendered: they cost nothing and keep the option open.
