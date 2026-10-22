# ADR 0022: Missing-episode alerts and fallbacks: the worker decides, the api acts

- Status: accepted
- Date: 2026-10-22
- Issue: #47. Builds on ADR 0006 (jobs and events), 0012 (log feeder), 0014 (show recurrence)
  and 0015 (as-run). Read by #48 (reruns) and #50 (log generator).

## Context
A pre-recorded show slot is only as good as its file. Community hosts upload late, and a slot
with no audio is dead air, covered at best by the safety playlist. The team wants warnings
ahead of time and a planned fallback when the audio never comes:
- alerts at T−48h and T−6h, on the dashboard and by email to the show's hosts and the
  station's programmers;
- a fallback per show when the episode is still missing at T: rerun the latest episode, a
  chosen episode, or music from the clock;
- the as-run must say that what aired was a fallback.

Two things shape the design:
- **Time-driven, not event-driven.** The steps fall due as the clock moves, not because
  something happened, so a timer has to drive them.
- **The side effects live in the api.** The alert framework (`app.alerts`), the mailer, and the
  log edits (retiming, `log.updated`, audit) are api code. The worker has a database and a
  queue publisher, nothing else.

## Decision

**The worker decides what is due; the api works it off, through an outbox table.**
- `episode-check` (worker job, `high` lane): one pass per station.
  - It expands the station's pre-recorded slots over the next 48 h with `expandSlots`, in the
    station's time zone.
  - For each occurrence whose premiere has no asset, it records the due steps in
    `episode_check`: `t48h`, `t6h`, `fallback`.
  - Unique per (slot, occurrence date, step): idempotent across passes and worker replicas.
- **The sweep.** Every worker replica enqueues a pass per station every minute
  (`jobs/episode-check/sweep.ts`, started from `main.ts` like the cache sweep). The payload key
  collapses concurrent enqueues.
- **The api plugin** (`apps/api/src/modules/shows/episode-check`) works the table off every
  15 s, on every replica.
  - It claims rows with `FOR UPDATE SKIP LOCKED`; a claim older than 2 min is taken over.
  - A failure releases the row for the next sweep, and it is given up after 10 attempts.
- **Rejected alternatives:**
  - Raising alerts from the worker would duplicate the framework (reopen, escalation, events).
  - An event or a `notify` job per step would need a new event type with permissions, or a job
    the alerts plugin's `notify` worker doesn't know. That worker dead-letters unknown names.
  - Running everything in the api would put the expansion on every api replica's timer. The
    issue gives the decision to a worker job.

**Steps and timing.**
- Leads are elapsed time before the occurrence's UTC start, like slot durations (ADR 0014). On
  a DST night, "48 h before" is 47 or 49 h of wall clock. Tests pin the last Sundays of March
  and October in Europe/Paris, including the 02:30 slot that moves past the gap or airs at the
  first 02:30.
- **Alerts.** Only the most recent due alert is recorded: an occurrence planned 3 h ahead gets
  `t6h`, never `t48h` afterwards.
- **The fallback** is decided **at T−1h**, not at T:
  - the feeder queues about 10 min ahead (ADR 0012), and the playout cache must hold the file
    (ADR 0004);
  - if the audio arrives later but 15 min or more before the start, the next reconcile puts the
    premiere back in place of the fallback.
- "Missing" means the occurrence's premiere has no asset. That includes no episode planned at
  all.
- Live slots are skipped (no file), and so are rerun slots (#48: they air an episode that has
  one).

**Alerts.**
- One `show.episode_missing` alert per occurrence: key `show.episode_missing:<slotId>:<date>`.
- Severity:
  - `info` at T−48h, `warning` at T−6h;
  - `warning` with a "fallback airs" title once the fallback is in;
  - `critical` when nothing can stand in (policy `none`, nothing to rerun, no clock music, or
    no log item for the slot). Critical goes through the framework's manager email.
- **Emails.**
  - The framework emails only critical alerts, and only to alert managers. The missing-episode
    emails go to the hosts (verified addresses) and the station's `programmer` members.
  - They are sent by the plugin: one per recipient and step, recorded in
    `episode_check.notified` so that a retry skips them.
  - Times are written on the station's clock.
