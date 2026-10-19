# Ondes v2: agent guide

Ondes is a multi-tenant webradio engine and management app: Node.js + RabbitMQ + Liquidsoap, deployed with Docker on a VPS. The first tenant is Vandale Radio (Lyon, non-profit).

- **Spec:** GitHub issue #1 (pinned). It's the source of truth for scope, architecture and glossary.
- **Research:** `docs/research/`; start with `00-SYNTHESIS.md`.
- **Work tracking:** GitHub project "Ondes". Epics are issues; tasks are their sub-issues; order comes from "blocked by" links.

Several agents work on this repo **in parallel**. Most of the rules below exist so they don't collide.

## Picking up work
1. Take one issue whose blockers are all closed (`gh issue view <n>` shows "Blocked by"). Never start a blocked issue.
2. Read the issue, its epic and the spec sections it references. The **Agent notes** section of the issue lists the paths you own, the contracts you provide or consume, and what's out of scope.
3. Move the issue to **In progress** in the project and assign yourself (or note the agent session in a comment).
4. Work in your own git worktree on a branch named `<issue-number>-<short-slug>`, e.g. `18-ingest-pipeline`. One issue = one branch = one PR.

## Staying in your lane
- Only edit the paths listed under **Owns** in the issue's Agent notes, plus tests next to them.
- Shared code is the collision zone: `packages/shared/src/contracts/*`, `packages/db/src/schema/*`, root config files.
  - **Additive changes** (new schema file, new contract file, new optional field) are fine inside your PR.
  - **Breaking or cross-cutting changes** (renaming or removing a field, changing an event payload others consume, changing root tooling) go in a **separate small PR first**, titled `contract: …`, and are linked from your issue.
- If you need something another open issue owns, don't implement it: comment on that issue, stub behind an interface, or ask.
- Don't reformat or "clean up" files you don't own.

## Repository layout
```
apps/
  api/src/
    plugins/            # fastify plugins: db, auth, rabbit, sse, errors
    modules/<module>/   # routes.ts, service.ts, repo.ts, *.test.ts
                        # auth, orgs, stations, library, engine, asrun, rotation,
                        # clocks, shows, log, public, jobs, alerts
  worker/src/
    jobs/<job>/         # one folder per job type: ingest, loudness, autocue, analysis,
                        # peaks, dedupe, cache-sync, log-generate, island-render, …
  web/src/
    app/                # shell, routing, auth pages, layout, SSE client
    features/<feature>/ # library, cue-editor, rotation, clocks, grid, shows,
                        # log-timeline, segue-editor, live, dashboard, settings
    ui/                 # shared design-system components
packages/
  shared/src/
    contracts/<domain>.ts  # zod schemas + inferred types: API DTOs, events, job payloads
    time/                  # timezone/DST helpers (station-local ↔ UTC)
  db/
    src/schema/<domain>.ts # one file per domain: tenancy, library, engine, asrun,
                           # rotation, clocks, shows, log, segues, live, alerts
    migrations/            # generated, timestamp-prefixed
  storage/                 # S3-compatible abstraction
  queue/                   # RabbitMQ job framework
  scheduling/              # pure, side-effect-free: rules engine, category picker,
                           # clock expansion, log generator, back-timing
engine/
  templates/               # Liquidsoap script templates (pinned 2.4.x)
  tests/                   # engine fixtures, seam/timing tests
deploy/                    # compose files, installer, Caddyfile
docs/                      # research, ADRs (docs/adr/NNNN-title.md)
```
This layout is the target. Issue #3 creates it and may adjust it. If it does, update this file in the same PR.

## Conventions
- **TypeScript** strict, ESM, Node 24 LTS, pnpm workspaces. Libraries (Fastify, Drizzle, TanStack, Vitest) are confirmed in #3. Check `package.json` rather than assuming.
- **Validation:** zod at every boundary (HTTP, queue messages, engine callbacks). Types are inferred from `packages/shared/src/contracts`, never duplicated.
- **Tenancy:** every station-scoped table has `station_id` (and `org_id` where relevant). Repository functions take the tenant scope explicitly. Never query station data without it.
- **Time:** store UTC (`timestamptz`); compute in the station's IANA timezone through `packages/shared/src/time`. Any scheduling code needs DST tests (last Sunday of March and October, Europe/Paris).
- **Audit:** every mutation through the API writes an `audit_log` row.
- **Jobs:** idempotent, keyed by content hash or `entity:version`; payloads defined in contracts; retries come from the queue framework, not ad-hoc loops.
- **Engine:** Liquidsoap control ports are never exposed publicly. Node talks to the engine only through the engine adapter (`apps/api/src/modules/engine`).
- **Real time:** SSE only, through the api's SSE plugin. Event names and payloads live in `packages/shared/src/contracts/events.ts`.
- **No paid/licensed components by default** (Stereo Tool, commercial AcoustID, Essentia models). Make them opt-in plugins.
- **Naming:** files kebab-case; DB tables snake_case singular (`log_item`); API routes `/api/v1/stations/:stationId/...`.

## Database migrations (parallel-safe)
- Put your tables in your domain's schema file, or create a new one. Don't edit another domain's file except to add a foreign key you need, and mention it in the PR.
- Migrations are generated with a **timestamp prefix**. If main moved and the migration journal conflicts: rebase, **delete your generated migration, regenerate it**, rerun the tests. Never hand-merge the journal.
- Migrations must be forward-only and safe on a populated DB (expand/contract for renames).

## Tests & checks
Every PR must pass, locally and in CI:
- `pnpm lint`, `pnpm typecheck` and `pnpm test` (unit tests next to the code, `*.test.ts`).
- `pnpm test:integration` when you touch db, queue, storage or engine (uses `deploy/compose.dev.yml` services).
- Engine template changes: `pnpm test:engine` (runs `liquidsoap --check` and the fixtures in `engine/tests`).

The exact scripts are defined by #3 and #10. If a command here is wrong, fix this file.

## Commits & PRs
- Conventional commits: `feat(library): …`, `fix(engine): …`, `contract: …`, `chore: …`, `docs: …`.
- PR title: `<type>(<area>): <summary> (#<issue>)`; the body uses the PR template and says `Closes #<issue>`.
- Keep PRs focused on one issue. If the scope grows, open a follow-up issue instead.
- **Done** = all acceptance criteria in the issue are met and ticked, tests added, docs/ADR updated if a decision was made, and the issue's Agent notes are still accurate.

## Never
- Commit secrets or `.env` files.
- Push to `main` directly or force-push shared branches.
- Expose Liquidsoap telnet/harbor control or the RabbitMQ management UI publicly.
- Bypass tenant scoping "just for now".
