# Icecast mounts and listener stats (#32)

The api's side of the public streams: which mounts each station has, Icecast's config for all
of them, listener counts and stream alerts. Deployment, passwords, fallback files, reload
behaviour, Caddy and measurements: `deploy/icecast/README.md`.

| Piece | File | Role |
|---|---|---|
| Mount plan | `mounts.ts` | `stationOutputs(row)`: the station's `engine_settings.outputs` or `defaultStationOutputs(slug)` (settings.ts: `<slug>/mp3` 128k, `<slug>/aac` 128k; `opusOutput(slug)` is the opt-in Opus 96k), rejected when a mount leaves `/<slug>/…`. `planMounts(rows)` for every station. |
| Passwords | `passwords.ts`, `service.ts` | Each station's mounts carry its source password: the lifecycle's secret (`secretsFor(scope).icecastSourcePassword`, #35), or without the lifecycle `icecastSourcePassword(ICECAST_SOURCE_SECRET, stationId)`. |
| Config | `config.ts` | `renderIcecastConfig(mounts, options, secrets)`: deterministic `icecast.xml` with per-mount limits, password, UTF-8 charset, fallback and intro. Global passwords as placeholders. |
| Sync | `sync.ts` | `createIcecastConfigSync({ db, path, config, sourcePasswordFor, assetsDir })`: reads the stations under an advisory lock, keeps a broken station's last good mounts, configures fallback/intro only when the file exists, writes the file atomically when it changed (boot, every 30 s, `syncNow()`, `syncStation(station, password)` from the lifecycle's `onBeforeCreate`). The Icecast container reloads it (SIGHUP). |
| Admin client | `admin.ts` | `createIcecastAdmin(...).stats()`: `/admin/stats` parsed and checked with zod. Never `/admin/listclients`: it makes Icecast 2.5.0 deadlock on the next reload. |
| Poller | `poller.ts` | `createListenerStatsPoller(...)`: one sample per planned mount every 15 s, folded per minute by `recordListenerSamples` (`@ondes/db`). Fallback listeners count for their mount. Reports source changes, removed mounts and Icecast being unreachable (4 failed polls). |
| Alerts | `alerts.ts` | `createStreamAlerts({ alerts: app.alerts })` (#33): `stream.source_missing` (60 s grace, 30 s hold before resolving), `stream.config_invalid`, `stream.icecast_unreachable`. |
| Wiring | `service.ts` | `createIcecastService({ db, config: icecastServiceConfigFromEnv(env), alerts, lifecycle })`, started from `main.ts` (`app.alerts`, `app.engineLifecycle` when registered). Sync with `ICECAST_CONFIG_PATH` (+ `ICECAST_SOURCE_SECRET` without the lifecycle); poller with `ICECAST_URL` + `ICECAST_ADMIN_PASSWORD`; hourly `downsampleListenerStats` with the poller. |

## Settings

Output fields (`apps/api/src/modules/engine/config/settings.ts`, `icecastOutputSchema`):
`mount`, `format`, `bitrate`, `public`, plus the Icecast-only `maxListeners` (500),
`burstSize` (64 KiB, must stay below) `queueSize` (512 KiB), `fallback` (true), `intro`
(false). Icecast-only fields (`ICECAST_ONLY_OUTPUT_FIELDS`) don't change the engine's config
version: editing them reloads Icecast and never restarts the engine. Where outputs are saved
or rendered, also reject `mountsOutsideNamespace(slug, outputs)`.

After a settings change, call the lifecycle's `reconcile` (engine, #35) and `sync.syncNow()`
(Icecast), or let the 30 s re-check pick it up.

## Tests

- Unit: `pnpm vitest run apps/api/src/modules/engine/icecast` (stats fixture captured from the
  pinned image in `testing/`).
- Integration: `icecast.int.test.ts` starts `testing/compose.yml` (project `ondes-icecast-it`,
  127.0.0.1:18100, override with `ICECAST_IT_PORT`): Icecast through
  `deploy/icecast/entrypoint.sh`, a Liquidsoap source with the template's encoders and the
  station's derived password, and `deploy/icecast/encode-assets.sh` for the fallback/intro
  files. Needs Docker and Postgres. It checks the generated mounts, that a station can't source
  another's mount, UTF-8 names, intro, stats, a reload under a listener, an unparsable config,
  a station's broken settings, fallback when the engine stops and back, a restart's impact,
  and the watchdog. It prints the measured gaps (`[icecast …]` lines). `ICECAST_IT_KEEP=1`
  leaves the stack up.
