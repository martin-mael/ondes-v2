# Missing-episode check (#47)

Alerts at T−48h and T−6h for pre-recorded occurrences whose episode has no audio, and the
show's fallback at T−1h. Design: `docs/adr/0022-missing-episode-fallbacks.md`.

| Where | What |
|---|---|
| `plan.ts` | Pure: which steps (`t48h`, `t6h`, `fallback`) are due for an occurrence at a given time. DST tests in `plan.test.ts`. |
| `check.ts` | One pass over a station: expand its pre-recorded slots over 48 h, record the due steps in `episode_check`. |
| `index.ts` | The `episode-check` job (high lane). |
| `sweep.ts` | Enqueues a pass per station every minute, from the worker's `main.ts`. |
| `packages/db/src/repos/episode-check.ts` | The queries. |
| `apps/api/src/modules/shows/episode-check` | The api's half: alerts, emails, fallbacks, as-run mark, restore. |

The worker only records steps. Recording is idempotent: unique per occurrence and step. The api
plugin works them off every 15 s.

## Tests

- **Unit:** `pnpm vitest run apps/worker/src/jobs/episode-check`.
- **Integration** (`check.int.test.ts`, the `worker` project): Postgres only.
- **The api side:** `apps/api/src/modules/shows/episode-check/episode-check.int.test.ts`
  (`core`). It covers:
  - alerts and emails;
  - fallbacks in the log;
  - the as-run mark;
  - restore, and the critical alert.
