# Engine adapter (#28)

Node's side of the engine control contract (ADR 0002, `@ondes/shared` `contracts/engine.ts`).
One `StationEngine` per station:

| Piece | File | Role |
|---|---|---|
| `EngineAdapter` | `adapter.ts` | Typed commands over `fetch`: `health`, `state`, `events(after)`, `push`, `pushSegment`, `remove`, `clear`, `skip`, `setLive`. Bearer token, per-attempt timeouts, zod-checked answers. |
| Errors | `errors.ts` | `EngineUnresolvableError` (422: file not in the playout cache, nothing queued), `EngineNotQueuedError` (404), `EngineConflictError` (409: live input disabled), `EngineUnavailableError` (timeout / unreachable), `EngineUnauthorizedError`, `EngineBadRequestError`, `EngineServerError`, `EngineProtocolError`. All extend `EngineError` with a `code`. |
| Event ingest | `ingest.ts` | Dedupes on `(boot_id, seq)`, backfills gaps and new boots from `GET /v1/events?after=`, publishes domain events, then hands `GET /v1/state` to `onResync`. |
| Health monitor | `health.ts` | Polls `GET /v1/health`; publishes `engine.up` (first contact, recovery, new boot) and `engine.down` (after `downAfter` failed probes). |
| Events route | `route.ts` | `POST /internal/engine/stations/:stationId/events`, the engine's `ENGINE_EVENTS_URL`. A plain handler plus `registerEngineEventRoutes(app, …)` for Fastify. |
| Wiring | `station.ts` | `createStationEngine(...)` and the `StationEngines` registry. An engine coming up triggers an event catch-up. |

## Usage

```ts
const engines = new StationEngines();
engines.add(
  createStationEngine({
    stationId,
    baseUrl: 'http://engine-<station>:7000', // internal network only
    token: process.env.ENGINE_CONTROL_TOKEN,
    publish: (event) => rabbit.events.publish(event),
    onResync: (state, reason) => feeder.reconcile(state, reason), // #29
    logger: app.log,
  }),
);
registerEngineEventRoutes(app, { ingestFor: engines.ingestFor, logger: app.log });
engines.startAll();
```

`engineEventsUrl(internalApiUrl, stationId)` builds the `ENGINE_EVENTS_URL` for the template (#27).

## Rules for callers

- **Retries.** Reads, `clear` and `setLive` are retried on timeouts and 5xx. `push`, `pushSegment`,
  `remove` and `skip` are not: repeating them changes what airs. On an `EngineUnavailableError`
  the feeder reconciles from `state()` instead of re-sending blindly.
- **Timeouts.** 2 s per attempt, 8 s per push (the engine resolves the file before it answers,
  up to 5 s on its side) and 8 s per part for a segment. A dead engine costs at most that; nothing
  here waits on audio.
- **Events.** Published on the RabbitMQ fanout as `engine.*` events from `contracts/events.ts`
  (`engine.up`, `engine.down`, `engine.booted`, `engine.track.started`/`ended`,
  `engine.live.connected`/`disconnected`/`gate`, `engine.blank.detected`/`recovered`). Engine-origin
  events carry `bootId` and `seq` and a deterministic `id`, so consumers dedupe the rare redelivery
  (an api restart between a publish and the engine's ack).
- **A new boot means an empty queue.** `onResync(state, 'boot' | 'catch_up')` comes with the new
  boot's state; the feeder re-pushes from there.
- **Events route exposure.** Internal network only, never behind the public proxy. It can require
  a bearer token (`token` option) once the template sends one on event posts.

## Tests

- Unit: `pnpm vitest run apps/api/src/modules/engine`, against `testing/fake-engine.ts`, an
  in-process HTTP stand-in for the control API.
- Integration: `adapter.int.test.ts` starts `testing/compose.yml` (project
  `ondes-engine-adapter-it`, control port 127.0.0.1:17180, events server on :17181; override with
  `ENGINE_IT_CONTROL_PORT` / `ENGINE_IT_EVENTS_PORT`) with the real station template, and RabbitMQ
  from `pnpm dev:up` (`RABBITMQ_URL`). It never touches the shared `ondes-dev` engine. The segment
  case skips itself until the template serves `POST /v1/segment` (#27).
