import { type Db, getStationEngineSettings, NotFoundError, resolveStationScope } from '@ondes/db';
import { type JobPublisher, jobType } from '@ondes/queue';
import {
  AUTOCUE_JOB,
  type AutocueJobPayload,
  autocueIdempotencyKey,
  autocueJobPayloadSchema,
  autocueSettingsOf,
  type RealtimeEvent,
} from '@ondes/shared';
import type { JobTrigger } from '../../registry.ts';
import { autocueAnalyzerVersion } from './autocue.ts';

/** The `autocue` job type, for publishers (the trigger, the backfill). */
export const autocueJob = jobType(AUTOCUE_JOB, autocueJobPayloadSchema, {
  lane: 'bulk',
  idempotencyKey: autocueIdempotencyKey,
});

/** Durable event queue of the trigger. */
export const AUTOCUE_EVENT_QUEUE = 'worker.autocue';

/**
 * `asset.ingested` → cue the new playout copy, with the station's current thresholds (they
 * are part of the analyzer version, so of the job key). The database is opened on first use.
 */
export function createAutocueTrigger(db: () => Promise<Db>): JobTrigger {
  return {
    queue: AUTOCUE_EVENT_QUEUE,
    async onEvent(event: RealtimeEvent, jobs: JobPublisher) {
      if (event.type !== 'asset.ingested') return;
      const conn = await db();
      let scope: Awaited<ReturnType<typeof resolveStationScope>>;
      try {
        scope = await resolveStationScope(conn, event.data.orgId, event.stationId);
      } catch (error) {
        // The station is gone: nothing to cue.
        if (error instanceof NotFoundError) return;
        throw error;
      }
      const settings = autocueSettingsOf(await getStationEngineSettings(conn, scope));
      await enqueueAutocue(jobs, {
        orgId: scope.orgId,
        stationId: scope.stationId,
        assetId: event.data.assetId,
        playoutSha256: event.data.playout.sha256,
        analyzerVersion: autocueAnalyzerVersion(settings),
      });
    },
  };
}

/**
 * Explicit key `autocue:<assetId>:<playoutSha256>:<analyzerVersion>`: a redelivered event, a
 * second replica or a backfill of an asset already cued with this version runs nothing.
 */
export async function enqueueAutocue(jobs: JobPublisher, payload: AutocueJobPayload) {
  await jobs.enqueue(autocueJob, payload, {
    idempotencyKey: autocueIdempotencyKey(payload),
    orgId: payload.orgId,
    stationId: payload.stationId,
  });
}