- The reconcile resolves the alert as:
  - `episode_ready` once the audio is there;
  - `occurrence_ended` once the slot is over. A premiere still `planned` then becomes
    `missing` (the status #44 reserved for this).

**Fallback.**
- Per show: `show.fallback_policy` (`latest_episode` by default, or `episode`, `clock_music`,
  `none`) and `show.fallback_episode_id`.
  - The episode must be one of the show's own; the api answers 422 otherwise. It is set to null
    if that episode is deleted.
  - Edited in the show dialog and audited with `show.update`.
- **Latest episode:** the highest-numbered episode with an asset that has already gone out:
  aired, unscheduled, or premiered on an earlier date. A ready premiere for next week is not
  burned as a rerun.
- **Chosen episode:** falls back to the latest one when it has no audio.
- **Applying it:** the plugin finds the occurrence's empty item in the log and replaces it
  through the log repository (`replaceLogItem`).
  - The empty item is a top-level item within the occurrence, with `origin_show_slot_id` = the
    slot or `episode_id` = the premiere, and no asset.
  - The replacement keeps the item's place, timing, anchor and length, and gets the fallback's
    `episode` asset. The rest of the day is untouched.
  - The edit is audited as the system actor `episode-check` and published as `log.item.changed`
    and `log.updated`, so the cache and the feeder follow.
  - Reruns stay minimal until #48: the item airs that episode's asset.
- **The mark.** `log_item_fallback` (one row per log item) records the fallback kind, the
  episode rerun and the missing premiere.
  - It is written before the edit, so a retry finds it.
  - `log_item` isn't touched, because the log's schema belongs to #100.
- **As-run.** On `track.started`, the recorder joins the mark and copies the kind into the new
  `asrun_entry.fallback` column. It is exposed as `fallback` on `GET …/asrun`.

**Clock music: an interface, stubbed until #50.**
- `ClockResolver(scope, at) → clockId | null` is #40's `resolveClock`.
- `ClockMusicSource.fill(scope, { clockId, startsAt, durationMs }) → LogItemInput[] | null` is
  #50's.
- Both are options of the api plugin (`buildApp({ episodeCheck: { resolveClock, clockMusic } })`).
  The defaults return null, so `clock_music` raises the critical alert today.
- With a filler, the first item takes the empty item's place and timing, and the others are
  inserted after it.
- Putting an episode back in place of clock music is left to #50 (several items).

## What #50 (log generator) must do
- Plan every pre-recorded occurrence as an `episode` item:
  - with `origin_show_slot_id` = the slot;
  - with `episode_id` = the premiere, if one is planned;
  - with the premiere's asset when it has one.
- When the premiere has no audio, either:
  - leave that item without an asset (the "empty slot" this plugin fills at T−1h). This needs
    `logItemInputSchema` to accept an `episode` item without `assetId`, a `contract:` change;
  - or plan the fallback itself: call `resolveFallback` (`shows/episode-check/fallback.ts`) and
    write a `log_item_fallback` row for the item, so the as-run marks it.
- Provide `ClockMusicSource` and pass it with #40's `resolveClock` to the plugin.
- When regenerating a day, keep items that carry a `log_item_fallback` mark, or drop the mark
  with them. The foreign key cascades.

## Consequences
- New tables `episode_check` and `log_item_fallback`, new columns `show.fallback_policy`,
  `show.fallback_episode_id` and `asrun_entry.fallback` (migration `*_episode-alerts`).
- Additive contract changes:
  - alert type `show.episode_missing`;
  - `Show.fallbackPolicy` / `fallbackEpisodeId`;
  - `AsRunEntry.fallback`;
  - `contracts/episode-check.ts` (steps, leads, the job payload).
- A replaced item becomes `manual` in the log (that's what `replaceLogItem` does), so a regenerated
  day won't see it as the show's. `log_item_fallback` still links it to the occurrence.
- Emails are in English, like the other alert emails, until users have a locale.
