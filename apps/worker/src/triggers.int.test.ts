import { randomUUID } from 'node:crypto';
import {
  connectQueue,
  createEventPublisher,
  deleteEventQueue,
  deleteTopology,
  type EventSubscription,
  type JobPublisher,
  type QueueConnection,
} from '@ondes/queue';
import { type RealtimeEvent, realtimeEventSchema } from '@ondes/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loudnessTrigger } from './jobs/loudness/trigger.ts';
import { startJobTriggers } from './triggers.ts';

// Job triggers against RabbitMQ: an `asset.ingested` published on the events exchange becomes
// a `loudness` job, through the trigger's durable queue.

const url = process.env.RABBITMQ_URL ?? 'amqp://ondes:ondes@127.0.0.1:5672/ondes';

let queue: QueueConnection;
let consumers: EventSubscription[] = [];
const enqueued: { name: string; key: string | undefined }[] = [];
const jobs: JobPublisher = {
  async enqueue(job, _payload, options) {
    enqueued.push({ name: job.name, key: options?.idempotencyKey });
    return {} as Awaited<ReturnType<JobPublisher['enqueue']>>;
  },
  close: async () => {},
};

beforeAll(async () => {
  // A random prefix isolates this run's exchanges and queues from dev data and other runs.
  queue = await connectQueue(url, { prefix: `test-${randomUUID().slice(0, 8)}` });
});

afterAll(async () => {
  await Promise.all(consumers.map((c) => c.close()));
  await deleteEventQueue(queue.rabbit, queue.topology, loudnessTrigger.queue);
  await deleteTopology(queue.rabbit, queue.topology);
  await queue.close();
});

async function until(check: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('startJobTriggers', () => {
  it('turns asset.ingested into a keyed loudness job', async () => {
    consumers = startJobTriggers(queue, [loudnessTrigger], jobs);
    await Promise.all(consumers.map((c) => c.ready));
    const events = createEventPublisher(queue.rabbit, queue.topology, realtimeEventSchema);
    const assetId = randomUUID();
    const file = (sha: string) => ({
      fileId: randomUUID(),
      storageKey: `org/x/sha256/${sha}.flac`,
      sha256: sha,
      sizeBytes: 1,
      codec: 'flac',
      sampleRate: 44100,
      channels: 2,
      durationSamples: 1,
      flacBlockSize: 1024,
    });
    const event: RealtimeEvent = {
      id: randomUUID(),
      stationId: randomUUID(),
      at: new Date().toISOString(),
      type: 'asset.ingested',
      data: {
        orgId: randomUUID(),
        assetId,
        uploadId: randomUUID(),
        master: file('b'.repeat(64)),
        playout: file('a'.repeat(64)),
      },
    };
    await events.publish(event);
    await events.close();
    await until(() => enqueued.length > 0);
    expect(enqueued).toEqual([{ name: 'loudness', key: `loudness:${assetId}:${'a'.repeat(64)}` }]);
  });
});
