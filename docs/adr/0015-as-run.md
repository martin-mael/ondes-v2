# ADR 0015: As-run log from engine events

- Status: accepted
- Date: 2026-10-21
- Issue: #30. Builds on ADR 0002 (engine control and its as-run events) and 0006 (durable
  event consumers).

## Context
The log is the plan; the as-run is what really aired. Rotation rules (#38), analytics (#42),
log vs as-run (#53), now playing (#74) and royalty reports read it, so it must be complete,
never rewritten, and cheap to query by time, asset and artist. The engine reports what went
on air as `track.started` / `track.ended` (ADR 0002), delivered at least once, in order per
boot, with deterministic event ids from (station, boot, seq).

## Decision
- **One append-only row per item on air** (`asrun_entry`). It is inserted on `track.started`.
  Afterwards its end is set once, in one update: `ended_at`, `duration_ms`, `outcome`, and
  `end_seq` (null when a restart closed it). Nothing else ever changes. The log item, segment,
  asset, file sha, titles, `artists[]` and plan (`planned_start`, `planned_duration_ms`) are
  snapshots without foreign keys, so history survives a regenerated log day or a deleted asset.
  Ids that aren't the station's own are not stored as references; the raw engine id stays in
  `engine_item_id`.
- **Recorded from a durable queue**, `asrun` (`consumeEventsDurable`, ADR 0006), keyed by
  station. A failing event blocks its station until it succeeds or is given up, so an end
  never overtakes its start. Writes are idempotent: unique on the start event id and on
  (station, boot, seq). A redelivery changes nothing and republishes the same `asrun.*` event
  (same id), so an event lost between commit and publish is sent again.
- **Engine clock.** `started_at` is the `track.started` time; `ended_at` is the end event's
  `started_at + played`. Both are on the engine's clock, in UTC. `recorded_at` is the api's.
- **Outcome thresholds:**
  - `complete`: within 2 s of the planned length, or no plan. 2 s covers crossfade jitter
    and the up to 2 s lag of `track.started` behind a fade-in (ADR 0002).
  - `cut`: shorter than that.
  - `skipped`: under 5 s on air while it should have played longer.

  The engine doesn't say why an item ended, so these are a reading of the times, not a cause.
- **`interrupted`**: an entry still open when the station's engine boots again (or when a
  `track.started` of a new boot arrives) never got its `track.ended`. It ends at the new
  boot's time, an upper bound, never before its own start. A wrong engine clock can step back.
- **Lost starts.** A `track.ended` with no open entry records the whole entry from the end
  event.
- **Permission** `log:read`, for both the API (`GET …/asrun`) and the `asrun.*` events: whoever
  reads the plan reads what aired. No new resource.
- **No retention policy.** Entries are kept while the station exists. Royalty societies and
  regulators can ask years later (`docs/research/07-compliance-royalties-logging.md`). A
  policy, if one is ever needed, is per tenant and comes with an export.
- **No audit rows.** Entries are written from engine events, not through an API mutation, so
  they carry no `audit_log` row. The entry is its own record (boot, seq, event id).

## Consequences
- Readers query by `(station_id, started_at)`, `(station_id, asset_id, started_at)` and the
  GIN index on `artists`. The helpers are in `apps/api/src/modules/asrun/index.ts`.
- Items the feeder never aired have no entry. #53 shows them as planned without an as-run;
  the feeder's own event (#29) gives the reason.
- `live_session_id` comes from the optional `live_session_id` on `track.started` (additive to
  the ADR 0002 contract). The template sends it once Node passes a session id when it opens
  the gate (#62); until then it stays null.
- Append-only is enforced by the repository (`where ended_at is null`), not by a trigger.
