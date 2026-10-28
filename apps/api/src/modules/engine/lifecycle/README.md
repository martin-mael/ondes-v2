# Engine lifecycle (#35)

Creates, starts, stops and restarts each station's Liquidsoap container from the api, and runs
one `StationEngine` (adapter, event ingest, health monitor: `../adapter`) per running station.
Decision record: `docs/adr/0008-engine-lifecycle.md`.

| Piece | File | Role |
|---|---|---|
| Container policy | `container-policy.ts` | What an engine container may be (image, entrypoint, mounts, ports, limits, labels). Dependency-free: shared by the lifecycle and the proxy guard. |
| Proxy guard | `proxy-guard.ts`, `proxy-guard-main.ts` | The only Docker endpoint the api reaches. Checks every request against the policy, then forwards it to the socket proxy. Runs as its own container. |
| Docker client | `docker.ts` | The Engine API calls the lifecycle needs, over `fetch`, to the guard. |
| Spec | `spec.ts` | Pure: station → settings to render (`engineSettingsFor`) → `POST /containers/create` body (`engineContainerSpec`) and its hash. |
| Secrets | `secrets.ts` | Per-station control token, live password and Icecast source password: generated once, AES-256-GCM in `station_engine` with `ENGINE_SECRETS_KEY`. The key id is in each value, so keys rotate. |
| Repo | `repo.ts` | `station_engine` row (desired state, secrets, applied version, container id, storm), the `engine_port` pool, the per-station advisory lock. |
| Guard | `guard.ts` | Restart-storm counter: restarts per station in a sliding window. |
| Service | `service.ts` | `reconcile`, `start`, `stop`, `restart`, `remove`, `status`, `secretsFor`, `tokenFor`, `adapterFor`, `onBeforeCreate`, `boot`, the supervisor. |
| Plugin | `plugin.ts` | Fastify wiring: `app.engineLifecycle`, `app.stationEngines`, engine routes, the internal events route, boot. `engineLifecycleConfigFromEnv`. |

## Docker access

```
api ──docker-api (internal)──> docker-proxy-guard ──docker-socket (internal)──> docker-socket-proxy ──> docker.sock
```

`deploy/engine/docker-socket-proxy.compose.yml` defines both services and both internal
networks. Engines are never on either network; the api and the guard refuse `ENGINE_NETWORK`
being one of them.

- **Socket proxy** (tecnativa, pinned by digest): filters API sections only (containers, images,
  ping, version).
