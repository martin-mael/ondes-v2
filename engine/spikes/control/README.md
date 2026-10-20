# Spike: Liquidsoap 2.4 control & just-in-time feeding (#13)

Validates, with running code, how Node drives a station engine. The outcome is
`docs/adr/0002-engine-control.md` (the engine adapter contract) and the draft zod contract
in `packages/shared/src/contracts/engine.ts`.

The spike drives the real template draft, `engine/templates/station.liq`, so whatever it
proves holds for the template too.

## Run it

```sh
docker compose -f engine/spikes/control/compose.yml run --rm --use-aliases driver
docker compose -f engine/spikes/control/compose.yml down -v
```

It takes about two minutes and exits non-zero if a check fails. The project is
self-contained (its own Icecast), so it neither needs nor disturbs `pnpm dev:up`. Listen along
at <http://127.0.0.1:8100/spike.mp3> while it runs.

## What's in here

| File | Role |
|---|---|
| `compose.yml` | `fixtures` (one-shot), Icecast, three engines from the same template, a stand-in `dj` and the `driver`. Only Icecast is published (127.0.0.1:8100). |
| `dj.liq` | Stand-in DJ: streams MP3 to the engine's live harbor over the Icecast protocol, started and stopped by the driver. |
| `fixtures.ts` | Writes sine-tone WAVs into a shared volume, so there are no binary fixtures in git. |
| `spike.ts` | The driver: plays the api's part. Calls the control API, serves the events and live-auth webhooks, streams a live source, and checks every payload against the zod contract. |

The three engines:
- `engine`: the full chain, events pushed to the driver, live auth through the driver's webhook.
- `engine-emergency`: empty safety directory, so a dry queue falls through to `single()`.
- `engine-bare`: no safety and no emergency file, so only `mksafe` is left. No events URL: the
  driver pulls `GET /v1/events` instead.

## What the driver checks

1. Health, bearer token on the control API, state snapshot matching the contract.
2. Empty queue at boot plays the safety playlist; `engine.started` is event #1.
3. Push validation: missing file → 422, bad body → 400.
4. Push A (cue 2→12 s, −6 dB, butt splice into B), B (fade-out), C, D; remove D; 404 on the second remove.
5. A refilled dry queue takes over from safety immediately.
6. As-run timing: A airs 10 s, B airs about 12 s (2 s default crossfade into C).
7. `liq_amplify`: A is about 6 dB below B, measured from `output_db` in `/v1/state`.
8. Skip on the last queued item → safety.
9. `blank.detect` on a silent item, then recovery; queue running dry → safety.
10. Live: a bad login is refused by the webhook, a slow (2 s) webhook doesn't stall audio, a
    connected DJ stays off air until Node opens the gate, takes over at once when it does, and
    hands back to automation on disconnect.
11. Node outage: the events endpoint answers 503 for 4 s, the engine redelivers in order.
12. Event log integrity (no gaps, no duplicates) and `GET /v1/events?after=0` returning the same log.
13. Emergency `single()` and `mksafe` + `blank.detected` on the other two engines.
14. Prometheus exposes the station gauges and Liquidsoap's latency metrics.

The findings, measurements and surprises are in ADR 0002 and in the exit report on #13.
