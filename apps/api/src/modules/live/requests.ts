import {
  type Db,
  type Executor,
  liveRequest,
  NotFoundError,
  type StationScope,
  streamer,
  type Tx,
  whereStation,
  writeAudit,
} from '@ondes/db';
import type { Actor, LiveRequest, LiveRequestStatus } from '@ondes/shared';
import { and, asc, eq } from 'drizzle-orm';

// Ad-hoc requests (#65, ADR 0033): a DJ whose streamer needs approval connected outside their
// slots and events, and a manager decides in the web app. One request per connection (the
// streamer's `last_connected_at` when it was raised), so a refused DJ isn't asked about again
// until they log in again. Raising is idempotent across api replicas (unique key); deciding
// claims the pending row (`where status = 'pending'`), so two managers can't both decide.

type RequestRow = typeof liveRequest.$inferSelect;

function toRequest(row: RequestRow, displayName: string): LiveRequest {
  return {
    id: row.id,
    streamer: { id: row.streamerId, displayName },
    input: row.input,
    status: row.status,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
  };
}

const withName = { request: liveRequest, displayName: streamer.displayName };

export async function listPending(db: Executor, scope: StationScope): Promise<LiveRequest[]> {
  const rows = await db
    .select(withName)
    .from(liveRequest)
    .innerJoin(streamer, eq(streamer.id, liveRequest.streamerId))
    .where(and(whereStation(liveRequest, scope), eq(liveRequest.status, 'pending')))
    .orderBy(asc(liveRequest.requestedAt));
  return rows.map((r) => toRequest(r.request, r.displayName));
}

export async function getRequest(
  db: Executor,
  scope: StationScope,
  requestId: string,
): Promise<LiveRequest & { connectedAt: Date }> {
  const [row] = await db
    .select(withName)
    .from(liveRequest)
    .innerJoin(streamer, eq(streamer.id, liveRequest.streamerId))
    .where(and(eq(liveRequest.id, requestId), whereStation(liveRequest, scope)));
  if (!row) throw new NotFoundError('live_request', requestId);
  return { ...toRequest(row.request, row.displayName), connectedAt: row.request.connectedAt };
}

/**
 * The request for this connection, raised if there was none. `created` is true only for the
 * replica that inserted it (it publishes the prompt); the others get the existing row.
 */
export async function raise(
  db: Db,
  scope: StationScope,
  request: { streamerId: string; input: number; connectedAt: Date },
  actor: Actor,
): Promise<{ request: LiveRequest; created: boolean } | null> {
  const [inserted] = await db
    .insert(liveRequest)
    .values({ orgId: scope.orgId, stationId: scope.stationId, ...request })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    await writeAudit(
      db,
      { actor, scope },
      {
        action: 'live_request.raise',
        entity: { type: 'live_request', id: inserted.id },
        diff: {
          streamerId: { from: null, to: request.streamerId },
          input: { from: null, to: request.input },
        },
      },
    );
  }
  const [row] = await db
    .select(withName)
    .from(liveRequest)
    .innerJoin(streamer, eq(streamer.id, liveRequest.streamerId))
    .where(
      and(
        whereStation(liveRequest, scope),
        eq(liveRequest.streamerId, request.streamerId),
        eq(liveRequest.input, request.input),
        eq(liveRequest.connectedAt, request.connectedAt),
      ),
    );
  return row ? { request: toRequest(row.request, row.displayName), created: !!inserted } : null;
}

/**
 * Decides a pending request (audited as `live_request.approve|refuse|cancel`). Null when it wasn't pending
 * any more: another manager or the sweep decided first.
 */
export async function decide(
  db: Db | Tx,
  ctx: { actor: Actor; scope: StationScope },
  requestId: string,
  status: Exclude<LiveRequestStatus, 'pending'>,
  at: Date,
): Promise<RequestRow | null> {
  const decidedBy = ctx.actor.type === 'user' ? ctx.actor.userId : null;
  const [row] = await db
    .update(liveRequest)
    .set({ status, decidedAt: at, decidedBy })
    .where(
      and(
        eq(liveRequest.id, requestId),
        whereStation(liveRequest, ctx.scope),
        eq(liveRequest.status, 'pending'),
      ),
    )
    .returning();
  if (!row) return null;
  await writeAudit(db, ctx, {
    action: `live_request.${status === 'approved' ? 'approve' : status === 'refused' ? 'refuse' : 'cancel'}`,
    entity: { type: 'live_request', id: requestId },
    diff: { status: { from: 'pending', to: status } },
  });
  return row;
}

/** Locks the request if it's still pending (`FOR UPDATE`), for an approval in progress. */
export async function lockPending(tx: Tx, scope: StationScope, requestId: string) {
  const [row] = await tx
    .select({ id: liveRequest.id })
    .from(liveRequest)
    .where(
      and(
        eq(liveRequest.id, requestId),
        whereStation(liveRequest, scope),
        eq(liveRequest.status, 'pending'),
      ),
    )
    .for('update');
  return !!row;
}

/** Pending requests of the station, raw (the sweep cancels the stale ones). */
export async function pendingRows(db: Executor, scope: StationScope): Promise<RequestRow[]> {
  return db
    .select()
    .from(liveRequest)
    .where(and(whereStation(liveRequest, scope), eq(liveRequest.status, 'pending')));
}
