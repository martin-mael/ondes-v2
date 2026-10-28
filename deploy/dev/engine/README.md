# Local station engines (`pnpm dev:engine`)

Opt-in: runs the seeded station's real engine (the station template, through the api's engine
lifecycle) so the dashboard's on-air view, the as-run, islands, hard starts and live switching
work in `pnpm dev`. Without it the api manages no engines and the dashboard says "Rien à
l'antenne". Sessions that don't set the `.env` lines below are unaffected. Why it's wired this
way: `docs/adr/0042-local-station-engines.md`.

## Get audio

1. Once: the dev stack, the seed and its audio (`deploy/README.md`): `pnpm dev:up`,
   `pnpm dev:seed`, `pnpm dev:seed:audio`.
2. Add the engine lines to `.env`. `pnpm dev:engine` prints them, with this checkout's paths,
   when they're missing:

   ```sh
   # --- Local station engines (pnpm dev:engine, deploy/dev/engine/README.md) ---
   ENGINE_DOCKER_URL=http://127.0.0.1:23750
   ENGINE_NETWORK=ondes-dev-engines
   ENGINE_API_URL=http://host.docker.internal:3000
   ENGINE_PUBLISH_CONTROL_ON_LOOPBACK=true
   ENGINE_EXTRA_HOSTS=host.docker.internal:host-gateway
   ENGINE_LIVE_BIND_IP=127.0.0.1
   ENGINE_CACHE_ROOT=/absolute/path/to/ondes-v2/.dev/cache
   # Dev only, shared by every checkout: never use it in production.
   ENGINE_SECRETS_KEY=dev-only-engine-secrets-key-change-me-0123
   ICECAST_CONFIG_PATH=/absolute/path/to/ondes-v2/.dev/icecast/icecast.xml
   ICECAST_URL=http://127.0.0.1:8010
   ```

   Put them after the existing `ICECAST_URL` line, or replace it: the last value wins.
3. `pnpm dev:engine`: starts the `ondes-dev-engine` compose project and marks the `vandale`
   station's engine as running.
4. Start `pnpm dev` (restart it if it was running: the api starts engines at boot). Within a
   minute the worker fills the playout cache and the api starts the engine container
   `ondes-engine-<stationId>` and feeds it the log.
5. Listen: <http://127.0.0.1:8010/vandale/mp3> (or `/vandale/aac`). The dashboard shows the
   current and next items; the as-run fills as tracks play.

**Stop**: `pnpm dev:engine:down`. It marks the station stopped (so a running api doesn't
recreate the engine), removes the engine containers and stops the project. It works without the
engine lines in `.env`. To go back to no engines: `pnpm dev:engine:down`, comment out
`ENGINE_DOCKER_URL`, restart `pnpm dev`. `pnpm dev:engine` marks the station running again.

Logs: `docker logs -f ondes-engine-<stationId>` (Liquidsoap), `docker logs ondes-dev-engine-icecast-1`.

## One checkout per machine

The engines play the station of the shared dev database, and the container, network and port
names are fixed, so only one checkout runs `pnpm dev:engine` at a time. A second one fails
with the path of the checkout that runs it; run `pnpm dev:engine:down` there first. The
station's `desired_state` is in the shared database too: `down` from any checkout stops it.
Agent sessions don't run `dev:engine:down` (it's the human's, like `dev:down`).

## Settings

| Variable | Default | |
|---|---|---|
| `ENGINE_DEV_DOCKER_PORT` | `23750` | Guard port on 127.0.0.1. Keep `ENGINE_DOCKER_URL` in step. Not 2376: that's Docker's TLS port. |
| `ENGINE_DEV_ICECAST_PORT` | `8010` | This project's Icecast on 127.0.0.1. Keep `ICECAST_URL` in step. |
| `ENGINE_CONTAINER_PREFIX` | `ondes-engine` | Engine container names (`<prefix>-<stationId>`): the api, the guard and `down` use it. |

Every other `ENGINE_*` variable: `apps/api/src/modules/engine/lifecycle/README.md`.

## How it's wired

```
api (host) ──127.0.0.1:23750──> docker-proxy-guard ──> docker-socket-proxy ──> docker.sock
  │  ▲
  │  └── events: engine ──> http://host.docker.internal:3000/internal/engine/... (ENGINE_API_URL)
  └───── control: api ──> 127.0.0.1:<random> ──> engine:7000
engine ──ondes-dev-engines──> icecast:8000 (published on 127.0.0.1:8010)
engine /cache (read-only) = ENGINE_CACHE_ROOT/<stationId>, written by the worker on the host
```

- **Same lifecycle as production.** The api creates engines through the production socket proxy
  and guard (`deploy/engine/docker-socket-proxy.compose.yml`, included unchanged), with the
  same container policy: pinned image, read-only root, no capabilities, limits, read-only cache.
- **Two dev-only allowances**, in `guard-override.yml` and nowhere else, the same ones the
  lifecycle integration test uses: the guard accepts an engine control port published on
  **127.0.0.1 only** (`GUARD_ALLOW_LOOPBACK_CONTROL`), and the `host.docker.internal` host entry
  (`GUARD_EXTRA_HOSTS`). The api asks for them with `ENGINE_PUBLISH_CONTROL_ON_LOOPBACK` and
  `ENGINE_EXTRA_HOSTS`. A production guard refuses both whatever the api sends, and the api
  itself refuses them under `NODE_ENV=production` (the production images).
- **The guard is published on 127.0.0.1 only.** Publishing needs a non-internal network: that
  one (`published`) holds the guard alone; `docker-api` and `docker-socket` stay internal.
- **Its own Icecast** (port 8010), the production setup: `deploy/icecast/entrypoint.sh` on the
  config the api writes to `ICECAST_CONFIG_PATH`, one source password per station. The
  `ondes-dev` Icecast (8000) keeps its static config, shared password and test tone.
- **Shared playout cache**: the worker's `PLAYOUT_CACHE_ROOT` defaults to `ENGINE_CACHE_ROOT`,
  the host path the guard lets engines mount.
- **Live inputs** are published on `127.0.0.1:8100…` (`ENGINE_LIVE_BIND_IP`); the Live page shows
  the port.
- Nothing in `ondes-dev` changes: new project, network and ports only.

## Notes

- `ENGINE_SECRETS_KEY` above is a dev key, the same in every checkout: never use it in
  production. Keep it stable: the station's engine secrets are sealed with it in
  `station_engine` the first time. If you change it, move the old one to
  `ENGINE_SECRETS_PREVIOUS_KEYS` (`k1:<old key>`) and give the new one another
  `ENGINE_SECRETS_KEY_ID` (lifecycle README, "Rotating the secrets key").
- The engine buffers its events while the api is down (a `pnpm dev` restart, a watch reload)
  and sends them when it's back, so the as-run catches up. Stopping the engine for good leaves
  the last as-run entry open until the next engine boot closes it (`interrupted`).
- Without an emergency file (Settings › Safety), the engine logs
  `Nonexistent file … /cache/emergency.flac` every second. Harmless.
- Linux: `host.docker.internal` resolves to the host gateway, so the api must listen there
  (it listens on `0.0.0.0` by default, `API_HOST`).
- Docker on macOS (OrbStack, Docker Desktop) shares `/Users`; keep `.dev/` inside it.
