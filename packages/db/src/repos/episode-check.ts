import type { EpisodeCheckStep, LocalDate, SlotRule } from '@ondes/shared';
import { and, eq, gte, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { episode, episodeCheck, showSlot, showSlotException } from '../schema/shows.ts';
import { station } from '../schema/tenancy.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Missing-episode check queries (#47, ADR 0022), for the worker's `episode-check` job: the
// rows it expands, and recording the steps that are due. The api's side lives in
// apps/api/src/modules/shows/episode-check.

export type EpisodeCheckSlot = {
  id: string;
  showId: string;
  rule: SlotRule;
  durationMs: number;
  exceptions: (typeof showSlotException.$inferSelect)[];
};

export type EpisodeCheckInputs = {
  timezone: string;
  slots: EpisodeCheckSlot[];
};

/**
 * The station's pre-recorded slots that can air between the local dates `first` and `last`,
 * with their exceptions. Null when the station is gone.
 */
export async function episodeCheckSlots(
  db: Executor,
  scope: StationScope,
  window: (timezone: string) => { first: LocalDate; last: LocalDate },
): Promise<EpisodeCheckInputs | null> {
  const [s] = await db
    .select({ timezone: station.timezone })
    .from(station)
    .where(eq(station.id, scope.stationId));
  if (!s) return null;
  const { first, last } = window(s.timezone);
  const slots = await db
    .select({
      id: showSlot.id,
      showId: showSlot.showId,
      rule: showSlot.rule,
      durationMs: showSlot.durationMs,
    })
    .from(showSlot)
    .where(
      and(
        whereStation(showSlot, scope),
        eq(showSlot.type, 'prerecorded'),
        lte(showSlot.startsOn, last),
        or(isNull(showSlot.endsOn), gte(showSlot.endsOn, first)),
      ),
    );
  if (!slots.length) return { timezone: s.timezone, slots: [] };
  const exceptions = await db
    .select()
    .from(showSlotException)
    .where(
      and(
        whereStation(showSlotException, scope),
        inArray(
          showSlotException.slotId,
          slots.map((slot) => slot.id),
        ),
      ),
    );
  return {
    timezone: s.timezone,
    slots: slots.map((slot) => ({
      ...slot,
      exceptions: exceptions.filter((e) => e.slotId === slot.id),
    })),
  };
}

export type OccurrenceKey = { slotId: string; occurrenceDate: LocalDate };

/**
 * For these slots and dates: the premiere of each occurrence (`episodeId`, `hasAudio`) and the
 * steps already recorded, keyed `slotId:date`.
 */
export async function episodeCheckState(
  db: Executor,
  scope: StationScope,
  slotIds: string[],
  dates: LocalDate[],
): Promise<{
  premieres: Map<string, { episodeId: string; hasAudio: boolean }>;
  recorded: Map<string, Set<EpisodeCheckStep>>;
}> {
  const premieres = new Map<string, { episodeId: string; hasAudio: boolean }>();
  const recorded = new Map<string, Set<EpisodeCheckStep>>();
  if (!slotIds.length || !dates.length) return { premieres, recorded };
  const [episodes, steps] = await Promise.all([
    db
      .select({
        id: episode.id,
        slotId: episode.slotId,
        occurrenceDate: episode.occurrenceDate,
        assetId: episode.assetId,
      })
      .from(episode)
      .where(
        and(
          whereStation(episode, scope),
          isNotNull(episode.slotId),
          inArray(episode.slotId, slotIds),
          inArray(episode.occurrenceDate, dates),
        ),
      ),
    episodeChecksOf(db, scope, slotIds, dates),
  ]);
  for (const e of episodes) {
    premieres.set(`${e.slotId}:${e.occurrenceDate}`, { episodeId: e.id, hasAudio: !!e.assetId });
  }
  for (const r of steps) {
    const key = `${r.slotId}:${r.occurrenceDate}`;
    recorded.set(key, (recorded.get(key) ?? new Set()).add(r.step));
  }
  return { premieres, recorded };
}

/** Recorded steps of these slots (and dates, if given). */
export function episodeChecksOf(
  db: Executor,
  scope: StationScope,
  slotIds: string[],
  dates?: LocalDate[],
) {
  return db
    .select()
    .from(episodeCheck)
    .where(
      and(
        whereStation(episodeCheck, scope),
        inArray(episodeCheck.slotId, slotIds),
        dates ? inArray(episodeCheck.occurrenceDate, dates) : undefined,
      ),
    );
}

export type NewEpisodeCheck = Omit<
  typeof episodeCheck.$inferInsert,
  'id' | 'orgId' | 'stationId' | 'notified' | 'attempts' | 'createdAt'
>;

/** Records due steps; one already recorded (another pass got there first) is skipped. */
export async function recordEpisodeChecks(
  db: Executor,
  scope: StationScope,
  rows: NewEpisodeCheck[],
): Promise<{ slotId: string; occurrenceDate: string; step: EpisodeCheckStep }[]> {
  if (!rows.length) return [];
  return db
    .insert(episodeCheck)
    .values(rows.map((r) => ({ ...r, orgId: scope.orgId, stationId: scope.stationId })))
    .onConflictDoNothing()
    .returning({
      slotId: episodeCheck.slotId,
      occurrenceDate: episodeCheck.occurrenceDate,
      step: episodeCheck.step,
    });
}

/** Stations with a pre-recorded slot that may still air on or after `since`. */
export function episodeCheckStations(
  db: Executor,
  since: LocalDate,
): Promise<{ orgId: string; stationId: string }[]> {
  return db
    .selectDistinct({ orgId: showSlot.orgId, stationId: showSlot.stationId })
    .from(showSlot)
    .where(
      and(
        eq(showSlot.type, 'prerecorded'),
        or(isNull(showSlot.endsOn), gte(showSlot.endsOn, since)),
      ),
    );
}
