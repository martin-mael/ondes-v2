import {
  asRunOutcome,
  ENGINE_CONTRACT_VERSION,
  engineEventSchema,
  listAsRunQuerySchema,
} from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { toRealtimeEvent } from '../engine/adapter/index.ts';
import { localDayBounds } from '../log/time.ts';
import { asRunSourceOf, shaFromFilename } from './repo.ts';

const sha = 'ab'.repeat(32);

describe('asRunOutcome', () => {
  it('is complete within the tolerance, or without a planned length', () => {
    expect(asRunOutcome(180_000, 180_000)).toBe('complete');
    expect(asRunOutcome(178_500, 180_000)).toBe('complete');
    expect(asRunOutcome(200_000, 180_000)).toBe('complete');
    expect(asRunOutcome(1000, null)).toBe('complete');
  });
  it('is cut when it ended early, skipped when it barely aired', () => {
    expect(asRunOutcome(120_000, 180_000)).toBe('cut');
    expect(asRunOutcome(4_000, 180_000)).toBe('skipped');
    // A 3 s jingle that played 3 s is complete, not skipped.
    expect(asRunOutcome(3_000, 3_020)).toBe('complete');
  });
});

describe('asRunSourceOf', () => {
  it('maps the feeder queue (and the hard-start lane) to the log', () => {
    expect(asRunSourceOf('queue')).toBe('log');
    expect(asRunSourceOf('scheduled')).toBe('log');
    expect(asRunSourceOf('safety')).toBe('safety');
    expect(asRunSourceOf('emergency')).toBe('emergency');
    expect(asRunSourceOf('live')).toBe('live');
    expect(asRunSourceOf('unknown')).toBe('unknown');
    expect(asRunSourceOf('something-new')).toBe('unknown');
  });
});

describe('shaFromFilename', () => {
  it('reads the sha256 of a playout cache path', () => {
    expect(shaFromFilename(`/var/ondes/cache/media/ab/${sha}.flac`)).toBe(sha);
    expect(shaFromFilename(`${sha}.mp3`)).toBe(sha);
    expect(shaFromFilename('/safety/jingle.mp3')).toBeNull();
    expect(shaFromFilename(`/x/${sha}`)).toBeNull();
    expect(shaFromFilename(null)).toBeNull();
  });
});

describe('listAsRunQuerySchema', () => {
  it('takes a range or a station-local date, not both', () => {
    const from = '2026-10-25T00:00:00Z';
    const to = '2026-10-26T00:00:00Z';
    expect(listAsRunQuerySchema.safeParse({ from, to }).success).toBe(true);
    expect(listAsRunQuerySchema.safeParse({ date: '2026-10-25' }).success).toBe(true);
    expect(listAsRunQuerySchema.safeParse({}).success).toBe(false);
    expect(listAsRunQuerySchema.safeParse({ from }).success).toBe(false);
    expect(listAsRunQuerySchema.safeParse({ from, to, date: '2026-10-25' }).success).toBe(false);
    expect(listAsRunQuerySchema.safeParse({ from: to, to: from }).success).toBe(false);
    expect(
      listAsRunQuerySchema.safeParse({ from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });
  it('defaults to air order, 100 per page', () => {
    expect(listAsRunQuerySchema.parse({ date: '2026-10-25' })).toMatchObject({
      order: 'asc',
      limit: 100,
    });
  });
});

// The `date` filter covers the station-local day, which is 23 or 25 h long around DST.
describe('station-local day (Europe/Paris)', () => {
  const hours = (d: string) => {
    const b = localDayBounds(d, 'Europe/Paris');
    return (b.endsAt.getTime() - b.startsAt.getTime()) / 3_600_000;
  };
  it('is 23 h on the last Sunday of March and 25 h on the last Sunday of October', () => {
    expect(hours('2026-03-29')).toBe(23);
    expect(hours('2026-10-25')).toBe(25);
    expect(hours('2026-10-24')).toBe(24);
    expect(localDayBounds('2026-10-25', 'Europe/Paris').startsAt.toISOString()).toBe(
      '2026-10-24T22:00:00.000Z',
    );
    expect(localDayBounds('2026-10-25', 'Europe/Paris').endsAt.toISOString()).toBe(
      '2026-10-25T23:00:00.000Z',
    );
  });
});

describe('engine track.started -> realtime', () => {
  it('carries the live session id when the engine sends one', () => {
    const wire = {
      v: ENGINE_CONTRACT_VERSION,
      seq: 3,
      boot_id: 'b',
      station_id: 's',
      at: 1_790_000_000,
      type: 'track.started' as const,
      data: {
        item_id: null,
        source: 'live' as const,
        title: null,
        artist: null,
        filename: null,
        rid: null,
        live_session_id: 'session-1',
      },
    };
    const event = toRealtimeEvent(engineEventSchema.parse(wire));
    expect(event.type === 'engine.track.started' && event.data.liveSessionId).toBe('session-1');
    const { live_session_id: _, ...older } = wire.data;
    const without = toRealtimeEvent(engineEventSchema.parse({ ...wire, data: older }));
    expect(without.type === 'engine.track.started' && without.data.liveSessionId).toBeNull();
  });
});
