# ADR 0028: Reruns are slots that point at an existing episode

- Status: accepted
- Date: 2026-10-22
- Issue: #48. Builds on ADR 0014 (show recurrence) and 0022 (missing-episode fallbacks). Read
  by #50 (log generator) and #53 (log vs as-run).

## Context
Vandale reruns shows all the time: last week's episode on Sunday morning, a best-of in the
summer, one particular episode on an anniversary. #44 reserved a slot type `rerun` with no link
to what it airs, and #47 added a missing-episode fallback that already reruns "the latest
episode" or "a chosen episode". The issue asks for:
- a `rerun` slot with a strategy: the latest aired episode, or episode N;
- a "schedule a rerun" action on any aired episode;
- now playing that shows the original episode number and a rerun flag.

An episode's audio is one asset, and an asset belongs to one episode (ADR 0014), so a rerun
can't be a copy of the episode.

## Decision
- **The strategy lives on the slot.** `show_slot.rerun_strategy` (`latest_episode` |
  `episode`) and `show_slot.rerun_episode_id`, set only on `rerun` slots. The contract exposes
  them as `ShowSlot.rerun: { strategy: 'latest_episode' } | { strategy: 'episode', episodeId } |
  null`.
  - A rerun slot written before #48 has no strategy; it reads as `latest_episode`. The check
    constraint allows that, so the migration is safe on a populated database without a backfill.
  - `rerun_episode_id` is a plain foreign key, `on delete set null`; the repository checks the
    episode is one of the slot's show. A deleted chosen episode leaves
    `{ strategy: 'episode', episodeId: null }`, which airs the latest one, like #47's chosen
    fallback.
  - Changing a slot to `rerun` without a strategy picks `latest_episode`; changing it away
    drops the strategy. Only rerun slots accept one (422 `not_a_rerun_slot`).
- **One resolver for reruns and fallbacks.** "Which earlier episode airs" was #47's
  `latestEpisode` query inside the api. It moved to `@ondes/db` (`repos/reruns.ts`):
  `pickEpisode` (strategy → episode with audio) and `latestAiredEpisode`. #47's
  `resolveFallback` delegates its `latest_episode` and `episode` policies to `pickEpisode`, and
  the worker's log generator (#50), which can't import the api, calls `resolveRerun(db, scope,
  { slotId, occurrenceDate })`.
  - "Latest" is the highest-numbered episode with audio that has already gone out before the
    occurrence's date: aired, unscheduled, or premiered on an earlier date. A ready premiere
    planned for later is not burned as a rerun.
  - "Episode N" airs that episode while it has audio, else the latest one.
- **"Schedule a rerun" makes a one-off rerun slot.**
  `POST …/shows/:showId/episodes/:episodeId/reruns { date, time, durationMs? }` creates a
  `{ freq: 'once' }` slot with `{ strategy: 'episode', episodeId }`.
  - No new table or occurrence kind: the rerun shows in the grid, the calendar and the
    upcoming airings, can be moved, cancelled or deleted like any slot, and #50 plans it like
    any rerun slot.
  - It needs `show:write` (it changes the grid), the episode must have audio (422 `no_audio`),
    and the date can't be before the episode's premiere date (422 `before_premiere`).
  - The length defaults to the premiere slot's, then the show's usual length, then the audio's
    rounded up to the minute.
  - Audited as `show_slot.create`.
- **The occurrences read says what each rerun airs.** `ShowOccurrence.rerunOf` (optional,
  rerun occurrences only) is the episode the strategy resolves to now, or null when nothing has
  audio yet. The UI shows "Rerun of episode N" or a calm note.
- **What #50 plans for a rerun occurrence:** an `episode` log item with `episode_id` = the
  resolved episode (the original, not a copy), its asset, `origin_type = 'show'` and
  `origin_show_slot_id` = the rerun slot. No `log_item_fallback` row: a rerun is planned, not a
  stand-in.
- **The as-run snapshots the episode.** On `track.started` the recorder copies the log item's
  episode into new `asrun_entry` columns `episode_id`, `show_id`, `episode_number` and `rerun`,
  exposed as `AsRunEntry.episode: { id, showId, number, rerun } | null` on `GET …/asrun` and the
  `asrun.started` / `asrun.ended` events (now playing).
  - `rerun` is true when the item stands in for a missing episode (#47's mark,
    `latest_episode` or `episode`), or when the show slot it was planned for isn't the
    episode's premiere slot. An item added by hand with no show slot is not a rerun.
  - Snapshots, like the rest of the as-run (ADR 0015): history keeps the number the episode had
    when it aired, after a renumbering or a regenerated log day.
  - Deriving the flag from the log item avoids a "rerun" column on `log_item` that every
    writer (generator, fallback, manual edits) would have to keep right.

## Consequences
- New columns `show_slot.rerun_strategy`, `show_slot.rerun_episode_id` and
  `asrun_entry.episode_id`, `.show_id`, `.episode_number`, `.rerun` (migration `*_reruns`).
- Additive contract changes: `RerunStrategy`, `SlotRerun`, `ShowSlot.rerun` (optional),
  create/update slot `rerun`, `ScheduleRerun`, `ShowOccurrence.rerunOf` (optional),
  `AsRunEntry.episode` (optional).
- The engine's own metadata (what listeners' players show) is unchanged; a public now-playing
  endpoint (#75) can read `AsRunEntry.episode`.
- Resolving `rerunOf` costs one query per distinct (show, strategy, date) in the range read.
  Ranges are capped at 92 days; that's fine for a station's grid.
- A "rerun of a rerun" doesn't exist: a rerun always points at the original episode.

## Code
| Where | What |
|---|---|
| `packages/db/src/repos/reruns.ts` | `pickEpisode`, `latestAiredEpisode`, `resolveRerun` (api and worker). |
| `apps/api/src/modules/shows/reruns.ts` | Slot strategy columns and checks, `rerunOf` for the occurrences read. |
| `apps/api/src/modules/shows/reruns-schedule.ts` | "Schedule a rerun". |
| `apps/api/src/modules/asrun/repo.ts` | The as-run episode snapshot and rerun flag. |
| `apps/web/src/features/shows/rerun-dialog.tsx`, `slot-editor.tsx`, `show-page.tsx` | The strategy in the slot editor, "Schedule a rerun", what each rerun airs. |
