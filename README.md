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
pnpm dev         # runs api and worker in watch mode
```

Backing services (Postgres, RabbitMQ, S3, Icecast, Liquidsoap) come with `deploy/compose.dev.yml` (#4).

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
