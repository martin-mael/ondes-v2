import { randomUUID } from 'node:crypto';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Executor } from '../client.ts';
import { island } from '../schema/segues.ts';
import { type StationScope, whereStation } from '../tenant.ts';

// Island render state (#55, ADR 0017), for the renderer (#56). Islands are derived by the api's
// sync, which rewrites a row's spec and hash whenever its segues or their media change, so every
// transition here is a compare-and-set **on the hash**: a render that finishes after the spec
// moved on changes nothing, and the row stays `pending` for the new hash. Rows that share a
// hash share the audio, so they move together. These are system state changes, not audited.

export type IslandRow = typeof island.$inferSelect;
export type PublishEvent = (event: RealtimeEvent) => Promise<void>;

/** `island.updated` for a row, as the api and the renderer publish it. */
export function islandUpdatedEvent(row: IslandRow): RealtimeEvent {
  return realtimeEventSchema.parse({
    id: randomUUID(),
    stationId: row.stationId,
    at: new Date().toISOString(),
    type: 'island.updated',
    data: {
      islandId: row.id,
      hash: row.hash,
      status: row.status,
      segueIds: row.segueIds,
      headItemId: row.headItemId,
      tailItemId: row.tailItemId,
    },
  });
}

async function publishRows(rows: IslandRow[], publish: PublishEvent | undefined) {
  if (!publish) return;
  for (const row of rows) await publish(islandUpdatedEvent(row));
}

/**
 * Claims the render of `hash`: its `pending` (or `failed`) rows become `rendering`. Returns
 * them; none means there is nothing to render (already rendered, or the spec changed). With
 * `staleAfterMs`, a `rendering` claim untouched for that long (a worker that died mid-render)
 * is taken over too.
 */
export async function claimIslandRender(
  db: Executor,
  scope: StationScope,
  hash: string,
  publish?: PublishEvent,
  options: { staleAfterMs?: number } = {},
): Promise<IslandRow[]> {
  const claimable = options.staleAfterMs
    ? or(
        inArray(island.status, ['pending', 'failed']),
        and(
          eq(island.status, 'rendering'),
          lt(island.updatedAt, staleBefore(options.staleAfterMs)),
        ),
      )
    : inArray(island.status, ['pending', 'failed']);
  const rows = await db
    .update(island)
    .set({ status: 'rendering', error: null })
    .where(and(whereStation(island, scope), eq(island.hash, hash), claimable))
    .returning();
  await publishRows(rows, publish);
  return rows;
}

/**
 * The file for `hash` is stored at `storageKey`: every row of the station that still has that
 * hash becomes `ready`. Returns the rows it changed; none when the spec changed meanwhile.
 */
export async function markIslandRendered(
  db: Executor,
  scope: StationScope,
  input: {
    hash: string;
    storageKey: string;
    /** The rendered file's own hash and size (#56): its playout cache key. */
    file?: { sha256: string; sizeBytes: number };
    renderedAt?: Date;
  },
  publish?: PublishEvent,
): Promise<IslandRow[]> {
  const rows = await db
    .update(island)
    .set({
      status: 'ready',
      storageKey: input.storageKey,
      fileSha256: input.file?.sha256 ?? null,
      fileSizeBytes: input.file?.sizeBytes ?? null,
      renderedAt: input.renderedAt ?? new Date(),
      error: null,
    })
    .where(
      and(
        whereStation(island, scope),
        eq(island.hash, input.hash),
        inArray(island.status, ['pending', 'rendering', 'failed']),
      ),
    )
    .returning();
  await publishRows(rows, publish);
  return rows;
}

/** The render of `hash` failed: its rows that still have that hash become `failed`. */
export async function markIslandFailed(
  db: Executor,
  scope: StationScope,
  input: { hash: string; error: string },
  publish?: PublishEvent,
): Promise<IslandRow[]> {
  const rows = await db
    .update(island)
    .set({ status: 'failed', error: input.error.slice(0, 2000) })
    .where(
      and(
        whereStation(island, scope),
        eq(island.hash, input.hash),
        inArray(island.status, ['pending', 'rendering']),
      ),
    )
    .returning();
  await publishRows(rows, publish);
  return rows;
}

const staleBefore = (ms: number) => sql`now() - make_interval(secs => ${ms / 1000})`;

/**
 * The hashes of the station's islands left to render (the renderer's sweep, #56): `pending`
 * ones not touched for `pendingAfterMs` (their job was lost, or never enqueued), and
 * `rendering` ones untouched for `staleAfterMs` (a worker died mid-render). Oldest first.
 */
export async function listIslandsToRender(
  db: Executor,
  scope: StationScope,
  options: { pendingAfterMs: number; staleAfterMs: number; limit?: number },
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ hash: island.hash, updatedAt: island.updatedAt })
    .from(island)
    .where(
      and(
        whereStation(island, scope),
        or(
          and(
            eq(island.status, 'pending'),
            lt(island.updatedAt, staleBefore(options.pendingAfterMs)),
          ),
          and(
            eq(island.status, 'rendering'),
            lt(island.updatedAt, staleBefore(options.staleAfterMs)),
          ),
        ),
      ),
    )
    .orderBy(island.updatedAt)
    .limit(options.limit ?? 100);
  return [...new Set(rows.map((r) => r.hash))];
}
