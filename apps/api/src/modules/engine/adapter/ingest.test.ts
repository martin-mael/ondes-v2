import type { EngineEvent, EngineRealtimeEvent, EngineState } from '@ondes/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngineAdapter } from './adapter.ts';
import { createEngineEventIngest, type EngineEventIngest, type ResyncReason } from './ingest.ts';
import { type FakeEngine, startFakeEngine } from './testing/fake-engine.ts';

let engine: FakeEngine;
let ingest: EngineEventIngest;
let published: EngineRealtimeEvent[];
let resyncs: Array<{ reason: ResyncReason; state: EngineState }>;
let failPublish: boolean;

const track = (item: string) =>
  ({
    item_id: item,
    source: 'queue',
    title: null,
    artist: null,
    filename: `/media/${item}.flac`,
    rid: '1',
  }) as const;

/** Seqs of what was published, for the engine events (engine.* types). */
const seqs = () => published.map((e) => ('seq' in e.data ? e.data.seq : null));

beforeEach(async () => {
  engine = await startFakeEngine();
  published = [];
  resyncs = [];
  failPublish = false;
  ingest = createEngineEventIngest({
    stationId: engine.stationId,
    engine: createEngineAdapter({ stationId: engine.stationId, baseUrl: engine.url }),
    async publish(event) {
      if (failPublish) throw new Error('rabbit down');
      published.push(event);
    },
    onResync: (state, reason) => {
      resyncs.push({ state, reason });
    },
  });
});

afterEach(() => engine.close());

describe('engine event ingest', () => {
  it('publishes a batch in seq order, mapped to domain events', async () => {
    engine.emit('track.started', track('A'));
    engine.emit('track.ended', {
      item_id: 'A',
      source: 'queue',
      started_at: 1_792_455_332.5,
      played: 9.96,
    });
    const batch = [...engine.log].reverse();
    expect(await ingest.receive(batch)).toEqual({ published: 3, duplicates: 0 });
    expect(published.map((e) => e.type)).toEqual([
      'engine.booted',
      'engine.track.started',
      'engine.track.ended',
    ]);
    expect(published[1]).toMatchObject({
      stationId: engine.stationId,
      data: { itemId: 'A', segmentId: null, bootId: engine.bootId, seq: 2 },
    });
    expect(published[2]?.data).toMatchObject({ startedAt: '2026-10-20T00:15:32.500Z' });
    expect(ingest.cursor()).toEqual({ bootId: engine.bootId, seq: 3 });
  });

  it('drops redeliveries', async () => {
    engine.emit('track.started', track('A'));
    await ingest.receive(engine.log);
    engine.emit('track.started', track('B'));
    expect(await ingest.receive(engine.log)).toEqual({ published: 1, duplicates: 2 });
    expect(seqs()).toEqual([1, 2, 3]);
  });

  it('backfills a gap from GET /v1/events and reconciles', async () => {
    await ingest.receive(engine.log);
    engine.emit('track.started', track('A'));
    engine.emit('track.ended', { item_id: 'A', source: 'queue', started_at: 1, played: 1 });
    const last = engine.emit('track.started', track('B'));
    expect(await ingest.receive([last])).toEqual({ published: 3, duplicates: 0, resync: 'gap' });
    expect(seqs()).toEqual([1, 2, 3, 4]);
    expect(resyncs.map((r) => r.reason)).toEqual(['gap']);
  });

  it('starts over on a new boot, backfilling its first events', async () => {
    engine.emit('track.started', track('A'));
    await ingest.receive(engine.log);
    engine.restart();
    engine.emit('track.started', track('S'));
    const late = engine.emit('track.started', track('T'));
    // Only the last event of the new boot arrives (the earlier POSTs were lost).
    expect(await ingest.receive([late])).toEqual({ published: 3, duplicates: 0, resync: 'boot' });
    expect(published.slice(2).map((e) => e.type)).toEqual([
      'engine.booted',
      'engine.track.started',
      'engine.track.started',
    ]);
    expect(ingest.cursor()).toEqual({ bootId: engine.bootId, seq: 3 });
    expect(resyncs[0]?.state.boot_id).toBe(engine.bootId);
  });

  it('keeps the cursor on a failed publish so the redelivery goes through', async () => {
    engine.emit('track.started', track('A'));
    failPublish = true;
    await expect(ingest.receive(engine.log)).rejects.toThrow('rabbit down');
    expect(ingest.cursor()).toBeNull();
    failPublish = false;
    expect(await ingest.receive(engine.log)).toEqual({ published: 2, duplicates: 0 });
  });

  it('serialises concurrent batches', async () => {
    for (const item of ['A', 'B', 'C', 'D']) engine.emit('track.started', track(item));
    const log = engine.log;
    await Promise.all([
      ingest.receive(log.slice(0, 2)),
      ingest.receive(log.slice(1, 4)),
      ingest.receive(log),
    ]);
    expect(seqs()).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses another station's events", async () => {
    const foreign = { ...engine.log[0], station_id: 'other' } as EngineEvent;
    await expect(ingest.receive([foreign])).rejects.toThrow('station other');
    expect(published).toEqual([]);
  });

  it('catches up from the cursor, and across a restart', async () => {
    await ingest.receive(engine.log);
    engine.emit('blank.detected', {});
    expect(await ingest.catchUp()).toEqual({ published: 1, duplicates: 0, resync: 'catch_up' });
    engine.restart();
    await ingest.catchUp();
    expect(published.map((e) => e.type)).toEqual([
      'engine.booted',
      'engine.blank.detected',
      'engine.booted',
    ]);
    expect(resyncs.map((r) => r.reason)).toEqual(['catch_up', 'catch_up']);
  });

  it('does not replay history on a catch-up before the first batch', async () => {
    engine.emit('track.started', track('A'));
    expect(await ingest.catchUp()).toEqual({ published: 0, duplicates: 0, resync: 'catch_up' });
    expect(published).toEqual([]);
    expect(resyncs).toHaveLength(1);
  });
});
