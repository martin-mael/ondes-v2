# Ondes

A professional, multi-tenant webradio engine and management app: music scheduling, shows and episodes, voice tracks, live shows, all running on Liquidsoap and Icecast and installed on a VPS with one script. Built first for [Vandale Radio](https://vandaleradio.org).

- **Spec & roadmap:** the pinned issue #1 and the GitHub project "Ondes"
- **Research:** [`docs/research/`](docs/research/00-SYNTHESIS.md)
- **Decisions:** [`docs/adr/`](docs/adr/)
- **Contributing (humans and agents):** [`CLAUDE.md`](CLAUDE.md)

## Quick start (development)

Requirements: Node 24.18+ and pnpm (enable it with `corepack enable`).

```sh
pnpm install
pnpm test        # unit tests
pnpm typecheck   # TypeScript, all packages
pnpm lint        # Biome lint + format check (pnpm format to fix)
pnpm dev         # api, worker and web app in watch mode
```

Backing services (Postgres, RabbitMQ, S3, Icecast, Liquidsoap, Mailpit) come with `deploy/compose.dev.yml` (#4): `cp .env.example .env`, `pnpm dev:up`, `pnpm dev:seed` ([`deploy/README.md`](deploy/README.md)).

### Web app
`pnpm dev` serves the web app on <http://localhost:5173>. Vite proxies `/api` (REST and the SSE stream) to the api on `API_PORT` from `.env`, so the session cookie stays same-origin; set `VITE_API_PROXY` to point it elsewhere. Emails (verification, reset, invitations) land in Mailpit at <http://127.0.0.1:8025> and link back to `APP_URL`.

```sh
pnpm --filter @ondes/web dev     # web app only (the api must be running)
pnpm --filter @ondes/web build   # static build in apps/web/dist
```

UI components come from shadcn/ui on Base UI and live in `apps/web/src/ui/` ([ADR 0008](docs/adr/0008-ui.md)). Add one with `pnpm dlx shadcn@4.22.1 add <name>` from `apps/web`, then `pnpm format`. Production serving (Caddy) comes with the installer (#84).

## Layout

| Path | What |
|---|---|
| `apps/api` | Fastify API, SSE, engine adapter |
| `apps/worker` | RabbitMQ job consumers (ingest, analysis, rendering, log generation) |
| `apps/web` | React web app |
| `packages/shared` | zod contracts and shared helpers |
| `packages/db` | Drizzle schema and migrations |
| `packages/storage` | S3-compatible storage |
| `packages/queue` | RabbitMQ job framework |
| `packages/scheduling` | Pure scheduling logic (rules, clocks, log generation) |
| `engine/` | Liquidsoap templates and engine tests |
| `deploy/` | Compose files, installer |
