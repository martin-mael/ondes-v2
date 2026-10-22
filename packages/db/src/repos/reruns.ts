import type { LocalDate, RerunStrategy } from '@ondes/shared';
import { and, desc, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { asset } from '../schema/library.ts';
import { episode, showSlot } from '../schema/shows.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Which earlier episode airs again (#48, ADR 0028): a rerun slot's strategy, and the
// missing-episode fallback's `latest_episode` / `episode` policies (#47, ADR 0022), are the
// same choice. It lives here so the api (fallbacks, the occurrences read) and the worker's log
// generator (#50) resolve it with one query.

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
  /** The occurrence's original local date: episodes premiered before it count as aired. */
  occurrenceDate: LocalDate;
};

/** The episode a strategy airs at an occurrence, or null when nothing with audio qualifies. */
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
          ),
        );
      if (chosen) return { kind: 'episode', ...chosen };
    }
  }
  const latest = await latestAiredEpisode(db, scope, request);
  return latest ? { kind: 'latest_episode', ...latest } : null;
}

/**
 * The show's latest episode with audio that has already gone out: the highest number among
 * those aired, unscheduled, or planned for an earlier date. A ready premiere planned for a
 * later week is not burned as a rerun.
 */
export async function latestAiredEpisode(
  db: Executor,
  scope: StationScope,
  request: Pick<PickEpisodeRequest, 'showId' | 'excludeEpisodeId' | 'occurrenceDate'>,
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
        or(
          eq(episode.status, 'aired'),
          isNull(episode.occurrenceDate),
          lt(episode.occurrenceDate, request.occurrenceDate),
        ),
      ),
    )
    .orderBy(desc(episode.number))
    .limit(1);
  return row ?? null;
}

/**
 * What a rerun slot's occurrence airs (the log generator's entry point): the slot's strategy
 * (none stored means `latest_episode`), picked at the occurrence's date. Null when the slot is
 * gone or isn't a rerun slot, or nothing with audio can air yet.
 */
export async function resolveRerun(
  db: Executor,
  scope: StationScope,
  request: { slotId: string; occurrenceDate: LocalDate },
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
  });
}
