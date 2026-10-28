# ADR 0042: Local station engines in development through the production lifecycle

- Status: accepted
- Date: 2026-10-28
- Issue: none (gap from `.handoffs/2026-10-27-after-wave-10.md`). Builds on ADR 0004 (playout
  cache), 0008 (engine lifecycle), 0012 (log feeder), 0034 (on-air view).

## Context
In `pnpm dev` the api manages no engines, so nothing plays: no as-run, no on-air item, and
islands, hard starts and live switching can't be heard. The api runs on the host
(`node --watch`), engines run in Docker. The engine must reach the api's events URL, and the api
must reach each engine's control port, which production never publishes (ADR 0008). The dev
stack is shared by parallel sessions and must not change.

## Decision
An opt-in compose project, `ondes-dev-engine` (`deploy/dev/engine`, `pnpm dev:engine`), runs the
**production** Docker access chain (`deploy/engine/docker-socket-proxy.compose.yml`, included
unchanged) and a production-style Icecast. The api of `pnpm dev` drives engines through it with
its real lifecycle, feeder and per-station secrets. The project needs two allowances, both
already used by the lifecycle integration test:
- the engine control port published on **127.0.0.1 only** (random host port), so the api on
  the host reaches it (`ENGINE_PUBLISH_CONTROL_ON_LOOPBACK`, guard `GUARD_ALLOW_LOOPBACK_CONTROL`);
- a `host.docker.internal:host-gateway` host entry, so engines post events to the api
  (`ENGINE_EXTRA_HOSTS`, guard `GUARD_EXTRA_HOSTS`).

They live only in the dev guard override. The production guard refuses both whatever the api
asks for, and the api refuses the two settings under `NODE_ENV=production`. The guard itself is
published on 127.0.0.1 (port 23750) through a network that holds only the guard.

Icecast is a second one (127.0.0.1:8010) running `deploy/icecast/entrypoint.sh` on the config
the api writes, because each station's engine has its own source password. The `ondes-dev`
Icecast keeps its static config. The worker's playout cache defaults to `ENGINE_CACHE_ROOT`, the
host path engines mount.

The station's `desired_state` lives in the shared database. One checkout per machine runs the
project: `pnpm dev:engine` refuses to start if another checkout's project runs.

## Alternatives
- **A compose service rendered from the template**, control port on 127.0.0.1: simpler, but it
  bypasses the lifecycle, the feeder attach and per-station secrets, so it tests less and drifts
  from production.
- **The api in Docker** on the engine network: no allowances needed, but `pnpm dev` loses its
  watch mode and host debugging.
- **A per-checkout project** (derived names and ports): every checkout shares the same database
  and station, so two engines would fight over one station's log and as-run.

## Consequences
- `pnpm dev:engine` + `pnpm dev` play the seeded station; `pnpm dev:engine:down` marks it stopped
  and removes everything. Without the `.env` lines nothing changes.
- A loopback guard is reachable by local processes; they could already use the Docker socket,
  which the guard only narrows.
- The dev `ENGINE_SECRETS_KEY` is shared by every checkout and never used in production.
