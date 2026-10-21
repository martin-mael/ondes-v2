# @ondes/queue

RabbitMQ job framework: typed jobs, `high` / `bulk` / `notify` lanes, TTL retry tiers, a dead-letter queue, idempotency keys and the real-time event fanout. Design and rationale: [`docs/adr/0006-job-queue.md`](../../docs/adr/0006-job-queue.md).

## Adding a job
Create `apps/worker/src/jobs/<job>/index.ts`; the worker discovers it at startup.

```ts
import { defineJob, NonRetryableError } from '@ondes/queue';
import { z } from 'zod';

export default defineJob(
  'peaks', // must match the folder name
  z.object({ stationId: z.uuid(), trackId: z.uuid(), version: z.int() }),
  async (payload, ctx) => {
    // ctx: jobId, attempt, isLastAttempt, stationId, signal (aborted on shutdown)
    // Throw to retry (10 s, 1 min, 10 min, then the DLQ).
    // Throw NonRetryableError to go straight to the DLQ.
  },
  { lane: 'bulk', idempotencyKey: (p) => `track:${p.trackId}:${p.version}` },
);
```

Put the payload schema in `packages/shared/src/contracts/<domain>.ts` when the api enqueues the job too, and declare it there with `jobType(name, schema, options)`, so the api doesn't import worker code.

## Enqueuing
```ts
const queue = await connectQueue(process.env.RABBITMQ_URL!); // declares the topology
const jobs = createJobPublisher(queue.rabbit, queue.topology);
await jobs.enqueue(peaksJob, payload, { stationId });
```

In the api, use `createRabbit()` from `apps/api/src/plugins/rabbit.ts`.

## Real-time events
`createEventPublisher(rabbit, topology, schema)` and `subscribeEvents(rabbit, topology, schema, onEvent)`. Every subscriber receives every event, best effort: for the UI.

For side effects (alerts, actions, emails), use `consumeEventsDurable(rabbit, topology, name, schema, onEvent, { keyOf })`: one durable queue per `name`, one active consumer at a time across processes, in order per key (a failing event is retried in place and blocks its key until it succeeds or is given up), acked once handled, kept while nobody consumes. Handlers must be idempotent (deduplicate on the event id). See "Event transport" in ADR 0006.

The `notify` lane is for jobs the api consumes itself (alert emails): the worker only consumes the lanes of its own jobs.

## Job status
`JobRunStore` records each run (`running`, `retrying`, `succeeded`, `dead`) and backs the admin job list (`store.list({ status: 'dead' })`). The worker uses `PostgresJobRunStore` from `@ondes/db`; `InMemoryJobRunStore` is for tests and single-process dev.

Idempotency: a derived key (payload hash) only collapses duplicates that are in flight at the same time; an explicit key (`idempotencyKey` on the job or at enqueue) blocks forever once a run succeeded. See ADR 0006.

## Tests
`pnpm vitest run packages/queue` (unit) and `pnpm test:integration` (needs RabbitMQ from `pnpm dev:up`, or `RABBITMQ_URL`). Integration tests use a random name prefix and delete their queues afterwards.
