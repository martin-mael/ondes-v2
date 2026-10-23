# ADR 0030: Log regeneration: a rolling horizon, a keep policy, no-op writes and a dry-run diff

- Status: accepted
- Date: 2026-10-23
- Issue: #101 (epic #49). Builds on ADR 0026 (the log generator), 0006 (job queue, event
  transport), 0012 (feeder), 0017 (segues), 0020 (clock grid), 0022 (missing-episode
  fallbacks). Read by #46 (hard starts) and #60 (promo VTs), which plug into the generator.

## Context
#50 shipped the generator and the `log-generate` job, but nothing ran it. A station needs its
log planned ahead, without anyone pressing a button, and kept in line with its schedule as the
clocks, the grid, the categories, the rules and the shows change. Regenerating must never
touch what already aired or is about to, must keep what people did by hand, must say what it
would change before it does, and must be safe to repeat: the issue's acceptance is that
regenerating twice with the same seed and inputs changes nothing.

## Decision

### What a regeneration keeps (`@ondes/scheduling` `regen/policy.ts`)
The generator already plans around *kept items* it is given (ADR 0026: locked items, segue
ends, fallback marks). Regeneration adds two reasons, through one pure function,
`keepReasons(item, policy)`, which the snapshot loader (what to keep) and the day writer (its
stale check) both call, so they can't disagree:
- **`past`**: the item starts before the **freeze point**, `now + 1 h` (`REGEN_FREEZE_MS`). That
  covers what aired, what is on air, and the feeder's 45 min lookahead (#29). Today can be
  regenerated: the morning stays, the afternoon is planned again. Days before today are
  refused (422).
