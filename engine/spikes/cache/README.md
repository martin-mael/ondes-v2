# Spike: S3 → local playout cache (#15)

How do we guarantee every item in the next 48 hours is on the station's local disk before
air, and what happens when one isn't? The decisions and measurements are in
`docs/adr/0004-playout-cache.md`; this folder is the prototype that backs them.

## Run it

```sh
pnpm dev:up                      # shared stack; the spike only needs Garage
cp -n .env.example .env
node --env-file=.env engine/spikes/cache/spike.ts
```

It takes about a minute (plus the first `docker pull` of `savonet/liquidsoap:v2.4.6`) and
exits non-zero if a check fails. Needs Docker and `ffmpeg` on the host.

- Objects go under a random org id (`org/spike-cache-<hex>/…`) and are deleted at the end
  (`--keep` leaves them). The shared stack is never stopped or restarted.
- Fixtures (about 630 MB of 24-bit FLAC with 1024-sample frames, like the playout copies)
  are generated with `ffmpeg` into a temp dir. Pass `--work <dir>` to reuse them across runs.
- The engine checks run throwaway Liquidsoap containers on the `ondes-dev_default` network
  (to reach `garage:3900`), and one with `--add-host host.docker.internal:host-gateway` to
  go through a 10 MB/s proxy the driver runs on the host. One check fetches a public FLAC
  from `raw.githubusercontent.com` to test HTTPS.

## Files

| File | Role |
|---|---|
| `layout.ts` | On-disk layout, path resolver, atomic + verified + resumable download (`fetchToCache`), shared bandwidth throttle, disk scan. |
| `planner.ts` | Pure planner: horizon + cache + budget → fetch order, evictions, deferred files. Readiness and alert rules. |
| `sync.ts` | One sync pass: scan, plan, drop stale partials, evict, fetch with a concurrency limit. What #31's job does. |
| `probe.liq` | Engine-side probe: resolves URIs like the template's push handler (`request.resolve` + timeout) and plays one. |
| `spike.ts` | The driver: fixtures, upload, a synthetic 48 h log, and every check below. |

## What the driver checks

1. Cold cache readiness is 0 %.
2. Cold sync at concurrency 1/2/4/8 while a watcher polls `media/`: no partial file is ever
   visible there; every file re-hashes to its name and is mode 0444.
3. A corrupt object (bytes don't match the key's hash) is rejected and leaves nothing behind;
   a missing object is reported as missing at the source; both raise the right alerts.
4. Restart: a second pass on a full cache downloads nothing.
5. With a 40 MB/s cap, files complete in air-time order and the next hour is ready as soon as
   its own bytes can arrive.
6. An interrupted download keeps its partial file and resumes with a Range request.
7. Eviction on "day 2": only files outside the horizon go, least recently needed first;
   everything in the horizon is on disk and usage stays within budget.
8. A budget smaller than the horizon: the earliest files are fetched, later ones deferred,
   `cache.budget_exceeded` raised.
9. Files that aired within the last hour stay pinned; past-only misses are never fetched.
10. Engine (Liquidsoap 2.4.6): resolves cached files from a read-only mount, fails at once on
    a missing path (the push 422), can't write to the mount; resolves and plays presigned
    HTTP and public HTTPS URLs; expired URLs fail; at 10 MB/s a track resolves in 2.2 s but a
    30 min show misses the template's 5 s timeout.
