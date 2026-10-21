import type { EngineEvent, EngineRealtimeEvent, EngineState } from '@ondes/shared';
import type { EngineAdapter } from './adapter.ts';
import { type Logger, silentLogger } from './logger.ts';
import { toRealtimeEvent } from './map.ts';

/**
 * Engine event ingest for one station (ADR 0002, "Events").
 *
 * The engine POSTs its event log in ordered batches and retries until it gets a 2xx, so
 * delivery is at least once and in order. This keeps a cursor `(boot_id, seq)` of the last
 * event it published and:
 * - drops anything at or before the cursor (redeliveries);
 * - on a gap in `seq`, backfills the missing events from `GET /v1/events?after=<seq>`;
 * - on a new `boot_id`, starts over from seq 1 (backfilling if the batch doesn't start
 *   there), since the engine restarted with an empty queue;
 * - publishes each event, mapped to its domain form, before moving the cursor. A failed
 *   publish rejects the batch (the route answers 503) and the engine redelivers it.
 * After a gap or a new boot it also fetches `GET /v1/state` and hands it to `onResync`, so
 * the feeder can reconcile its view of the queue.
 *
 * Batches and catch-ups are processed one at a time, in arrival order.
 *
 * Published events carry a deterministic id and their `(bootId, seq)`, so consumers can
 * dedupe the rare duplicate (an api restart between a publish and the engine's ack).
 */
export type EngineEventIngest = {
  readonly stationId: string;
  /** Ingests one batch POSTed by the engine (already validated against the contract). */
  receive(batch: readonly EngineEvent[]): Promise<IngestResult>;
  /**
   * Pulls whatever the engine logged since the cursor and reconciles with its state.
   * Called by the health monitor when the engine comes back or reports a new boot.
   */
  catchUp(): Promise<IngestResult>;
  /** Last published event, or null before the first one. */
  cursor(): IngestCursor | null;
};

export type IngestCursor = { bootId: string; seq: number };

export type IngestResult = {
  /** Events published by this call (including backfilled ones). */
  published: number;
  /** Events dropped as already published. */
  duplicates: number;
  /** Set when the call resynced: what triggered it. */
  resync?: ResyncReason;
};

export type ResyncReason = 'gap' | 'boot' | 'catch_up';

export type EngineEventIngestOptions = {
  stationId: string;
  engine: Pick<EngineAdapter, 'events' | 'state'>;
  /** Publishes on the real-time fanout. Must reject if the event wasn't published. */
  publish(event: EngineRealtimeEvent): Promise<void>;
  /** Engine state after a resync, for the feeder to reconcile with. Errors are logged. */
  onResync?(state: EngineState, reason: ResyncReason): void | Promise<void>;
  logger?: Logger;
};

export class EngineStationMismatchError extends Error {}

export function createEngineEventIngest(options: EngineEventIngestOptions): EngineEventIngest {
  const { stationId, engine, publish } = options;
  const logger = options.logger ?? silentLogger;
  let cursor: IngestCursor | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  /** Runs `fn` after everything queued before it, whatever their outcome. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  }

  function isNew(e: EngineEvent): boolean {
    return cursor === null || cursor.bootId !== e.boot_id || e.seq > cursor.seq;
  }

  async function deliver(e: EngineEvent): Promise<void> {
    await publish(toRealtimeEvent(e));
    cursor = { bootId: e.boot_id, seq: e.seq };
  }

  /** Publishes the engine's log after `after` for the current boot, in order. */
  async function backfill(bootId: string, after: number): Promise<number> {
    const events = await engine.events(after);
    let published = 0;
    let expected = after + 1;
    for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
      if (e.boot_id !== bootId) break; // The engine restarted again; the next batch says so.
      if (e.seq < expected) continue;
      if (e.seq > expected) {
        // Older than the engine's 1000-event window: those are gone for good.
        logger.warn(
          { stationId, bootId, from: expected, to: e.seq - 1 },
          'Engine events lost: no longer in its log',
        );
      }
      await deliver(e);
      expected = e.seq + 1;
      published++;
    }
    return published;
  }

  async function reconcile(reason: ResyncReason): Promise<void> {
    if (!options.onResync) return;
    try {
      await options.onResync(await engine.state(), reason);
    } catch (error) {
      logger.warn({ stationId, reason, err: error }, 'Engine resync callback failed');
    }
  }

  async function processBatch(batch: readonly EngineEvent[]): Promise<IngestResult> {
    const result: IngestResult = { published: 0, duplicates: 0 };
    const foreign = batch.find((e) => e.station_id !== stationId);
    if (foreign) {
      throw new EngineStationMismatchError(
        `Event from station ${foreign.station_id} posted for station ${stationId}`,
      );
    }
    // Stable sort: keeps boots in arrival order, seqs ascending within each boot.
    const events = [...batch].sort((a, b) => (a.boot_id === b.boot_id ? a.seq - b.seq : 0));
    for (const e of events) {
      const last = cursor;
      let backfilled = false;
      if (last && e.boot_id !== last.bootId) {
        logger.info({ stationId, bootId: e.boot_id }, 'Engine restarted');
        if (e.seq > 1) result.published += await backfill(e.boot_id, 0);
        backfilled = true;
        result.resync = 'boot';
      } else if (last && e.seq > last.seq + 1) {
        logger.warn(
          { stationId, bootId: e.boot_id, after: last.seq, got: e.seq },
          'Engine event gap, backfilling',
        );
        result.published += await backfill(e.boot_id, last.seq);
        backfilled = true;
        result.resync ??= 'gap';
      }
      // With no cursor (first contact since the api started), the first event is the first
      // one nobody acknowledged: the engine only moves its own cursor on a 2xx.
      if (isNew(e)) {
        await deliver(e);
        result.published++;
      } else if (!backfilled) {
        result.duplicates++;
      }
    }
    if (result.resync) await reconcile(result.resync);
    return result;
  }

  async function processCatchUp(): Promise<IngestResult> {
    const result: IngestResult = { published: 0, duplicates: 0, resync: 'catch_up' };
    const state = await engine.state();
    if (cursor !== null) {
      if (state.boot_id !== cursor.bootId) {
        logger.info({ stationId, bootId: state.boot_id }, 'Engine restarted');
        result.published += await backfill(state.boot_id, 0);
      } else if (state.seq > cursor.seq) {
        result.published += await backfill(state.boot_id, cursor.seq);
      }
    }
    // Without a cursor we don't know what was published before the api started; the engine
    // redelivers everything it has no ack for, so the next batch starts at the right place.
    await reconcile('catch_up');
    return result;
  }

  return {
    stationId,
    receive: (batch) => serial(() => processBatch(batch)),
    catchUp: () => serial(processCatchUp),
    cursor: () => (cursor ? { ...cursor } : null),
  };
}
