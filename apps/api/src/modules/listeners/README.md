# Listeners (#71)

Listener counts for the dashboard, read from what the Icecast stats poller (#32,
`apps/api/src/modules/engine/icecast/poller.ts`) records in `stream_listener_stat`: no sampler
of its own. ADR 0035.

| Route | Permission |
|---|---|
| `GET /api/v1/stations/:stationId/listeners` | `dashboard:read` |
| `GET /api/v1/stations/:stationId/listeners/history?hours=24` (1–168) | `dashboard:read` |

- **Now**: per mount, the newest minute bucket of the last 3 minutes (average rounded, max, and
  whether the engine fed the mount for most of it). No recent bucket: not listed (unknown is not
  zero).
- **History**: averages per step, at most 288 steps (5 min over 24 h), aligned on the step; a
  step with no sample is `null`.

Contracts: `currentListenersSchema`, `listenerHistorySchema` in
`packages/shared/src/contracts/streams.ts`. Test: `listeners.int.test.ts` (Postgres).
