import { fileURLToPath } from 'node:url';
import { createDb, PostgresJobRunStore, runMigrations, sweepStorageDeletions } from '@ondes/db';
import { connectQueue, createJobPublisher, createJobWorker } from '@ondes/queue';
import { createS3Storage, loadStorageConfig } from '@ondes/storage';
import { cacheRootFromEnv } from './jobs/cache-sync/deps.ts';
import { startCacheTriggers } from './jobs/cache-sync/trigger.ts';
import { sweepUploads } from './jobs/ingest/sweep.ts';
import { sweepIslandRenders } from './jobs/island-render/sweep.ts';
import { discoverJobs, discoverTriggers } from './registry.ts';
import { startJobTriggers } from './triggers.ts';

// Worker bootstrap (#8): connect, declare the topology, discover jobs/<job>/ and consume.

const url = process.env.RABBITMQ_URL;
if (!url) throw new Error('RABBITMQ_URL is not set (see .env.example)');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');

const jobsDir = fileURLToPath(new URL('./jobs/', import.meta.url));
const jobs = await discoverJobs(jobsDir);
const triggers = await discoverTriggers(jobsDir);
const queue = await connectQueue(url, { connectionName: 'ondes-worker' });
// Job status lives in Postgres so idempotency holds across worker replicas. Migrations are
// safe to run from every process (advisory lock), so the worker can boot before the api.
await runMigrations(databaseUrl);
const database = createDb(databaseUrl, { applicationName: 'ondes-worker' });
const store = new PostgresJobRunStore(database.db);
const worker = createJobWorker({ rabbit: queue.rabbit, topology: queue.topology, store, jobs });
await worker.ready;

// Deferred bucket deletes (#17): objects released by asset deletes are removed once their
// grace period is over. Safe to run from every worker replica (row locks, skip locked).
const storage = createS3Storage(loadStorageConfig(process.env));
const publisher = createJobPublisher(queue.rabbit, queue.topology);

// Job triggers: events → jobs, one durable queue each (registry.ts `JobTrigger`).
const triggerConsumers = startJobTriggers(queue, triggers, publisher);
await Promise.all(triggerConsumers.map((consumer) => consumer.ready));
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const result = await sweepStorageDeletions(database.db, storage);
    if (result.deleted.length || result.revived.length || result.failed.length) {
      console.log(JSON.stringify({ level: 'info', msg: 'storage sweep', ...result }));
    }
  } catch (err) {
    console.error(
      JSON.stringify({ level: 'error', msg: 'storage sweep failed', err: String(err) }),
    );
  }
  try {
    // Uploads (#18): expire abandoned multipart uploads, re-enqueue lost ingest jobs.
    const uploads = await sweepUploads({ db: database.db, storage, jobs: publisher });
    if (uploads.expired.length || uploads.requeued.length) {
      console.log(JSON.stringify({ level: 'info', msg: 'upload sweep', ...uploads }));
    }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'upload sweep failed', err: String(err) }));
  }
  try {
    // Islands (#56): re-enqueue renders whose job was lost or whose worker died.
    const islands = await sweepIslandRenders({ db: database.db, jobs: publisher });
    if (Object.keys(islands).length) {
      console.log(JSON.stringify({ level: 'info', msg: 'island render sweep', counts: islands }));
    }
  } catch (err) {
    console.error(
      JSON.stringify({ level: 'error', msg: 'island render sweep failed', err: String(err) }),
    );
  } finally {
    sweeping = false;
  }
}
const sweepTimer = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
void sweep();

// Playout cache (#31): log changes and a 10 min sweep enqueue `cache-sync`. Only when this
// worker keeps the station caches (PLAYOUT_CACHE_ROOT, see jobs/cache-sync/deps.ts).
const cacheTriggers = cacheRootFromEnv()
  ? startCacheTriggers({
      queue,
      jobs: publisher,
      db: database.db,
      onError: (err) =>
        console.error(
          JSON.stringify({ level: 'error', msg: 'cache sync trigger failed', err: String(err) }),
        ),
    })
  : undefined;
if (!cacheTriggers) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'PLAYOUT_CACHE_ROOT (or ENGINE_CACHE_ROOT) is not set: this worker keeps no playout cache, so no station files are fetched and engines will skip uncached items',
    }),
  );
}

console.log(
  JSON.stringify({
    level: 'info',
    msg: 'worker started',
    jobs: jobs.map((job) => `${job.name} (${job.lane})`),
    triggers: triggers.map((trigger) => trigger.queue),
  }),
);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', msg: 'worker stopping', signal }));
  clearInterval(sweepTimer);
  await Promise.all(triggerConsumers.map((consumer) => consumer.close()));
  await cacheTriggers?.close();
  await worker.close();
  await publisher.close();
  await queue.close();
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
