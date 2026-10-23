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
- **Only aired episodes are rerunnable.** "Aired by an occurrence" (`airedBy` in
  `packages/db/src/repos/reruns.ts`) means the episode has audio and either:
  - its status is `aired` and its `aired_at` is before the occurrence starts (or unknown, for
    an episode marked aired by hand); or
  - its status is `ready` and its premiere is planned on an earlier local date than the
    occurrence's: by the time the rerun airs, the premiere has. This is what lets a log planned
    days ahead rerun this week's episode on Sunday.

  An unscheduled episode that never aired, a `missing` one, or one premiering on the same day
  or later never qualifies, under either strategy and for #47's fallbacks too.
  - **The as-run marks episodes aired.** The status the contract promised since #44 ("`aired`:
    went out, as-run sets it") had no writer. On `track.started`, an entry that airs an episode
    and isn't a rerun sets it `aired`, with `aired_at` = the first such start (kept on replays).
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
  - `{ strategy: 'episode', episodeId: null }` may also be written: the programmer chose "a
    chosen episode" but hasn't picked one yet. It is saved as such (never silently turned into
    `latest_episode`), airs the latest one meanwhile, and the UI says so.
- **One resolver for reruns and fallbacks.** "Which earlier episode airs" was #47's
  `latestEpisode` query inside the api. It moved to `@ondes/db` (`repos/reruns.ts`):
  `pickEpisode` (strategy → episode with audio) and `latestAiredEpisode`. #47's
  `resolveFallback` delegates its `latest_episode` and `episode` policies to `pickEpisode`, and
  the worker's log generator (#50), which can't import the api, calls `resolveRerun(db, scope,
  { slotId, occurrenceDate })`.
  - "Latest" is the highest-numbered episode aired by the occurrence (the rule above). A ready
    premiere planned for later is not burned as a rerun.
  - "Episode N" airs that episode once it has aired by the occurrence; before that, or without
    audio, the latest one airs.
  - `resolveRerun(db, scope, { slotId, occurrenceDate, startsAt })`: the start is needed for
    the `aired_at` comparison.
- **"Schedule a rerun" makes a one-off rerun slot.**
  `POST …/shows/:showId/episodes/:episodeId/reruns { date, time, durationMs? }` creates a
  `{ freq: 'once' }` slot with `{ strategy: 'episode', episodeId }`.
  - No new table or occurrence kind: the rerun shows in the grid, the calendar and the
    upcoming airings, can be moved, cancelled or deleted like any slot, and #50 plans it like
    any rerun slot.
  - It needs `show:write` (it changes the grid). The episode must have audio (422 `no_audio`)
    and have aired by the rerun's start, by the rule above: 422 `before_premiere` when its
    premiere is that day or later, else 422 `not_aired`. The rerun's start is the date and time
    on the station's clock, so a rerun earlier on the day the episode first aired is refused.
  - The web app offers the action on aired episodes, or ready ones whose premiere day is past,
    and checks the same rule (date and time in the station zone) before sending.
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
    `latest_episode` or `episode`), or when it was planned in another show slot than the
    episode's premiere slot. Planned in its own premiere slot, it is never a rerun (a replay
    after an engine restart stays the premiere). Otherwise (no premiere slot, or an item added
    by hand), it is a rerun when the episode already aired before (`aired_at` earlier).
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
- Resolving `rerunOf` costs one query per distinct (show, strategy, occurrence) in the range
  read, run in parallel. Ranges are capped at 92 days; that's fine for a station's grid.
- A premiere planned earlier counts as aired for a later occurrence even if it ends up not
  airing (cancelled the same day, engine down). Cancelling detaches it, so it stops counting;
  an outage is covered by the episode-check alerts, not by this rule.
- A "rerun of a rerun" doesn't exist: a rerun always points at the original episode.

## Code
| Where | What |
|---|---|
| `packages/db/src/repos/reruns.ts` | `pickEpisode`, `latestAiredEpisode`, `resolveRerun` (api and worker). |
| `apps/api/src/modules/shows/reruns.ts` | Slot strategy columns and checks, `rerunOf` for the occurrences read. |
| `apps/api/src/modules/shows/reruns-schedule.ts` | "Schedule a rerun". |
| `apps/api/src/modules/asrun/repo.ts` | The as-run episode snapshot and rerun flag. |
| `apps/web/src/features/shows/rerun-dialog.tsx`, `slot-editor.tsx`, `show-page.tsx` | The strategy in the slot editor, "Schedule a rerun", what each rerun airs. |
