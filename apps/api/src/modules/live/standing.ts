import {
  type Executor,
  liveEvent,
  liveEventStreamer,
  liveSession,
  type StationScope,
  streamer,
  streamerShow,
} from '@ondes/db';
import { LIVE_EARLY_CONNECT_MS, type LiveAdHocPolicy, type LocalDate } from '@ondes/shared';
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { getOccurrences } from '../shows/repo.ts';

// What a connected DJ may do right now (#65, ADR 0033), in this order:
// 1. `slot`: a live slot of one of their shows is running; or starts within
//    `LIVE_EARLY_CONNECT_MS` and its early-connect behaviour is `go_live`;
// 2. `event`: an event they're on (or one listing nobody) is running;
// 3. `waiting`: a live slot or event of theirs starts within `LIVE_EARLY_CONNECT_MS` and they
//    wait for its start (connected, not on air, not asking for anything);
// 4. `ad_hoc`: none of these; their streamer's ad-hoc policy decides (approval or allowed).
// Reruns never count (ADR 0023). Slot times are the shows module's occurrences: station time
// and DST included.

export type LiveOccurrence = {
  showId: string;
  showName: string;
  slotId: string;
  date: LocalDate;
  startsAt: Date;
  endsAt: Date;
};

export type LiveEventRef = { id: string; title: string; startsAt: Date; endsAt: Date };

/** What a session is opened for: a slot occurrence or an event (neither: ad-hoc or manual). */
export type LiveBinding =
  | { kind: 'slot'; occurrence: LiveOccurrence }
  | { kind: 'event'; event: LiveEventRef };

export type Standing =
  /** May go on air now, for this; `since`: when the window opened (manual returns after it hold). */
  | { kind: 'slot' | 'event'; binding: LiveBinding; since: Date }
  | { kind: 'waiting' }
  | { kind: 'ad_hoc'; policy: LiveAdHocPolicy };

/** The live slots of the streamer's shows overlapping `[at, at + LIVE_EARLY_CONNECT_MS)`. */
async function liveOccurrences(
  db: Executor,
  scope: StationScope,
  streamerId: string,
  at: Date,
): Promise<(LiveOccurrence & { earlyConnect: 'wait' | 'go_live' })[]> {
  const allowed = await db
    .select({ showId: streamerShow.showId })
    .from(streamerShow)
    .where(
      and(eq(streamerShow.streamerId, streamerId), eq(streamerShow.stationId, scope.stationId)),
    );
  if (!allowed.length) return [];
  const showIds = new Set(allowed.map((a) => a.showId));
  const { occurrences } = await getOccurrences(db, scope, {
    from: at,
    to: new Date(at.getTime() + LIVE_EARLY_CONNECT_MS),
  });
  return occurrences
    .filter((o) => o.type === 'live' && showIds.has(o.show.id))
    .map((o) => ({
      showId: o.show.id,
      showName: o.show.name,
      slotId: o.slotId,
      date: o.date,
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      earlyConnect: o.live?.earlyConnect ?? 'wait',
    }));
}

/** Events the streamer may go on air in, overlapping `[at, at + LIVE_EARLY_CONNECT_MS)`. */
export async function eventsFor(
  db: Executor,
  scope: StationScope,
  streamerId: string,
  at: Date,
): Promise<LiveEventRef[]> {
  const rows = await db
    .select({
      id: liveEvent.id,
      title: liveEvent.title,
      startsAt: liveEvent.startsAt,
      endsAt: liveEvent.endsAt,
    })
    .from(liveEvent)
    .where(
      and(
        eq(liveEvent.stationId, scope.stationId),
        gt(liveEvent.endsAt, at),
        lte(liveEvent.startsAt, new Date(at.getTime() + LIVE_EARLY_CONNECT_MS)),
        // Its streamers, or anyone when it lists none.
        or(
          sql`not exists (select 1 from ${liveEventStreamer} where ${liveEventStreamer.eventId} = ${liveEvent.id})`,
          sql`exists (select 1 from ${liveEventStreamer} where ${liveEventStreamer.eventId} = ${liveEvent.id} and ${liveEventStreamer.streamerId} = ${streamerId})`,
        ),
      ),
    )
    .orderBy(asc(liveEvent.startsAt));
  return rows;
}

export async function standingOf(
  db: Executor,
  scope: StationScope,
  streamerId: string,
  at: Date,
): Promise<Standing> {
  const t = at.getTime();
  const slots = await liveOccurrences(db, scope, streamerId, at);
  const running = slots.find((o) => o.startsAt.getTime() <= t && o.endsAt.getTime() > t);
  if (running) {
    return {
      kind: 'slot',
      binding: { kind: 'slot', occurrence: running },
      since: running.startsAt,
    };
  }
  const events = await eventsFor(db, scope, streamerId, at);
  const event = events.find((e) => e.startsAt.getTime() <= t);
  if (event) return { kind: 'event', binding: { kind: 'event', event }, since: event.startsAt };
  const early = slots.find((o) => o.earlyConnect === 'go_live');
  if (early) {
    return {
      kind: 'slot',
      binding: { kind: 'slot', occurrence: early },
      since: new Date(early.startsAt.getTime() - LIVE_EARLY_CONNECT_MS),
    };
  }
  if (slots.length || events.length) return { kind: 'waiting' };
  const [row] = await db
    .select({ adHoc: streamer.adHoc })
    .from(streamer)
    .where(and(eq(streamer.id, streamerId), eq(streamer.stationId, scope.stationId)));
  return { kind: 'ad_hoc', policy: row?.adHoc ?? 'approval' };
}

/**
 * Someone handed the air back to automation (a manual return, or a gate closed by hand) since
 * `since` and the DJ hasn't logged in again after it: the automatic takeover must not undo it
 * (ADR 0027). A new login (`last_connected_at`) lifts it; so does the next slot or event.
 */
export async function returnedSince(
  db: Executor,
  scope: StationScope,
  streamerId: string,
  since: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: liveSession.id })
    .from(liveSession)
    .innerJoin(streamer, eq(streamer.id, liveSession.streamerId))
    .where(
      and(
        eq(liveSession.stationId, scope.stationId),
        eq(liveSession.streamerId, streamerId),
        eq(liveSession.endReason, 'returned'),
        gte(liveSession.endedAt, since),
        or(
          isNull(streamer.lastConnectedAt),
          sql`${streamer.lastConnectedAt} <= ${liveSession.endedAt}`,
        ),
      ),
    )
    .limit(1);
  return !!row;
}

/** Whether a DJ ever went on air in this occurrence (any session bound to it). */
export async function occurrencesWithSessions(
  db: Executor,
  scope: StationScope,
  keys: { slotId: string; date: LocalDate }[],
): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const rows = await db
    .selectDistinct({ slotId: liveSession.slotId, date: liveSession.occurrenceDate })
    .from(liveSession)
    .where(
      and(
        eq(liveSession.stationId, scope.stationId),
        inArray(
          liveSession.slotId,
          keys.map((k) => k.slotId),
        ),
      ),
    );
  return new Set(rows.map((r) => `${r.slotId}/${r.date}`));
}
