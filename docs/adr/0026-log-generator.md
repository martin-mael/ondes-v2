# ADR 0026: The log generator: a pure day builder, a snapshot, and kept items

- Status: accepted
- Date: 2026-10-23
- Issue: #50 (epic #49). Builds on ADR 0003 (hard starts), 0012 (feeder), 0013 (categories),
  0014 (show recurrence), 0016 (rotation rules), 0017 (segues), 0020 (clock grid) and 0022
  (missing-episode fallbacks). Read by #46 (back-timing), #60 (VT placement), #101
  (regeneration), #52 (markers).

## Context
The log (#100) is every second of a station's day, planned ahead. Until now a hand-made fixture
filled it. The generator turns the station's plan into log items:
- the weekly clock grid (#40), one clock per real hour, 23 or 25 of them on DST days;
- show slots and their episodes (#44), reruns (#48), live slots;
- category picks under the rotation rules (#38);
- voice-track placeholders, filled later by #60.

It has to be reproducible (the same plan and seed give the same day), explain itself (the slot
each item comes from, the rules relaxed for it), never fail on a station's data, and generate
a week in under 10 s for a 20k-track library.

## Decision

### A pure core, a snapshot, a thin job
- **`@ondes/scheduling` `generateDay(snapshot, localDate)` / `generateDays(snapshot, dates)`**
  (`packages/scheduling/src/generator`): pure, no I/O, no clock. The snapshot is everything the
  days depend on: timezone, grid, clocks, categories with members resolved, assets, rules,
  history (as-run and planned items around the days), older airings, show occurrences with
  their episodes, kept items, the previous day's end. `generateDays` chains days: each day's
  picks join the next day's history, and each day's first item is timed against the day before.
- **`@ondes/db` `loadGeneratorSnapshot`** (`packages/db/src/repos/log-generate.ts`) loads it in a
  dozen queries, the way the api's picker loads its own (`apps/api/src/modules/rotation`):
  - the whole library, once, with tags, album, analysis and cues;
  - membership with `resolveCategory` (ADR 0013), at the first day's start;
  - a history of 8 days around the range, or the longest rest or separation if longer, plus
    each asset's last airing before it.
- **`writeGeneratedDay`** writes one day per transaction and audits `log_day.generate` (actor
  `system:log-generate`). It deletes the items that aren't kept, renumbers the kept ones
  (through negative positions: the position key isn't deferrable) and inserts the new ones.
  Then it bumps the version, stores `seed` and `generator_version`, and refreshes the next
  day's first-item conflict. Every new item is parsed with `logDayItemInputSchema` first (the
  bulk-write contract: `logItemInputSchema`'s rules plus origin and relaxed rules).
- **The snapshot can go stale.** It is loaded once per job, outside any transaction. Each day's
  write therefore locks the day's items (`FOR UPDATE`) and checks that the kept set is still
  the snapshot's before deleting anything.
  - If an item became kept since the load (locked, a segue end, a fallback mark), or a kept
    one went away, the write throws `StaleGeneratorSnapshotError` and writes nothing.
  - The queue's retry then loads a fresh snapshot.
  - The row locks also hold off a concurrent lock, segue or mark on those items until the
    write commits: their writes, and the foreign keys pointing at the items, wait for it.
- **The `log-generate` worker job** (`apps/worker/src/jobs/log-generate`, bulk lane) takes 1–14
  consecutive dates. It loads one snapshot for all of them, generates them in order, writes
  each, and publishes one `log.updated` (cause `generate`). No event triggers it: #101's
  routes, or a horizon sweep, enqueue it. New days are `draft` unless the payload says
  `published`. Existing days keep their status.
- **Idempotency.** The job keeps the queue's default key: `log-generate:<sha256 of the
  payload>`, deduplicated while a job with the same key is in flight. That is a content hash,
  as CLAUDE.md asks, and the job is idempotent: the same snapshot and seed write the same
  items.
  - An explicit key would make the job run once ever for its key (`idempotency: 'once'`), so
    a later regeneration of the same days after an edit would be dropped.
  - A snapshot hash or day versions can only be computed by loading the snapshot, which the
    enqueuer doesn't do.
- `@ondes/db` now depends on `@ondes/scheduling` (pure, depends only on `@ondes/shared`), for
  `resolveCategory`, `expandSlots` and `retime`. The worker has no query builder, so its
  queries live in `@ondes/db`, as for #47.
- **`retime`** (ADR 0003's planned starts) moved from `apps/api/src/modules/log/timing.ts` to
  `packages/scheduling/src/log`. The api's `timing.ts` re-exports it. The generator retimes
  its day with the same function, so what it writes is what the log would compute.

### Build order
1. **Fixed blocks.**
   - Kept items (below) first.
   - Then show occurrences overlapping the day (`expandSlots` output, loaded with the
     episode each airs), each one item anchored `hard` at its start:
     - `prerecorded`: an `episode` item with `episode_id` = the premiere and its asset;
     - `rerun`: the episode it plays again (#48), the same way;
     - `live`: a `live_slot` item.
   - Origin `show` with the slot (`origin_show_slot_id`).
   - An episode with audio lasts its own length: a shorter one leaves room for music before
     the next item, a longer one shows as an overrun. Without audio, the item lasts the slot
     and has no asset (next section).
   - An occurrence that started the day before only blocks the start of the day: its item
     is that day's.
2. **Structure.** The windows between blocks are laid out from the grid (`expandGrid`, so the
   DST rules of ADR 0020 apply).
   - An hour clock, or a partial clock repeated inside the hour, starts again at every hour.
   - A clock longer than an hour runs on across consecutive hours of the same clock.
   - Markers become `marker` items with their timing and anchor.
   - A window that starts inside a clock skips the slots that nominally end before it
     (`estimateClock`, category averages).
3. **Music.** Each clock's slots are filled in air order. Each pick joins the history before the
   next one is made, so every rule sees what's already planned. Slots that would start past
   the next marker are skipped.
   - An item goes in before an anchor when it ends by then, or overruns it by less than the
     gap it would leave. The residual, at most half an item, is #46's to absorb.
   - Past an anchor, planning follows the log's timing model (ADR 0003, `retime`): a `hard`
     or `soft` item starts at its anchor and the items after it follow from there. When the
     run before it overran, the engine cuts the item on air at the anchor (hard), or the
     feeder drops what's queued (soft). Retiming records the overrun as the anchored item's
     `conflict`.
     - The generator's cursor follows the same rule, so it never disagrees with the planned
       starts that get written.
     - Keeping the later end instead would plan the rest of the clock from a time the log
       doesn't use, and leave it short.
   - A clock whose slots run out before its end repeats its music slots and reports
     `underfilled_clock`.

Shows and kept items go first because they are fixed in time. Structure goes next because
markers anchor the hour. Music fills what is left, in time order, because the rules compare
neighbours.

### Collisions
ADR 0014 left "what wins" to the generator. Occurrences that start together, or one inside the
other, can't both air. The one with priority stays:
1. a one-off slot or moved occurrence;
2. else the shorter;
3. else by slot id.

The other is dropped and reported (`occurrence_dropped`). A partial overlap keeps both: the later
starts at its time (hard), and retiming reports the overrun on it (`occurrence_overlap`).
Conflicts stay data, as in ADR 0014.

### Seeding
The seed is `<stationId>:<localDate>` unless the job gives one. It is stored on `log_day.seed`
with `generator_version` (`GENERATOR_VERSION`, bumped when the same snapshot and seed would
give another day). The picker draws `weighted_random` from `(seed, category, slot time)`.
Everything else is ordered deterministically: same snapshot and seed, same items.

Regenerating one day of a range gives a different day than generating the range: the other
days' items are now planned history, and the rules pick around them. That is wanted.

### Relaxation
The rules engine's ladder (ADR 0016) is used as is. Each item stores the rules relaxed for it
in `relaxed_rules`. A slot no candidate can fill (an empty category, unbreakable rules) is left
out and reported `unfilled_slot` with the picker's reason. Property tests check, over 32 seeded
runs, that an unbreakable separation is never broken and that every broken song rest is
recorded on the item. They also check that items stay in their day, in order, and meet the
bulk-write contract. The runs vary the library (120–720 songs), the separation and its featured
artists, and the clock (8–20 music slots, with or without a top-of-hour marker). Their dates
include the DST weekends.

**Picker fast path.** `pickForSlot` gains `explain: false`, which the generator uses:
- it checks candidates in rotation order only until the pick is found. With `search_depth`
  active, nothing past the depth can be picked. `weighted_random` draws among every eligible
  candidate within it;
- when nothing is eligible without relaxing, it runs the full ladder, so `relaxed` and its
  reasons are those of the full ranking;
- a category's rotation order is kept between consecutive picks. Only the members played since
  move. It is rebuilt when a schedule window or older airing falls between the two slots, or
  when history isn't append-only;
- history indexes are extended rather than rebuilt when picks are appended in air order, and
  normalized keys are cached per candidate.

All of it is exact: `quick-pick.test.ts` checks that both modes give the same pick, `relaxed`
and `unfilled` on random snapshots. Measured on a 20k-track library (three categories of 5k,
7k and 8k songs, 90 % with an older airing), a week took about 2 s on a loaded shared machine.
Before the fast path it took over 30 s. `generate.bench.test.ts` runs it with the unit tests,
in CI too, logs the time and enforces the 10 s budget.

### Never fail, report
`GeneratedDay.issues`:
- `no_clock`, `unknown_clock`: hours the grid leaves without a clock (ADR 0020's `source:
  'none'`);
- `unfilled_slot`, `underfilled_clock`;
- `episode_missing`, `occurrence_dropped`, `occurrence_overlap`;
- `vt_placeholder`.

None of them stops the day. After a hole (an hour without a clock, or a show from the night
before), the cursor jumps to the end of the hole and the next item doesn't slide into it: a
`flow` item becomes `not_before` the hole's end. The feeder holds it and the safety source plays meanwhile (ADR 0012). The job logs the
counts. Turning them into dashboard alerts is left to the caller (#101).

### Missing episodes (ADR 0022)
- An occurrence whose episode has no audio, or that has no episode planned, becomes an
  `episode` item without an asset (`contract:` PR #165 allows it). It has the premiere's
  `episode_id`, when there is one, and always `origin_show_slot_id`. Without either, an episode
  item is refused: a manual input must name its `episodeId`, a bulk write its show slot. This is the empty item #47's fallback fills at T−1h.
- The generator doesn't plan fallbacks itself: whether audio arrives is only known close to
  air time.
- **Late audio:** `attachEpisodeAudio(db, ctx, episodeId)` puts an episode's new asset into the
  empty items planned for it that haven't started.
  - Each item takes the episode's own length, as the generator would give it.
  - The day is retimed, and so is the next day's first-item conflict, like the log repository
    after every edit. A shorter episode shows as a gap on the next anchored item.
  - It returns the touched days. The api's episode update should call it and publish
    `log.updated`; that wiring is a follow-up.
- **Clock music:** `fillWithClockMusic` (`@ondes/db`) loads the day around the slot and plans
  `[start, start + duration)` from one clock with `planClockMusic`. It is #47's
  `ClockMusicSource`, now the plugin's default (`generatorClockMusic`).

### Kept items: locked, segue ends, fallback marks
Regenerating a day rewrites its items. Three kinds must survive, with their ids:
- **locked items** (#100);
- **both ends of every segue** (ADR 0017): new ids would detach it;
- **items with a fallback mark** (ADR 0022): the as-run joins the mark, and the mark is the
  record that the occurrence airs its fallback.

The loader returns them per day as `KeptItem`s, segments with their parts. The generator groups
back-to-back kept items into blocks at their planned times, so a segue's A and B stay
consecutive and the segue stays `ready`. An occurrence is not planned again when a kept item
stands for it (same show slot); one whose time a kept item holds is dropped and reported. A kept
item changes only its position and planned start. Everything else is deleted and recreated.
The foreign keys detach the segues of deleted items and cascade their fallback marks.

Which items a user may keep, dry-runs and diffs are #101's. It can pass its own `kept`.

### Extension points (`GenerateOptions.extensions`)
- **`beforeAnchor({ anchor, run, runEndsAt }) → items`** (#46, hard-start fill and back-timing):
  called at every anchored item (show start, marker) with the run planned since the previous
  anchor. Whatever it returns replaces the run: a flexible last song with `cueOverrides`, a
  sized bed. By default the run stays as planned, and retiming reports the gap or overrun.
- **`placeVoiceTrack({ clockId, slotIndex, mode, at, previous }) → items | null`** (#60): called
  for every `vt` placeholder slot. Voice tracks are segue lanes (ADR 0017), so a placement may
  return nothing and add segues after the day is written. `null`, or no hook, reports
  `vt_placeholder`.
- Elastic `fill` slots get what's left before the next anchor, capped at the bed's length.
  Sizing them exactly is #46's.

### Reruns (#48)
The loader takes a `RerunResolver`. The default (`latestEpisodeRerun`) plays the show's latest
episode with audio that has aired by the occurrence's start (`aired` before it, or `ready` with
an earlier premiere): #48's `latest_episode` rule. #48 (PR
#166) adds `resolveRerun` in `packages/db/src/repos/reruns.ts`, which reads the slot's
`rerun_strategy` / `rerun_episode_id`. Once both are on main, the default becomes
`(db, scope, o) => resolveRerun(db, scope, { slotId: o.slotId, occurrenceDate: o.date,
startsAt: o.startsAt })`. A rerun is planned like a premiere,
with the episode it plays again, and gets no fallback mark.

## Consequences
- New: `contracts/log-generate.ts` (job payload), `@ondes/db` `loadGeneratorSnapshot`,
  `writeGeneratedDay`, `fillWithClockMusic`, `attachEpisodeAudio`, `latestEpisodeRerun`;
  `@ondes/scheduling` `generateDay`, `generateDays`, `planClockMusic`, `settleOccurrences`,
  `retime`.
- `pickForSlot` gets `explain: false`. Its default behaviour is unchanged.
- The generator plans, it doesn't publish: the feeder plays only `published` days.
- Follow-ups:
  - the api's episode update calls `attachEpisodeAudio`;
  - a horizon sweep, or #101, enqueues `log-generate`;
  - #101 raises alerts from `issues`;
  - #48's resolver replaces `latestEpisodeRerun` for rerun slots that name an episode.
