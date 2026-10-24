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
import { and, asc, eq, gt, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { getOccurrences } from '../shows/repo.ts';

// What a connected DJ may do right now (#65, ADR 0033), in this order:
// 1. `slot`: a live slot of one of their shows is running; or starts within
//    `LIVE_EARLY_CONNECT_MS` and its early-connect behaviour is `go_live`;
// 2. `event`: an event that lists them is running; or one listing nobody, if their ad-hoc
//    policy is `allowed` (an open event doesn't override the approval gate);
// 3. `waiting`: a live slot or listed event of theirs starts within `LIVE_EARLY_CONNECT_MS`
//    and they wait for its start (connected, not on air, not asking for anything);
// 4. `ad_hoc`: none of these; their streamer's ad-hoc policy decides (approval or allowed).
//    An `approval` DJ during an event listing nobody asks, and goes on air for that event.
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
/** `listed`: the event names this streamer (else it lists nobody: open to any streamer). */
export type LiveEventFor = LiveEventRef & { listed: boolean };

/** What a session is opened for: a slot occurrence or an event (neither: ad-hoc or manual). */
export type LiveBinding =
  | { kind: 'slot'; occurrence: LiveOccurrence }
  | { kind: 'event'; event: LiveEventRef };

export type Standing =
  /** May go on air now, for this; `since`: when the window opened (manual returns after it hold). */
  | { kind: 'slot' | 'event'; binding: LiveBinding; since: Date }
  | { kind: 'waiting' }
  /** `binding`: the open event (listing nobody) an approved request goes on air for. */
  | { kind: 'ad_hoc'; policy: LiveAdHocPolicy; binding: LiveBinding | null };

/** Who wins when several DJs may take the air: a slot before an event. */
export const STANDING_RANK: Record<Standing['kind'], number> = {
  slot: 0,
  event: 1,
  waiting: 2,
  ad_hoc: 3,
};

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
): Promise<LiveEventFor[]> {
  const rows = await db
    .select({
      id: liveEvent.id,
      title: liveEvent.title,
      startsAt: liveEvent.startsAt,
      endsAt: liveEvent.endsAt,
      listed: sql<boolean>`exists (select 1 from ${liveEventStreamer} where ${liveEventStreamer.eventId} = ${liveEvent.id} and ${liveEventStreamer.streamerId} = ${streamerId})`,
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
  const [row] = await db
    .select({ adHoc: streamer.adHoc })
    .from(streamer)
    .where(and(eq(streamer.id, streamerId), eq(streamer.stationId, scope.stationId)));
  const policy = row?.adHoc ?? 'approval';
  const ref = ({ listed: _, ...event }: LiveEventFor): LiveBinding => ({ kind: 'event', event });
  const all = await eventsFor(db, scope, streamerId, at);
  // An event listing nobody counts only for DJs who may go on air ad hoc anyway.
  const events = all.filter((e) => e.listed || policy === 'allowed');
  const event = events.find((e) => e.startsAt.getTime() <= t);
  if (event) return { kind: 'event', binding: ref(event), since: event.startsAt };
  const early = slots.find((o) => o.earlyConnect === 'go_live');
  if (early) {
    return {
      kind: 'slot',
      binding: { kind: 'slot', occurrence: early },
      since: new Date(early.startsAt.getTime() - LIVE_EARLY_CONNECT_MS),
    };
  }
  if (slots.length || events.length) return { kind: 'waiting' };
  const open = all.find((e) => !e.listed && e.startsAt.getTime() <= t);
  return { kind: 'ad_hoc', policy, binding: open ? ref(open) : null };
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
