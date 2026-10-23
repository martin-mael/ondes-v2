import {
  type Executor,
  pickEpisode,
  type StationScope,
  show,
  station,
  whereStation,
} from '@ondes/db';
import { resolveClockAt } from '@ondes/scheduling';
import type { EpisodeFallbackKind, EpisodeFallbackPolicy, LogItemInput } from '@ondes/shared';
import { and, eq } from 'drizzle-orm';
import { loadClockGrid } from '../../clocks/grid-repo.ts';

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

/** #40's grid: the clock airing at `at` in the station's own timezone (DST-aware). */
export function gridClockResolver(db: Executor): ClockResolver {
  return async (scope, at) => {
    const [row] = await db
      .select({ timezone: station.timezone })
      .from(station)
      .where(and(eq(station.id, scope.stationId), eq(station.orgId, scope.orgId)));
    if (!row) return null;
    return resolveClockAt(await loadClockGrid(db, scope), at, row.timezone).clockId;
  };
}

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
    case 'episode':
    case 'latest_episode': {
      // The chosen episode if it still has audio, else the latest one (#48's `pickEpisode`,
      // shared with rerun slots).
      const picked = await pickEpisode(db, scope, {
        showId: request.showId,
        strategy: policy,
        episodeId: row.episodeId,
        excludeEpisodeId: request.missingEpisodeId,
        occurrenceDate: request.occurrenceDate,
        startsAt: request.startsAt,
      });
      return {
        policy,
        fallback: picked
          ? { kind: picked.kind, episodeId: picked.episodeId, assetId: picked.assetId }
          : null,
      };
    }
  }
}
