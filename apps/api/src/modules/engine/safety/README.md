# Safety playlist and emergency file (#34)

What a station plays when the log runs dry or its items aren't cached (ADR 0002, ADR 0004):
the safety playlist (random order), then the emergency file on a loop, then silence.

| Where | What |
|---|---|
| `service.ts` | Selection with audit rows, status, on-air source, alert sweep. `app.safety`. |
| `routes.ts` | `/api/v1/stations/:stationId/safety…` |
| `alerts.ts` | Pure: the alerts a station should have open. |
| `plugin.ts` | Decorates `app.safety`, the durable event consumer, the 30 s alert sweep. |
| `packages/db/src/schema/safety.ts`, `repos/safety.ts` | Tables and queries. |
| `packages/shared/src/contracts/safety.ts` | DTOs, file names. |
| `apps/worker/src/jobs/cache-sync/fallbacks.ts` | Puts the files in the engine's cache. |
| `apps/web/src/features/settings/safety` | The settings page. |

## Flow

1. A station manager picks library assets (or every asset with a tag, as a snapshot) and one
   emergency asset. An uploaded emergency file goes through the library upload and ingest
   first (#18), so it is a library asset like any other (type `other`).
2. Each change writes an `audit_log` row and asks for a `cache-sync` pass
   (`app.playoutCache.requestSync`). The worker's 10 min sweep catches up if RabbitMQ is down.
3. The pass hard-links the playout files into `/cache/safety/` and `/cache/emergency.flac` and
   records each file's state in `station_fallback_file`.
4. The template picks the change up by itself (watched directory, emergency file re-read at
   every loop; ADR 0007 "Fallback files"). **No engine restart, no reconcile.**

## API

| Route | Permission | |
|---|---|---|
| `GET …/safety` | `engine:read` | Selection with each file's cache state, last sync, on-air source. |
| `PUT …/safety/assets` | `engine:control` | `{ assetIds }`: replaces the playlist (≤ 1000). |
| `POST …/safety/assets` | `engine:control` | `{ assetIds }` or `{ tag: { key, value } }`: adds. 409 `safety_playlist_full`. |
| `DELETE …/safety/assets/:assetId` | `engine:control` | 204, 404 if not in it. |
| `PUT …/safety/emergency` | `engine:control` | `{ assetId }`, or `null` to clear it. |

Assets of another station are 404. Cache states: `ready`, `pending` (not synced yet),
`failed` (`error`: `source_missing`, `checksum_mismatch`, `io`), `no_file` (not ingested).

## Safety mode and alerts

The durable event queue `ondes.events.safety` records the source of every
`engine.track.started` in `station_fallback_state` (reset on `engine.booted` / `engine.down`;
late events are ignored). `GET …/safety` returns it as `onAir`.

Every 30 s one api replica evaluates, for each station whose engine should run:

| Alert | Severity | When |
|---|---|---|
| `engine.safety_mode` | warning, critical on `emergency` | Safety or emergency on air for 30 s (boot plays the emergency file for about a second). |
| `engine.safety_empty` | warning | No safety file in the engine's cache (none selected, or none synced). |
| `engine.emergency_missing` | warning | No emergency file selected, or not in the cache. |

They resolve with `back_on_schedule`, `fallback_ok`, or `engine_stopped` when the engine's
desired state is no longer `running`.

## Not here

- The listeners' Icecast fallback (ADR 0010) is the same emergency file re-encoded per mount
  format into Icecast's webroot. That re-encoding is a separate worker job (ADR 0010
  "Consequences"); until it exists, `deploy/icecast/encode-assets.sh` does it by hand.
- The feeder (#29) never pushes fallback content and never forces safety: it just stops
  pushing, and the template's fallback takes over.

## Tests

- `alerts.test.ts` (unit).
- `safety.int.test.ts` (Postgres): routes, permissions, audit, cache states, safety mode, alerts.
- `apps/worker/src/jobs/cache-sync/fallbacks.int.test.ts` (Postgres, Garage): the files on disk.
- `apps/web/src/features/settings/safety/safety-page.test.tsx`: the page.
