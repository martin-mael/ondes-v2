# Alerts (#33)

A generic, station-scoped alert framework, plus silence detection on top of it.
Contracts: `packages/shared/src/contracts/alerts.ts` (model, API, silence settings) and the
`alert.*` events in `contracts/events.ts`. Tables: `packages/db/src/schema/alerts.ts`.

| File | Role |
|---|---|
| `repo.ts` | Queries: raise (dedupe + escalation, race-safe), resolve, acknowledge, list, escalation sweep, recipients, silence settings. |
| `service.ts` | `createAlertService`: the repo plus `alert.*` events on the fanout and emails. `app.alerts` in the api. |
| `engine-alerts.ts` | Engine events (#28) → alerts, and the silence action. |
| `routes.ts` | API under `/api/v1/stations/:stationId/…`. |
| `plugin.ts` | `alertsPlugin`: decorates `app.alerts`, mounts the routes, subscribes to the fanout, runs the escalation sweep. |
| `emails.ts` | The critical-alert email. |

## Model

- **Type**: an open `<domain>.<what>` string (`engine.silence`, `engine.down`,
  `stream.source_missing`). Add yours to `alertTypes` in the contract; nothing else changes.
- **Severity**: `info` < `warning` < `critical`. It only goes up.
- **Dedupe key**: one problem, one key (`engine.silence`, `stream.source_missing:main.mp3`).
  There is at most one *open* alert per (station, key), enforced by a partial unique index.
  Raising an open alert again bumps `occurrences` and `lastSeenAt`. At a higher severity, it
  escalates the alert. Concurrent raises (two replicas, a redelivered event) collapse into one.
- **Lifecycle**: raised → (escalated) → resolved. Acknowledged (`acknowledgedAt`/`By`) is
  orthogonal: the alert stays open until its cause is gone or someone resolves it by hand.
  After a resolve, the next raise opens a new alert.
- **Escalation**:
  - `escalate: { afterSeconds, to }` on raise schedules it.
  - The plugin's sweep (every 5 s, `SKIP LOCKED` across replicas) applies due escalations,
    acknowledged or not.
  - Resolving cancels it.

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

`raise` returns `{ kind: 'raised' | 'escalated' | 'repeated', alert }`. Act on `raised` only when
an automatic action must run once.

**Side effects**, done by the service:
- It publishes `alert.raised` / `alert.escalated` / `alert.acknowledged` / `alert.resolved`.
  A repeat raise publishes nothing.
- When an alert *becomes* critical (raised critical, or escalated to it), it emails every
  member with `alert:manage` on the station and a verified address: station managers, org
  owners and admins.
- Publish and email failures are logged, never thrown.

## API

| Route | Permission |
|---|---|
| `GET /alerts?status=open\|resolved\|all&type=&limit=&before=` | `alert:read` |
| `GET /alerts/:alertId` | `alert:read` |
| `POST /alerts/:alertId/acknowledge` (idempotent, 409 once resolved) | `alert:manage` |
| `POST /alerts/:alertId/resolve` (409 if already resolved) | `alert:manage` |
| `GET /silence-settings` | `alert:read` |
| `PATCH /silence-settings` | `alert:manage` |

Mutations are audited (`alert.acknowledge`, `alert.resolve`, `silence_setting.update`).

## Silence

The engine template detects silence: `blank.detect` on the final mix, after `mksafe` (#27,
ADR 0002). The adapter publishes `engine.blank.detected` / `recovered` on the fanout. This
module turns them into alerts.

**Settings** (`GET/PATCH /silence-settings`, defaults for anything unset):

| Setting | Default | Stored in | Meaning |
|---|---|---|---|
| `maxSeconds` | 10 | `station.engine_settings.blank` | Seconds of silence before an alert (template `max_blank`) |
| `thresholdDb` | -40 | `station.engine_settings.blank` | Below this level counts as silence (template `threshold`) |
| `action` | `skip` | `silence_setting` | What to do on silence |
| `escalateAfterSeconds` | 60 | `silence_setting` | How long silence can last after the action before the alert goes critical |

The detection values live where the engine lifecycle (#35) renders from: `station.engine_settings`,
same ranges and defaults as the template's `blank` (`settings.test.ts`). A change publishes
`alert.silence_settings.updated`; the lifecycle reconciles the station on it (a restart only if
the rendered `config_version` changed).

**Events → alerts:**
- `engine.blank.detected`: raise `engine.silence`.
  - With an action, the alert is a `warning` that escalates to `critical` after
    `escalateAfterSeconds` of continued silence.
  - With `none`, it is `critical` at once.
  - The action runs only for the raise that opened the alert. What it did is stored in
    `details.action`.
- `engine.blank.recovered`: resolve (`recovered`).
- `engine.booted`: resolve (`engine_restarted`). A new boot has a fresh detector, which fires
  again if it is still silent.
- `engine.down` / `engine.up`: raise a critical `engine.down` / resolve it (`engine_up`).

**Actions**, through the engine adapter (`alertsPlugin({ engineFor })`):
- `skip`: `skip()`, which ends the silent item on air.
- `safety`: `clear()` then `skip()`. With an empty queue the template's fallback plays the
  safety playlist. The feeder (#29) refills the queue on its next push, so this holds until
  then.
- `none`: alert only.

## Tests

- **Unit**: `pnpm vitest run apps/api/src/modules/alerts`.
- **Integration**, `alerts.int.test.ts`: Postgres + RabbitMQ from `pnpm dev:up`. Engine events
  go through the fanout, with the fake engine from #28. Covers raise, dedupe, escalation,
  acknowledge, resolve, actions, email, API permissions, tenancy and races.
- **Engine level**, `silence.int.test.ts`: Docker. It runs the real template in its own compose
  project, `testing/compose.yml` (`ondes-alerts-it`, control 127.0.0.1:17280, events server on
  :17281; override with `ALERTS_IT_CONTROL_PORT` / `ALERTS_IT_EVENTS_PORT`). A silent file in
  the queue fires `blank.detected` within `maxSeconds`, raises the alert, gets skipped, and the
  alert resolves on `blank.recovered`. It never touches the shared `ondes-dev` stack.
