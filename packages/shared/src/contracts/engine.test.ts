import { describe, expect, it } from 'vitest';
import {
  engineEventBatchSchema,
  engineEventSchema,
  enginePushItemSchema,
  engineStateSchema,
} from './engine.ts';

// Payloads below are copied from what Liquidsoap 2.4.6 actually sent in the #13 spike.
const base = { v: 1, boot_id: '1792455332-211523', station_id: 'spike', at: 1792455332.7 };

describe('enginePushItemSchema', () => {
  it('accepts a fully annotated item', () => {
    const item = {
      item_id: 'A',
      uri: '/media/tone-a.wav',
      cue_in: 2,
      cue_out: 12,
      amplify_db: -6,
      cross_out: 0,
      title: 'Say "hi", Lyon',
    };
    expect(enginePushItemSchema.parse(item)).toEqual(item);
  });

  it('rejects cue_out before cue_in', () => {
    const r = enginePushItemSchema.safeParse({
      item_id: 'A',
      uri: '/a.wav',
      cue_in: 5,
      cue_out: 2,
    });
    expect(r.success).toBe(false);
  });

  it('rejects negative crossfades', () => {
    expect(enginePushItemSchema.safeParse({ item_id: 'A', uri: '/a', cross_in: -1 }).success).toBe(
      false,
    );
  });
});

describe('engineEventSchema', () => {
  it('parses a batch in order', () => {
    const batch = [
      { ...base, seq: 1, type: 'engine.started', data: { version: '2.4.6' } },
      {
        ...base,
        seq: 6,
        type: 'track.started',
        data: {
          item_id: 'A',
          source: 'queue',
          title: 'B',
          artist: null,
          filename: '/media/tone-a.wav',
          rid: '4',
        },
      },
      {
        ...base,
        seq: 7,
        type: 'track.ended',
        data: { item_id: 'A', source: 'queue', started_at: 1792454822.13, played: 9.96 },
      },
      { ...base, seq: 8, type: 'live.connected', data: { headers: [['ice-name', 'Spike DJ']] } },
      { ...base, seq: 9, type: 'blank.detected', data: {} },
    ];
    expect(engineEventBatchSchema.parse(batch).map((e) => e.type)).toEqual([
      'engine.started',
      'track.started',
      'track.ended',
      'live.connected',
      'blank.detected',
    ]);
  });

  it('rejects an unknown event type', () => {
    expect(engineEventSchema.safeParse({ ...base, seq: 2, type: 'nope', data: {} }).success).toBe(
      false,
    );
  });
});

describe('engineStateSchema', () => {
  it('accepts the state before the first track', () => {
    const state = {
      boot_id: base.boot_id,
      station_id: 'spike',
      version: '2.4.6',
      uptime: 0.4,
      seq: 1,
      on_air: { elapsed: 1792455332.7 },
      queue: [],
      live: { enabled: false, connected: false, ready: false },
      blank: false,
      output_db: null,
    };
    expect(engineStateSchema.parse(state)).toEqual(state);
  });
});
