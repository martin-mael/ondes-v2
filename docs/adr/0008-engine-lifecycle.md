# ADR 0008: Station engine lifecycle through a guarded Docker proxy

- Status: accepted
- Date: 2026-10-21
- Issue: #35. Builds on ADR 0002 (engine control), 0004 (playout cache), 0007 (station template).

## Context
Each station runs one Liquidsoap container, rendered from its settings (ADR 0007). Creating a
station in the app must bring its stream up without a shell, a settings change must reach the
engine, and a crashing engine must not loop forever. The api needs to drive Docker for that,
and the Docker API is root on the host.

## Decision

### The api reaches Docker only through a guard
Two containers sit between the api and the socket, on two internal networks
(`deploy/engine/docker-socket-proxy.compose.yml`):
- **Socket proxy**: `tecnativa/docker-socket-proxy` v0.5.0, pinned by digest. It forwards
  container, image, ping and version requests only. It filters paths, not bodies, so on its
  own anything reaching it could still create a privileged container.
- **Proxy guard** (`apps/api/src/modules/engine/lifecycle/proxy-guard.ts`): a small
  dependency-free Node server, the api's only Docker endpoint. It validates bodies and targets
  against the engine container policy. Only `<prefix>-<id>` containers can be created:
  - the pinned image and entrypoint, `ondes.*` labels, the engine network;
  - a read-only cache bind under `ENGINE_CACHE_ROOT`, tmpfs `/tmp`, a read-only root;
  - limits set, all capabilities dropped, only the live port published.
  Only engine containers can be inspected, started, stopped, updated (restart policy only) or
  removed. Archives, exec, networks, volumes and logs are refused.

Even a compromised api can therefore only create and manage engine-shaped containers. The
policy lives in one file, used by both the lifecycle and the guard, and a unit test checks that
the lifecycle's spec passes it.

### The api owns the containers, not compose
Engines are created by the api, not declared in a compose file: stations come and go at
runtime. The rendered script travels in the container's environment and is written to a tmpfs
by the entrypoint, so the api needs no filesystem shared with the Docker host and the guard
needs no archive endpoint. Containers carry labels (`ondes.engine`, `ondes.station`,
`ondes.config_version`, `ondes.spec`).

### Restart only when needed
A container is replaced when:
- the engine reports a `config_version` other than the one its current settings render to;
- or the container spec hash changes (script, secrets, limits, ports, image);
- or it was never started (an interrupted create).

Otherwise reconcile leaves it alone. A replacement is a new boot with an empty queue
(ADR 0002); the feeder refills it on `onResync('boot')`.

### One actor per station, across replicas
Every lifecycle operation holds a transaction-scoped Postgres advisory lock on the station.
Several api replicas, or the old and the new api during a rolling deploy, never reconcile a
station at once. Restart storms are recorded in the database (`station_engine.storm_at`).

### Failures heal
- Stations whose reconcile fails at boot or later are retried with backoff.
- A failed create removes its container.
- A sweep removes engine containers whose station has no engine row.
- Stations reference-restrict their engine rows: `remove()` must run before a station is
  deleted, so a deleted station can't keep streaming.

### Per-station secrets, rotatable key
Control token, live password and Icecast source password are generated per station and stored
AES-256-GCM encrypted with a dedicated `ENGINE_SECRETS_KEY`. Each value carries its key id,
values sealed with an older key are re-sealed on load, and a station's secrets can be
regenerated on restart. The events route checks each station's own token. **There is no
shared Icecast source password**: Icecast authenticates each mount with its station's password
(#32 writes it, via the lifecycle's `onBeforeCreate` hook), so one station can't take over
another's mount.

### One shared engine network
Engines, Icecast and the api share one Docker network (`ENGINE_NETWORK`). Per-station networks
would need network management through the guard and the api connected to every network. The
per-station bearer tokens (ADR 0002) separate engines, and the unauthenticated Prometheus
server is off until a scraper runs on an isolated network.

### Ports from a database pool
Only harbor live inputs are published, one host port per station from `engine_port`
(`ENGINE_LIVE_PORT_MIN`..`MAX`), allocated lowest-free with the primary key arbitrating races.

### Restart storms
Docker restarts a crashed engine up to 5 times (`on-failure`). A supervisor counts those
restarts and its own. Past 5 in 10 minutes it disables the restart policy, stops the container,
sets `storm_at` and publishes `engine.restart_storm`. A person restarts it.

### Limits
Default 1 CPU, 512 MB (no swap), 256 pids per engine, read-only root, `CapDrop: ALL`,
`no-new-privileges`. **Measured:** 256 MB OOM-kills Liquidsoap 2.4.6 while it loads, even for a
one-line script; a running station uses around 40–120 MB.

## Consequences
- #32 writes outputs into `station.engine_settings` and calls `reconcile`, and puts each
  station's source password on its Icecast mounts from `onBeforeCreate`.
- #33 alerts on `engine.down` / `engine.restart_storm`, and drives engines from any replica
  with `adapterFor`.
- Production compose (epic #2) includes the proxy file, puts the api on `docker-api`, and passes
  `ENGINE_*` to the api and the guard. The cache root is a host path the worker also mounts.
- A station deletion flow must call `engineLifecycle.remove` first.
