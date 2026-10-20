# Spike #12: seamless island splicing, results

**Question:** can Liquidsoap 2.4.6 (`savonet/liquidsoap:v2.4.6`, the compose pin) play
`A body → rendered island → B body` with no audible seam?

**Answer: GO, with conditions.** The splice is sample-exact (residual at the 24-bit floor,
−110 to −127 dB) on FLAC and AAC playout copies, provided that:

1. the island chain is played as **one track** (`sequence(merge=true)`), so `cross` /
   `crossfade` never sees an island join;
2. `liq_amplify` is applied **per request, before the merge**;
3. every **cue-in is on the playout copy's packet grid**;
4. cue points are sent as **sample positions biased by half a sample**;
5. there is **no engine micro-crossfade**.

The stdlib crossfade metadata (`liq_cross_duration`, `liq_fade_in/out`, fade types) cannot
express a clean join on 2.4.6, with or without a micro-crossfade.

Reproduce: `sh engine/tests/splice/run.sh` (matrix), plus the probes in this folder.
Method and detector: `engine/tests/splice/README.md`.

## Measured seams

Odd sample positions (A cue-in 88 211, A→island at A-sample 529 417, B cue-in ≈ 353 k),
gains A −3.5 dB, island 0 dB, B −1.5 dB, 44.1 kHz. Residual = output − ideal splice
around each join, relative to the reference RMS; shift = lag change across the join in
samples (+ inserted, − dropped). "A→I / I→B" are the two joins.

### Recommended setup (`segment`: merged chain + station crossfade, snapped cues)

| playout copy | signal | shift A→I / I→B | residual A→I / I→B (dB) | clicks / dropouts | verdict |
|---|---|---|---|---|---|
| FLAC 24-bit, 1024-sample blocks | tone | 0 / 0 | −127.4 / −126.1 | none | clean |
| | noise | 0 / 0 | −116.7 / −115.2 | none | clean |
| | music | 0 / 0 | −110.6 / −110.1 | none | clean |
| AAC-LC 256k .m4a (ffmpeg `aac`) | tone | 0 / 0 | −127.4 / −125.9 | none | clean |
| | noise | 0 / 0 | −116.6 / −115.4 | none | clean |
| | music | 0 / 0 | −110.6 / −110.1 | none | clean |
| MP3 256k (LAME) | tone | 0 / 0 | −124.3 / −125.8 | none | clean |
| | noise | 0 / 0 | −116.2 / **+0.7** | **57 samples of silence** at B start | seam |
| | music | 0 / 0 | −110.6 / **−13.2** | **113 samples of silence** at B start | seam |

The `sequence` mode (no transition operator at all) gives identical numbers. The station
sketch below confirms it with a dynamic segment and real crossfades around it.

Island rendered from the FLAC masters while the bodies play lossy copies: the joins then
show the codec difference (I→B residual: AAC −65 / −21 / −53 dB, MP3 −81 dB / dropout /
dropout for tone / noise / music). So the island must be rendered from the exact file
the engine plays, or everything must be lossless.

### What does not work

| setup | result (same on FLAC, AAC, MP3) |
|---|---|
| Cue-in not on the packet grid | B starts 443 samples late (FLAC/AAC), A body shifted by its seek error (877); MP3 lands early (−612, −278) |
| `crossfade` with `liq_cross_duration=0`, `liq_fade_in/out=0` (crossfade disabled per track) | 211 samples dropped at A→I (replaced by silence), 443 more at I→B; residual ≈ 0 dB |
| `crossfade` with a 10 ms linear micro-crossfade in metadata | −211 at A→I, +439 at I→B, 652 samples of silence |
| Custom `cross` transition doing the 10 ms micro-crossfade | identical to the line above |
| Same, frame duration 5 ms / 40 ms, or 50 ms handles | still off by −109/−103, −1093/−443, +671/−159 samples |

## Root causes (Liquidsoap 2.4.6)

**Seeks are packet-granular, and the error carries over to the cue-out.**
`seek-probe.ts`, one white-noise request per target, ffmpeg decoder (the default):

| copy | where `liq_cue_in` lands |
|---|---|
| FLAC, 1024 blocks | next block boundary (within ~1 ms tolerance: 1025 → 1024, 1152 → 2048, 88 211 → 89 088); exact on a boundary |
| FLAC, 4096 blocks | next 4096 boundary (up to 4095 samples late) |
| AAC .m4a / ADTS | same as FLAC 1024 (frames of 1024 after priming) |
| MP3 | previous frame boundary (1152-sample frames offset by the 1105-sample delay); up to 1106 early |
| WAV | ~4060–4095 samples late, every time |

The native libFLAC decoder lands at the same place. The track then plays exactly
`cue_out − cue_in` from wherever it landed.

