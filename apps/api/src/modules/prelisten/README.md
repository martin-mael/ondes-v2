# Pre-listen (#71)

Hear a live input before it takes the air. ADR 0035.

- **Engine**: the station template (`engine/templates/station.liq`) adds one `output.harbor` per
  live input on the control port (internal only), mount `prelisten/<input>`, MP3 96 kb/s, behind
  the control token as HTTP basic auth (user `ondes`). Liquidsoap registers the mount only while
  the input has a DJ: otherwise 404.
- **Adapter**: `engine.listen(input, signal)` returns the stream's `Response`, or null on 404.
  Only the answer is timed; the body runs until `signal` aborts.
- **Route**: `GET /api/v1/stations/:stationId/live/inputs/:input/listen` (`live:read`) proxies it
  as `audio/mpeg` until the client hangs up. 404 `not_connected` when nobody streams there, 503
  `engine_unavailable` when the engine isn't running or doesn't answer. Not audited (a read).

Tests: `prelisten.int.test.ts` (the route over a fake engine, Postgres) and
`prelisten.engine.int.test.ts` (the real template with a DJ container, Docker; `engine` project).
