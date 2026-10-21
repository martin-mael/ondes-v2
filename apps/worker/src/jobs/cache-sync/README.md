# Playout cache sync (#31)

Keeps every file the log needs over the next 48 h on each station's local disk, so the
engine only ever plays local files. Design and measurements: `docs/adr/0004-playout-cache.md`.

## Pieces

| Where | What |
|---|---|
| `layout.ts` | The on-disk layout: scan, LRU stamp (mtime), atomic verified resumable download, per-file lock, free space. |
| `planner.ts` | Pure: the pinned window (`now − 1 h` → `now + 48 h`, UTC), what to fetch, defer and evict. |
| `sync.ts` | One pass for a station (`syncStation`), and `fetchOne`. |
| `urgent.ts` | The feeder's urgent fetch of one file (`cache-fetch` job, `../cache-fetch`). |
| `trigger.ts` | What enqueues passes: a durable consumer of `log.updated`, and a 10 min sweep. |
| `deps.ts` | Dependencies from the environment, shared by both jobs. |
| `packages/db/src/schema/cache.ts`, `repos/cache.ts` | `playout_cache_file`, `station_cache`; horizon query, readiness. |
| `packages/shared/src/contracts/cache.ts` | `playoutPath`, readiness DTOs, job payloads. |
| `apps/api/src/modules/cache` | `app.playoutCache` (readiness for #29), `GET …/cache`, the cache alerts. |

```
<cache root>/<stationId>/            read-only at /cache in the station's engine
  media/<aa>/<sha256>.<ext>          final files, 0444, created only by rename(2)
  .partial/<sha256>.<ext>.part       downloads in progress (resumed with a Range request)
  .partial/<sha256>.<ext>.lock       held by the process downloading that file
  safety/, emergency.flac            the template's fallbacks: outside media/, never evicted
```

## A pass

1. Scan `media/`: the disk is the source of truth.
2. Plan from the log items overlapping the window (with their asset's playout file):
   - fetch missing files in first-air-time order while they fit the budget;
   - once one doesn't fit, defer it and everything after it (strict air-time priority);
   - evict only to make room, least recently needed first (mtime = last planned air time),
     never a file the window needs, and not at all when eviction wouldn't make enough room.
3. Drop partial files no longer planned, evict, bump kept files' mtime, reconcile
   `playout_cache_file` with the disk (rows of vanished files go; `failed` rows go once the
   horizon no longer needs the file).
4. Fetch, 4 at a time per station and 8 per worker process, through a per-file lock (shared
   by worker replicas and the urgent fetch). Each file is hashed while written, size- and
   SHA-256-checked, fsynced, made read-only and renamed into place, then recorded `ready`.
   - A corrupt resume starts over once from byte 0.
   - A wrong object (`checksum_mismatch`), a missing one (`source_missing`) or any other
     error (`io`) is recorded on the row; the pass carries on, the next pass retries.
   - Fetching stops when the disk would go under its reserve (5 % or 2 GB): `diskLow`.
5. Record the pass on `station_cache`: bytes used, horizon size, deferred files, disk low.
6. If the log days in the window changed meanwhile, run again (up to 3 passes).

A pass that throws (unwritable cache root, database down) records `last_error` on
`station_cache` before the queue retries it; the next complete pass clears it.

### Concurrency with urgent fetches and other workers

- Every download, partial-file removal and eviction happens under the file's lock
  (`.partial/<file>.lock`, O_EXCL, holding a random token). A lock is stale after 2 min
  without progress; it is taken over by renaming it aside and checking its token, and
  released only by its owner.
- Partial files are removed only when unplanned, untouched for 10 min and unlocked.
- Eviction re-checks the file's mtime under its lock: a file touched since the scan (an urgent
  fetch, another pass) stays. The pass may evict against a log that changed mid-pass; the
  fingerprint check reruns it and the file is fetched again if needed.
- Reconcile and forget only delete rows older than the pass's scan, so a row an urgent fetch
  wrote meanwhile survives.

## Triggers

- `log.updated` on the events fanout, through the durable queue `ondes.events.cache-sync`
  (single active consumer), when it touches the next week: enqueue `cache-sync`, and again
  30 s later (one trailing enqueue per station), for a change that lands just after a running
  pass's last log check (its enqueue collapses into that pass's in-flight key). A failing
  handler retries in process (1 s, 5 s, 30 s), then gives the event up to the sweep: the
  queue never redelivers it in a loop.
