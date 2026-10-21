# ADR 0006: Job queue client and topology

- Status: accepted
- Date: 2026-10-20
- Issue: #8

## Context
ADR 0001 picked RabbitMQ 4 behind a thin `@ondes/queue` wrapper and left the AMQP client to #8. Every async process (ingest, analysis, renders, log generation, cache sync) and the real-time event fanout goes through it, so it needs reconnection, publisher confirms and typed APIs, and must run on Node 24 without a build step.

## Decisions

### Client: `rabbitmq-client` 5.1.0
`rabbitmq-client` is written in TypeScript (its own types, no `@types/*` package), has no runtime dependencies, and does what we would otherwise build on top of `amqplib`: it reconnects with backoff and, on every reconnect, redeclares the queues, exchanges and bindings a consumer or publisher needs; consumers have bounded concurrency and ack/nack from the handler's result; publishers wait for broker confirms and retry. `amqplib` is the more widespread library, but its connection and channel objects die on the first network error and every application ends up writing the same reconnect and redeclare logic. Swapping clients later stays cheap: only `packages/queue/src` imports it.

### Topology
Names below use the default prefix `ondes`.

| Name | Kind | Purpose |
|---|---|---|
| `ondes.jobs` | direct exchange | routing key = lane |
| `ondes.jobs.high`, `ondes.jobs.bulk` | quorum queues | one per lane, so bulk analysis never delays engine-related work |
| `ondes.jobs.notify` | quorum queue | notifications the api sends itself (alert emails); consumed by the api, never by the worker (added by #33) |
| `ondes.jobs.retry` | direct exchange | routing key = `<lane>.<delayMs>` |
| `ondes.jobs.<lane>.retry.<delayMs>ms` | quorum queues with `x-message-ttl` | hold a failed job for its tier, then dead-letter it back to `ondes.jobs` with its lane as routing key |
| `ondes.jobs.dead` | fanout exchange + quorum queue | the DLQ |
| `ondes.events` | fanout exchange | real-time events; each subscriber binds an exclusive auto-delete queue |
| `ondes.events.<name>` | quorum queue, single active consumer | a durable consumer of the events (`consumeEventsDurable`), e.g. `ondes.events.alerts` (added by #33) |

- Retry tiers are 10 s, 1 min and 10 min; a job gets 4 attempts, then goes to the DLQ. One queue per tier (instead of per-message TTL) keeps expiry in FIFO order, which quorum queues require. The delay is part of the queue name because a queue's TTL can't change after declaration.
- The worker acks a delivery only after its follow-up message (retry or dead letter) is confirmed. If publishing that fails, the delivery is requeued, and the lane queues' quorum `x-delivery-limit` (5) dead-letters a message that keeps crashing workers. Dead-lettering uses the at-least-once strategy.
- Invalid envelopes, unknown job names, payloads that fail their schema, and `NonRetryableError`s go to the DLQ without retrying.
- Idempotency is enforced on consume, through the `JobRunStore` port. A job is always dropped when it already succeeded (a redelivery). Whether *another* job with the same key blocks it depends on the envelope's `idempotency` mode:
  - `in_flight` (default, with the derived key `<job>:<sha256 of the canonical payload>`): blocked only while that other run is `running` or `retrying`. Concurrent duplicates collapse, but the same work enqueued again later (regenerate a log, resync a cache) runs again.
  - `once` (set automatically when the key is explicit, e.g. `track:<id>:<version>`): also blocked after that other run `succeeded`. An explicit key names one unit of work.
  - (Revised in review of #110: the first version blocked on `succeeded` for every key, which silently dropped legitimate re-runs.)
- Delivery is at least once. Handlers must be idempotent anyway, because a worker can die between finishing a handler and recording success.

### Event transport (added by #33)
Events on `ondes.events` have two kinds of consumers, with different guarantees:

- **UI (SSE, dashboards): best-effort fanout.** `subscribeEvents` gives each api instance its own exclusive, auto-deleted, no-ack queue: every instance sees every event, concurrently, and misses what was published while it was down. Clients resync over HTTP. The SSE plugin relays an allowlist of event types to browsers, never everything on the exchange.
- **Side effects (alerts, automatic actions, emails): durable competing consumers.** `consumeEventsDurable(name, …)` binds one durable quorum queue per `name` with `x-single-active-consumer`. Every api replica consumes it, one at a time is active (failover when it goes away), events arrive in publish order, are handled in order per key (the station) and acked once handled. Events published while no replica runs wait in the queue (TTL 1 h, capped at 100 000, oldest dropped). A handler that keeps failing is retried in process, then requeued. Delivery is at least once: handlers deduplicate on the event id (engine events have deterministic ids) and drop events older than the state they would change.
- Work that must run *where something lives* (an engine command on the replica that holds the station's engine) is recorded in the database by the durable consumer and claimed there by whichever replica can run it, never sent through the fanout alone.
- Never put a side effect on a `subscribeEvents` handler: with N replicas it runs N times, or zero times during a restart.

### Job registry
The worker loads `apps/worker/src/jobs/<job>/index.ts`, whose default export is a `defineJob(...)` named after its folder. Adding a job never touches a shared file.

## Consequences
- Job status lives behind `JobRunStore`. Production uses the Postgres store (`job_run` table in `packages/db`), whose partial unique index on in-flight keys makes duplicate detection atomic across worker replicas. The in-memory store is per-process and prunes finished runs (`maxFinishedRuns`), for tests and single-process dev only.
- Fanout subscriptions are transient: a subscriber that is down misses events, and clients resync over HTTP. Durable event queues (`consumeEventsDurable`) are for consumers that must not miss them.
