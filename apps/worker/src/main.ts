import { fileURLToPath } from 'node:url';
import { connectQueue, createJobWorker, InMemoryJobRunStore } from '@ondes/queue';
import { discoverJobs } from './registry.ts';

// Worker bootstrap (#8): connect, declare the topology, discover jobs/<job>/ and consume.

const url = process.env.RABBITMQ_URL;
if (!url) throw new Error('RABBITMQ_URL is not set (see .env.example)');

const jobs = await discoverJobs(fileURLToPath(new URL('./jobs/', import.meta.url)));
const queue = await connectQueue(url, { connectionName: 'ondes-worker' });
// TODO: switch to the Postgres JobRunStore once packages/db lands (#5 follow-up to #8).
const store = new InMemoryJobRunStore();
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
  process.exit(0);
}
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('SIGINT', () => void stop('SIGINT'));
