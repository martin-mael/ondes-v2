# Ondes v2: agent guide

Ondes is a multi-tenant webradio engine and management app: Node.js + RabbitMQ + Liquidsoap, deployed with Docker on a VPS. The first tenant is Vandale Radio (Lyon, non-profit).

- **Spec:** GitHub issue #1 (pinned). It's the source of truth for scope, architecture and glossary.
- **Research:** `docs/research/`; start with `00-SYNTHESIS.md`.
- **Handoffs:** `.handoffs/`, one dated file per handoff (`YYYY-MM-DD-<topic>.md`), plus the orchestration scripts in `.handoffs/tools/`. A session that picks up orchestration reads the latest handoff first; one that hands over writes a new file there.
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
                        # clocks, shows, log, public, jobs, alerts, cache, segues, live,
                        # listeners, prelisten
  worker/src/
    jobs/<job>/         # one folder per job type: ingest, loudness, autocue, analysis,
                        # peaks, dedupe, cache-sync (+ cache-fetch, its urgent
                        # one-file variant), episode-check, log-generate,
                        # island-render, …
  web/src/
    app/                # shell, routing (router.tsx), auth pages, layout, api client,
                        # SSE client (sse/), i18n
    features/<feature>/ # library, cue-editor, rotation, clocks, grid, shows,
                        # log-timeline, segue-editor, live, dashboard, alerts, settings
    ui/                 # shared design-system components (shadcn/ui on Base UI)
packages/
  shared/src/
    contracts/<domain>.ts  # zod schemas + inferred types: API DTOs, events, job payloads
    time/                  # timezone/DST helpers (station-local ↔ UTC)
    segues/                # island derivation and hashing (pure, shared by api, worker, web)
  db/
    src/schema/<domain>.ts # one file per domain: tenancy, library, engine, asrun,
                           # rotation, clocks, shows, log, segues, live, alerts,
                           # cache, safety
    migrations/            # generated, timestamp-prefixed
  storage/                 # S3-compatible abstraction
  queue/                   # RabbitMQ job framework
  scheduling/              # pure, side-effect-free: rules engine, category picker,
                           # clock expansion, log generator (generator/), log timing
                           # (log/: retime), back-timing
engine/
  templates/               # Liquidsoap script templates (pinned 2.4.x)
  tests/                   # engine fixtures, seam/timing tests