- **`manual`**: a hand edit. That is an item inserted or replaced by hand (`origin: manual`,
  #100), or a generated item moved by hand. A move keeps the item's origin, since the as-run
  matching (#53) reads it. Its `log_item.move` audit row is the record that its place was a
  choice, so the loader looks it up there; no column needed.

**Deleting is not kept, on purpose.** A deleted generated item leaves its clock slot, show
occurrence or marker in the plan, and the next regeneration fills it again:
- an hour with a hole would run short, and the safety playlist would play the gap;
- what a deleted show occurrence or marker comes from is the schedule, and the schedule is
  where to drop it (a slot exception, #44).
- To make a choice stick in the log, replace the item (manual) or lock what's around it.

The regenerate dialog says so in its description, so nobody is surprised. Tombstones that
leave a slot empty would need the generator to skip slots (ADR 0026's builder). That's a
follow-up if the owner wants it.

### Kept flow items are pinned (`log_item_pin`)
A kept `flow` item follows the items before it. The generator plans around it at its stored
start; retiming then moves it to where the new items before it end. Planning around that new
start next time gives other items, which move it again: regeneration never settled (the pure
test that locks a few songs and regenerates in a loop showed it at once).

So the writer records, for every kept item, where the generator planned it (`start`) and where
retiming put it (`settled_start`). The loader plans around `start` while the item still sits at
`settled_start` (`keptStart`). If an edit moved it or retimed its day since, the pin no longer
matches and its current start is used. Pins go with their item (foreign key, cascade).

### No-op writes (`sameDay`)
`writeGeneratedDay` compares, under the day's row locks, the generated day with the stored one:
- the same items in the same order: kind, asset, episode, live slot, title, timing, anchor,
  cap, origin, relaxed rules, planned start and length, conflict;
- kept items with their ids;
- the same seed and generator version.

An equal day isn't written at all: no new ids, no version bump, no audit row, no `log.updated`
(`WrittenDay.changed: false`). New items get new ids on every write, so without this a
regeneration with the same inputs would still churn the day, the cache sync (keyed on
`logDayId:version`) and the feeder. It also makes the horizon's automatic passes cheap when
nothing changed.

The writer no longer uses `withAudit` (which insists on an audit row); it writes the
`log_day.generate` row itself, in the same transaction, when it writes the day.

### The rolling horizon (`log-horizon` job)
- `log_regen_setting` holds a station's `horizon_days` (default 14, at most 56) and the status of
  the days the horizon creates (`new_day_status`, default `draft`, as ADR 0026 decided).
  Existing days keep their status. `GET/PUT …/log/regen/settings`, audited
  `log_regen_setting.update`.
- The horizon is `horizonDates(now, timezone, days)`: station-local dates from today. A DST day
  is one date like any other; the generator gives it 23 or 25 hours.
- **`log-horizon`** (worker, `bulk` lane) brings one station's horizon up to date: it
  generates the horizon's days that have no log yet, and once a schedule change is due, it
  regenerates every horizon day from the change's first date on (`horizonWork`). It runs
  `runLogGenerate` inline, 14 consecutive days per run (`consecutiveChunks`).
- **The nightly extension is the same pass.** At local midnight a new date enters the horizon
  without a log, so the station is due.
- **The sweep lives in the api** (`regenPlugin`, every 30 s). It records schedule changes
  (below), then `stationsDueForHorizon` lists the stations that have a clock grid and either a
  missing horizon day or a due change. The api
  enqueues a `log-horizon` pass for each, keyed on the payload hash, so concurrent replicas
  collapse while one pass is in flight. The worker's own timers live in its `main.ts`, which
  job folders don't edit; the api already runs several sweeps (alerts, episode check).
  - A station without a clock grid gets nothing: no empty days full of `no_clock`.

### Automatic regeneration, debounced
- **Detecting changes from the audit log.** Every api mutation writes its `audit_log` row in its
  own transaction. So the sweep reads schedule changes from there (`recordScheduleChanges`,
  `SCHEDULE_ACTIONS`):
  - clock updates and deletes;
  - the clock grid, dayparts and overrides;
  - category updates and deletes, rotation rules;
  - shows, slots, slot exceptions, episodes and reruns;
  - the library: asset create, update, delete and tags. Category membership follows tags and
    asset fields (ADR 0013), and the rules read titles and artists.
- **Why not a publish after the response.** A first version published a `schedule.changed`
  event from an `onResponse` hook. A failed publish, or a crash between the commit and the
  publish, lost the change. Reading the audit row can't lose it, deletes included. It also
  keeps the change out of every module: none of them has to know about regeneration.
- **What's new** is what's after the station's cursor (`log_regen_cursor.seen_until`), or after
  its pending request's last change. The cursor moves to a request's last change when a
  regeneration clears it.
  - Times are compared in milliseconds, like the request's: a change is never seen twice.
  - Stations without a cursor look back one day.
  - A transaction that commits after a regeneration that started later could slip behind the
    cursor; a mutation transaction is far shorter than the debounce.
- **Recording them.** The sweep upserts the station's `log_regen_request` in one statement:
  the earliest `from_date` (null: today), the areas, the first and last change times, and the
  due time. Concurrent first changes merge instead of overwriting each other.
- **Debounce.** The request is due 30 s after the last change, and no later than 5 min after
  the first (`regenDueAt`), so a programmer editing a clock for ten minutes gets a
  regeneration every five, then one 30 s after they stop. Until then, passes leave it alone.
  The sweep picks it up once due and enqueues a `log-horizon` pass (RabbitMQ). After
  regenerating, the pass deletes the request only if no change came in meanwhile
  (`last_requested_at` unchanged), and moves the cursor. A newer change waits for its own turn.
- A schedule change regenerates every future horizon day, not just the ones it affects.
  Picks are seeded per slot (ADR 0026), so unaffected parts come back the same and the no-op
  check skips unchanged days.

### Dry-run and diff (`POST …/log/regen/preview`)
- The api loads the snapshot with the same keep policy, runs the generator (up to 7 days, while
  the request waits) and diffs each day against the stored one (`diffDay`). Nothing is written.
- Kept items are matched by id. They're counted by reason, or listed as moved when retiming
  shifts them.
- The other items are paired by identity: what they play (asset, episode, live slot), else
  where they come from (markers, empty episodes, placeholders).
  - Same start: unchanged. Another start: moved, with the shift.
  - Leftovers are added or removed.
  - Rules relaxed lists the regenerated items that broke a rule, flagged `new` when the
    paired current item hadn't.
- The response has each day's change (`new`, `changed`, `unchanged`, the last meaning the write
  would be a no-op), the four lists, the kept counts, the hypothetical day itself and the
  generator's issues, plus the freeze point.
- **Applying** (`POST …/log/regen`, 202) applies what a preview showed:
  - the same 7 days at most;
  - `expectedVersions` from the preview, required for every date (422 otherwise; 409 when a
    day changed since).
  - It audits `log_day.regenerate` and enqueues a `log-generate` job with the station's
    new-day status. The job publishes `log.updated` as usual.
  - Bulk regeneration without a review is the horizon's job, not the API's.
- The extension points the worker uses (#46's `beforeAnchor`, #60's `placeVoiceTrack`) are a
  builder, `(loaded, scope) => GeneratorExtensions`. `runLogGenerate` takes it as
  `deps.extensions` and the api's `regenPlugin` as `extensions`, so a preview plans like the
  job.

### History reads what aired
The snapshot's history is as-run before `now` and planned items after (ADR 0026), and that is
intended: the rules should space songs against what really aired. A regeneration later in the
day can therefore pick differently for the following days if something aired off plan. Those
aren't the same inputs. When everything aired as planned, the history is the same and so is
the day.

### A failing day doesn't swallow the events
`log-generate` writes days one transaction each. If a later day fails (a stale snapshot, a
database error), the days already written are announced (`log.updated`, `log.generated`)
before the error goes up for the retry. Otherwise the retry would find them unchanged and
announce nothing, and the timeline, the feeder and the alerts would stay stale.

### Issues become alerts
After writing, `log-generate` publishes `log.generated`: every day it went through, `changed`
or not, with its issue counts and up to 50 issues. The api consumes it from a durable queue
(`log-regen`) and keeps one `log.generation_issues` alert per station and local date:
- raised, `warning`, for `no_clock`, `unknown_clock`, `unfilled_slot`, `underfilled_clock`,
  `occurrence_dropped`, `occurrence_overlap`;
- `details.i18n = { key: 'logRegen.issues', params: { localDate, total } }`, as #47 does;
- resolved when a regeneration of the day has none of them left, and once the day is over.

Missing episodes are left out: #47 raises its own alerts, with lead times and fallbacks. So are
unplaced voice tracks, which the timeline shows. An unchanged day keeps the alert it already
has.

### Late episode audio
The api's episode update calls `attachEpisodeAudio` when it sets an asset, then publishes
`log.updated` for the days it touched (ADR 0026's follow-up).

### UI
A "Regenerate" button on the timeline (with `log:write`, today and later) opens a dialog: a range
of up to 7 days, "Preview changes", the diff per day in station time, then "Regenerate". A
preview not applied counts as unsaved work. A stale preview is refused and the dialog says so.

## Consequences
- New: `log_regen_setting`, `log_regen_request`, `log_regen_cursor`, `log_item_pin`.
  `contracts/log-regen.ts` holds settings, requests, the diff, `log.generated` and the
  `log-horizon` payload. Also new: alert type `log.generation_issues`, `@ondes/scheduling` `regen/`,
  `@ondes/db` `repos/log-regen.ts`, the `log-horizon` job, and the api's `regen-*` files under
  `modules/log`.
- `KeptReason` gains `past` and `manual`.
- `loadGeneratorSnapshot` takes `keep` and returns the current days and the kept reasons.
- `writeGeneratedDay` takes `keep`, skips unchanged days and pins kept items.
- `runLogGenerate` always applies the regeneration policy, takes `extensions`, and publishes
  `log.updated` only for changed days.
- Every `log-generate` run now keeps the next hour. Rewriting what aired was never right.
- Two horizon passes for one station can overlap (sweeps on two api replicas). The
  writes are row-locked and stale-checked, and the no-op check makes the second one cheap, so
  the only cost is duplicated work.
- Follow-ups:
  - a settings screen for the horizon (the API is there);
  - regenerating only the days a change can affect (from an exception's date, for example);
  - tombstones that leave a deleted item's slot empty, if wanted (needs the generator).
