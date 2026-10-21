# Engine lifecycle (#35)

Creates, starts, stops and restarts each station's Liquidsoap container from the api, and runs
one `StationEngine` (adapter, event ingest, health monitor: `../adapter`) per running station.
Decision record: `docs/adr/0008-engine-lifecycle.md`.

| Piece | File | Role |
|---|---|---|
| Docker client | `docker.ts` | The Engine API calls the lifecycle needs, over `fetch`, to the **Docker socket proxy**. `tarFile` builds the archive that copies the rendered script into a container. |
| Spec | `spec.ts` | Pure: station → settings to render (`engineSettingsFor`) → `POST /containers/create` body (`engineContainerSpec`) and its hash. |
| Secrets | `secrets.ts` | Per-station control token, live password and Icecast source password: generated once, AES-256-GCM in `station_engine` (key from `AUTH_SECRET`, own HKDF label). |
| Repo | `repo.ts` | `station_engine` row (desired state, secrets, applied version, container id) and the `engine_port` pool. |
| Guard | `guard.ts` | Restart-storm guard: restarts per station in a sliding window. |
| Service | `service.ts` | `reconcile`, `start`, `stop`, `restart`, `remove`, `status`, `secretsFor`, `boot`, the supervisor. |
| Plugin | `plugin.ts` | Fastify wiring: `app.engineLifecycle`, `app.stationEngines`, engine routes, the internal events route, boot. `engineLifecycleConfigFromEnv`. |

## What a station's engine gets

- **Script**: `renderStationScript(engineSettingsFor(station))`, copied to `/etc/ondes/station.liq`
  with `PUT /containers/{id}/archive` before the first start. Nothing on the host filesystem.
