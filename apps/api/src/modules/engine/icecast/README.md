# Icecast mounts and listener stats (#32)

The api's side of the public streams: which mounts each station has, Icecast's config for all
of them, and listener counts. Deployment, reload behaviour, Caddy and measurements:
`deploy/icecast/README.md`.

| Piece | File | Role |
|---|---|---|
| Mount plan | `mounts.ts` | `stationOutputs(row)`: the station's `engine_settings.outputs` or the defaults (`<slug>/mp3` 128k, `<slug>/aac` 128k; `opusOutput(slug)` is the opt-in 96k Opus), checked to stay in `/<slug>/…`. `planMounts(rows)` for every station; a station with broken outputs is skipped and reported, not fatal. |
| Config | `config.ts` | `renderIcecastConfig(mounts, options)`: deterministic `icecast.xml` with per-mount limits, UTF-8 charset, fallback and intro. Password placeholders only. |
| Sync | `sync.ts` | `createIcecastConfigSync({ db, path, config })`: reads the stations, writes the file atomically when it changed (boot, every 30 s, `syncNow()`). The Icecast container reloads it on its own (SIGHUP). |
| Admin client | `admin.ts` | `createIcecastAdmin(...).stats()`: `/admin/stats` parsed and checked with zod. Not `/admin/listclients`: it makes Icecast 2.5.0 deadlock on the next reload. |
| Poller | `poller.ts` | `createListenerStatsPoller(...)`: one sample per planned mount every 15 s, folded per minute by `recordListenerSamples` (`@ondes/db`). Fallback listeners count for their mount. Nothing recorded while Icecast is unreachable. |
| Alerts | `alerts.ts` | `stream.source_missing` (warning) through #33's `app.alerts` after a mount has had no engine for 60 s; resolved when it's back. |
| Wiring | `service.ts` | `createIcecastService({ db, config: icecastServiceConfigFromEnv(env), alerts })`, started from `main.ts`. Sync only with `ICECAST_CONFIG_PATH`, poller only with `ICECAST_URL` + `ICECAST_ADMIN_PASSWORD`. |

## Settings

Output fields (`apps/api/src/modules/engine/config/settings.ts`, `icecastOutputSchema`):
`mount`, `format`, `bitrate`, `public`, plus the Icecast-only `maxListeners` (500),
`burstSize` (64 KiB, must stay below) `queueSize` (512 KiB), `fallback` (true), `intro`
(false). Icecast-only fields (`ICECAST_ONLY_OUTPUT_FIELDS`) don't change the engine's config
version: editing them reloads Icecast and never restarts the engine.

After a settings change, call the lifecycle's `reconcile` (engine, #35) and `sync.syncNow()`
(Icecast), or let the 30 s re-check pick it up.

## Tests

- Unit: `pnpm vitest run apps/api/src/modules/engine/icecast` (stats fixtures captured from the
  pinned image in `testing/`).
- Integration: `icecast.int.test.ts` starts `testing/compose.yml` (project `ondes-icecast-it`,
  127.0.0.1:18100, override with `ICECAST_IT_PORT`): Icecast through
  `deploy/icecast/entrypoint.sh`, a Liquidsoap source with the template's encoders, and a
  one-shot that encodes the fallback/intro files. Needs Docker and Postgres. It checks the
  generated mounts, UTF-8 names, intro, stats, a reload under a listener, an unparsable config,
  fallback when the engine stops and back, a restart's impact, and the watchdog. It prints the
  measured gaps (`[icecast …]` lines). `ICECAST_IT_KEEP=1` leaves the stack up.
