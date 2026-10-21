# Alerts (#33)

A generic, station-scoped alert framework, plus silence detection on top of it.
- Contracts: `packages/shared/src/contracts/alerts.ts` (model, API, silence settings), and the
  `alert.*` events in `contracts/events.ts`.
- Tables: `packages/db/src/schema/alerts.ts`.

| File | Role |
|---|---|
| `repo.ts` | Queries for alerts, actions, the event log, engine boots, notifications and silence settings. |
| `service.ts` | `createAlertService`, available as `app.alerts`. Wraps the repo, publishes `alert.*` events, runs actions and sends emails. |
| `engine-alerts.ts` | Turns engine events (#28) into alerts, handles the silence actions and the reconcile. |
| `email-job.ts` | The `alert-email` job (`notify` lane). |
| `routes.ts` | The API under `/api/v1/stations/:stationId/…`. |
| `plugin.ts` | `alertsPlugin`: wires the durable consumer, the email worker, the action fast path and the sweep. |
| `emails.ts` | The critical-alert email. |

## Model

- **Type**: an open `<domain>.<what>` string (`engine.silence`, `engine.down`,
  `stream.source_missing`). Add yours to `alertTypes` in the contract.
- **Severity**: `info` < `warning` < `critical`. It only goes up during an alert's life.
- **Dedupe key**: one key per problem (`engine.silence`, `stream.source_missing:main.mp3`).
  - At most one *open* alert per (station, key). A partial unique index enforces it, so
    concurrent raises collapse into one.
  - Raising an open alert again bumps `occurrences` and `lastSeenAt`. A higher severity
    escalates it.
- **Lifecycle**: raised → (escalated) → resolved.
  - **Reopened**: a key raised again less than 5 min after its resolve reopens the same alert
    (flapping). It gets an `alert.reopened` event and no second email.
- **Acknowledged** (`acknowledgedAt`/`By`) is orthogonal. The alert stays open until its cause
  is gone or someone resolves it by hand. Escalation still raises an acknowledged alert's
  severity, but sends no email.
- **Escalation**:
  - `escalate: { afterSeconds, to }` on raise schedules it, counted from when the problem was
    observed.
  - The sweep applies due escalations once across replicas (`SKIP LOCKED`).
  - Resolving cancels it.
- **Action**: `action: '<name>'` on raise attaches an automatic action (e.g. `engine.skip`).
  - Recorded as `pending` in the alert row.
  - Claimed (`running`) and run once, by a replica whose registered runner says it can
    (`registerAction(name, { available, run })`). Only while the alert is open.
  - A `failed` action is retried once on escalation. A `done` one isn't repeated.

## Using it from another module

```ts
await app.alerts.raise(scope, {
  type: 'stream.source_missing',
  severity: 'critical',
  dedupeKey: `stream.source_missing:${mount}`,
  title: 'Stream has no source',
  details: { mount },
});
await app.alerts.resolve(scope, `stream.source_missing:${mount}`, { reason: 'source_back' });
```

`raise` returns `{ kind }`:
- `raised`, `reopened`, `escalated` or `repeated`, with `alert`;
- `stale`, when `occurredAt` predates the key's last resolve;
- `duplicate`, when `eventId` was already applied.

Pass `{ occurredAt, eventId }` when raising from an event.

**Side effects**:
- **Events**: `alert.raised` / `reopened` / `escalated` / `acknowledged` / `resolved` on the
  fanout, for the UI. Best effort.
- **Email** to members with `alert:manage` on the station and a verified address (station
  managers, org owners and admins), when an alert becomes critical:
  - It's an `alert-email` job on the `notify` lane, consumed by the api. Idempotency key
    `alert-email:<alertId>:<severity>`, so one email per alert and severity.
  - Retries skip recipients already emailed (`alert_notification`).
  - Not sent if the alert has resolved by then. An escalation email is not sent if the alert
    is acknowledged.
  - Not sent if another alert of the same (station, type) was emailed in the last 15 minutes
    (cooldown).

## Event transport

Side effects never run from the per-replica fanout: see "Event transport" in ADR 0006.

- **Engine events**: they reach `engine-alerts.ts` through the durable queue `ondes.events.alerts`
  (`consumeEventsDurable`).
  - One active replica at a time, in order per station.
  - Events published while no api runs wait in the queue.
- **Each event applies once**: `alert_event_seen` dedupes on the event id.
- **Late events are dropped**:
  - an event from an engine boot older than the newest one seen (`alert_engine_boot`);
  - a detection older than the key's last resolve;
  - a recovery older than the alert's last detection.
- **Actions**: the durable consumer records the action. The replica that holds the station's
  engine claims and runs it:
  - right away if that's the consumer itself;
  - otherwise on the `alert.raised` / `reopened` / `escalated` fanout event;
  - the sweep (every 5 s) is the fallback.
- **Reconcile**: every 30 s, open `engine.silence` / `engine.down` alerts not seen for 30 s are
  checked against the engine, if this replica holds it.
  - An engine that answers resolves `engine.down`.
  - An engine that isn't blank resolves `engine.silence`.
  - This covers a recovery that was never delivered.

## API

| Route | Permission |
|---|---|
| `GET /alerts?status=open\|resolved\|all&type=&limit=&before=` | `alert:read` |
| `GET /alerts/:alertId` | `alert:read` |
| `POST /alerts/:alertId/acknowledge` (idempotent; 409 once resolved, even if it resolved meanwhile) | `alert:manage` |
| `POST /alerts/:alertId/resolve` (409 if already resolved) | `alert:manage` |
| `GET /silence-settings` | `alert:read` |
| `PATCH /silence-settings` (partial: omitted fields keep their value) | `alert:manage` |

Mutations are audited (`alert.acknowledge`, `alert.resolve`, `silence_setting.update`).

## Silence

The engine template detects silence: `blank.detect` on the final mix, after `mksafe` (#27,
ADR 0002).

**Settings**, with defaults for anything unset:

| Setting | Default | Stored in | Meaning |
|---|---|---|---|
| `maxSeconds` | 10 | `station.engine_settings.blank` | Seconds of silence before an alert (template `max_blank`) |
| `thresholdDb` | -40 | `station.engine_settings.blank` | Below this level counts as silence (template `threshold`) |
| `action` | `skip` | `silence_setting` | What to do on silence |
| `escalateAfterSeconds` | 60 | `silence_setting` | How long silence may last after the action before the alert goes critical |

The detection values live where the engine lifecycle (#35) renders from, with the template's
ranges and defaults (`settings.test.ts`). After a change:
- the plugin's `onSilenceSettingsUpdated` reconciles the station's engine (wired to #35);
- an `alert.silence_settings.updated` event goes out.

**Events → alerts:**
- `engine.blank.detected`: raise `engine.silence`.
  - With an action, the alert is a `warning` that escalates to `critical` after
    `escalateAfterSeconds`.
  - With `none`, it is `critical` at once.
- `engine.blank.recovered`: resolve (`recovered`).
- `engine.booted`: resolve (`engine_restarted`). A new boot's detector fires again if the
  output is still silent.
- `engine.down` / `engine.up`: raise a critical `engine.down` / resolve it (`engine_up`).
  - Every api replica's health monitor (#35) publishes these, with its own event ids. N
    replicas mean N events per transition.
  - The dedupe key folds them into one alert: `occurrences` counts them. A `down` older than
    the last resolve is stale.

**Actions**, through the engine adapter (`alertsPlugin({ engineFor })`, sync or async; with #35, `(id) => app.engineLifecycle.adapterFor(id)`, which reaches the engine from any replica):
- `skip` (`engine.skip`): `skip()`, which ends the silent item on air.
- `safety` (`engine.safety`): `clear()`, then `skip()`. With an empty queue, the template's
  fallback plays the safety playlist. It holds until the feeder (#29) pushes again.
- `none`: alert only.

If no replica can reach the engine, the action stays `pending`. The alert still escalates and
emails.

## Tests

- **Unit**: `pnpm vitest run apps/api/src/modules/alerts`.
- **Integration** (`alerts.int.test.ts`): Postgres + RabbitMQ (`pnpm dev:up`). It drives the
  durable queue and the fake engine from #28. Covers:
  - raise, dedupe and redelivery;
  - reopen and cooldown;
  - escalation, and escalation after an acknowledge;
  - acknowledge and resolve;
  - the actions, including two replicas with the engine on one;
  - late, out-of-order and stale-boot events;
  - reconcile, the partial PATCH, email recipients, permissions, tenancy and races.
- **Engine level** (`silence.int.test.ts`): Docker. The real template runs in its own compose
  project, `testing/compose.yml` (`ondes-alerts-it`, control 127.0.0.1:17280, events server on
  :17281). It checks that a silent file in the queue:
  - fires `blank.detected` within `maxSeconds`;
  - raises the alert and gets skipped;
  - resolves the alert on `blank.recovered`.
- **Queue** (`packages/queue/src/events-durable.int.test.ts`): `consumeEventsDurable`.
