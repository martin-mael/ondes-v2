# ADR 0001: Workspace tooling and library choices

- Status: accepted
- Date: 2026-10-20
- Issue: #3

## Context
The spec (#1) proposes a TypeScript monorepo (Node.js api and worker, React web app) with Fastify, Drizzle and TanStack. Several agents will work in parallel, so the tooling must be fast, strict and boring, with as few moving parts as possible.

## Decisions

### Workspace
- **pnpm workspaces**, version pinned in `packageManager` (pnpm 11.23). The workspaces are `apps/*` and `packages/*`.
- **Internal packages are source-first:** each package exports `./src/index.ts` directly. There's no build step between packages, and consumers (Node, Vite, Vitest) read TypeScript sources.

### Runtime: Node 24 with native type stripping
- Node ≥ 24.18 runs `.ts` files directly (`node src/main.ts`, `node --watch src/main.ts` for dev). There's no tsx/ts-node/build step for the api and worker in development.
- This imposes two rules, which `tsconfig.base.json` enforces:
  - `erasableSyntaxOnly`: no `enum`, `namespace` or constructor parameter properties. Use `as const` objects or zod enums instead.
  - Relative imports include the `.ts` extension (`import { x } from './x.ts'`; `allowImportingTsExtensions`).
- Whether production images also run sources directly or bundle them is decided in #10.

### Type checking: TypeScript 7
- TypeScript 7.0 (the native compiler) is used for type checking only (`noEmit`).
- `strict` plus `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `module: preserve` and `moduleResolution: bundler`.
- Each package runs `tsc --noEmit -p .`; the root `pnpm typecheck` runs them in parallel.

### Lint & format: Biome 2
- Biome replaces ESLint and Prettier: one fast tool for lint, format and import sorting, with one config (`biome.json`).
- It also avoids depending on typescript-eslint keeping pace with TypeScript 7.
- Recommended rule preset, single quotes, 100-column lines.

### Tests: Vitest 5
- Unit tests are `*.test.ts` next to the code, run from the root (`pnpm test`).
- Integration tests are `*.int.test.ts` (`pnpm test:integration`); they need the services from `deploy/compose.dev.yml` (#4).
- Engine template checks run through `pnpm test:engine` (`engine/tests/run.sh`, which uses the Liquidsoap image pinned in #13).

### Libraries confirmed for upcoming issues
Each is installed by the issue that first needs it, not here.

| Area | Choice | First used in |
|---|---|---|
| Validation & contracts | zod 4 (in `@ondes/shared`) | #3 |
| HTTP server | Fastify 5 (with zod type provider) | #5 / #6 |
| Database | PostgreSQL 18 + Drizzle ORM 0.45 / drizzle-kit 0.31 (timestamp-prefixed migrations) | #5 |
| Queue | RabbitMQ 4 via a thin wrapper in `@ondes/queue` (client library chosen in #8) | #8 |
| Web | React 19 + Vite 8 + TanStack Router & Query | #9 |

Drizzle is still pre-1.0. We accept this for its SQL-first schema files, which fit our one-file-per-domain layout. #5 should keep raw SQL migrations reviewable so a later ORM change stays possible.

## Consequences
- New contributors and agents need Node 24.18+ and pnpm (via Corepack: `corepack enable`).
- Code must stay erasable-only TypeScript; Biome and `tsc` catch violations.
- Swapping a library listed above requires a new ADR.
