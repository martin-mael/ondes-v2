import { describe, expect, it } from 'vitest';
import {
  engineEventBatchSchema,
  engineEventSchema,
  enginePushItemSchema,
  enginePushSegmentSchema,
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

describe('enginePushSegmentSchema', () => {
  const part = (item_id: string) => ({ item_id, uri: `/media/${item_id}.flac` });

  it('accepts an island chain with per-part gain and segment transitions', () => {
    const segment = {
      segment_id: 'island-1',
      parts: [
        { ...part('A'), cue_in: 2.0000113, cue_out: 12.0000113, amplify_db: -3.5 },
        { ...part('VT'), amplify_db: 0 },
        { ...part('B'), cue_in: 8.0000113, amplify_db: -1.5 },
      ],
      cross_in: 3,
      cross_out: 2,
    };
    expect(enginePushSegmentSchema.parse(segment)).toEqual(segment);
  });

  it('needs at least two parts, each with ordered cues', () => {
    expect(enginePushSegmentSchema.safeParse({ segment_id: 's', parts: [part('A')] }).success).toBe(
      false,
    );
    expect(
      enginePushSegmentSchema.safeParse({
        segment_id: 's',
        parts: [part('A'), { ...part('B'), cue_in: 4, cue_out: 1 }],
      }).success,
    ).toBe(false);
  });

  it('keeps transitions on the segment, not its parts', () => {
    const parsed = enginePushSegmentSchema.parse({
      segment_id: 's',
      parts: [{ ...part('A'), cross_out: 0 }, part('B')],
    });
    expect(parsed.parts[0]).not.toHaveProperty('cross_out');
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
