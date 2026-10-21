import { describe, expect, it } from 'vitest';
import { realtimeEventSchema } from './events.ts';

const envelope = {
  id: '0b9e3c84-6f1d-5a51-9a1e-3f0a4c7d2e10',
  stationId: 'station-1',
  at: '2026-10-20T08:00:00.000Z',
};

describe('realtimeEventSchema', () => {
  it('accepts engine as-run events', () => {
    const event = {
      ...envelope,
      type: 'engine.track.started',
      data: {
        bootId: '1792455332-211523',
        seq: 6,
        itemId: 'A',
        segmentId: null,
        source: 'queue',
        title: 'Say "hi", Lyon',
        artist: null,
        filename: '/media/a.flac',
        rid: '4',
      },
    };
    expect(realtimeEventSchema.parse(event)).toEqual(event);
  });

  it('accepts engine up/down from health polling', () => {
    expect(
      realtimeEventSchema.parse({
        ...envelope,
        type: 'engine.down',
        data: { bootId: null, reason: 'timeout' },
      }).type,
    ).toBe('engine.down');
  });

  it('rejects wire events that were not mapped', () => {
    expect(
      realtimeEventSchema.safeParse({ ...envelope, type: 'track.started', data: {} }).success,
    ).toBe(false);
  });
});
