import type { LocalDate, RerunStrategy } from '@ondes/shared';
import { and, desc, eq, isNotNull, isNull, lt, ne, or, type SQL } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { asset } from '../schema/library.ts';
import { episode, showSlot } from '../schema/shows.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Which earlier episode airs again (#48, ADR 0028): a rerun slot's strategy, and the
// missing-episode fallback's `latest_episode` / `episode` policies (#47, ADR 0022), are the
// same choice. It lives here so the api (fallbacks, the occurrences read) and the worker's log
// generator (#50) resolve it with one query.
//
// Only an episode that has aired by then can air again (`airedBy`): one the as-run marked
// `aired` before the occurrence starts, or one whose premiere is planned on an earlier date (it
// will have aired by the time the occurrence does, which lets a log planned days ahead rerun
// this week's episode). An unscheduled episode that never aired, a `missing` one, or one that
// premieres later never qualifies, under either strategy.

export type PickedEpisode = {
  /** `episode` when the chosen episode airs; `latest_episode` when the latest one does. */
  kind: RerunStrategy;
  episodeId: string;
  assetId: string;
};

export type PickEpisodeRequest = {
  showId: string;
  strategy: RerunStrategy;
  /** For `episode`: the chosen one. The latest airs instead when it has no audio or is gone. */
  episodeId: string | null;
  /** Never picked (a missing premiere isn't its own fallback). */
  excludeEpisodeId: string | null;
  /** The occurrence's original local date: episodes premiering before it count as aired. */
  occurrenceDate: LocalDate;
  /** When the occurrence starts: episodes the as-run marked aired before it count. */
  startsAt: Date;
};

/**
 * Has aired by an occurrence on `occurrenceDate` starting at `startsAt` (see the header). The
 * audio is checked by the callers' join on `asset`.
 */
export function airedBy(occurrenceDate: LocalDate, startsAt: Date): SQL {
  return or(
    and(eq(episode.status, 'aired'), or(isNull(episode.airedAt), lt(episode.airedAt, startsAt))),
    and(
      eq(episode.status, 'ready'),
      isNotNull(episode.occurrenceDate),
      lt(episode.occurrenceDate, occurrenceDate),
    ),
  ) as SQL;
}

/** The episode a strategy airs at an occurrence, or null when no aired episode qualifies. */
export async function pickEpisode(
  db: Executor,
  scope: StationScope,
  request: PickEpisodeRequest,
): Promise<PickedEpisode | null> {
  if (request.strategy === 'episode' && request.episodeId) {
    if (request.episodeId !== request.excludeEpisodeId) {
      const [chosen] = await db
        .select({ episodeId: episode.id, assetId: asset.id })
        .from(episode)
        .innerJoin(asset, eq(asset.id, episode.assetId))
        .where(
          and(
            whereStation(episode, scope),
            eq(episode.id, request.episodeId),
            eq(episode.showId, request.showId),
            airedBy(request.occurrenceDate, request.startsAt),
          ),
        );
      if (chosen) return { kind: 'episode', ...chosen };
    }
  }
  const latest = await latestAiredEpisode(db, scope, request);
  return latest ? { kind: 'latest_episode', ...latest } : null;
}

/**
 * The show's latest episode with audio that has aired by the occurrence (`airedBy`): the
 * highest number. A ready premiere planned for a later week is not burned as a rerun.
 */
export async function latestAiredEpisode(
  db: Executor,
  scope: StationScope,
  request: Pick<PickEpisodeRequest, 'showId' | 'excludeEpisodeId' | 'occurrenceDate' | 'startsAt'>,
): Promise<{ episodeId: string; assetId: string } | null> {
  const [row] = await db
    .select({ episodeId: episode.id, assetId: asset.id })
    .from(episode)
    .innerJoin(asset, eq(asset.id, episode.assetId))
    .where(
      and(
        whereStation(episode, scope),
        eq(episode.showId, request.showId),
        isNotNull(episode.assetId),
        request.excludeEpisodeId ? ne(episode.id, request.excludeEpisodeId) : undefined,
        airedBy(request.occurrenceDate, request.startsAt),
      ),
    )
    .orderBy(desc(episode.number))
    .limit(1);
  return row ?? null;
}

/**
 * What a rerun slot's occurrence airs (the log generator's entry point): the slot's strategy
 * (none stored means `latest_episode`), picked for the occurrence. Null when the slot is gone or
 * isn't a rerun slot, or no aired episode with audio qualifies yet.
 */
export async function resolveRerun(
  db: Executor,
  scope: StationScope,
  request: { slotId: string; occurrenceDate: LocalDate; startsAt: Date },
): Promise<PickedEpisode | null> {
  const [slot] = await db
    .select({
      showId: showSlot.showId,
      type: showSlot.type,
      strategy: showSlot.rerunStrategy,
      episodeId: showSlot.rerunEpisodeId,
    })
    .from(showSlot)
    .where(and(whereStation(showSlot, scope), eq(showSlot.id, request.slotId)));
  if (slot?.type !== 'rerun') return null;
  return pickEpisode(db, scope, {
    showId: slot.showId,
    strategy: slot.strategy ?? 'latest_episode',
    episodeId: slot.episodeId,
    excludeEpisodeId: null,
    occurrenceDate: request.occurrenceDate,
    startsAt: request.startsAt,
  });
}

/** Whether an episode of the show has aired by an occurrence (`airedBy`), with audio. */
export async function hasAiredBy(
  db: Executor,
  scope: StationScope,
  request: { episodeId: string; occurrenceDate: LocalDate; startsAt: Date },
): Promise<boolean> {
  const [row] = await db
    .select({ id: episode.id })
    .from(episode)
    .innerJoin(asset, eq(asset.id, episode.assetId))
    .where(
      and(
        whereStation(episode, scope),
        eq(episode.id, request.episodeId),
        airedBy(request.occurrenceDate, request.startsAt),
      ),
    );
  return row !== undefined;
}
