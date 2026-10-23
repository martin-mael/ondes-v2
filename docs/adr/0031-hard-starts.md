# ADR 0031: Hard starts: back-time every anchor, stretch the tail, let the engine cut

- Status: accepted
- Date: 2026-10-23
- Issue: #46 (epic #43). Builds on ADR 0003 (the hard-start spike), 0012 (log feeder), 0014
  (show recurrence), 0024 (islands on air) and 0026 (log generator, `beforeAnchor`).

## Context
A pre-recorded episode must start on time, and the music before it must end cleanly. ADR 0003
measured what works on Liquidsoap 2.4.6 and decided on two mechanisms together:
- **back-timing and a runtime re-plan** make the music *arrive* at T: a flexible last song, a bed
  sized to the gap, re-planned on every `track.started`;
- **an engine-timed cut** makes the item *start* at T to the frame, whatever went wrong.

Until now none of it existed:
- the generator (ADR 0026) left a residual of up to half a song before every anchor;
- the feeder (ADR 0012) trimmed overruns but held the item behind the safety playlist on a gap;
- the engine had no `POST /v1/schedule`.

The issue also asks for a per-slot policy, hard or soft, and for proof over two weeks of as-run.

## Decision

### Slot policy: `startMode` and `startCapMs` on `show_slot`
- `hard` (default): the item starts at its time, and the engine fades out what's on air.
- `soft`: the item on air ends first, then the episode starts, at most `startCapMs` late
  (null: `SOFT_START_DEFAULT_CAP_MS`, 30 s, ADR 0003's measured cap; at most 10 min).
- The cap goes with `soft` only: the contract refuses it on a hard slot, and the repository drops
  it when a slot becomes hard.
- The generator plans the occurrence's item `soft` with `capMs`, through
  `GeneratorOccurrence.startPolicy` (loaded by `loadGeneratorSnapshot`).
- The slot editor (#45) has a "Start" field (FR + EN).
- Additive: new columns with a default (migration `*_slot-start-policy`), optional contract
  fields, so older payloads still parse.

### Back-timing (`@ondes/scheduling` `backTiming(snapshot)`, `packages/scheduling/src/backtiming`)
It is the generator's `beforeAnchor` hook (ADR 0026). The `log-generate` job always uses it.

**Which anchors.** Every `hard` and `soft` anchor is back-timed: shows and clock markers alike.
- First design: only hard starts and soft shows. The as-run simulation (below) showed why that
  is wrong. At runtime a `soft` anchor only drops what would start after it. When an hour's
  music ends early, everything after it flows early: hour after hour, up to the next show.
- The drift came out 30–180 s, more than the bed before the show can stretch, so the safety
  playlist aired before 24 of 41 hard starts in two weeks.
- Back-timing every hour keeps the drift to what happens at runtime. `not_before` anchors wait
  anyway: nothing to back-time.

**How**, on the editable tail of the run (the generator's own trailing songs and fills; kept
items, segments and other kinds are never touched):
1. Elastic `fill` items the clock already planned are taken out: one fill, sized here, replaces
   them at the end.
2. Trailing songs the anchor cuts into by more than they can give are dropped. The run's only
   song goes too when a fill can cover the gap.
3. If what's left can't be absorbed, the last song is re-picked in its own slot's category. If
   the gap is still too long for a fill, up to two songs from that category are added.
   - Picks go through `AnchorTools.pick`, which the generator now passes to `beforeAnchor`:
     the same picker, rules and history as the clock slots, among the members whose length
     works.
   - A dropped or replaced pick stays in the rules' history (it is append-only, and the
     picker's indexes rely on that). Later picks just rest that song a little more.
4. The last song is cut when the run still overruns, or to leave the fill its minimum
   (`minFillMs`, 8 s). The cut is at most `maxSongCutMs` (45 s), and the song keeps at least
   `minSongMs` (90 s).
5. A **fill** takes the rest:
   - From the clock's `fill` slot (beds), as a `fill` item sized to the gap. It is picked at
     least `fillHeadroomMs` (15 s) longer than its slot when one is, so the feeder can stretch
     it (ADR 0003: "aim at the middle of the range").
   - Else from the clock's `jingle` slot: a whole jingle that fits, a `jingle` item.
   - The fill source is the clock of the run's last clock item, or the anchor's (a marker right
     after a show has an empty run).

Measured on the fixtures (`backtime.test.ts`):
- with beds, every show and marker ends exactly at its anchor, DST weekends included;
- with jingles only and 2.5–5.5 min songs, about 70 % close within 8 s, and none overrun;
- a week for a 20k-track library takes about 2 s with back-timing (`backtime.bench.test.ts`;
  the budget is 10 s).

`GENERATOR_VERSION` is now `2`.

### What a shortened item means: the log slot is what airs
A song or fill shorter in the log than its media must air that way. The feeder now plays a
flexible item (song, bed, fill) to its log slot (`slotFit`, `feeder/hardstart.ts`):
- the cut is `natural slot − planned slot`, using ADR 0003's slot model, ignored below 250 ms;
- it is pushed as a trim, with the usual fade-out of at least 3 s;
- the item may play up to that much longer again (`stretchMs`).

A log slot shorter than its media used to air whole while the feeder predicted the shorter
slot. Now the prediction and the audio agree.

### Runtime correction (the feeder, `plan.ts` + `hardstart.ts`)
- **Early:** before a `hard` or `soft` anchor, the tail since the previous anchor stretches
  back toward its media's length, the last entry first (`stretchTail`).
- **Late:** the existing `absorb` (drop whole entries, then trim the flexible ones).
- Both re-run on every sync: every `track.started` and the 5 s tick. ADR 0003's "re-plan on
  every `track.started`" is the feeder's stateless reconcile as it already was.
- **Engine-timed cut** (`engineCut`, on when the adapter has `schedule`): the `hard` item is
  never queued.
  - The plan returns it as `scheduled`, and stops there: nothing after it is queued before it
    airs.
  - `syncSchedule` sends `POST /v1/schedule` once per boot and body. It sends again after a
    restart, or when the item's body or time changes. It sends `DELETE /v1/schedule` when the
    log no longer starts that item hard.
  - In the last 5 s before T, the engine's copy of the same item is left alone: replacing it
    could open the gate on an empty slot.
  - The tail aims `cutOverlapMs` (500 ms) past the anchor, so the music never runs dry before T
    because of noise. The cut fades out that half second under the episode.
  - A `soft` tail aims the same 500 ms past its anchor: a soft item waits for the music's end,
    so aiming at the anchor would start it early half the time.
- An engine that answers 404 (rendered before #46) turns `engineCut` off: re-plan only, the
  ADR 0012 behaviour.
- Segments (island chains) are not scheduled. A hard island chain keeps the re-plan alone.

### Engine: `POST /v1/schedule`, `DELETE /v1/schedule` (template, contract, adapter)
- **Contract (additive):**
  - `engineScheduleSchema`: `{item_id, uri, at, fade_out?, cue_in?, cue_out?, fade_in?,
    amplify_db?, title?, artist?}`;
  - `engineUnscheduleResultSchema`;
  - `ENGINE_ROUTES.schedule`;
  - `GET /v1/state` `scheduled: {item_id, at} | null` (optional).
  - The adapter's `schedule` and `unschedule` are optional on `EngineAdapter`, so other test
    doubles still compile.
- **Template:** the spike's `HARDSTART` block, adapted:
  - a `request.queue` behind a `switch` gate, in a `fallback` above the automation and below
    live;
  - the gate opens on the audio timeline: `clock_origin + frame_pos ≥ at − 1.5 frames`,
    estimated in an `on_frame(before=true)` on that fallback;
  - the cut fades the automation out over `fade_out` and then skips it, aborting the
    interrupted queue segment and its voices.
- Three things the spike didn't hit, found by `pnpm test:engine:template`:
  - The gate must stay open while the item plays. Closing it on the item's first track (the
    spike's reset) hands the air straight back to the automation. `at` stays in the past until
    the next schedule, and the handler sets the new time *before* it pushes the request.
  - The outgoing side of the cut must lose its metadata (`quiet`). Otherwise the as-run sees the
    interrupted item start again.
  - The fallback must not replay metadata (`replay_metadata=false`): when the automation takes
    the air back after the item, its last (skipped) item would be reported again.
- **The scheduled item reports `source: queue`, not ADR 0003's `scheduled`.** It is a log item
  like any other. A new `engineSourceSchema` value would change the `track.started` payload
  that as-run, on-air and log-vs-as-run consume, for no gain: the feeder finds it on air by its
  `item_id`, as for a queued item.
- Events keep `time()` (10 ms resolution). The audio-timeline `at` of ADR 0003 is a separate
  change of the event envelope that no consumer needs yet: the gate uses the audio timeline
  inside the engine, which is what makes the start exact.

### Acceptance: two weeks of as-run, simulated (`feeder/hardstart.sim.test.ts`)
There are no two real weeks of as-run yet, so the test makes them.
- **The log:** two weeks from `hardStartSnapshot`, generated with back-timing:
  - shows at 07:00, 12:00 (soft, 30 s cap), 18:30 and 21:00;
  - hour clocks with a soft top-of-hour marker and a fill slot of beds;
  - each fortnight contains a DST change (from 2026-10-19 and from 2026-03-23).
- **The feeder:** the real `createStationFeeder` plays it into a model of the engine built on
  ADR 0003's measurements:
  - items last what was pushed, landing a frame either way of the plan now and then;
  - ~0.3 s of decoder and metadata error, 0.3 % of items several seconds off, 0.2 % skipped;
  - Node hears each start 45–60 ms late, rarely up to 0.8 s;
  - the gate opens on the frame nearest T, from a clock origin anywhere against the second;
  - an empty queue airs safety;
  - one engine restart 18 min before an evening show it had scheduled.
- The as-run entries are its audio-timeline starts.

Results (`SIM_REPORT=1` prints them), per fortnight:

| | Oct 19 – Nov 1 | Mar 23 – Apr 5 |
|---|---|---|
| Hard starts (41), error | max 8 ms, all within ±10 ms | max 1 ms |
| Music faded by the cut, p5 / p50 / p95 | 44 / 432 / 884 ms | 50 / 514 / 818 ms |
| Safety before a hard start | 5 (all after a skip, a wrong length or the restart, or < 1 s) | 3 |
| Soft starts (14), p50 / p95 late | 0.6 / 2.2 s | 0.7 / 2.1 s |
| Re-plan only (engine without `/v1/schedule`), hard \|error\| p50 | 51 ms (p5 −4.6 s: ADR 0012's 5 s hold window) | |

The test asserts, on both fortnights:
- every hard start within one frame (20 ms) of T: ADR 0003's target;
- no episode missing;
- soft starts at most their cap late, and early only after a disturbance since the previous
  hard start;
- the cut fades out 0–1.5 s of music (the tail arrives on its own);
- safety before a hard start only after a disturbance, or for less than a second.

The engine's own gate accuracy (≤ 1 ms on the recorded audio) is the spike's measurement. The
template test checks the mechanics: H starts at its time, G fades under it and doesn't resume.

## Consequences
- Every hour of a clock with a `fill` slot now ends with a sized bed before its marker, and the
  marker's conflict is null. A clock without one gets a whole jingle that fits, or keeps the
  residual. Stations that don't want hourly beds leave the fill slot out.
- **Early drift after a disturbance:** a skip or a wrong length leaves less audio than time.
  Each back-timed hour absorbs only its fill's headroom (15 s and up), so a big deficit reaches
  the next hard start as safety airplay before the cut. Adding audio at runtime (looping a bed,
  picking music in the feeder) was rejected: the feeder has no rules engine, and safety is
  already the station's chosen filler.
- The feeder pushes flexible items trimmed to their log slot. A log edit that shortens a song
  now airs shorter, as the timeline (#51) shows it.
- `@ondes/scheduling/testing` exports the hard-start station for other packages' tests.
- `test:engine:template` checks `POST`/`DELETE /v1/schedule`, the state, the as-run and the cut
  in the audio.
- Follow-ups:
  - audio-timeline event times (ADR 0003's envelope `at`, `audio_pos`);
  - scheduling a soft item with the engine at T + cap as a backstop (ADR 0003 "Markers", #52);
  - showing a slot's start policy on the show page.
