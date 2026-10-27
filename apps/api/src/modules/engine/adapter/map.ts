import { createHash } from 'node:crypto';
import type { EngineEvent, EngineRealtimeEvent } from '@ondes/shared';

/** Engine times are epoch seconds (float); domain events carry ISO 8601 UTC. */
export function isoFromEpochSeconds(seconds: number): string {
  return new Date(Math.round(seconds * 1000)).toISOString();
}

/**
 * Deterministic event id (a name-based, version 5 style UUID) from station, boot and seq,
 * so a redelivered engine event republishes with the same id and consumers can dedupe.
 */
export function engineEventId(stationId: string, bootId: string, seq: number): string {
  const h = createHash('sha1').update(`ondes-engine:${stationId}:${bootId}:${seq}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Maps one wire event (snake_case, epoch seconds) to its real-time domain event. */
export function toRealtimeEvent(e: EngineEvent): EngineRealtimeEvent {
  const envelope = {
    id: engineEventId(e.station_id, e.boot_id, e.seq),
    stationId: e.station_id,
    at: isoFromEpochSeconds(e.at),
  };
  const origin = { bootId: e.boot_id, seq: e.seq };
  switch (e.type) {
    case 'engine.started':
      return { ...envelope, type: 'engine.booted', data: { ...origin, version: e.data.version } };
    case 'track.started':
      return {
        ...envelope,
        type: 'engine.track.started',
        data: {
          ...origin,
          itemId: e.data.item_id,
          segmentId: e.data.segment_id ?? null,
          source: e.data.source,
          title: e.data.title,
          artist: e.data.artist,
          filename: e.data.filename,
          rid: e.data.rid,
          liveSessionId: e.data.live_session_id ?? null,
          liveStreamerId: e.data.live_streamer_id ?? null,
          liveInput: e.data.live_input ?? null,
        },
      };
    case 'track.ended':
      return {
        ...envelope,
        type: 'engine.track.ended',
        data: {
          ...origin,
          itemId: e.data.item_id,
          segmentId: e.data.segment_id ?? null,
          source: e.data.source,
          startedAt: isoFromEpochSeconds(e.data.started_at),
          played: e.data.played,
        },
      };
    case 'live.connected':
      return {
        ...envelope,
        type: 'engine.live.connected',
        data: {
          ...origin,
          headers: e.data.headers,
          input: e.data.input ?? null,
          streamerId: e.data.streamer_id ?? null,
        },
      };
    case 'live.disconnected':
      return {
        ...envelope,
        type: 'engine.live.disconnected',
        data: { ...origin, input: e.data.input ?? null, streamerId: e.data.streamer_id ?? null },
      };
    case 'live.gate':
      return {
        ...envelope,
        type: 'engine.live.gate',
        data: {
          ...origin,
          enabled: e.data.enabled,
          input: e.data.input ?? null,
          sessionId: e.data.session_id ?? null,
        },
      };
    case 'live.recording.started':
      return {
        ...envelope,
        type: 'engine.live.recording.started',
        data: {
          ...origin,
          file: e.data.file,
          sessionId: e.data.session_id,
          startedAt: isoFromEpochSeconds(e.data.started_at),
        },
      };
    case 'live.recording.closed':
      return {
        ...envelope,
        type: 'engine.live.recording.closed',
        data: {
          ...origin,
          file: e.data.file,
          sessionId: e.data.session_id,
          startedAt: isoFromEpochSeconds(e.data.started_at),
          endedAt: isoFromEpochSeconds(e.data.ended_at),
        },
      };
    case 'blank.detected':
      return { ...envelope, type: 'engine.blank.detected', data: origin };
    case 'blank.recovered':
      return { ...envelope, type: 'engine.blank.recovered', data: origin };
  }
}
