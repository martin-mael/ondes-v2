import {
  auditDiff,
  type Db,
  type Executor,
  liveEvent,
  liveEventStreamer,
  NotFoundError,
  type StationScope,
  streamer,
  type Tx,
  whereStation,
  withAudit,
} from '@ondes/db';
import {
  type CreateLiveEvent,
  createLiveEventSchema,
  type LiveEvent,
  type UpdateLiveEvent,
  updateLiveEventSchema,
} from '@ondes/shared';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { HttpError } from '../../plugins/errors.ts';
import type { StationContext } from './repo.ts';

// Live events (#65, ADR 0033): one-off live blocks with a title, not a show. The switcher puts
// their DJs on air at the start (`standing.ts`), the harbor auth callback lets them connect
// from 15 min before (`auth.ts`). Every function takes the station scope; mutations are
// audited (`live_event.*`).

type EventRow = typeof liveEvent.$inferSelect;

async function toEvents(db: Executor, rows: EventRow[]): Promise<LiveEvent[]> {
  if (!rows.length) return [];
  const links = await db
    .select({
      eventId: liveEventStreamer.eventId,
      id: streamer.id,
      displayName: streamer.displayName,
    })
    .from(liveEventStreamer)
    .innerJoin(streamer, eq(streamer.id, liveEventStreamer.streamerId))
    .where(
      inArray(
        liveEventStreamer.eventId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(streamer.displayName));
  return rows.map((r) => ({
    id: r.id,
    stationId: r.stationId,
    title: r.title,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    streamers: links
      .filter((l) => l.eventId === r.id)
      .map((l) => ({ id: l.id, displayName: l.displayName })),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function eventRow(db: Executor, scope: StationScope, eventId: string) {
  const [row] = await db
    .select()
    .from(liveEvent)
    .where(and(eq(liveEvent.id, eventId), whereStation(liveEvent, scope)));
  if (!row) throw new NotFoundError('live_event', eventId);
  return row;
}

async function streamerIdsOf(db: Executor, eventId: string): Promise<string[]> {
  const rows = await db
    .select({ id: liveEventStreamer.streamerId })
    .from(liveEventStreamer)
    .where(eq(liveEventStreamer.eventId, eventId));
  return rows.map((r) => r.id).sort();
}

async function setStreamers(tx: Tx, scope: StationScope, eventId: string, ids: string[]) {
  if (ids.length) {
    const found = await tx
      .select({ id: streamer.id })
      .from(streamer)
      .where(and(inArray(streamer.id, ids), whereStation(streamer, scope)));
    if (found.length !== ids.length) {
      throw new HttpError(422, 'invalid_streamer', 'a streamer is not one of this station');
    }
  }
  await tx
    .delete(liveEventStreamer)
    .where(and(eq(liveEventStreamer.eventId, eventId), whereStation(liveEventStreamer, scope)));
  if (ids.length) {
    await tx.insert(liveEventStreamer).values(
      ids.map((streamerId) => ({
        eventId,
        streamerId,
        orgId: scope.orgId,
        stationId: scope.stationId,
      })),
    );
  }
}

/** Events not over at `at`, by start. */
export async function listEvents(
  db: Executor,
  scope: StationScope,
  at = new Date(),
): Promise<LiveEvent[]> {
  const rows = await db
    .select()
    .from(liveEvent)
    .where(and(whereStation(liveEvent, scope), gt(liveEvent.endsAt, at)))
    .orderBy(asc(liveEvent.startsAt));
  return toEvents(db, rows);
}

export async function getEvent(
  db: Executor,
  scope: StationScope,
  eventId: string,
): Promise<LiveEvent> {
  const [out] = await toEvents(db, [await eventRow(db, scope, eventId)]);
  return out as LiveEvent;
}

export async function createEvent(
  db: Db,
  ctx: StationContext,
  input: CreateLiveEvent,
): Promise<LiveEvent> {
  const body = createLiveEventSchema.parse(input);
  const id = await withAudit(db, ctx, async (tx, audit) => {
    const [row] = await tx
      .insert(liveEvent)
      .values({
        orgId: ctx.scope.orgId,
        stationId: ctx.scope.stationId,
        title: body.title,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
      })
      .returning();
    if (!row) throw new Error('insert returned nothing');
    const streamerIds = body.streamerIds ?? [];
    await setStreamers(tx, ctx.scope, row.id, streamerIds);
    await audit({
      action: 'live_event.create',
      entity: { type: 'live_event', id: row.id },
      diff: { ...auditDiff(null, row), streamerIds: { from: null, to: [...streamerIds].sort() } },
    });
    return row.id;
  });
  return getEvent(db, ctx.scope, id);
}

export async function updateEvent(
  db: Db,
  ctx: StationContext,
  eventId: string,
  input: UpdateLiveEvent,
): Promise<LiveEvent> {
  const { streamerIds, ...fields } = updateLiveEventSchema.parse(input);
  await withAudit(db, ctx, async (tx, audit) => {
    const before = await eventRow(tx, ctx.scope, eventId);
    const startsAt = fields.startsAt ?? before.startsAt;
    const endsAt = fields.endsAt ?? before.endsAt;
    if (endsAt <= startsAt || endsAt.getTime() - startsAt.getTime() > 24 * 3600 * 1000) {
      throw new HttpError(422, 'invalid_span', 'an event ends after it starts, at most 24 h later');
    }
    let after = before;
    if (Object.values(fields).some((v) => v !== undefined)) {
      const [row] = await tx
        .update(liveEvent)
        .set(fields)
        .where(and(eq(liveEvent.id, eventId), whereStation(liveEvent, ctx.scope)))
        .returning();
      if (!row) throw new NotFoundError('live_event', eventId);
      after = row;
    }
    const diff = auditDiff(before, after);
    if (streamerIds !== undefined) {
      const previous = await streamerIdsOf(tx, eventId);
      await setStreamers(tx, ctx.scope, eventId, streamerIds);
      const next = [...streamerIds].sort();
      if (previous.join() !== next.join()) diff.streamerIds = { from: previous, to: next };
    }
    await audit({ action: 'live_event.update', entity: { type: 'live_event', id: eventId }, diff });
  });
  return getEvent(db, ctx.scope, eventId);
}

/** A session already on air for it carries on; the event's title stays on its as-run. */
export async function deleteEvent(db: Db, ctx: StationContext, eventId: string): Promise<void> {
  await withAudit(db, ctx, async (tx, audit) => {
    const before = await eventRow(tx, ctx.scope, eventId);
    await tx
      .delete(liveEvent)
      .where(and(eq(liveEvent.id, eventId), whereStation(liveEvent, ctx.scope)));
    await audit({
      action: 'live_event.delete',
      entity: { type: 'live_event', id: eventId },
      diff: auditDiff(before, null),
    });
  });
}
