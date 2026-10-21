import { createHash } from 'node:crypto';
import type { Db, StationScope } from '@ondes/db';
import {
  type AsRunEntry,
  type AsRunRealtimeEvent,
  type RealtimeEvent,
  realtimeEventSchema,
} from '@ondes/shared';
import type { Logger } from '../engine/adapter/index.ts';
import * as repo from './repo.ts';

/** Where `asrun.*` events go: `app.rabbit.events` in the api. */
export interface AsRunEventSink {
  publish(event: RealtimeEvent): Promise<void>;
}

export type AsRunRecorderOptions = {
  db: Db;
  publish?: AsRunEventSink['publish'];
  logger: Logger;
};

/** Event id derived from the engine event and the entry, so a retried handler reuses it. */
function derivedId(sourceEventId: string, type: string, entryId: string): string {
  const h = createHash('sha1').update(`ondes-asrun:${sourceEventId}:${type}:${entryId}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Engine events (#28) -> as-run entries. Runs from the durable `asrun` consumer (one api
 * replica at a time, in order per station). Every write is idempotent, so a redelivery
 * changes nothing and publishes nothing:
 *
 * - `engine.track.started`: inserts the entry (unique on the event id), after closing the
 *   entries of earlier boots that never ended (`interrupted`);
 * - `engine.track.ended`: sets the end of the matching open entry, or records the whole entry
 *   if its start was lost;
 * - `engine.booted`: closes the entries of earlier boots.
 *
 * Each write publishes `asrun.started` / `asrun.ended` (best effort: the row is committed).
 */
export function createAsRunRecorder(options: AsRunRecorderOptions) {
  const { db, logger } = options;

  async function publish(
    source: RealtimeEvent,
    type: AsRunRealtimeEvent['type'],
    entry: AsRunEntry,
  ) {
    if (!options.publish) return;
    const event = realtimeEventSchema.parse({
      id: derivedId(source.id, type, entry.id),
      stationId: entry.stationId,
      at: type === 'asrun.started' ? entry.startedAt : (entry.endedAt ?? source.at),
      type,
      data: entry,
    });
    await options.publish(event).catch((err: unknown) => {
      logger.error({ err, type, stationId: entry.stationId }, 'As-run event publish failed');
    });
  }

  async function closeInterrupted(
    source: RealtimeEvent,
    scope: StationScope,
    bootId: string,
    at: Date,
  ) {
    for (const entry of await repo.closeInterrupted(db, scope, bootId, at)) {
      await publish(source, 'asrun.ended', entry);
    }
  }

  async function handle(event: RealtimeEvent): Promise<void> {
    if (
      event.type !== 'engine.track.started' &&
      event.type !== 'engine.track.ended' &&
      event.type !== 'engine.booted'
    ) {
      return;
    }
    // Engines of stations that aren't in the database (tests, a stale container) are ignored.
    const scope = await repo.stationScopeById(db, event.stationId);
    if (!scope) return;
    const at = new Date(event.at);
    switch (event.type) {
      case 'engine.booted':
        await closeInterrupted(event, scope, event.data.bootId, at);
        return;
      case 'engine.track.started': {
        // A lost `engine.booted` still closes the previous boot's entry here.
        await closeInterrupted(event, scope, event.data.bootId, at);
        const entry = await repo.recordStart(db, scope, {
          eventId: event.id,
          bootId: event.data.bootId,
          seq: event.data.seq,
          at,
          itemId: event.data.itemId,
          segmentId: event.data.segmentId,
          source: event.data.source,
          title: event.data.title,
          artist: event.data.artist,
          filename: event.data.filename,
          rid: event.data.rid,
        });
        if (entry) await publish(event, 'asrun.started', entry);
        return;
      }
      case 'engine.track.ended': {
        const entry = await repo.recordEnd(db, scope, {
          eventId: event.id,
          bootId: event.data.bootId,
          seq: event.data.seq,
          at,
          itemId: event.data.itemId,
          segmentId: event.data.segmentId,
          source: event.data.source,
          startedAt: new Date(event.data.startedAt),
          playedMs: event.data.played * 1000,
        });
        if (entry) await publish(event, 'asrun.ended', entry);
        return;
      }
    }
  }

  return { handle };
}

export type AsRunRecorder = ReturnType<typeof createAsRunRecorder>;
