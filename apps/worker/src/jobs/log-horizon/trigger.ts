import { type JobPublisher, jobType } from '@ondes/queue';
import {
  LOG_HORIZON_JOB,
  type LogHorizonJobPayload,
  logHorizonJobPayloadSchema,
  type RealtimeEvent,
} from '@ondes/shared';
import type { JobTrigger } from '../../registry.ts';

/** The job as publishers see it (the api's sweep enqueues it too). */
export const logHorizonJob = jobType(LOG_HORIZON_JOB, logHorizonJobPayloadSchema, {
  lane: 'bulk',
});

/** `schedule.changed` → record the change and bring the horizon up to date (debounced). */
export const logHorizonTrigger: JobTrigger = {
  queue: 'worker.log-horizon',
  async onEvent(event: RealtimeEvent, jobs: JobPublisher) {
    if (event.type !== 'schedule.changed') return;
    await enqueueChange(jobs, {
      orgId: event.data.orgId,
      stationId: event.stationId,
      change: { eventId: event.id, at: event.at, areas: event.data.areas, from: event.data.from },
    });
  },
};

/** Explicit key: a redelivered event records its change once. */
export async function enqueueChange(
  jobs: JobPublisher,
  payload: LogHorizonJobPayload & { change: NonNullable<LogHorizonJobPayload['change']> },
): Promise<void> {
  await jobs.enqueue(logHorizonJob, payload, {
    idempotencyKey: `log-horizon:change:${payload.change.eventId}`,
    orgId: payload.orgId,
    stationId: payload.stationId,
  });
}
