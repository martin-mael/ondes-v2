# ADR 0014: Show slot recurrence as a structured RRULE subset

- Status: accepted
- Date: 2026-10-21
- Issue: #44. Read by #45 (shows UI), #47 (missing-episode alerts), #48 (reruns), #50 (log
  generator), #65 (live slots), #75 (schedule API and ICS).

## Context
Shows air in recurring slots ("every Tuesday 20:00–22:00", "every other Sunday at 10:00"),
with one-offs and exceptions (a cancelled week, one occurrence moved by a day). Several
features read the expanded schedule: the grid, the log generator, missing-episode alerts and
the public ICS feed. Every station has an IANA timezone, and shows are planned on the local
wall clock, so the expansion has to be station-local and right on DST nights, where a weekly
02:30 slot either doesn't exist (last Sunday of March in Europe/Paris) or exists twice (last
Sunday of October).

The options were a free-form RFC 5545 `RRULE` string expanded by a library (`rrule.js`), or a
structured rule of our own. `rrule.js` handles time zones through `Date` objects in the host's
zone and has long-standing DST bugs; a free-form string also accepts rules nobody can edit in
a form (`BYSETPOS`, `BYWEEKNO`, hourly frequencies) and is hard to validate with zod.

## Decision
- **A structured rule, a strict subset of RRULE.** `{ freq: 'once', date, time }` or
  `{ freq: 'weekly', startDate, until, interval, byDay, time }`: dates are station-local
  `YYYY-MM-DD`, `time` is `HH:MM`, `until` is inclusive, weeks start on Monday and are counted
  from `startDate`'s week. It maps one to one to `DTSTART;TZID=…` + `RRULE:FREQ=WEEKLY;
  INTERVAL;BYDAY;WKST=MO;UNTIL` (`toIcsLines`, for #75). Another frequency (say, "first
  Monday of the month") is a new `freq` variant, an additive contract change. The rule is a
  `jsonb` column on `show_slot`, with `starts_on`/`ends_on` columns derived from it to index
  range reads.
- **Pure expansion in `@ondes/scheduling`** (`packages/scheduling/src/recurrence`):
  `expandSlots(slots, range, timeZone)` returns every occurrence that overlaps a UTC range,
  `findConflicts(occurrences)` every overlapping pair. No I/O. The wall-clock ↔ UTC helpers it
  uses (`zonedInstant`, `localDayBounds`, …) live in `packages/shared/src/time`, shared with
  the log.
- **DST follows RFC 5545 (3.3.5).** A local time in the spring-forward gap is read with the
  offset before the gap, so it lands after it (02:30 → 03:30 CEST). A time that happens twice
  is its first occurrence (02:30 CEST, not 02:30 CET). The slot keeps a single occurrence on
  both nights.
- **Durations are elapsed time.** An occurrence ends `durationMs` after it starts: a two-hour
  episode file plays two hours whatever the clocks do. On a DST night a slot that crosses the
  change therefore ends an hour later or earlier on the wall clock, which can overlap the next
  slot; `findConflicts` reports it rather than the model hiding it.
- **Occurrences are identified by slot and original local date** (RFC 5545's
  `RECURRENCE-ID`). An exception (`show_slot_exception`) is keyed the same way and either
  cancels the occurrence or moves it (new local start, optional new duration) by at most
  seven days. A moved occurrence keeps its identity, so the episode planned for it
  (`episode.slot_id` + `episode.occurrence_date`, both set or both null) follows it.
- **A premiere whose occurrence goes away is detached, not blocking.** Deleting the slot,
  changing its rule or type, or cancelling the occurrence clears the episode's slot and date
  (audited as `episode.detach`), and the response lists the detached episodes. The episode
  keeps its audio and number and shows up in `GET …/episodes?scheduled=false` to be planned
  again. Refusing the change with a 409 would let any planned episode block a programmer's
  grid edit; detaching keeps the grid the programmer's and loses nothing.
- **Conflicts are data, not write errors.** Writing an overlapping slot is allowed (a special
  replacing a regular show for a month is a normal thing to plan); the occurrences read
  returns the conflicts alongside, and the log generator decides what wins.

- **Episodes.** Numbers come from a per-show counter (`show.next_episode_number`) that only
  grows, so a deleted episode's number is never reused; an explicit number above it moves it.
  Live and pre-recorded episodes share it. An episode is `ready` only with its asset (a
  database check; deleting the asset turns it back into `planned` through a trigger). An asset
  is the audio of one episode at most: a rerun airs the same episode again (#48), it doesn't
  copy it.

## Consequences
- The rule can't express monthly or yearly recurrences yet; Vandale's shows are weekly or
  every N weeks. Adding a frequency means extending `isOccurrenceDate` and the contract.
- ICS export is direct; importing arbitrary ICS feeds would need a translation step that
  refuses what the subset can't express.
- A move beyond seven days is a cancellation plus a one-off slot. The bound keeps range
  reads to a fixed window of dates around the range.
