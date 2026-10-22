# ADR 0020: Weekly clock grid, overrides and DST hours

- Status: accepted
- Date: 2026-10-22
- Issue: #40. Builds on ADR 0014 (show recurrence, time helpers). Read by #47 (missing-episode
  alerts), #50 (log generator).

## Context
Clocks (#39) are hour templates. The log generator needs to know which clock airs in every
hour, and programmers plan that as a week: weekday mornings, weekend nights, with exceptions
for holidays and special weeks. The station plans in its own wall-clock time (Europe/Paris for
Vandale), so two nights a year the week doesn't have 168 hours: the last Sunday of March loses
02:00–03:00, the last Sunday of October has it twice.

## Decision

### Model
- **Weekly cells**: one row per painted station-local hour (`clock_grid_cell`: ISO weekday
  1–7, hour 0–23, clock). An hour without a cell airs the station's **default clock**
  (`clock_grid.default_clock_id`). The cells and the default are saved together by
  `PUT …/clock-grid`, with optimistic concurrency on `clock_grid.version` (409
  `edit_conflict`), because the editor paints many cells and saves once.
- **Dayparts** (`daypart`): named ranges of hours on some weekdays, used to paint in bulk. They
  schedule nothing: painting a daypart writes cells in the editor's draft. A range whose end is
  not after its start runs past midnight into the next day (Sunday into Monday).
  `daypartCells` (shared contract) expands one, for the editor and tests alike.
- **Overrides** (`clock_grid_override`): a station-local date range (inclusive), an hour range
  each day (`[startHour, endHour)`, all day by default) and a clock. Saved one by one.

### Resolution
`resolveClock(grid, { date, hour })` in `@ondes/scheduling` (`src/grid`), pure:
1. an override covering the date and the hour, if any;
2. the hour's weekly cell;
3. the default clock;
4. otherwise `none` (only possible while no default clock is set; the editor warns).

With a default clock, every hour resolves to exactly one clock. Overlapping overrides: the one
with the **fewest days** wins (a one-evening special inside a holiday week), then the one that
**starts later**, then the one **created last** (uuidv7 ids). This is deterministic and
matches how programmers stack exceptions; a manual priority field would be one more thing to
get wrong.

Deleting a clock deletes its cells (those hours go back to the default) and nulls the default
and the overrides that used it. An override without a clock is ignored by resolution and
flagged in the editor, rather than silently deleted.

### DST: wall-clock hours, two rules
`resolveClock` is a lookup by wall-clock hour. Real time goes through `expandGrid(grid, range,
timeZone)` (every real hour overlapping a UTC range, each resolved) and `resolveClockAt(grid,
instant, timeZone)`:
- **The hour that doesn't exist is skipped.** On the last Sunday of March (Europe/Paris), there
  is no 02:00 block: 01:00 CET runs one real hour, then the 03 cell starts at 03:00 CEST. The 02
  cell doesn't air that night; the day has 23 blocks.
- **The hour that happens twice airs twice.** On the last Sunday of October, the 02 cell runs
  at 02:00 CEST and again at 02:00 CET (`repeated: true` on the second): the day has 25 blocks.
  Overrides apply to both by local date.

Every block runs until the next one starts, so the blocks tile time without gaps or overlaps.
This keeps the wall-clock grid honest (03:00 is always the 03 clock) and gives the log
generator exactly one clock per real hour. The alternatives were worse: shifting the 02 clock
into 03 on the spring night would push every later hour, and airing the October 02 clock once
would leave a real hour with no clock.

The repeated hour is detected by checking the instant an hour or half an hour after its first
start, so zones with half-hour shifts (Australia/Lord_Howe) work; half-hour offsets
(Asia/Kolkata) are tested.

### API
Under `/api/v1/stations/:stationId/clock-grid` (clocks module, `clock:read` / `clock:write`,
audited): `GET`, `PUT`, `GET /hours?from&days` (resolved hours, for the editor and debugging),
`POST|PATCH|DELETE /dayparts[/:id]`, `POST|PATCH|DELETE /overrides[/:id]`. `loadClockGrid(db,
scope)` (`grid-repo.ts`) gives the generator what `resolveClock` / `expandGrid` take.

## Consequences
- Partial clocks (shorter than an hour) still take a whole grid hour; packing several in one
  hour is the generator's business (#50).
- An override is a single clock over its hours; a special week with several clocks is several
  overrides.
- Grid edits that a clock deletion causes are audited as the clock's deletion only.
