# ADR 0035: Health panels, listener counts, pre-listen and the dashboard's alerts

- Status: accepted
- Date: 2026-10-23
- Issue: #71 (epic #69). Builds on ADR 0002 (engine control), 0006 (event transport), 0008
  (engine lifecycle), 0010 (public streams, listener stats), 0018 (island renderer), 0022
  (missing-episode fallbacks) and 0027 (live switching).

## Context
The dashboard has to show whether the station is healthy: the engine, the DJs connected to the
live inputs (and what they sound like before they go on air), how many people listen, and what
needs attention. Most of the pieces existed:
- the alert framework (#33) with silence and engine-down alerts, plus the cache (#31) and
  missing-episode (#47) alerts;
- the Icecast stats poller (#32), which already folds a sample per mount every 15 s into
  minute buckets (`stream_listener_stat`) and downsamples them into hours after 30 days, two
  years kept;
- the lifecycle's status (#35) and the live status (#64).

What was missing: alerts for failed island renders and for engine restarts, a way to read the
listener counts, a way to hear a live input that isn't on air, and the web pages.

## Decision

### Listener counts: read what #32 records, no second sampler
No new table or job. The poller's minute buckets are the source of truth; the listeners module
(`apps/api/src/modules/listeners`) only reads them, station-scoped, behind `dashboard:read`:
- `GET …/listeners`: per mount, the newest minute bucket seen in the last 3 minutes (its
  average, rounded, and whether the engine fed the mount for most of it). A mount with no recent
  bucket isn't listed: unknown is not zero (Icecast unreadable, poller off).
- `GET …/listeners/history?hours=24`: averages per step, 288 steps (5 min over 24 h), aligned on
  the step so refetches keep the same points; a step without any sample is `null`, which the
  graph shows as a gap rather than a drop to zero.

There is no listener SSE event: the counts move slowly and the poller runs outside the request
path, so the dashboard refetches "now" every 30 s and the graph every 5 minutes, quietly.
Retention stays #32's (minutes 30 days, hours two years): enough for a 24 h graph and for later
reports. Counts only, never an address (GDPR, ADR 0010).

### Alert types added, and where they are raised
Additive in `alertTypes`; the generator's own alerts belong to #101.
- `island.render_failed` (warning, one per island): raised from the durable alerts consumer on
  `island.updated`, after reading the island row: only a `failed` island with no `retry_at`
  (a bad input, or retries spent) whose head item still has to air. Resolved when it renders,
  is retried, removed, or its item has aired. The renderer publishes best effort, so the sweep's
  30 s reconcile also raises the ones whose event was lost and closes stale ones. A warning:
  the feeder airs a failed island's items with the plain crossfade and the voice over
  (ADR 0024).
- `engine.restarted` (warning, one per station): the lifecycle supervisor publishes a new
  `engine.restarted` event when it sees Docker restart a crashed container or replaces a dead
  one (not restarts asked by a person or a settings change). `occurrences` counts restarts. It
  resolves after 30 minutes without one; a crash loop is still `engine.restart_storm`.

Silence, engine down and the restart storm (#33/#35), uncached items (#31) and missing episodes
(#47) were already raised by their producers; the dashboard only shows them.

### Visible within 5 s: events, not polling
Every alert change publishes an `alert.*` event (#33), relayed over SSE. The alerts page and the
dashboard panel refetch their list on each one, so an alert is on screen about a second after
it is raised. The integration tests measure the event's arrival (under 5 s) for every type.

### Pre-listen through the engine's control port
A DJ's audio exists only inside the engine (the harbor input), so the engine serves it: the
station template adds one `output.harbor` per live input on the control port (internal, never
published), mount `prelisten/<input>`, MP3 96 kb/s, behind the control token as HTTP basic auth.
It is fallible: Liquidsoap registers the mount only while the input has a DJ, so an empty input
answers 404. The api proxies it (`GET …/live/inputs/:input/listen`, `live:read`) through a new
`listen()` on the engine adapter, so the browser never reaches the engine and the token never
leaves the api. Rejected: a second Icecast mount per input (public by default, more Icecast
config per station) and recording to a file for playback (latency, disk).

The encoders run only while a DJ is connected (at most four inputs), a few percent of a core.
Liquidsoap logs that `output.harbor` is little maintained; it is used here for an internal,
best-effort monitor only, never for listeners.

## Consequences
- The dashboard reads the engine status through a new contract (`engineStatusViewSchema`)
  matching the lifecycle's `status()`; changing that shape is now a contract change.
- Listener history is only as good as the poller: while it is off or Icecast is unreadable,
  the graph has gaps. Several pollers (api replicas) don't skew it: buckets keep a sum and a
  sample count, so the average stays right.
- If `output.harbor` is dropped from Liquidsoap, pre-listen moves to `output.icecast` on a
  private Icecast mount; the api route and the UI stay.
- Staging checks for each alert type are listed in the PR of #71.
