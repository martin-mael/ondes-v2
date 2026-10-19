# ADR 0005: Production images run TypeScript sources directly

- Status: accepted
- Date: 2026-10-20
- Issue: #10

## Context
ADR 0001 has Node 24 run the `.ts` sources directly in development (type stripping, erasable-only TypeScript, source-first `@ondes/*` packages) and left open whether the production images for `api` and `worker` do the same or ship a bundle.

## Options
1. **Run sources directly.** The image holds the app's sources, the workspace packages it depends on and its production dependencies; `node src/main.ts` is the entry point.
2. **Bundle** (esbuild/rolldown) into one `.js` file per app, shipped with only native/external dependencies.

## Decision
Run sources directly (option 1).

- Same runtime path in dev, CI and production: no bundler config, no source maps to keep in sync, stack traces point at the real files.
- Type stripping is stable in Node 24 and its cost is a one-off at module load; the api and worker are long-running processes.
- Bundling would add a tool that has to understand our TypeScript (TS 7, `.ts` extension imports) and would hide dependency problems that only show up unbundled.

## How the images are built
`deploy/docker/<app>.Dockerfile`, built from the repository root:
- **Build stage:** copies the repository (filtered by `<app>.Dockerfile.dockerignore`) and runs a **filtered production install**, `pnpm install --frozen-lockfile --prod --filter "@ondes/<app>..."`, with the pnpm store in a BuildKit cache mount. Other apps and `*.test.ts` files are removed.
- **Runtime stage:** the same pinned `node:24.x-slim` base (by digest), files owned by root, process running as the unprivileged `node` user, `NODE_ENV=production`, `CMD ["node", "src/main.ts"]`.

We don't use `pnpm deploy`: it copies workspace packages into `node_modules`, and **Node refuses to strip types from files under `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The filtered install keeps workspace dependencies as symlinks to `packages/*`, which works.

CI (`.github/workflows/images.yml`) builds both images on PRs and pushes them to GHCR on `main` as `ghcr.io/martin-mael/ondes-<app>`, tagged with the full git SHA (immutable) and `main` (moving).

## Consequences
- Every workspace package used at runtime must stay erasable-only TypeScript and source-first. Third-party packages in `node_modules` must ship JavaScript.
- Images contain readable sources (no secrets live in the repo anyway).
- If startup time or image size becomes a problem, bundling can be revisited in a new ADR without changing app code.
- `web` (static Vite build, #9) and `engine` (Liquidsoap, #13) get their own Dockerfiles in those issues.
