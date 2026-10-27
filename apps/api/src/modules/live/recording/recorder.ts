import { createHash } from 'node:crypto';
import {
  type Db,
  type LiveRecordingRow,
  openPartsOfOtherBoots,
  type PartChange,
  recordPartClosed,
  recordPartStarted,
  type StationScope,
} from '@ondes/db';
import { type RealtimeEvent, realtimeEventSchema, uuidSchema } from '@ondes/shared';
import { stationScopeById } from '../../asrun/repo.ts';
import type { Logger } from '../../engine/adapter/index.ts';

// Live recording (#67, ADR 0039): the engine's recording events → parts and recordings.
//
// Runs from the durable `live-recording` consumer (one api replica at a time, in order per
// station; see plugin.ts). Every write is idempotent (parts are unique per station and file),
// so a redelivery changes nothing and republishes the same event:
//
// - `engine.live.recording.started`: the part, assigned to its recording, which is now
//   `recording` (a build of an earlier version waits for it);
// - `engine.live.recording.closed`: the part is complete; the recording's version goes up and
//   it is `pending` once no part is open (`skipped` when the station records nothing);
// - `engine.booted`: parts of earlier boots still open are `interrupted` (the file is readable
//   up to the crash) and count as closed. A lost `engine.booted` is caught by the next part of
//   the new boot.
//
// Each change publishes `live.recording.updated`; the worker builds the `pending` ones.

export type LiveRecordingRecorderOptions = {
  db: Db;
  publish?: (event: RealtimeEvent) => Promise<void>;
  logger: Logger;
};

/** Event id derived from the source event and the recording version, so a redelivery reuses it. */
function derivedId(sourceEventId: string, recording: LiveRecordingRow, part: string): string {
  const h = createHash('sha1')
    .update(`ondes-live-recording:${sourceEventId}:${part}:${recording.id}:${recording.version}`)
    .digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The `live.recording.updated` event of a recording row. */
export function recordingUpdatedEvent(
  id: string,
  at: string,
  recording: LiveRecordingRow,
): RealtimeEvent {
  return realtimeEventSchema.parse({
    id,
    stationId: recording.stationId,
    at,
    type: 'live.recording.updated',
    data: {
      orgId: recording.orgId,
      recordingId: recording.id,
      episodeId: recording.episodeId,
      showId: recording.showId,
      status: recording.status,
      version: recording.version,
    },
  });
}

export function createLiveRecordingRecorder(options: LiveRecordingRecorderOptions) {
  const { db, logger } = options;

  async function publish(source: RealtimeEvent, file: string, change: PartChange) {
    if (!change || !options.publish) return;
    try {
      await options.publish(
        recordingUpdatedEvent(
          derivedId(source.id, change.recording, file),
          source.at,
          change.recording,
        ),
      );
    } catch (err) {
      // Best effort for browsers, but the worker builds from this event: the redelivery of a
      // failing handler would publish it again, so let it throw.
      logger.error({ err, stationId: source.stationId }, 'Live recording event publish failed');
      throw err;
    }
  }

  async function interruptOtherBoots(source: RealtimeEvent, scope: StationScope, bootId: string) {
    const at = new Date(source.at);
    for (const part of await openPartsOfOtherBoots(db, scope, bootId)) {
      const change = await recordPartClosed(db, scope, {
        file: part.file,
        sessionId: part.sessionId,
        bootId: part.bootId,
        startedAt: part.startedAt,
        endedAt: at,
        status: 'interrupted',
      });
      await publish(source, part.file, change);
    }
  }

  async function handle(event: RealtimeEvent): Promise<void> {
    if (
      event.type !== 'engine.live.recording.started' &&
      event.type !== 'engine.live.recording.closed' &&
      event.type !== 'engine.booted'
    ) {
      return;
    }
    const scope = await stationScopeById(db, event.stationId);
    if (!scope) return;
    await interruptOtherBoots(event, scope, event.data.bootId);
    if (event.type === 'engine.booted') return;
    // Sessions are Node's uuids; anything else is an engine opened by hand.
    if (!uuidSchema.safeParse(event.data.sessionId).success) return;
    const part = {
      file: event.data.file,
      sessionId: event.data.sessionId,
      bootId: event.data.bootId,
      startedAt: new Date(event.data.startedAt),
    };
    const change =
      event.type === 'engine.live.recording.started'
        ? await recordPartStarted(db, scope, part)
        : await recordPartClosed(db, scope, {
            ...part,
            endedAt: new Date(event.data.endedAt),
            status: 'closed',
          });
    // A start that only joined a recording already `recording` changes nothing to announce.
    if (change && (change.changed || event.type === 'engine.live.recording.closed')) {
      await publish(event, event.data.file, change);
    }
  }

  return { handle };
}
