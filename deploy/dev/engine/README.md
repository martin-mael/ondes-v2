# Local station engines (`pnpm dev:engine`)

Opt-in: runs the seeded station's real engine (the station template, through the api's engine
lifecycle) so the dashboard's on-air view, the as-run, islands, hard starts and live switching
work in `pnpm dev`. Without it the api manages no engines and the dashboard says "Rien à
l'antenne". Sessions that don't set the `.env` lines below are unaffected.

## Get audio

1. Once: the dev stack, the seed and its audio (`deploy/README.md`): `pnpm dev:up`,
   `pnpm dev:seed`, `pnpm dev:seed:audio`.
2. Add the engine lines to `.env`. `pnpm dev:engine` prints them, with this checkout's paths,
   when they're missing:

   ```sh
   # --- Local station engines (pnpm dev:engine, deploy/dev/engine/README.md) ---
   ENGINE_DOCKER_URL=http://127.0.0.1:2376
   ENGINE_NETWORK=ondes-dev-engines
   ENGINE_API_URL=http://host.docker.internal:3000
   ENGINE_PUBLISH_CONTROL_ON_LOOPBACK=true
   ENGINE_EXTRA_HOSTS=host.docker.internal:host-gateway
   ENGINE_LIVE_BIND_IP=127.0.0.1
   ENGINE_CACHE_ROOT=/absolute/path/to/ondes-v2/.dev/cache
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

Stop: `pnpm dev:engine:down` removes the engine containers and the project (the station stays
marked running, so the next `pnpm dev:engine` + api boot bring it back). To go back to no
engines: comment out `ENGINE_DOCKER_URL` in `.env`, restart `pnpm dev`, then
`pnpm dev:engine:down`.

Logs: `docker logs -f ondes-engine-<stationId>` (Liquidsoap), `docker logs ondes-dev-engine-icecast-1`.

## How it's wired

```
api (host) ──127.0.0.1:2376──> docker-proxy-guard ──> docker-socket-proxy ──> docker.sock
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
  `ENGINE_EXTRA_HOSTS`; a production guard refuses both whatever the api sends. The guard
  itself is published on 127.0.0.1 only.
- **Its own Icecast** (port 8010), the production setup: `deploy/icecast/entrypoint.sh` on the
  config the api writes to `ICECAST_CONFIG_PATH`, one source password per station. The
  `ondes-dev` Icecast (8000) keeps its static config, shared password and test tone.
- **Shared playout cache**: the worker's `PLAYOUT_CACHE_ROOT` defaults to `ENGINE_CACHE_ROOT`,
  the host path the guard lets engines mount.
- **Live inputs** are published on `127.0.0.1:8100…` (`ENGINE_LIVE_BIND_IP`); the Live page shows
  the port.
- Nothing in `ondes-dev` changes: new project, network and ports only.

Other options weighed: a compose service rendered from the template (bypasses the lifecycle,
feeder attach and secrets, so it tests less and drifts from production) and running the api in
Docker (breaks `pnpm dev`'s watch mode).

## Notes

- Keep `ENGINE_SECRETS_KEY` stable: the station's engine secrets are sealed with it in
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