- **Proxy guard**: filters bodies and targets.
  - Creates: only `<prefix>-<id>` names, the pinned image, the engine entrypoint, `ondes.*`
    labels with `ondes.engine=true`, the engine network, a read-only bind of
    `<ENGINE_CACHE_ROOT>/<id>` at `/cache`, a read-write bind of
    `<ENGINE_CACHE_ROOT>/<id>/recordings` at `/recordings` (live recording, #67), tmpfs `/tmp`, a read-only root, CPU/memory/pids
    limits, no swap, `CapDrop: ALL`, `no-new-privileges`, only the live port published. No
    privileged mode, binds, devices, added capabilities, host namespaces or volumes.
  - Inspect, start, stop, update (restart policy only) and remove: only engine containers (label
    and name prefix, checked upstream). Any other container looks missing (inspect) or is
    refused (403).
  - Lists must filter on `ondes.engine=true`. Only the engine image can be checked or pulled.
  - Archives, exec, networks, volumes, logs and everything else: 403.

## What a station's engine gets

- **Script**: `renderStationScript(engineSettingsFor(station))`, passed in `ENGINE_SCRIPT` and
  written to `/tmp/station.liq` (tmpfs) by the entrypoint before Liquidsoap starts. Nothing on
  the host filesystem, no archive upload.
- **Settings**: `station.engine_settings` (outputs, blank, processing, crossfade, live mount and
  buffer, …), with the fields the lifecycle owns forced: station id, ports (control 7000,
  metrics 9599, live 8005 inside the container), metrics off, `eventsUrl`, paths under `/cache`,
  Icecast host and port. Outputs default to one 128 kbps MP3 mount `<slug>.mp3` until the
  station has its own (#32 replaces this default).
- **Secrets** in its environment (`ENGINE_CONTROL_TOKEN`, `ENGINE_LIVE_PASSWORD`,
  `ICECAST_SOURCE_PASSWORD`), never in the script. Each station has its own Icecast source
  password, which Icecast must know as its mounts' `<password>` (#32 writes it, through
  `onBeforeCreate`). There is no shared source password: with one, a station could take over
  another's mount.
- **Limits**: `NanoCpus`, `Memory` = `MemorySwap` (no swap), `PidsLimit`; `ReadonlyRootfs`,
  `CapDrop: ALL`, `no-new-privileges`; json-file logs capped at 30 MB.
- **Playout cache**: `<ENGINE_CACHE_ROOT>/<stationId>` bind-mounted read-only at `/cache`
  (ADR 0004), created if missing.
- **Live recordings**: `<ENGINE_CACHE_ROOT>/<stationId>/recordings` bind-mounted read-write at
  `/recordings` (ADR 0039), the only path the engine writes to. The lifecycle creates it before
  creating the container (a directory Docker creates is root's), mode 0750, and runs the engine
  as its own `uid:gid` (`User`, with `HOME=/tmp`; `ENGINE_USER` overrides), the user the worker
  runs as too: the engine writes and the worker deletes as the owner. An api running as root
  (or an `ENGINE_USER` of someone else) leaves the engine on the image's user and makes the
  directory 0777 instead. The worker's sweep makes it too, and logs one it can't write to.
  The template's `live.recordDir` points there. The guard allows binds of the container's own
  station only, and `User` only as a numeric, non-root `uid:gid`.
- **Network**: `ENGINE_NETWORK`, shared with the api and Icecast; the container is reachable as
  `<prefix>-<stationId>`. The control port is never published.
- **Metrics**: the Prometheus server is off (it has no auth, and engines share a network). Turn
  it on per station (`metrics.enabled`) once a scraper is set up on an isolated network.
- **Live port**: one host port per station from the `engine_port` pool
  (`ENGINE_LIVE_PORT_MIN`..`MAX`), published on `ENGINE_LIVE_BIND_IP` → 8005. Kept across
  recreations; freed by `remove`. If the port is taken on the host, the start fails with
  `EnginePortInUseError` naming it (HTTP 409 `engine_port_in_use`).
- **Restart policy**: `on-failure`, 5 retries. Then the supervisor decides.

## Restart only when needed

`reconcile(scope)` (call it after changing `station.engine_settings`):

| Situation | Action |
|---|---|
| No container | create + start (`created`) |
| The container never started (an interrupted create), the engine reports another `config_version` than the rendered one, or the spec hash label differs (secrets, limits, ports, image, script) | stop, remove, create, start (`recreated`) |
| Container exists but exited | start (`started`) |
| Otherwise | nothing (`unchanged`); a drifted restart policy is set back |
| Desired state `stopped` | stop if running (`stopped`) |
| Restart storm (`storm_at` set) | nothing (`storm`) |

A failure after `create` removes the container again. `restart(scope, { rotateSecrets? })` is a
person's restart: it clears the storm, optionally generates new secrets, and always recreates.
Every new container is a new boot with an empty queue; the feeder re-pushes on
`onResync(…, 'boot')`.

## Concurrency, boot and failures

- **One actor per station.** Every operation runs under
  `pg_advisory_xact_lock(hashtext('ondes.engine:<stationId>'))`, held for the operation. Two api
  replicas, or the old and new api during a rolling deploy, never act on a station at once.
- **Boot**: removes orphans, then reconciles every `running` station, three at a time.
  Stations that fail (Docker or the guard down, say) go to a retry set. The supervisor retries
  them with backoff (5 s, doubling, up to 5 min).
- **Supervisor** (every 5 s; 15 s before #71):
  - counts Docker's own restarts (`RestartCount` deltas) and restarts dead containers itself;
  - retries failed stations;
  - removes **orphans**: engine containers with this deployment's prefix whose station has no
    `station_engine` row.
- **Restart storms**: more than `ENGINE_RESTART_MAX` (5) restarts in
  `ENGINE_RESTART_WINDOW_SECONDS` (600) trips the guard. Docker's 5 `on-failure` retries plus one
  restart by the supervisor are enough. The restart policy goes to `no`, the container is
  stopped, `storm_at` is set (shared by replicas, survives api restarts) and
  `engine.restart_storm` is published (alerts, #33). The engine stays down until
  `POST …/engine/restart`.
- **Station deletion**: `station_engine` and `engine_port` reference the station with
  `ON DELETE RESTRICT`. Call `engineLifecycle.remove(scope)` first: it removes the container,
  then the row (secrets) and ports. The sweep catches anything left behind.

## Interfaces for other modules

- `reconcile(scope)`: after changing `station.engine_settings` (#32 outputs, #33 blank).
- `secretsFor(scope)` (async): decrypted secrets (Icecast mount passwords, #32). Generates
  them on first use; the engine row it creates stays `stopped` until `start`. Throws
  `NotFoundError` only for a station outside the scope.
- `onBeforeCreate(hook)`: runs before every container create with the secrets it will get
  (#32 syncs the station's Icecast mounts there). A failure aborts the create.
- `adapterFor(stationId)`: a command adapter on any replica: the attached one, or one built
  from the station's token (#33's queue consumers).
- `tokenFor(stationId)`: the events route's token check, from the database on a cache miss.
- Events: `engine.up` / `engine.down` (health monitors), `engine.restart_storm`.

## Routes

| Route | Permission | |
|---|---|---|
| `GET /api/v1/stations/:stationId/engine` | `engine:read` | status |
| `POST /api/v1/stations/:stationId/engine/start` | `engine:control` | desired = running, reconcile |
| `POST /api/v1/stations/:stationId/engine/stop` | `engine:control` | desired = stopped |
| `POST /api/v1/stations/:stationId/engine/restart` | `engine:control` | clear the storm, recreate; body `{ rotateSecrets?: true }` |
| `POST /internal/engine/stations/:stationId/events` | station's control token | engine events (#28) |

Control routes write an `audit_log` row (`engine.start|stop|restart`), and
`engine.<verb>.failed` with the error when they fail. `/internal/*` routes skip the api-key
check of the auth plugin and must never be routed through the public proxy.

## Configuration (api environment)

| Variable | Default | |
|---|---|---|
| `ENGINE_DOCKER_URL` | – | The proxy guard, `http://docker-proxy-guard:2375`. Unset: no engine management. |
| `ENGINE_NETWORK` | – (required) | Docker network shared by the api, Icecast and engines. Never `docker-api` / `docker-socket`. |
| `ENGINE_DOCKER_NETWORK` | `docker-api` | The guard's network, for that check. |
| `ENGINE_API_URL` | – (required) | The api as engines reach it, e.g. `http://api:3000`. |
| `ENGINE_CACHE_ROOT` | – (required) | **Host** path of the playout cache root (same value for the guard). |
| `ENGINE_SECRETS_KEY` | – (required) | 32+ characters (`openssl rand -base64 32`). Seals the engine secrets. |
| `ENGINE_SECRETS_KEY_ID` | `k1` | Id stored with each sealed value. |
| `ENGINE_SECRETS_PREVIOUS_KEYS` | – | `id:key,id:key`: old keys, to read values not re-sealed yet. |
| `ENGINE_IMAGE` | `savonet/liquidsoap:v2.4.6` | Same value for the guard. |
| `ENGINE_CONTAINER_PREFIX` | `ondes-engine` | Same value for the guard. |
| `ENGINE_ICECAST_HOST` / `_PORT` | `icecast` / `8000` | |
| `ENGINE_LIVE_PORT_MIN` / `_MAX` | `8100` / `8199` | |
| `ENGINE_LIVE_BIND_IP` | `0.0.0.0` | |
| `ENGINE_CPUS` / `ENGINE_MEMORY_MB` / `ENGINE_PIDS` | `1` / `512` / `256` | 256 MB is not enough: Liquidsoap 2.4.6 is OOM-killed while loading. |
| `ENGINE_RESTART_MAX` / `ENGINE_RESTART_WINDOW_SECONDS` | `5` / `600` | |
| `ENGINE_PUBLISH_CONTROL_ON_LOOPBACK` | – | Dev only (`deploy/dev/engine`): `true` publishes the control port on 127.0.0.1, for an api outside Docker. The guard refuses it without `GUARD_ALLOW_LOOPBACK_CONTROL`. |
| `ENGINE_EXTRA_HOSTS` | – | Dev only: comma-separated `/etc/hosts` entries (`host.docker.internal:host-gateway`). The guard refuses any not in `GUARD_EXTRA_HOSTS`. |

**Rotating the secrets key**:
1. Set the new key as `ENGINE_SECRETS_KEY` with a new `ENGINE_SECRETS_KEY_ID`, and move the old
   one to `ENGINE_SECRETS_PREVIOUS_KEYS`.
2. Values are re-sealed as stations are loaded (every reconcile, so within one boot).
3. Drop the old key once no `station_engine` value starts with `v1:<old id>:`.

Rotating a station's own secrets is `POST …/engine/restart` with `{ "rotateSecrets": true }`.

## Tests

- **Unit**: `pnpm vitest run apps/api/src/modules/engine/lifecycle`.
  - The container policy, including every refusal.
  - The proxy guard in front of a stand-in Docker.
  - Spec, guard, secrets (including key rotation), the Docker client and the env config.
- **`service.int.test.ts`**: the real api and database with an in-memory Docker
  (`testing/fake-docker.ts`). Covers:
  - reconcile decisions, the storm guard and its persistence, boot and retries;
  - the advisory lock with two replicas, failed and interrupted creates, port conflicts;
  - deletion and the orphan sweep, secrets rotation;
  - routes, RBAC and audit.
- **`lifecycle.int.test.ts`**: real containers through the real guard and socket proxy
  (`testing/compose.yml` includes the deploy file plus a test override).
  - Its own project `ondes-engine-lifecycle-it`: guard on 127.0.0.1:17190, Icecast on :17191,
    live ports 17192–17199. Override with `ENGINE_LIFECYCLE_IT_DOCKER_PORT` /
    `ENGINE_LIFECYCLE_IT_ICECAST_PORT`.
  - Creates a station's engine and checks health, events, limits, the read-only root and cache,
    and the Icecast mount (per-station password).
  - Checks that the chain refuses a privileged container and non-engine containers.
  - Changes a setting and checks the restart, then stops and removes the engine.
  - Needs Docker and Postgres; never touches `ondes-dev`.
