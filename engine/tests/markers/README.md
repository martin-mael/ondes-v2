# Fixed-time markers on the real engine (#52)

`markers.engine.int.test.ts` plays a log with hard, soft and not-before markers through the
api's real feeder into the station template, in the Liquidsoap image pinned in
`deploy/compose.dev.yml`, and checks the recorded final mix (ADR 0036, "Acceptance").

```bash
pnpm test:integration --project engine engine/tests/markers
```

- Needs Docker. It starts its own container on a random 127.0.0.1 port, never the shared dev
  stack, and removes it afterwards (`KEEP_MARKERS_WORK=1` keeps the recording in the temp
  directory).
- `MARKERS_REPORT=1` prints the feeder's view at each change, the engine's track events and
  the tone runs found in the recording, in seconds from the first marker.
- Type check: `pnpm exec tsc --noEmit -p engine/tests/markers`.