- Every 10 min: enqueue `cache-sync` for every station.
- `app.playoutCache.requestSync(scope)` (a 422 from the engine) and
  `requestUrgentFetch(scope, assetFileId)` (a miss at push time), from the api.

Both jobs run on the `high` lane with the default `in_flight` idempotency (payload hash), so
duplicates collapse while one runs and later enqueues run again.

## Readiness and alerts (api)

`app.playoutCache` (`apps/api/src/modules/cache`): `isCached(scope, assetFileId)`,
`readiness(scope, { windowMs })`, `status`, `requestUrgentFetch`, `requestSync`.
`GET /api/v1/stations/:stationId/cache?hours=48` (`engine:read`) returns budget, usage, last
pass and readiness (`pctAirTime`, `firstMissingAt`, each missing item and why).

Every 30 s one api replica evaluates the alerts from these tables and raises or resolves them
through the alert framework (#33). It covers every station with file items in the next 6 h,
**synced or not** (a worker without `PLAYOUT_CACHE_ROOT`, or whose passes always fail, must
not silence them), every station with a cache record, and every station with an open cache
alert:

| Alert | Severity | When |
|---|---|---|
| `cache.item_missing:<logItemId>` | critical | An item overlapping the next hour isn't cached (T−1h). |
| `cache.horizon_degraded` | warning | Anything in the next 6 h isn't cached. |
| `cache.budget_exceeded` | warning | The last pass deferred files. |
| `cache.source_missing:<sha256>` | critical | The object isn't in storage. |
| `cache.checksum_mismatch:<sha256>` | critical | The object doesn't match its hash. |
| `cache.disk_low` | critical | Fetching paused: the disk is under its reserve. |
| `cache.sync_failing` | warning | The last pass failed (`details.error`). |

Each one resolves at the first evaluation where its cause is gone: `cache_ok` when the file is
now cached (or the condition cleared), `no_longer_needed` when the item aired or left the log,
or the file left the horizon, without being cached.

The worker logs an error at startup, and for every cache job it skips, when
`PLAYOUT_CACHE_ROOT` (or `ENGINE_CACHE_ROOT`) is unset.

## Configuration

Worker environment (`.env.example`): `PLAYOUT_CACHE_ROOT` (defaults to `ENGINE_CACHE_ROOT`;
unset turns the cache off), `CACHE_BUDGET_GB` (40), `CACHE_HORIZON_HOURS` (48),
`CACHE_CONCURRENCY` (4), `CACHE_WORKER_DOWNLOADS` (8), `CACHE_DISK_RESERVE_BYTES` (instead
of 5 % or 2 GB). Per station, `station_cache`
overrides the budget, horizon and a download cap (`bytes_per_sec`) — `setStationCacheSettings`.

## Tests

- Unit: `pnpm vitest run apps/worker/src/jobs/cache-sync` (planner incl. DST windows, layout
  with an in-memory storage, triggers), `packages/db/src/repos/cache.test.ts` (readiness),
  `apps/api/src/modules/cache/alerts.test.ts`.
- Integration (`pnpm dev:up`, `.env` loaded): `cache-sync.int.test.ts` (Garage, Postgres,
  RabbitMQ: cold sync, idempotency, corrupt object then fixed, missing object, eviction under
  budget, deferral, disk/table reconcile, urgent fetch, triggers) and
  `apps/api/src/modules/cache/cache.int.test.ts` (alerts raised and resolved, the endpoint).