**Cue rounding** (`cue-rounding-probe.ts`): with a cue-in, Liquidsoap plays
`ceil(out·sr) − ceil(in·sr)` samples; without one it stops at `floor(out·sr)`. A 9-decimal
`n/sr` was enough to gain one sample at A→I. Fix: send `(n − ½)/sr` on a request with a
cue-in, `(n + ½)/sr` without.

**`cross` is frame-granular.** At a track boundary that is not on a frame boundary, `cross`
loses the partial frame of the ending track: the A→I join at output sample 440 329 lost
211 samples = 440 329 − 499 × 882. Metadata, the transition function and the frame size
change the amount, not the behaviour. A normal crossfade hides this under the fade-out; an
island join cannot.

**`sequence(merge=true)` keeps a track mark before its last source**, hence the trailing
`source.fail()`. **`amplify` reads `liq_amplify` on new tracks only**, so it must run per
request inside the segment.

**MP3 after a seek**: 57–113 samples of digital silence, then wrong samples for the first
frame or so (no decoder pre-roll). The native `mad` decoder is worse (the output was
1.4 M samples short).

## Metadata keys and values that work on 2.4.6

Per request in the chain, for sample positions `n` at 44 100 Hz:

| request | keys |
|---|---|
| A body | `liq_cue_in="<(nIn − ½)/sr>"` with nIn on A's packet grid, `liq_cue_out="<(nJoin − ½)/sr>"`, `liq_amplify="<gain A> dB"` |
| island | `liq_amplify="0. dB"` (set it explicitly), no cue points |
| B body | `liq_cue_in="<(nB − ½)/sr>"` with nB on B's packet grid, `liq_amplify="<gain B> dB"`, plus the normal `liq_cue_out` / fades for B's own end |

With no cue-in on A (the body starts at 0): `liq_cue_out="<(nJoin + ½)/sr>"`. Gains as
`"-3.5 dB"`; the renderer applies the same 10^(dB/20) per sample.

`liq_cross_duration`, `liq_fade_in`, `liq_fade_out` and the `*_type` keys are **not** used
at island joins; they keep their normal meaning for the transitions into and out of the
chain (the station crossfade sees the merged chain as one track).

Station side (sketch: `station-sketch.liq`, checked by `station-sketch.ts`):

```liquidsoap
def segment(uris) =   # one log item, or an island chain A body | island | B body
  sequence(merge=true, [...list.map(one_request, uris), source.fail()])
end
radio = source.dynamic(self_sync=false, track_sensitive={true}, next_segment)
radio = crossfade(duration=3., fade_in=3., fade_out=3., radio)
```

`one_request` wraps each request in `amplify(override="liq_amplify", 1., …)`. Running
Z → [A | island | B] → C gave two normal 3 s crossfades, and inside the chain shift 0 at
both joins, residuals −116.7 / −115.2 dB, and no lag change across the chain.

## Micro-crossfade parameters

**None.** With the rules above the butt splice is already sample-exact, so a
micro-crossfade has nothing to mask, and the only way to do one on 2.4.6 (`cross`) breaks
the join it is meant to protect. Renderer parameters that were tested and work:

- handles: 10 ms (441 samples) on each side. They are rendered but unused by the butt
  splice; keep them, they cost nothing.
- island tail extended by less than one packet (< 1024 samples, 23 ms) so that B's cue-in
  lands on B's grid; A's cue-in moved up to the next packet (< 23 ms on a song intro).

## What the next issues need

- **Ingest / playout copies:** FLAC at the engine rate (44.1 kHz), fixed block size
  `-frame_size 1024`, block size stored with the asset. AAC works only if the island is
  rendered from that very file and its grid is known (priming depends on the encoder; only
  ffmpeg `aac` was tested). Not MP3.
- **Renderer (#56):** render from the playout copy, snap A's cue-in and B's cue-in onto the
  grid, apply gains as `liq_amplify` does, and reuse `engine/tests/splice/seam-detector.ts`
  plus this test in CI.
- **Feeder (#57) / templates:** push an island chain as one segment (above); send cue points
  with the half-sample bias; never put island joins through `cross`. Skipping inside a
  segment skips the whole chain, to be designed there.
- **Fallback when the island is not rendered at air time** (epic #54: standard crossfade
  with the VT overlaid): this is a live mix in a custom `cross` transition. It works but
  inherits the frame-granular boundary errors measured above (up to one frame at each
  transition edge). That is acceptable under fades, so it stays a degraded mode and is not
  "what you preview is what airs". Not needed as the primary path.
- **Upgrades:** the splice test fails if a known-bad FLAC case turns clean (or a good one
  breaks), so a Liquidsoap bump re-validates these rules.
