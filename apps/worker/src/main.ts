import { fileURLToPath } from 'node:url';
import { createDb, PostgresJobRunStore, runMigrations } from '@ondes/db';
import { connectQueue, createJobWorker } from '@ondes/queue';
import { discoverJobs } from './registry.ts';

// Worker bootstrap (#8): connect, declare the topology, discover jobs/<job>/ and consume.

const url = process.env.RABBITMQ_URL;
if (!url) throw new Error('RABBITMQ_URL is not set (see .env.example)');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');

const jobs = await discoverJobs(fileURLToPath(new URL('./jobs/', import.meta.url)));
const queue = await connectQueue(url, { connectionName: 'ondes-worker' });
// Job status lives in Postgres so idempotency holds across worker replicas. Migrations are
// safe to run from every process (advisory lock), so the worker can boot before the api.
await runMigrations(databaseUrl);
const database = createDb(databaseUrl, { applicationName: 'ondes-worker' });
const store = new PostgresJobRunStore(database.db);
const worker = createJobWorker({ rabbit: queue.rabbit, topology: queue.topology, store, jobs });
await worker.ready;
console.log(
  JSON.stringify({
    level: 'info',
    msg: 'worker started',
    jobs: jobs.map((job) => `${job.name} (${job.lane})`),
  }),
);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', msg: 'worker stopping', signal }));
  await worker.close();
  await queue.close();
  await database.close();
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