- **Settings**: `station.engine_settings` (outputs, blank, processing, crossfade, live mount and
  buffer, …), with the fields the lifecycle owns forced: station id, ports (control 7000, metrics
  9599, live 8005 inside the container), `eventsUrl`, paths under `/cache`, Icecast host and port.
  Outputs default to one 128 kbps MP3 mount `<slug>.mp3` until the station has its own (#32).
- **Secrets** in its environment (`ENGINE_CONTROL_TOKEN`, `ENGINE_LIVE_PASSWORD`,
  `ICECAST_SOURCE_PASSWORD`), never in the script. With `ICECAST_SOURCE_PASSWORD` set on the api,
  every engine uses that shared password (one Icecast `<source-password>`); unset, each engine
  gets its station's generated one, for per-mount passwords. The deploy's Icecast has a single
  global source password (#32), so set `ICECAST_SOURCE_PASSWORD` in production; the api logs a
  warning at boot when it's unset.
- **Limits**: `NanoCpus`, `Memory` = `MemorySwap` (no swap), `PidsLimit`; `CapDrop: ALL`,
  `no-new-privileges`; json-file logs capped at 30 MB.
- **Playout cache**: `<ENGINE_CACHE_ROOT>/<stationId>` bind-mounted read-only at `/cache`
  (ADR 0004), created if missing.
- **Network**: `ENGINE_NETWORK`, shared with the api and Icecast; the container is reachable as
  `<prefix>-<stationId>`. The control and metrics ports are never published.
- **Live port**: one host port per station from the `engine_port` pool
  (`ENGINE_LIVE_PORT_MIN`..`MAX`), published on `ENGINE_LIVE_BIND_IP` → 8005. Kept across
  recreations; released by `remove`.
- **Restart policy**: `on-failure`, 5 retries. Then the supervisor decides.

## Restart only when needed

`reconcile(scope)` (call it after changing `station.engine_settings`):

| Situation | Action |
|---|---|
| No container | create + start (`created`) |
| The engine reports another `config_version` than the rendered one, or the container's spec hash label differs (secrets, limits, ports, image, version) | stop, remove, create, start (`recreated`) |
| Container exists but exited | start (`started`) |
| Otherwise | nothing (`unchanged`) |
| Desired state `stopped` | stop if running (`stopped`) |
| Storm guard tripped | nothing (`storm`) |

`restart(scope)` is a person's restart: it clears the guard and always recreates. Every new
container is a new boot with an empty queue; the adapter's health monitor sees the new
`boot_id` and the feeder re-pushes on `onResync(…, 'boot')`.

## Health and restart storms

- **Up/down**: each running station's `StationEngine` health monitor publishes `engine.up` /
  `engine.down` (#28). `GET /api/v1/stations/:stationId/engine` reports it with the container
  state, the expected and reported `config_version` (`restartPending`) and the live port.
- **Supervisor** (every 15 s): counts Docker's own restarts (`RestartCount` deltas) and restarts
  dead containers itself. More than `ENGINE_RESTART_MAX` (5) restarts in
  `ENGINE_RESTART_WINDOW_SECONDS` (600) trips the guard: the restart policy is set to `no`, the
  container is stopped and `engine.restart_storm` is published (alerts, #33). It stays down
  until `POST …/engine/restart`. Counts live in memory.

## Routes

| Route | Permission | |
|---|---|---|
| `GET /api/v1/stations/:stationId/engine` | `engine:read` | status |
| `POST /api/v1/stations/:stationId/engine/start` | `engine:control` | desired = running, reconcile |
| `POST /api/v1/stations/:stationId/engine/stop` | `engine:control` | desired = stopped |
| `POST /api/v1/stations/:stationId/engine/restart` | `engine:control` | clear the guard, recreate |
| `POST /internal/engine/stations/:stationId/events` | station's control token | engine events (#28) |

Control routes write an `audit_log` row (`engine.start|stop|restart`). `/internal/*` routes skip
the api-key check of the auth plugin and must never be routed through the public proxy.

## Configuration (api environment)

| Variable | Default | |
|---|---|---|
| `ENGINE_DOCKER_URL` | – | The socket proxy, `http://docker-socket-proxy:2375`. Unset: no engine management. |
| `ENGINE_NETWORK` | – (required) | Docker network shared by the api, Icecast and engines. |
| `ENGINE_API_URL` | – (required) | The api as engines reach it, e.g. `http://api:3000`. |
| `ENGINE_CACHE_ROOT` | – (required) | **Host** path of the playout cache root. |
| `ENGINE_IMAGE` | `savonet/liquidsoap:v2.4.6` | |
| `ENGINE_CONTAINER_PREFIX` | `ondes-engine` | |
| `ENGINE_ICECAST_HOST` / `_PORT` | `icecast` / `8000` | |
| `ENGINE_LIVE_PORT_MIN` / `_MAX` | `8100` / `8199` | |
| `ENGINE_LIVE_BIND_IP` | `0.0.0.0` | |
| `ENGINE_CPUS` / `ENGINE_MEMORY_MB` / `ENGINE_PIDS` | `1` / `512` / `256` | 256 MB is not enough: Liquidsoap 2.4.6 is OOM-killed while loading. |
| `ENGINE_RESTART_MAX` / `ENGINE_RESTART_WINDOW_SECONDS` | `5` / `600` | |

## Docker socket proxy

`deploy/engine/docker-socket-proxy.compose.yml` (tecnativa/docker-socket-proxy, pinned by
digest). Allowed: containers, image pulls, ping, version; non-GET methods on those. Denied:
exec, networks, volumes, build, swarm, system, events, … Never publish its port; only the api
shares its network.

## Tests

- Unit: `pnpm vitest run apps/api/src/modules/engine/lifecycle` (spec, guard, secrets, Docker
  client and tar, env config).
- `service.int.test.ts`: decisions, storm guard, boot, port pool and routes on the real api and
  database, with an in-memory Docker (`testing/fake-docker.ts`).
- `lifecycle.int.test.ts`: real containers through the real proxy definition
  (`testing/compose.yml`, project `ondes-engine-lifecycle-it`, proxy on 127.0.0.1:17190, Icecast
  on :17191, live ports 17192–17199; override with `ENGINE_LIFECYCLE_IT_DOCKER_PORT` /
  `ENGINE_LIFECYCLE_IT_ICECAST_PORT`). Creates a station's engine, checks health, events,
  limits and the Icecast mount, changes a setting and checks the restart, stops and removes it.
  Needs Docker and Postgres; never touches `ondes-dev`.
