import type { Db } from '@ondes/db';
import { type JobPublisher, jobType } from '@ondes/queue';
import { EPISODE_CHECK_JOB, episodeCheckJobPayloadSchema } from '@ondes/shared';
import { listCheckedStations } from './check.ts';

// What enqueues `episode-check` (#47): a sweep every minute for every station with a
// pre-recorded slot. Steps fall due with time, not with an event, so a timer drives them; a
// pass is cheap (a few queries per station). Every worker replica runs the sweep: the job's
// payload key collapses concurrent enqueues, and inserting a step is idempotent.

export const episodeCheckJobType = jobType(EPISODE_CHECK_JOB, episodeCheckJobPayloadSchema, {
  lane: 'high',
});

export type EpisodeCheckSweepOptions = {
  db: Db;
  jobs: JobPublisher;
  /** Default 60 s; 0 turns the timer off (tests call `sweep`). */
  intervalMs?: number;
  onError?: (error: unknown) => void;
};

export type EpisodeCheckSweep = { sweep(): Promise<number>; close(): void };

export function startEpisodeCheckSweep(options: EpisodeCheckSweepOptions): EpisodeCheckSweep {
  const onError = options.onError ?? (() => {});
  async function sweep() {
    const stations = await listCheckedStations(options.db);
    for (const s of stations) {
      const scope = { orgId: s.orgId, stationId: s.stationId };
      // The payload, then the envelope's tenant fields (`EnqueueOptions`).
      await options.jobs.enqueue(episodeCheckJobType, scope, scope);
    }
    return stations.length;
  }
  const intervalMs = options.intervalMs ?? 60_000;
  let timer: NodeJS.Timeout | undefined;
  if (intervalMs > 0) {
    timer = setInterval(() => void sweep().catch(onError), intervalMs);
    void sweep().catch(onError);
  }
  return {
    sweep,
    close() {
      clearInterval(timer);
    },
  };
}
