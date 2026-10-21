# ADR 0004: Playout cache: content-addressed local files, synced from the log horizon

- Status: accepted
- Date: 2026-10-20
- Issue: #15 (spike). Consumers: #31 (cache sync job), #29 (feeder). Related: ADR 0002 (push resolves synchronously, 422 when not local), #7 (`@ondes/storage`).

## Context
Media lives in S3-compatible storage, content-addressed per org (`org/<orgId>/sha256/<hash>.<ext>`). Each station's Liquidsoap reads **local files only**: ADR 0002's push handler calls `request.resolve(timeout=5.)` and answers 422 when the file can't be resolved. Something has to put every file the log needs on the station's disk before air, keep the disk within a budget, and define what happens when a file isn't there.

Everything below was measured by `engine/spikes/cache` against the shared dev Garage and throwaway `savonet/liquidsoap:v2.4.6` containers (all 33 checks pass; run it with the README there). LibreTime's playout works the same way in principle: its fetcher downloads scheduled files into a local cache ahead of their start times and Liquidsoap only ever gets local paths.

## Decision

### On-disk layout
One cache directory per station, mounted **read-write in the worker** and **read-only in that station's engine** at `/cache`:

```
<cache root>/<stationId>/            host directory, e.g. /srv/ondes/cache/<stationId>
  media/<aa>/<sha256>.<ext>          final files, mode 0444, only ever created by rename(2)
  .partial/<sha256>.<ext>.part       downloads in progress (same filesystem as media/)
```

- **Content-addressed.** The path is a pure function of the file's hash: `enginePath('/cache', {sha256, ext})` → `/cache/media/ab/ab12….flac`. The feeder needs no lookup to build a URI, the same file used by many log items is stored once, and a name that re-hashes to itself proves the content.
- **Atomic writes.** Download to `.partial/…part` (append), hash while writing, check size and SHA-256, `fsync`, `chmod 0444`, `rename` into `media/`, `fsync` the directory. The engine is only ever given paths under `media/`, so it can't open a partial file. A watcher polling `media/` during cold syncs at concurrency 1–8 (about 12,500 observations) never saw a file at the wrong size.
- **Resumable.** An interrupted download keeps its partial file; the next attempt seeds the hash with the bytes on disk and fetches the rest with a Range request (measured: a 178 MB show resumed from 71 MB and verified). Partial files of objects no longer planned are deleted at the start of each pass.
- **Verified.** A SHA-256 or size mismatch deletes the partial file and fails that file with `ChecksumMismatchError` (non-retryable: the object itself is wrong).
- **Per station, not per org or per host.** Per-station budgets are simple to account for, and an engine can only read its own station's files. Two stations of one org playing the same file store it twice; a shared per-org directory with hard links is a later optimisation if multi-station orgs need it.
- **Permissions.** Files are 0444 and directories 0755, so the engine's `liquidsoap` user (uid 100) reads them whatever uid the worker runs as. The engine container got `Read-only file system` when it tried to write to the mount.
- **LRU without a database.** A file's mtime is set to the **last planned air time** of the items that use it (`utimes`). The eviction order is therefore on disk, survives worker restarts, and doesn't depend on `atime` (often `noatime`).

