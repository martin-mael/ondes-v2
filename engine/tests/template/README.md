# Station template tests

Tests for `engine/templates/station.liq`, the Liquidsoap script every station runs (#27,
ADR 0007). The template is rendered from station settings by
`apps/api/src/modules/engine/config`, so the tests always work on rendered scripts.

```sh
pnpm test:engine            # render every combination in combos.ts, liquidsoap --check each (docker)
pnpm test:engine:template   # run the rendered template and drive it (docker + ffmpeg, ~1 min)
node engine/tests/template/combos.ts <dir>   # just render the combinations into <dir>
```

Both use the Liquidsoap image pinned in `deploy/compose.dev.yml` (override with
`LIQUIDSOAP_IMAGE`). Generated files go to `engine/tests/template/.work/` (git-ignored).

## `liquidsoap --check` per settings combination (`combos.ts`)
Every combination of the toggles that change the script's structure (live input,
compressor, limiter), one rendering with all four output formats, a live auth webhook and
settings full of characters that need escaping (`"`, `\`, `#{…}`, non-ASCII, newlines), and
one without an events URL. Warnings count as failures. Add a combination here when a new
setting changes the script's structure.

## Runtime test (`run.ts`)
Runs the rendered template in its own container (random name, control port published on a
random `127.0.0.1` port, never the shared dev stack). Processing is off so the output can
be compared sample by sample, and a WAV recorder of the final mix is appended to the
script. It checks:

- the control API: health and `config_version`, 401 without the token, 422/400 on bad pushes,
  a refused segment queues nothing, queue state, remove by item id and by any part of a segment;
- the island chain from the splice test (`engine/tests/splice`, FLAC noise, cues snapped to
  the grid and half-sample biased) pushed as one `POST /v1/segment`: as-run reports
  `A`, `VT`, `B` in order with their `segment_id`, and the seam detector finds **no seam**
  (shift 0, residual ≤ −70 dB at both joins; about −115 dB measured);
- `POST /v1/skip` during a segment drops its remaining parts;
- B stops at its cue-out within one frame (the end of a segment is a normal crossfade
  boundary, frame-granular in Liquidsoap 2.4: 441 samples measured).

`--keep` keeps `output.wav` and `reference.wav` in `.work/run/` to listen to.
