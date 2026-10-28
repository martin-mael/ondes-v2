import { engineEventSchema, realtimeEventSchema } from '@ondes/shared';
import { describe, expect, it } from 'vitest';
import { toRealtimeEvent } from '../../engine/adapter/map.ts';

// The engine's live recording events (#67) as domain events: ISO times, camelCase.

describe('live recording engine events', () => {
  const base = { v: 1, seq: 7, boot_id: 'b', station_id: 'st', at: 1_793_134_494.5 };

  it('maps a closed file', () => {
    const wire = engineEventSchema.parse({
      ...base,
      type: 'live.recording.closed',
      data: {
        file: 'live-b-1.flac',
        session_id: 's',
        started_at: 1_793_134_400,
        ended_at: 1_793_134_494.25,
      },
    });
    const event = toRealtimeEvent(wire);
    expect(realtimeEventSchema.parse(event)).toMatchObject({
      type: 'engine.live.recording.closed',
      data: {
        bootId: 'b',
        seq: 7,
        file: 'live-b-1.flac',
        sessionId: 's',
        startedAt: '2026-10-27T20:53:20.000Z',
        endedAt: '2026-10-27T20:54:54.250Z',
      },
    });
  });

  it('maps a started file', () => {
    const wire = engineEventSchema.parse({
      ...base,
      type: 'live.recording.started',
      data: { file: 'live-b-2.flac', session_id: 's', started_at: 1_793_134_400 },
    });
    expect(toRealtimeEvent(wire)).toMatchObject({
      type: 'engine.live.recording.started',
      data: { file: 'live-b-2.flac', sessionId: 's', startedAt: '2026-10-27T20:53:20.000Z' },
    });
  });
});
