import { type Db, listIslandsToRender, resolveStationScope, station } from '@ondes/db';
import type { JobPublisher } from '@ondes/queue';
import { islandRenderJob } from './job.ts';
import { STALE_RENDER_MS } from './render.ts';

// Island render sweep (#56), run by the worker on its 5 min timer next to the storage sweep.
// The api enqueues a render after every sync; this catches what got lost: an enqueue that
// failed after the commit, a job that died in the queue, a worker killed mid-render (its
// `rendering` claim is taken over once stale). Safe from every replica: duplicate jobs
// collapse on their payload while one runs, and the render itself is a compare-and-set.

/** A `pending` island this old has missed its job. */
const PENDING_AFTER_MS = 2 * 60 * 1000;

/** Enqueues a render for every island left behind; returns how many, per station. */
export async function sweepIslandRenders(deps: {
  db: Db;
  jobs: JobPublisher;
}): Promise<Record<string, number>> {
  const stations = await deps.db.select({ id: station.id, orgId: station.orgId }).from(station);
  const counts: Record<string, number> = {};
  for (const { id, orgId } of stations) {
    const scope = await resolveStationScope(deps.db, orgId, id);
    const hashes = await listIslandsToRender(deps.db, scope, {
      pendingAfterMs: PENDING_AFTER_MS,
      staleAfterMs: STALE_RENDER_MS,
    });
    for (const hash of hashes) {
      await deps.jobs.enqueue(
        islandRenderJob,
        { orgId, stationId: id, hash },
        { orgId, stationId: id },
      );
    }
    if (hashes.length) counts[id] = hashes.length;
  }
  return counts;
}
