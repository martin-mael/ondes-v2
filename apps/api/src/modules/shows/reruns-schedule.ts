import {
  asset,
  type Db,
  episode,
  hasAiredBy,
  NotFoundError,
  show,
  showSlot,
  station,
  whereStation,
} from '@ondes/db';
import {
  type ScheduleRerun,
  SHOW_MAX_DURATION_MS,
  type ShowSlot,
  scheduleRerunSchema,
  zonedInstant,
} from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import { createSlot, type StationContext } from './repo.ts';

// "Schedule a rerun" (#48, ADR 0028): an episode that has aired airs again once, as a
// one-off `rerun` slot on that episode. The slot is an ordinary one afterwards: it shows in the
// grid, can be moved, cancelled or deleted, and the log generator plans it like any rerun slot.

const MINUTE_MS = 60_000;

/** Creates the one-off rerun slot (audited as `show_slot.create`). */
export async function scheduleRerun(
  db: Db,
  ctx: StationContext,
  showId: string,
  episodeId: string,
  input: ScheduleRerun,
): Promise<ShowSlot> {
  const parsed = scheduleRerunSchema.parse(input);
  const [row] = await db
    .select({
      assetId: episode.assetId,
      occurrenceDate: episode.occurrenceDate,
      slotDurationMs: showSlot.durationMs,
      showDurationMs: show.defaultDurationMs,
      assetDurationMs: asset.durationMs,
      timezone: station.timezone,
    })
    .from(episode)
    .innerJoin(show, eq(show.id, episode.showId))
    .innerJoin(station, eq(station.id, episode.stationId))
    .leftJoin(showSlot, eq(showSlot.id, episode.slotId))
    .leftJoin(asset, eq(asset.id, episode.assetId))
    .where(
      and(whereStation(episode, ctx.scope), eq(episode.id, episodeId), eq(episode.showId, showId)),
    );
  if (!row) throw new NotFoundError('episode', episodeId);
  if (!row.assetId) {
    throw new HttpError(422, 'no_audio', 'the episode has no audio to air again');
  }
  // Only an aired episode: marked aired before the rerun starts, or premiering on an earlier
  // date (ADR 0028), the rule the rerun slot itself resolves with.
  const startsAt = zonedInstant(parsed.date, parsed.time, row.timezone);
  const aired = await hasAiredBy(db, ctx.scope, {
    episodeId,
    occurrenceDate: parsed.date,
    startsAt,
  });
  if (!aired) {
    throw row.occurrenceDate && row.occurrenceDate >= parsed.date
      ? new HttpError(
          422,
          'before_premiere',
          `the episode premieres on ${row.occurrenceDate}; a rerun comes after it`,
        )
      : new HttpError(422, 'not_aired', 'only an episode that has aired can be rerun');
  }
  const durationMs =
    parsed.durationMs ??
    row.slotDurationMs ??
    row.showDurationMs ??
    (row.assetDurationMs
      ? Math.min(
          SHOW_MAX_DURATION_MS,
          Math.max(MINUTE_MS, Math.ceil(row.assetDurationMs / MINUTE_MS) * MINUTE_MS),
        )
      : null);
  if (durationMs === null) {
    throw new HttpError(422, 'duration_required', 'say how long the rerun lasts');
  }
  return createSlot(db, ctx, showId, {
    type: 'rerun',
    rule: { freq: 'once', date: parsed.date, time: parsed.time },
    durationMs,
    rerun: { strategy: 'episode', episodeId },
  });
}