deploy/                    # compose files, installer, Caddyfile
docs/                      # research, ADRs (docs/adr/NNNN-title.md)
```
Created by #3. Packages are named `@ondes/<folder>` (e.g. `@ondes/shared`) and are **source-first**: each exports `./src/index.ts`, with no build step between packages. If you change the layout, update this file in the same PR.

## Conventions
- **Stack:** see `docs/adr/0001-stack.md`. Node ≥ 24.18, pnpm workspaces, TypeScript 7 (type check only), Biome 2 (lint + format), Vitest 5. Fastify, Drizzle, React/Vite/TanStack are installed by the issue that first needs them. Check `package.json` rather than assuming.
- **Erasable TypeScript only:** Node runs `.ts` files directly (`node src/main.ts`), so there are no `enum`, `namespace` or constructor parameter properties (use `as const` objects or zod enums). Relative imports carry the `.ts` extension: `import { x } from './x.ts'`.
- **Adding a dependency:** `pnpm --filter @ondes/<pkg> add <dep>@<exact-version>`. Pin exact versions and don't add root dependencies except tooling.
- **Validation:** zod at every boundary (HTTP, queue messages, engine callbacks). Types are inferred from `packages/shared/src/contracts`, never duplicated.
- **Tenancy:** every station-scoped table has `station_id` (and `org_id` where relevant). Repository functions take the tenant scope explicitly. Never query station data without it.
- **Time:** store UTC (`timestamptz`); compute in the station's IANA timezone through `packages/shared/src/time`. Any scheduling code needs DST tests (last Sunday of March and October, Europe/Paris).
- **Audit:** every mutation through the API writes an `audit_log` row.
- **Jobs:** idempotent, keyed by content hash or `entity:version`; payloads defined in contracts; retries come from the queue framework, not ad-hoc loops. A job started by an event (e.g. `asset.ingested`) declares `export const triggers: JobTrigger[]` in its `index.ts` (`apps/worker/src/registry.ts`); the worker runs each on a durable event queue, so don't edit `main.ts` for it (ADR 0006, "Event transport").
- **Engine:** Liquidsoap control ports are never exposed publicly. Node talks to the engine only through the engine adapter (`apps/api/src/modules/engine`).
- **Real time:** SSE only, through the api's SSE plugin. Event names and payloads live in `packages/shared/src/contracts/events.ts`; a new event type also needs its read permission in `realtimeEventPermissions` there (undeclared types are never forwarded). The browser fanout is best-effort: side effects go through durable queues. In the web app, read events with `useSse` / `useSseEvent` (`apps/web/src/app/sse/sse.tsx`).
- **Web app:** `docs/adr/0009-ui.md`. Components come from the pinned shadcn CLI into `apps/web/src/ui/` (`pnpm dlx shadcn@4.22.1 add <name>` in `apps/web`, then `pnpm format`); don't hand-edit them for style. Base UI composes with `render={…}`, not `asChild`. A feature adds its route in `apps/web/src/app/router.tsx` (under `stationRoute`), a nav entry in `app/shell/nav.ts`, calls the api through `app/api/client.ts` with its contract schemas, and keeps UI strings in FR + EN. UI rules the owner asked for:
  - **Loading:** never show a loader for a fast request. Use `app/pending.tsx`: `PageSkeleton` / `ListSkeleton` (shaped like the content, space reserved from the start, visible after 400 ms) for data, `DelayedSpinner` in buttons for actions. No spinner for background refetches (`isFetching`).
  - **Unsaved changes:** every page or dialog that edits something guards it with `useUnsavedChanges(dirty)` (`app/unsaved.tsx`): it asks before leaving the page, closing the dialog or closing the tab. Call `allowLeave()` before the save's own navigation.
  - **Time:** show the station's time only (its IANA zone), never server, UTC or browser time side by side.
  - **Coloured accents** (a show or category colour on a card or calendar entry): a straight-edged strip inside the element (`absolute inset-y-0 left-0 w-1`), not a `border-l-*` on a rounded box, whose inner edge curves; give the element a radius equal to the strip's width (`rounded-[4px]` for `w-1`) so the strip fills the corners. No extra ring around the element.
  - **Sizes:** headings inside a page's content (calendar day headers, list group titles, empty states) are `text-sm`; only the page title is large.
  - **Toasts:** bottom-right (`<Toaster position="bottom-right" />` in `app/app.tsx`).
  - **Room to work:** precision editors (cue points, waveforms) get a full page per item, not a cramped drawer panel.
  - **Saving work in progress:** never block a save because something is incomplete (e.g. hours with no clock); show a calm inline warning instead.
- **No paid/licensed components by default** (Stereo Tool, commercial AcoustID, Essentia models). Make them opt-in plugins.
- **Naming:** files kebab-case; DB tables snake_case singular (`log_item`); API routes `/api/v1/stations/:stationId/...`.

## Database migrations (parallel-safe)
- Full workflow, tenant scopes (`resolveStationScope`, `whereStation`) and the audit writer (`withAudit`): `packages/db/README.md`.
- Put your tables in your domain's schema file, or create a new one. Don't edit another domain's file except to add a foreign key you need, and mention it in the PR.
- Migrations are generated with a **timestamp prefix**. If main moved and the migration journal conflicts: rebase, **delete your generated migration, regenerate it**, rerun the tests. Never hand-merge the journal.
- Migrations must be forward-only and safe on a populated DB (expand/contract for renames).

## Tests & checks
Every PR must pass, locally and in CI:
- `pnpm lint` (Biome; `pnpm format` auto-fixes formatting and import order), `pnpm typecheck` and `pnpm test` (unit tests next to the code, `*.test.ts`).
- `pnpm test:integration` when you touch db, queue, storage or engine: `*.int.test.ts` files, using the `deploy/compose.dev.yml` services.
- Engine template changes: `pnpm test:engine` (`engine/tests/run.sh`: renders the station template for every settings combination in `engine/tests/template/combos.ts` and runs `liquidsoap --check` on each, in the Liquidsoap image pinned in `deploy/compose.dev.yml`). Needs Docker and `pnpm install`. Then `pnpm test:engine:template` (`engine/tests/template/README.md`): runs the rendered template and checks its control API and a seamless island segment. Needs Docker and `ffmpeg`.
- Island splice regression test (`engine/tests/splice/README.md`): `pnpm test:engine:splice` (full matrix) or `pnpm test:engine:splice --quick` (FLAC cases, what CI runs). Needs Docker and `ffmpeg`. Run it when you touch islands, cue handling or the Liquidsoap version.
- Ingest and autocue integration tests (`apps/worker/src/jobs/ingest`, `apps/worker/src/jobs/autocue`) run the worker image's ffmpeg (7.1 with libsoxr): `docker build --target ffmpeg -t ondes-ffmpeg:dev -f deploy/docker/worker.Dockerfile .` once, then `PATH=$PWD/apps/worker/test/bin:$PATH pnpm test:integration`. CI does the same.
- Run one package's tests with `pnpm vitest run apps/api`, or typecheck one package with `pnpm --filter @ondes/api typecheck`. Web tests (`*.test.tsx`, happy-dom) are the `web` Vitest project: `pnpm vitest run --project web`.
- **The dev stack is shared.** Every worktree talks to the same `ondes-dev` compose project on fixed localhost ports, so parallel sessions use the same Postgres, RabbitMQ, Garage, Icecast and Liquidsoap.
  - Start it with `pnpm dev:up`. It's idempotent and safe to run even if another session already started it.
  - **Never run `pnpm dev:down`, `pnpm dev:reset` or `docker compose … down` from a session**, and don't restart or recreate its services. You'd cut off every other session mid-test. Stopping the stack is for the human.
  - Integration tests stay isolated on the shared stack: a throwaway database per test file (`createTestDatabase`), random queue prefixes, random S3 keys. Keep it that way in new tests.
  - If you need extra containers (e.g. a spike's own engine), use your own compose project name and your own ports, like `engine/spikes/control` does.
- Integration tests are split into the projects of `vitest.integration.config.ts`: `core`, `engine` (tests that start their own Liquidsoap/Icecast compose project) and `worker` (worker jobs, which need the ffmpeg image above). `pnpm test:integration` runs all three; `pnpm test:integration --project worker` runs one. A new `*.int.test.ts` lands in `core` unless it's under `apps/worker/src` or `apps/api/src/modules/engine`; add it to `engine` in that config if it starts Liquidsoap. (e.g. `apps/api/src/modules/live/live-auth.engine.int.test.ts`, the harbor auth callback on the real template).
- CI (`.github/workflows/ci.yml`) runs only what a PR needs. A `changes` job (path filters) decides; on `main`, on manual runs and on a PR labelled `ci:full`, everything runs. To force a full run that gates a PR, add the `ci:full` label: it starts a new pull_request run on the PR head (other labels don't cancel the run in flight). `gh workflow run ci.yml --ref <branch>` is for ad-hoc runs only: it isn't the PR's pull_request run, so don't rely on it for the PR's `CI ok`.

  | Job | Runs on a PR when it touches |
  |---|---|
  | Lint, typecheck, unit tests | always |
  | Web build | `apps/web`, `packages/shared` |
  | Integration (core) | `apps/api`, `packages`, `deploy/compose.dev.yml`, `deploy/dev` |
  | Integration (engine) | same as core, plus everything that triggers the engine jobs |
  | Integration (worker) | `apps/worker`, `apps/api/src/modules/library`, `packages`, `deploy/docker/worker.Dockerfile`, `deploy/compose.dev.yml`, `deploy/dev` |
  | Engine templates, Engine island splice | `engine`, `apps/api/src/modules/engine/config`, `apps/api/src/modules/engine/feeder/push.ts`, `apps/worker/src/jobs/island-render`, `packages/shared`, `deploy/compose.dev.yml` |

  Changes to `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig.base.json` or `ci.yml` run every job. Skipped jobs report as skipped, not pending: **branch protection on `main` should require only the `CI ok` check** (never the individual jobs), which fails when any job failed or was cancelled. The repo has no branch protection rule yet. When you add a job, add it to `CI ok`'s `needs`; when you add a test folder, check the filters in the `changes` job cover it.
- `images.yml` builds the production images on PRs only when their build inputs change (`deploy/docker`, any `package.json`, the lockfile, the workspace file, `.dockerignore`, `images.yml` itself) and pushes them to GHCR from `main`, where it runs on every commit. It isn't a required check.
- Build a production image locally from the repo root: `docker build -f deploy/docker/api.Dockerfile .` (or `worker`). Images run the `.ts` sources directly (`docs/adr/0005-production-images.md`).

If a command here is wrong, fix this file.

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
