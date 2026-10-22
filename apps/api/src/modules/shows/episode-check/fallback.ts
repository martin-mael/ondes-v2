import { asset, type Executor, episode, type StationScope, show, whereStation } from '@ondes/db';
import type { EpisodeFallbackKind, EpisodeFallbackPolicy, LogItemInput } from '@ondes/shared';
import { and, desc, eq, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';

// What airs in place of a missing episode (#47, ADR 0022). Read by the episode check when it
// applies a fallback, and meant for the log generator (#50): a generator that plans an
// occurrence whose episode has no audio calls `resolveFallback` and plans what it returns.

/**
 * The clock that covers a UTC instant on the station's grid (#40's `resolveClock`). The
 * integration wires it; null means no grid, or a gap in it.
 */
export type ClockResolver = (scope: StationScope, at: Date) => Promise<string | null>;

/**
 * Music from a clock to fill `[startsAt, startsAt + durationMs)`: the log generator's (#50)
 * job. Returns the items in air order (the first one takes the empty item's place and its
 * timing), or null when it can't fill it.
 */
export interface ClockMusicSource {
  fill(
    scope: StationScope,
    request: { clockId: string; startsAt: Date; durationMs: number },
  ): Promise<LogItemInput[] | null>;
}

/** Until #50 exists, clock music isn't available: the slot is left to the safety playlist. */
export const noClockMusic: ClockMusicSource = { fill: async () => null };
export const noClockResolver: ClockResolver = async () => null;

export type FallbackDeps = { resolveClock: ClockResolver; clockMusic: ClockMusicSource };

export type ResolvedFallback =
  | {
      kind: Extract<EpisodeFallbackKind, 'latest_episode' | 'episode'>;
      episodeId: string;
      assetId: string;
    }
  | { kind: 'clock_music'; clockId: string; items: LogItemInput[] };

export type FallbackRequest = {
  showId: string;
  /** The missing premiere, never chosen as its own fallback. */
  missingEpisodeId: string | null;
  /** The occurrence's original local date: episodes premiered before it count as aired. */
  occurrenceDate: string;
  startsAt: Date;
  durationMs: number;
};

/** The show's policy, then what it resolves to now; null when nothing can air. */
export async function resolveFallback(
  db: Executor,
  scope: StationScope,
  request: FallbackRequest,
  deps: FallbackDeps,
): Promise<{ policy: EpisodeFallbackPolicy; fallback: ResolvedFallback | null }> {
  const [row] = await db
    .select({ policy: show.fallbackPolicy, episodeId: show.fallbackEpisodeId })
    .from(show)
    .where(and(whereStation(show, scope), eq(show.id, request.showId)));
  if (!row) return { policy: 'none', fallback: null };
  const { policy } = row;
  switch (policy) {
    case 'none':
      return { policy, fallback: null };
    case 'clock_music': {
      const clockId = await deps.resolveClock(scope, request.startsAt);
      const items = clockId
        ? await deps.clockMusic.fill(scope, {
            clockId,
            startsAt: request.startsAt,
            durationMs: request.durationMs,
          })
        : null;
      return {
        policy,
        fallback: clockId && items?.length ? { kind: 'clock_music', clockId, items } : null,
      };
    }
    case 'episode': {
      // The chosen episode, if it still has audio; else the latest one, like the default.
      if (row.episodeId && row.episodeId !== request.missingEpisodeId) {
        const [chosen] = await db
          .select({ id: episode.id, assetId: episode.assetId })
          .from(episode)
          .where(
            and(
              whereStation(episode, scope),
              eq(episode.id, row.episodeId),
              eq(episode.showId, request.showId),
            ),
          );
        if (chosen?.assetId) {
          return {
            policy,
            fallback: { kind: 'episode', episodeId: chosen.id, assetId: chosen.assetId },
          };
        }
      }
      const latest = await latestEpisode(db, scope, request);
      return { policy, fallback: latest ? { kind: 'latest_episode', ...latest } : null };
    }
    case 'latest_episode': {
      const latest = await latestEpisode(db, scope, request);
      return { policy, fallback: latest ? { kind: 'latest_episode', ...latest } : null };
    }
  }
}

/**
 * The show's latest episode with audio that has already gone out: the highest number among
 * those aired, unscheduled, or planned for an earlier date. A ready premiere planned for a
 * later week is not burned as a rerun.
 */
async function latestEpisode(
  db: Executor,
  scope: StationScope,
  request: FallbackRequest,
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
        request.missingEpisodeId ? ne(episode.id, request.missingEpisodeId) : undefined,
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
