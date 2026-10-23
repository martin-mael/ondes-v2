# As-run (#30)

What actually aired, one `asrun_entry` row per item that took the air. The log is the plan;
the as-run is the record that rotation rules (#38), analytics (#42), log vs as-run (#53) and
now playing (#74) read.

## Recording
Engine track events (#28, ADR 0002) reach `recorder.ts` through the durable `asrun` event
queue (`consumeEventsDurable`, ADR 0006): one api replica at a time, in order per station,
kept while the api restarts. The SSE fanout is never used for this.

| Event | Effect |
|---|---|
| `engine.track.started` | Insert the entry (unique on the event id, which is deterministic from station, boot and seq). Close entries of earlier boots first. |
| `engine.track.ended` | Set the end of the open entry with the same boot, source and log item, started within 2 s of `startedAt`. If the start was lost, insert the whole entry. |
| `engine.booted` | Close entries of earlier boots still on air: `interrupted`, ending at the boot time (an upper bound). |

Redelivered events change nothing; they republish the same `asrun.*` event (same id), so a
publish lost after the commit is sent again. A failing event blocks its station until it
succeeds or is given up (the queue fix of #146), so an end never overtakes its start. Each write publishes `asrun.started`
or `asrun.ended` (data = the entry, permission `log:read`).

Decisions: ADR 0015.

**Append-only.** A row is inserted once; afterwards its end is set once, in one update
(`where ended_at is null`): `ended_at`, `duration_ms`, `outcome`, and `end_seq` (null when a
restart closed it). Log item and segment ids are kept only when they are the station's own;
the raw engine id is `engine_item_id`, which also matches the end. The log item, segment,
asset, file sha, titles and plan (`planned_start`, `planned_duration_ms`) are snapshots taken
when it started, with no foreign keys: history survives a regenerated log day or a deleted
asset. Deleting a station deletes its history.

**What is resolved at start:**
- the log item (kind, plan, asset) from `itemId`;
- the file sha from the cache path (`media/ab/<sha256>.flac`, ADR 0004), else the asset's
  playout file. A safety or unplanned file finds its asset by that sha;
- title and artist as aired: the engine's metadata, else the log item and the asset;
- `artists`: the asset's artists array, for artist rules.

**Times.** `started_at` / `ended_at` are on the engine's clock, in UTC (`started_at` = the
`track.started` time; `ended_at` = the end event's `started_at + played`). `recorded_at` is the api's clock. `driftMs` in the API is
`startedAt − plannedStart`.

**Outcome** (`asRunOutcome` in the contract): `complete` (within 2 s of the planned length,
or no plan), `cut` (ended early), `skipped` (left the air in under 5 s while it should have
played longer), `interrupted` (the engine restarted).

**Live.** `source = live` entries come from the engine's live takeover. `live_session_id` is
the optional `live_session_id` of `track.started` (added to the engine contract by #30); the
template sends it once #62 passes a session id with the live gate, null until then.

**Retention.** None: the as-run is kept as long as the station exists (royalty disputes and
regulators can ask years later, see `docs/research/07-compliance-royalties-logging.md`).

## API
`GET /api/v1/stations/:stationId/asrun` (`log:read`), see `listAsRunQuerySchema`:
- `from` + `to` (≤ 31 days), or `date`: the station-local day (23–25 h around DST);
- `assetId`, `source`; `order=asc|desc`; `limit` (≤ 500), `cursor` (`nextCursor`).

`GET /api/v1/stations/:stationId/asrun/overlay?date` (`log:read`, #53): the station-local day's
plan with what aired laid over it, one row per entry plus one per plan item that never aired:
`aired`, `replaced`, `fallback`, `missed`, `pending`, `live`, `safety`, `emergency`,
`unplanned`, `transition` (`asRunOverlaySchema`). Matching (`overlay.ts`, pure): by log item id,
live entries by the live slot they overlap, rendered islands (#57) as the transition between
their items, the rest off-plan. Decisions: ADR 0029.

## For later consumers (`index.ts`)
- `lastAiredByAsset(db, scope, assetIds, before)`, `lastAiredByArtist(db, scope, artists, since, before)` (#38);
- `getOnAir(db, scope)` (#74);
- indexes: `(station_id, started_at)`, `(station_id, asset_id, started_at)`, GIN on `artists`,
  `log_item_id` (#53), open entries per boot.
