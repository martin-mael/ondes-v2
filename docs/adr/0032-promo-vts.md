# ADR 0032: Promo VTs: pools, placement over transitions, and never airing expired

- Status: accepted
- Date: 2026-10-23
- Issue: #60 (epic #54). Builds on ADR 0013 (categories), 0016 (rotation rules), 0017 (segues and
  islands), 0019 (gain model), 0020 (clock grid), 0024 (islands on air), 0025 (VT recording) and
  0026 (the log generator and its `placeVoiceTrack` extension point). Read by #61 (smart default
  placement).

## Context
Vandale promotes its shows and events with short voiced promos ("Concert at the Marché Gare on
Saturday"). They must air automatically, spread over the day, for as long as they are relevant,
and never after the event. The issue asks for promo assets with a validity window, an optional
show or event, a weight, a cap of plays per day and dayparts; pools of promos assignable to clock
VT slots; the generator placing a promo between two songs as a default segue, editable later; and
two guarantees: an expired promo never airs, and plays per promo are visible.

## Decision

### Data: a promo is a `vt` asset with rules, a pool groups promos
`packages/db/src/schema/promos.ts`:
- **`promo`**: one per `vt` asset (`promo_asset_key`). Weight (1–100), `max_plays_per_day`
  (null: no cap), `dayparts` (jsonb, like grid dayparts without a name: weekdays, start hour, end
  hour, past midnight into the next weekday; empty: any time), `enabled`, an optional `show_id`
  and an optional event (`event_name`, `event_at`), and a `version` for optimistic saves.
- **Validity is the asset's own `start_at` / `kill_at`.** A promo has no dates of its own: one
  source of truth, already honoured by the library and the rules engine. The promo API writes them
  through the library's `updateAsset` (its audit row) in the promo's transaction.
- **`vt_pool`** and **`vt_pool_member`**: a promo may be in several pools.
- **`promo_placement`**: one row per promo the generator placed: the log day and its local date,
  A and B (`from_item_id`, `to_item_id`, `set null`), the clock slot, the planned time of the
  transition (A's planned end), the segue made for it, a status (`pending`, `placed`, `dropped`)
  and why it was dropped. It is the ledger of planned plays.
- **Clock slots**: `clock_slot.pool_id` (additive, `set null`). A `vt` slot in `promo` mode with a
  `poolId` asks for a pool's promo; `categoryId` (picking a `vt` asset like music, a standalone
  item) stays as the older alternative. A pool slot takes no time in the clock's estimate.
- Tenancy: the promo, its pool memberships and placements reach their station's asset, pools,
  promos and log days through composite (id, org, station) foreign keys. The optional references
  that are set null when their target goes (`promo.show_id`, `promo_placement.pool_id`,
  `clock_slot.pool_id`) are single-column, like `clock_slot.category_id` / `asset_id` (#39): a
  composite key can't `set null` without nulling the tenant columns, and drizzle can't declare
  Postgres' `set null (column)`. The repositories check those references are in the station on
  write (the promo and clock routes answer 422 / 400 otherwise), and the generator only reads pools
  of the station it generates.
- Permissions: `voice_track:read` / `voice_track:write`. No new resource.

### Placement: the generator's hook, then a segue
**In the generator (`@ondes/scheduling` `createPromoPlacer`, pure).** The generator now calls
`placeVoiceTrack` for promo slots with a pool too, and passes the `poolId`. Placeholders stay the
generator's (`null`: reported `vt_placeholder`). For a pool slot the hook:
1. needs a song just before the slot (A), not kept by the regeneration (it may carry a segue), no
   other promo on that transition, and a music slot after it in the clock (B);
2. keeps the pool's promos that are enabled, valid over every time the default segue could voice
   them (below), inside one of their dayparts (station wall clock: on DST nights the repeated hour
   counts twice, the skipped one never), and under their daily cap (station-local day);
3. picks the lowest `(plays that day + 1) / weight`, then the least recently placed, then a seeded
   draw (`randomFor(seed, pool, time, promo)`): plays spread in proportion to weight, and the same
   snapshot and seed give the same promos;
4. **returns no items.** A promo is a segue voice lane (ADR 0017): it takes no time of its own, and
   the run is planned as if it weren't there. It records the placement instead.

After each day, `placer.resolve(day)` (`resolvePromoPlacements`) pairs the placements with the generated items: A by
origin and asset at the nearest start within 10 minutes (back-timing, #46, may move it), B as the next top-level item, which must be a song too. The worker job
writes them `pending` (`writePromoPlacements`, audited `log_day.promos`) right after the day.
Placements that can't be made are reported, not errors: `no_song_before`, `transition_taken`,
`no_eligible_promo`, `no_song_after`, counted in the job log as `promo_*`. A play counts against
caps and in rotation once the hook accepts it; one the day then rejects (B isn't a song after all)
is given back, so it doesn't burn the cap for the days after. Within the same day, the clock check
in step 1 turns most of those down before a play is counted; the rare rest (a marker skipped
slots) may hold a slot of the cap until the day ends.

Plays that count against caps and rotation are the placements of the days around the ones being
generated (a week back), and those of the generated days a regeneration keeps.

**In the api (`apps/api/src/modules/promos/placements.ts`).** A durable event queue (`promos`,
single active consumer per station, ADR 0006) handles `log.updated`: each `pending` placement of
the named days gets its segue from the segues module's own `createSegue` (A and B checked,
`segue.create` audited, islands synced, renders requested, `segue.changed` published), with
`origin: 'auto'`. Making the segue in the api, not the worker, keeps one code path for segue
writes; the worker has no segues module. A placement whose media aren't there yet waits for the
next event (also on `asset.ingested` of the promo).

### One air window for every validity check
`@ondes/shared` `promoAirWindow` / `promoValidOnAir` (contracts/promos.ts) is the one window the
generator, the api's re-check and the feeder test a promo's validity against, with one voice
length (`promoVoiceMs`: its cues, else the asset's length):
- with the voice's place on the segue axis (a segue exists: the api's re-check, the feeder), exactly
  when it airs;
- without it (the generator, a placement before its segue), every time the default segue may put
  it: `PROMO_MAX_LEAD_MS` (30 s) either side of the transition, plus its length. The default segue
  keeps the voice within that bound, so a promo the generator placed is never dropped later for its
  dates unless they changed.

### The default segue: from cue markers, ducked (`@ondes/shared` `defaultPromoLanes`)
On the segue axis (0 = A's end), "hitting the post":
1. B's natural start is A's `crossStartNext` (0 without it);
2. the voice starts with A's outro (`outroStart`), or at B's natural start if earlier, or without
   an outro marker; never more than 30 s from A's end either way (the air window above);
3. B starts so that its intro (`introEnd`) ends with the voice: the voice covers A's outro and B's
   intro, and B's vocals come in as it ends (without an intro marker, B starts as it ends);
4. B never starts before its natural start: a short voice moves later instead. A voice longer than
   the instrumental parts delays B;
5. A and B duck 8 dB under the voice with 300 ms ramps, both ramping down to where the voice comes
   in (B starting before the voice plays at full level until then), B back up once it ends (the
   owner's default, the segue editor's first preset). The duck itself (`duckEnvelopes`) is now shared by the generator and the editor's
   "duck" preset.

Markers only, deterministic. **No AI or ML, not even opt-in** (the owner's rule). #61 refines this
(beds, better use of markers) behind the same function.

The delay of B (rule 4) is not in the log's planned times: the run is planned without the promo,
and the next anchor absorbs the difference (soft cap or hard cut, ADR 0003). Promos are short, and
the default only delays B when the markers leave less instrumental time than the voice needs.

### Regeneration: generated promos don't pin the log, edited ones do
ADR 0026 keeps both ends of every segue. A promo's default segue would then freeze its songs and,
regenerated, the day would place more promos around them. So **an `auto` segue that a placement
made doesn't keep its ends** (`keepMarks` in `@ondes/db`). Regenerating deletes A and B, the
placement loses them (`set null`), `writePromoPlacements` drops it, and the consumer deletes its
segue (audited). Once a person saves the segue in the editor it becomes `manual` (the editor sends
`origin: 'manual'` on save): its songs are kept, the placement stays, and its play still counts.

### An expired promo never airs
At every step:
- **Generator:** a promo is placed only if valid around the transition (above).
- **Api re-check:** a promo edit (disabled, new dates, out of a pool), a library edit of its asset
  (`asset.updated`), and every `log.updated` re-check its coming placements, those whose transition
  is still ahead: one that can't air any more is dropped and its generated segue deleted. A past
  transition is history, and an edit of a past day after a kill date leaves it alone. Deleting a
  promo or a pool retires its coming placements first (a deleted pool's placements lose their
  pool, so the re-check alone couldn't tell). A `manual` segue is never deleted: it is a person's
  work.
- **Feeder (`apps/api/src/modules/engine/feeder`):** the last word, at push time, whatever the log
  says (an edited segue, a kill date moved after planning, a log running late). `FeedMedia` carries
  the asset's validity. An island or a fallback overlay with a voice outside its validity over its
  exact air window (its place on the segue axis, from the head item's planned end or now, if
  later) is left out: the
  transition airs as a plain crossfade. A standalone `vt` item outside its validity is skipped,
  reported `expired` (`feeder.item.passed_over`, an additive reason).

### Plays are visible
`GET …/promos` returns each promo's counts: aired today (station day), in the last 7 days, in
total, the last airing, and planned from now. `GET …/promos/:id/plays?from&to` lists planned
(placements, dropped ones with why) and aired plays with a per-day count. Aired plays come from
the as-run: a `vt` entry playing the asset, or a voice of a transition
(`as_run_entry.transition.voices`, ADR 0024) that started before its entry left the air.

### Web
`apps/web/src/features/promos`: pools and promos on one page, a promo dialog (asset, dates in
station time, show or event, weight, daily cap, dayparts, pools), a plays view; the clock editor's
promo slot picks a VT pool. Saving never waits on completeness: a promo in no pool, or a daypart
without days, saves with a calm warning.

## Consequences
- New: `contracts/promos.ts`, `schema/promos.ts`, `segues/promo.ts`, `@ondes/scheduling`
  `createPromoPlacer` / `resolvePromoPlacements`, `@ondes/db` `loadPromoSnapshot` /
  `writePromoPlacements`, the api `promos` module and its `promos` event queue.
- Additive: `vtSlotSchema.poolId`, `slotPoolId`, `VtPlacementContext.poolId`,
  `feeder.item.passed_over` reason `expired`, `clock_slot.pool_id` (foreign key to `vt_pool`).
- Changed behaviour: an `auto` segue made for a promo no longer keeps its ends on regeneration;
  the segue editor saves `origin: 'manual'`.
- A placement dropped on a regeneration keeps its row (status `dropped`) as history; rows go with
  their log day.
- Follow-ups: #61 smart placement; an SSE event for promo changes if the page needs live updates
  (it refetches today).