### Sync: log changes plus a periodic sweep
`cache-sync` is one worker job per station (#31). Each pass:

1. **Scan** `media/` (name, size, mtime). Disk is the source of truth for what's cached.
2. **Plan** (pure, `planner.ts`). Needed files = items with `airAt < now + 48 h` and an end after `now − 1 h`. Items that aired within the last hour stay **pinned** (the log can run late, an engine restart re-pushes, as-run lags), but a file that only aired in the past is never fetched.
3. Drop stale partial files, **evict** what the plan says, bump the mtime of kept files.
4. **Fetch** missing files in air-time order with a concurrency limit and an optional per-station bandwidth cap.
5. **Publish** the result: upsert the readiness table (below), raise or clear alerts.

Triggers:
- **Log changes.** Whenever the log for the horizon changes (#100), enqueue `cache-sync` for the station, on the **high** lane if the change starts within the next 2 h, else **bulk**. Use the queue's default `in_flight` idempotency (key `cache-sync:<stationId>`), so duplicates collapse while one runs. Because a change that lands during a run is dropped by that rule, the job **re-reads the log version at the end and runs another pass if it changed**.
- **Periodic sweep** every 10 min (bulk lane): catches anything missed, retries failed files, rolls the horizon forward, and frees budget as items age out.
- **Urgent fetch** (high lane, key `cache-fetch:<stationId>:<sha256>`): enqueued by the feeder when an item it's about to push isn't cached. Same `fetchToCache`, one file.
- Retries come from the queue framework (10 s, 1 min, 10 min). A failed file doesn't fail the pass: the pass records it and the next sweep tries again. Missing objects (`ObjectNotFoundError`) and checksum mismatches are reported, not retried in a loop.

**Concurrency and bandwidth.**

| Concurrency | Cold sync, 21 files / 536 MB, local Garage |
|---|---|
| 1 | 1.5–3.1 s (170–350 MB/s) |
| 2 | 0.8–1.4 s (375–690 MB/s) |
| 4 | 0.7–1.0 s (550–810 MB/s) |
| 8 | 0.7–1.9 s (280–770 MB/s) |

On one machine the bottleneck is the disk, and 8 is no faster than 4. Against remote object storage, per-connection latency dominates and a few parallel streams fill the link. **Default: 4 downloads per station, 8 per worker process** (the worker's consumer concurrency). A **shared token-bucket cap per station** (`bytesPerSec`) keeps a cold start from saturating the VPS link: capped at 40 MB/s, the pass ran at 39.4 MB/s. Icecast listeners use the *outbound* direction, so the cap is unset by default and exists for small or metered links.

**Priority by air time.** Files are fetched by their first upcoming air time. With the 40 MB/s cap, no file completed after one airing more than an hour later, and the next hour (341 MB) was ready in 9.3 s against an ideal of 8.5 s. The spike's library is small (20 tracks), so the first hour needs most of it; a real library spreads further, which makes the ordering matter more, not less.

**Sizing for Vandale.** 24-bit FLAC music is about 7.5–10.5 MB per minute (the spike's fixtures are 6.2). 48 h of air with no repeats at all is about 26 GB, the worst case; rotation repeats bring it down a lot. A cold start at 50 MB/s (typical object storage to VPS) fills a worst-case horizon in about 9 min and the next hour (≤ 600 MB) in about 12 s; at 10 MB/s it takes 45 min and about 1 min. That meets #31's "ready within minutes".

### Eviction and the disk budget
- **Never evict anything in the pinned window** (`now − 1 h` to `now + 48 h`).
- **Lazy LRU outside it.** Files outside the window stay as a warm cache until their space is needed, since rotation brings most tracks back within days. When a missing file doesn't fit, evict the least recently needed (oldest mtime) until it does. Measured on a synthetic "day 2": 4 of the 5 retired tracks were evicted, oldest first, the fifth stayed warm, nothing in the horizon was touched, and usage ended at 561 of 582 MB.
- **Per-station budget** (`station.cache_budget_bytes`, default **40 GB**, about 1.5× the worst-case Vandale horizon). The UI shows the horizon's size next to the budget.
- **When the horizon doesn't fit,** air time wins: files are fetched in air-time order until the budget is full, and **everything after the first file that doesn't fit is deferred**, so a small late track never takes the space an earlier show needs. Deferred files are fetched on later sweeps as aired items leave the window and become evictable, so the cache behaves like a rolling window. The planner raises `cache.budget_exceeded`. Measured with a budget of 60 % of the horizon: 18 files fetched, 3 deferred, ready until +0.95 h (86 % of air time), with a critical alert for the first item it didn't cover.
- **Host safety.** Separately from per-station budgets, the worker stops fetching (and alerts `cache.disk_low`) when the host filesystem has less than 5 % or 2 GB free, whichever is larger.

### Missing at air time
Three options, measured on Liquidsoap 2.4.6:

| Option | What we measured | Verdict |
|---|---|---|
| **Skip + alert** | A missing local path fails `request.resolve` in 0.1–0.2 ms, so the push answers 422 at once. The feeder pushes the next cached item. | **Default.** |
| **Presigned URL as a fallback** | Works: HTTP and HTTPS (including a redirect) resolve, and the request plays. `request.resolve` downloads the **whole file** into the container's `/tmp` before playback (`/tmp/liq-process….osb`), so the pushed duration only becomes known once it's downloaded. Local Garage: track 70–150 ms, 178 MB show 0.4–0.65 s. **Through a 10 MB/s link: track 2.2 s, show 17.8 s, so with the template's 5 s timeout the show fails (422) after blocking the push handler for the full 5 s.** Expired URLs fail (5–30 ms). Under load we once saw a track's resolve stall for 6.5 s (past the 5 s timeout) and the next URL fail at once. | **Rejected.** See below. |
| **Safety playlist + alert** | The engine already falls back to the safety playlist when its queue runs dry (ADR 0002). | **Backstop**, not a strategy. |

Why no presigned fallback: it only helps for files small enough to download within the push timeout, and in exactly those cases an **urgent fetch by the worker is just as fast** (it's the same download, about 2 s for a track at 10 MB/s) and lands the file verified and atomically in the cache, where it stays for the next airing. A fallback would also give every engine egress to object storage, put signed URLs in engine logs and requests, need writable temp space in the engine container, and block the harbor handler for up to the timeout. Long files (shows), the ones most likely to be scheduled at a hard time, wouldn't make it anyway.

**Behaviour (#29):**
1. Before pushing an item, the feeder checks `isCached`. If the item isn't cached, the feeder **doesn't push it**: it enqueues an urgent fetch, raises `cache.item_missing` (critical), marks the log item `skipped_not_cached` for as-run, and pushes the next cached item instead. The skipped item is not retried later in the same slot, because the log's timing has already moved on.
2. A **422 from the engine** (the DB said cached, the disk disagrees) is handled the same way, and it also enqueues a `cache-sync` pass, which reconciles the table with the disk.
3. If **nothing cached** can be pushed, the engine queue runs dry and the safety playlist takes over; the engine adapter alerts on that (ADR 0002).
4. Islands (#57): a segment is pushable only if **every** file in it is cached; otherwise the feeder skips the whole segment.

Hard-start items that get skipped leave a gap for back-timing to absorb (#14).

### Readiness API (#31 provides, #29 and the dashboard consume)
The worker owns the disk; the api and feeder read a table the worker keeps in sync with it.

- **Table** `playout_cache_file` (schema file `packages/db/src/schema/cache.ts`, new and additive): `station_id`, `org_id`, `sha256`, `ext`, `size_bytes`, `state` (`ready` | `failed`), `error` (`source_missing` | `checksum_mismatch` | `io`), `fetched_at`, `last_needed_at`. Rows are written only after the rename (`ready`) or after a failed attempt. Every pass reconciles the table with its disk scan, so a row can't claim a file the disk doesn't have for longer than one pass, and the engine's 422 catches the rest.
- **Contract** (`packages/shared/src/contracts/cache.ts`):

```ts
/** Engine URI for a cached file. Pure; no I/O. */
playoutPath(file: { sha256: string; ext: string }, engineRoot = '/cache'): string;

interface PlayoutCacheReader {
  isCached(scope: StationScope, assetFileId: string): Promise<boolean>;
  /** Over the log items in [now, now + window). */
  readiness(scope: StationScope, opts?: { windowMs?: number }): Promise<{
    items: number;
    readyItems: number;
    pctItems: number;        // 0–100
    pctAirTime: number;      // 0–100, weighted by planned duration: the dashboard number
    firstMissingAt: string | null;  // ISO UTC
    missing: Array<{ logItemId: string; airAt: string; sha256: string;
                     reason: 'pending' | 'deferred' | 'source_missing' | 'checksum_mismatch' }>;
  }>;
  requestUrgentFetch(scope: StationScope, assetFileId: string): Promise<void>;
}
```

  `StationScope` is the tenant scope from `@ondes/db` (`resolveStationScope`). The dashboard shows `pctAirTime` for 48 h and for 6 h.

### Alerts
Evaluated by every pass and by the sweep (`cacheAlerts` in `planner.ts` covers the first three; the sync pass reports the others), raised through the generic alert model from #33 (cache sync only adds these alert types), one open alert per station and item:

| Alert | Severity | When |
|---|---|---|
| `cache.item_missing` | critical | An item starting within **the next hour** isn't cached (one per item). This is the T−1h alert. |
| `cache.horizon_degraded` | warning | Anything in the next 6 h isn't cached; carries `pctAirTime` and `firstMissingAt`. |
| `cache.budget_exceeded` | warning | The horizon doesn't fit the station's budget (some files deferred). |
| `cache.source_missing` | critical | The object isn't in storage: retries won't help, someone must re-upload or replace the item. |
| `cache.checksum_mismatch` | critical | The stored object doesn't match its hash. |
| `cache.disk_low` | critical | Host free space under the reserve; fetching paused. |

All clear on their own once a later pass fixes the cause.

## Consequences
- **#31** implements `apps/worker/src/jobs/cache-sync` from `engine/spikes/cache` (`layout.ts`, `planner.ts`, `sync.ts`): the job, its triggers (log change, 10 min sweep, urgent fetch), the `playout_cache_file` table and the `cache.ts` contract above, and the alerts. Use `@ondes/storage`'s `get` with `range` for resume. Add DST tests for the window boundaries (the horizon is in UTC, but "next hour" alerts are shown in station time).
- **#29** builds engine URIs with `playoutPath`, checks `isCached` before each push, and handles a miss or a 422 as described above.
- **#27 / deploy:** the station engine mounts `<cache root>/<stationId>` at `/cache` read-only; the worker mounts `<cache root>` read-write. The engine needs no route to object storage. On a single VPS, the cache root is a host directory; a multi-host setup would run the sync job on each engine host.
- **Open:** a weekly full re-hash of the cache (disk-bound, a few minutes for 26 GB) to catch bit rot, and per-org deduplication across stations, are deferred until needed.

## Implementation notes (#31)
Where #31 departs from or fills in the above (details: `apps/worker/src/jobs/cache-sync/README.md`):
- **Budget and settings** live in a new `station_cache` table (budget, horizon, download cap, and the last pass's usage, deferred files and disk-low flag), not a `station.cache_budget_bytes` column: the tenancy schema stays untouched.
- **One lane.** `cache-sync` and `cache-fetch` both run on `high` with the default `in_flight` key (payload hash); an explicit key would make them run once ever.
- **Log changes** reach the worker through a durable event queue (`ondes.events.cache-sync`, ADR 0006), so a change published while no worker runs isn't lost.
- **Alerts are evaluated by the api**, every 30 s by one replica, from the tables the worker keeps (`apps/api/src/modules/cache`), and go through `app.alerts`. A pass doesn't raise them itself: the T−1h rule depends on the clock, not only on passes, and the alert framework lives in the api. A file recorded `ready` resolves its alerts within 30 s. Stations are evaluated whether or not a pass ever ran for them, so a worker without a cache or with failing passes can't silence `cache.item_missing`; a failed pass adds `cache.sync_failing`.
- **Eviction is lazier than the spike's:** files are evicted only when that makes enough room for the next file; a file that can't fit anyway is deferred without evicting anything.
- **Per-file locks** (`.partial/<file>.lock`, created with `O_EXCL`, holding a token, stale after 2 min without progress, taken over by rename) keep two worker processes, or a pass and an urgent fetch, from appending to one partial file, and guard partial cleanup and eviction against concurrent fetches.
- **Log changes during a pass:** besides the end-of-pass fingerprint check, the trigger enqueues once more 30 s after each change.
- **A corrupt resume** starts over once from byte 0 before the file is marked `checksum_mismatch`.
- **Island renders** aren't modelled yet (#57); the horizon query takes the segment parts' files, and renders join it when they exist.
