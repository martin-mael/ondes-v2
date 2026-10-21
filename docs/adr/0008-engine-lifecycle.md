# ADR 0008: Station engine lifecycle through a Docker socket proxy

- Status: accepted
- Date: 2026-10-21
- Issue: #35. Builds on ADR 0002 (engine control), 0004 (playout cache), 0007 (station template).

## Context
Each station runs one Liquidsoap container, rendered from its settings (ADR 0007). Creating a
station in the app must bring its stream up without a shell, a settings change must reach the
engine, and a crashing engine must not loop forever. The api needs to drive Docker for that,
and giving it the Docker socket would make an api compromise a root-on-host compromise.

## Decision

### The api talks to Docker through a socket proxy
`tecnativa/docker-socket-proxy` v0.5.0, pinned by digest (`deploy/engine/
docker-socket-proxy.compose.yml`). It forwards only container, image-pull, ping and version
requests and refuses the rest (exec, networks, volumes, build, swarm, system, events). The
api gets `ENGINE_DOCKER_URL`, never the socket. The proxy runs read-only, without capabilities,
on a network only the api shares.

**Limit, accepted:** the proxy filters paths, not bodies. Whoever reaches it can still create a
privileged container or bind-mount `/`. It removes exec, network and volume management and the
raw socket from the api's reach, and it narrows the blast radius of a bug, not of a full api
compromise. A body-validating proxy (allowing only our image, our labels, our mounts) is the
next step if the threat model needs it.

### The api owns the containers, not compose
Engines are created by the api (`apps/api/src/modules/engine/lifecycle`), not declared in a
compose file: stations come and go at runtime. The rendered script is copied into the container
(`PUT /containers/{id}/archive`) before its first start, so the api needs no filesystem shared
with the Docker host. Containers carry labels (`ondes.engine`, `ondes.station`,
`ondes.config_version`, `ondes.spec`).

### Restart only when needed
A container is replaced when the engine reports a `config_version` other than the one its
current settings render to, or when the container spec hash changes (secrets, limits, ports,
image). Otherwise reconcile leaves it alone. A replacement is a new boot with an empty queue
(ADR 0002); the feeder refills it on `onResync('boot')`.

### Per-station secrets, encrypted
Control token, live password and Icecast source password are generated per station and stored
AES-256-GCM encrypted (key derived from `AUTH_SECRET` under its own HKDF label). The engine
events route checks each station's own token. With one shared Icecast source password
configured, engines use it; per-mount passwords use the station's own (#32).

### One shared engine network
Engines, Icecast and the api share one Docker network (`ENGINE_NETWORK`). Per-station networks
would stop engines reaching each other's control ports, but would need network management in
the proxy (`NETWORKS=1`) and the api connected to every network. The per-station bearer token
(ADR 0002) is the isolation between engines for now.

### Ports from a database pool
Only harbor live inputs are published, one host port per station from `engine_port`
(`ENGINE_LIVE_PORT_MIN`..`MAX`), allocated lowest-free with the primary key arbitrating races.

### Restart storms
Docker restarts a crashed engine up to 5 times (`on-failure`). A supervisor counts those
restarts and its own; past 5 in 10 minutes it disables the restart policy, stops the container
and publishes `engine.restart_storm`. A person restarts it.

### Limits
Default 1 CPU, 512 MB (no swap), 256 pids per engine, `CapDrop: ALL`, `no-new-privileges`.
**Measured:** 256 MB OOM-kills Liquidsoap 2.4.6 while it loads, even for a one-line script; a
running station uses around 70–120 MB.

## Consequences
- #32 writes outputs into `station.engine_settings` and calls `app.engineLifecycle.reconcile`;
  #33 does the same for blank settings and alerts on `engine.down` / `engine.restart_storm`.
- Production compose (epic #2) runs the proxy and passes `ENGINE_*` to the api; the cache root
  is a host path (`ENGINE_CACHE_ROOT`) the worker also mounts.
- Storm counts live in memory: an api restart forgets them.
