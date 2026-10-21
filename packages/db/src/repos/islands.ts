import { randomUUID } from 'node:crypto';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import { and, eq, inArray } from 'drizzle-orm';
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
 * them; none means there is nothing to render (already rendered, or the spec changed).
 */
export async function claimIslandRender(
  db: Executor,
  scope: StationScope,
  hash: string,
  publish?: PublishEvent,
): Promise<IslandRow[]> {
  const rows = await db
    .update(island)
    .set({ status: 'rendering', error: null })
    .where(
      and(
        whereStation(island, scope),
        eq(island.hash, hash),
        inArray(island.status, ['pending', 'failed']),
      ),
    )
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
  input: { hash: string; storageKey: string; renderedAt?: Date },
  publish?: PublishEvent,
): Promise<IslandRow[]> {
  const rows = await db
    .update(island)
    .set({
      status: 'ready',
      storageKey: input.storageKey,
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
