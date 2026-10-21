# ADR 0012: The log feeder runs in the api, stateless, one lease per station

- Status: accepted
- Date: 2026-10-21
- Issue: #29. Builds on ADR 0002 (engine control), 0003 (hard starts), 0004 (playout cache), 0006 (event transport) and 0008 (engine lifecycle).

## Context
Node plans the log; each station's Liquidsoap only plays what it is pushed (ADR 0002). Something has to keep the engine queue 2–3 items or about 10 minutes ahead of air:
- follow log edits without touching what plays;
- pass over files the playout cache doesn't have;
- re-fill an engine that restarted with an empty queue;
- move the tail so anchored items start on time (ADR 0003).

There are several api replicas, and every one of them holds an adapter for every station's engine (ADR 0008). Exactly one of them may feed a given station.

## Decision

**Where.** The feeder is an api module (`apps/api/src/modules/engine/feeder`), not a worker job:
- it needs the engine adapter and the lifecycle's `adapterFor` (api-side, engine network);
- it reacts within seconds to engine events, which the api ingests;
- it is a long-lived loop per station, not a unit of work with retries.

**Stateless reconcile.** The feeder keeps no plan. Each sync:
1. reads `GET /v1/state` and the log around now (published days only);
2. plans with a pure function (`plan.ts`);
3. keeps the longest queued prefix that matches the plan (same entry, same push body, trim within 250 ms), removes the rest, re-reads the state, and pushes what's missing.

Consequences:
- an engine restart, a missed event, a failover and a log edit are all the same case;
- the item on air is never in the engine queue, so a re-plan can't touch it (acceptance of #29);
- in memory there are only caches: what it pushed during this boot (body fingerprints, to avoid re-pushing), what aired, files the engine refused.

**Triggers.**
- A 5 s tick per station.
- The RabbitMQ fanout (`engine.track.started` / `ended` / `booted` / `up`, `log.updated`). The fanout is best-effort, but here an event only says "sync now": a missed one costs one tick, and since only the lease holder acts, the side effect never runs once per replica (ADR 0006's concern with fanout side effects).
- A durable single-active-consumer queue was rejected: it would pick one replica for *all* stations and doesn't drive the tick.

**One feeder per station: a session-level advisory lock.**
- Each replica reserves one database connection. Every 10 s it calls `pg_try_advisory_lock(hashtextextended('ondes.feeder:<stationId>', 0))` on it for each station whose engine should run.
- The holder feeds the station. The lock dies with the session, so a dead replica frees its stations for the next lease round of another.
- Before every change to an engine queue, the feeder checks that its session is alive.
- A failed lease session is unlocked (`pg_advisory_unlock_all`) before the connection goes back to the pool.
- Rejected: the lifecycle's transaction-scoped lock (held only for one operation), and a lease table with expiry (more code for the same guarantee).

**Hard starts, as far as the engine allows today.**
- The log contract has `hard`, `soft` and `not_before` anchors (#100). The feeder re-plans the tail on every sync:
  - a `hard` overrun drops whole entries, then trims flexible ones (song, bed, fill) down to 30 s, with a fade-out;
  - a `soft` anchor drops what would start after it or end past its cap;
  - a gap bigger than 5 s holds a `hard` or `not_before` item until its anchor;
  - a live slot holds what follows until its end.
- ADR 0003's engine-timed cut (`POST /v1/schedule`) needs a `contract:` change and template work. It is not there yet: what re-planning can't absorb is reported as `late`. The planner already computes the anchor and the residual, so the cut plugs in there.
- Markers (#52) only add anchors the planner already handles.

## Consequences
- Every sync costs one `GET /v1/state` and two queries (the log window, then media for its assets). That's every 5 s per station, plus events.
- Additive contract changes:
  - alert types `feeder.items_skipped` and `feeder.log_empty`;
  - real-time event `feeder.item.passed_over` (`engine:read`): items that will not air, for the log-vs-as-run view (#53). As-run (#30) records only what aired and does not consume it.
- When the log runs dry the feeder pushes nothing and raises `feeder.log_empty`; the template's safety source takes over on its own (#34). The feeder never clears or skips to hand over.
- Follow-ups:
  - `POST /v1/schedule` in the contract, the template and the adapter, then the feeder: schedule `hard` items when they enter the window, and again after a boot.
  - A bed sized at runtime for hard-start gaps (#46).
