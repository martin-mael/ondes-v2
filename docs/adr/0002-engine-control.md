# ADR 0002: Engine control: harbor HTTP + JSON, pushed events, just-in-time queue

- Status: accepted. Amended 2026-10-20: island joins follow spike #12; contract v1 finalised by #28 (see "Contract v1" below).
- Date: 2026-10-20
- Issue: #13 (spike). Consumers: #27 (template), #28 (adapter).

## Context
Node owns the log; each station runs one Liquidsoap process that only executes it and reports what aired (spec #1). We needed to know, on the pinned Liquidsoap and with working code rather than docs, how Node feeds that process just in time, how it controls it, and how the process reports back without ever risking the audio.

Everything below was validated by `engine/spikes/control` (a Node driver plus three engine containers built from `engine/templates/station.liq`). Run it with the commands in its README.

## Liquidsoap version
Pin **`savonet/liquidsoap:v2.4.6`** (latest 2.4.x, published 2026-10-18), as `deploy/compose.dev.yml` already does. Use the full image, not `-minimal`: we need ffmpeg decoders and the Prometheus server. `pnpm test:engine` reads the tag from the compose file, so it's pinned in one place.

## Decision

### Transport: harbor HTTP + JSON, not telnet
Each engine serves a small control API with `harbor.http.register` on an internal port (`ENGINE_CONTROL_PORT`, default 7000). The telnet server and the Unix socket server are **disabled** (`settings.server.telnet := false`).

| | harbor HTTP (chosen) | telnet / socket server |
|---|---|---|
| Payloads | JSON both ways, typed on the Liquidsoap side with `let json.parse (x : {...})` and on Node with zod | Line protocol, `END` terminators, ad-hoc parsing |
| Errors | HTTP status codes (400, 401, 404, 422) with `{error}` | Free-text replies |
| Concurrency | One request per connection; Node uses plain `fetch` with timeouts | One stateful connection to serialise |
| Surface | Only the routes we register | Every built-in command (`var.set`, `request.trace`, source internals) |
| Auth | Optional bearer token checked in the handler | None |

**Exposure rules:**
- The control port and Prometheus port (9599) are never published. Only the api container shares the station's Docker network.
- Harbor binds every harbor port to `settings.harbor.bind_addrs` (one global list), so the control port listens on the same addresses as the live port. Isolation therefore comes from the network, not the bind address. Put live on its own port (`ENGINE_LIVE_PORT`, 8005) and publish only that one, through the reverse proxy.
- As defence in depth, the api passes `ENGINE_CONTROL_TOKEN` and sends `Authorization: Bearer <token>`. `GET /v1/health` is the only unauthenticated route (healthchecks).

### Commands (Node → engine)
All under `/v1`, JSON bodies, schemas in `packages/shared/src/contracts/engine.ts`.

| Route | Body | Answer |
|---|---|---|
| `GET /v1/health` | – | `{status, boot_id, version}` |
| `GET /v1/state` | – | `{boot_id, station_id, version, uptime, seq, on_air, queue[], live: {enabled, connected, ready}, blank, output_db}` |
| `GET /v1/events?after=<seq>` | – | event log after `seq` (last 1000 kept) |
| `POST /v1/queue` | `{item_id, uri, cue_in?, cue_out?, fade_in?, fade_out?, amplify_db?, cross_in?, cross_out?, title?, artist?}` | `201 {rid, item_id, uri, status}`, `422` if the file can't be resolved, `400` on a bad body |
| `POST /v1/segment` | `{segment_id, parts: [{item_id, uri, cue_in?, cue_out?, amplify_db?, title?, artist?}] (2–16), fade_in?, fade_out?, cross_in?, cross_out?}` | `201 {segment_id, requests[]}`, `422` if any part can't be resolved (nothing queued), `400` on a bad body. Added by #28, served by #27. |
| `DELETE /v1/queue/:id` | – | `{removed}` (requests): every queued entry whose `item_id` or `segment_id` is `id`. Naming one part of a segment removes the whole segment. `404` if none |
| `DELETE /v1/queue` | – | `{removed}` (clears the queue) |
| `POST /v1/skip` | – | `{skipped}`: ends whatever is on air (a whole segment, if one plays) |
| `POST /v1/live` | `{enabled}` | opens or closes the live gate; `409` if live is disabled in the station settings |

Notes:
- **Push resolves synchronously.** The handler calls `request.resolve` before `queue.push`, so a 201 means the file is local and decodable. A missing file in the playout cache is reported to Node at push time, not discovered on air. A push costs about 30 ms.
- `uri` is a path in the station's local playout cache. Liquidsoap never reads S3.
- **Remove works on queued items only.** `queue.queue()` lists every pushed request with its `ondes_item_id`. Once an item is on air, use `skip`. Nothing is hidden by prefetch: `request.queue` in 2.4.6 only prepares the next request at the end of the current one.
- There is no "reload" command. A settings change regenerates the script and restarts the container (#27). The safety playlist reloads itself when its directory changes (`reload_mode="watch"`).
- `remaining` is not in the state: see "Thread safety" below. Node knows every item's planned duration and computes it from `elapsed`.

### Just-in-time feeding
Node keeps the engine queue **2–3 items or about 10 minutes ahead** (spec), pushing the next item when a `track.started` arrives. If the queue runs dry, the safety playlist plays and the adapter raises an alert. When Node pushes again, the log takes the air back straight away (`fallback(track_sensitive=false)`) through the normal crossfade. A "re-plan" (the log changed) is `DELETE /v1/queue` followed by fresh pushes. The item on air keeps playing unless Node also skips it.

### Per-item metadata: what 2.4.6 honours
The template turns push fields into `annotate:` metadata (values quoted with `string.quote`; titles with quotes, commas and colons survive). Validated:

| Contract field | Liquidsoap key | Honoured by | Result |
|---|---|---|---|
| `cue_in`, `cue_out` | `liq_cue_in`, `liq_cue_out` | request resolution (built in since 2.3; `cue_cut` is deprecated) | ✅ a 2→12 s cue airs 9.96–10.10 s |
| `amplify_db` | `liq_amplify` (`"-6. dB"`) | `amplify(override="liq_amplify", 1., s)` on each branch, **before** the crossfade | ✅ about −6 dB measured |
| `fade_in`, `fade_out` | `liq_fade_in`, `liq_fade_out` | `crossfade` (passed to `cross.simple` as initial fade metadata) | ✅ |
| `cross_in` | `liq_cross_start_duration` | `crossfade` | ✅ |
| `cross_out` | `liq_cross_end_duration` | `crossfade` | ✅ |
| `item_id` | `ondes_item_id` (ours) | our as-run callback | ✅ |
| – | `ondes_source` (ours) | tags each branch: `queue`, `safety`, `emergency`, `live` | ✅ |

**Crossfade overlap = min(outgoing `cross_out`, incoming `cross_in`).** Set both to the planned overlap. **0 on both = an abrupt cut, but not a sample-exact one:** the `crossfade` operator is frame-granular, and spike #12 measured up to ~443 samples lost at such a boundary. **Never use it for island joins.** Unset means the station default (`ENGINE_CROSS_DURATION`).

**Island chains (#54) are pushed as one merged segment**, never as separate queue items. The segment is `A body → island → B body`, built with `sequence(merge=true, [...requests, source.fail()])`, with `liq_amplify` applied per request inside it, cue-ins on the playout copy's 1024-sample grid, and cue points biased by half a sample. The station crossfade then sees the chain as one track. See `engine/spikes/splice/RESULTS.md`; the push API for segments is designed in #29 and #57.

**Don't use `liq_cross_duration`.** In 2.4.6 it sets both ends of the track at once, and it decouples the track's metadata from its track mark: the mark comes at the start of the transition with empty metadata, and the metadata only arrives once the track's audio starts. The audio is right (no dead air), but anything keyed on `on_track` loses the item id. Use the start/end keys.

### Events (engine → Node)
Envelope: `{v: 1, seq, boot_id, station_id, at, type, data}`. `seq` is 1, 2, 3, … per boot and `boot_id` changes on every start. `at` is Unix epoch seconds (UTC, float).

| Type | Data |
|---|---|
| `engine.started` | `{version}` (always seq 1) |
| `track.started` | `{item_id, source, title, artist, filename, rid}` |
| `track.ended` | `{item_id, source, started_at, played}` |
| `live.connected` | `{headers}` |
| `live.disconnected` | `{}` |
| `live.gate` | `{enabled}` |
| `blank.detected` / `blank.recovered` | `{}` |

**Delivery.** Callbacks run on the clock thread and only append to an in-memory log (the last 1000 events). A separate `thread.run(fast=false)` POSTs new events to `ENGINE_EVENTS_URL` as an ordered JSON array, with a 2 s timeout and backoff from 0.2 s up to 5 s. It moves its cursor only on a 2xx, so delivery is **at least once, in order**. The adapter dedupes on `(boot_id, seq)`. On a gap, a new `boot_id` or a reconnect, it backfills from `GET /v1/events?after=<last seq>` and reconciles with `GET /v1/state`. Only the clock thread writes the log and only the sender reads it, so the two never race.

**As-run is keyed on metadata, not track marks.** The callback sits on the final mix (after the live fallback and the crossfade, right before `blank.detect` and the output). A new request id (`rid`) means a new item. Sources without requests (live) are keyed by `ondes_source`. A repeated track mark for the same request (a looping `single()`) also counts. `track.started.at` is when the item's metadata reached the final mix: the start of the overlap for a default crossfade, or the moment the item's own audio starts when it carries crossfade overrides. It can lag the first audible fade-in by up to the crossfade length (we measured 1.6–2.0 s for a refilled dry queue with a 2 s crossfade). As-run timings between consecutive items are accurate to ±0.1 s (a 2→12 s cue measured 9.96–10.10 s). `track.ended.played` is the time until the next item started.

Engine up/down is the adapter's job (failed `/v1/health`, a new `boot_id`), not a wire event.

### Measured (last full spike run, 36/36 checks)
| What | Value |
|---|---|
| Push (resolve + queue), per item | 32 ms |
| Skip → next `track.started` | 30–220 ms |
| Event delivery, engine → Node | median 145 ms; 4 s worst case, during a simulated 4 s Node outage, with no loss and no duplicates |
| `blank.detect` with `max_blank=4` | fires 4.0 s into silence |
| Live: gate opened → on air | 146 ms |
| `liq_amplify -6 dB` | −18.0 dB vs −12.0 dB for the same tone |

### Thread safety (surprise)
**Handlers (harbor threads) and `thread.run` callbacks must not call source methods that pull audio state, `remaining()` in particular.** In 2.4.6, polling `remaining()` on the crossfade/fallback chain from the harbor thread crashes the engine at the next track boundary: `source called while not ready!`, then `Error: Source.Unavailable`, and the process exits (code 2). We reproduced it deterministically. Calling `skip()`, `queue.queue()`, `queue.length()`, `push`, `remove`, `set_queue`, `is_ready()`, `is_blank()` and `dB_levels()` from other threads is fine; `skip()` only sets a flag the clock acts on. Rule for #27/#28: **handlers read refs that the clock thread keeps up to date, and act on the queue.** Production should still assume the engine can die: give the container a restart policy and an Icecast fallback mount (#31).

### Source chain and never-silent
```
live (input.harbor, gated) ─┐
                            ├─ fallback(track_sensitive=false, 1 s fades) → as-run → mksafe → blank.detect → outputs
queue ─ amplify ┐           │
safety ─ amplify ├─ fallback(track_sensitive=false) → crossfade ┘
emergency loop ───┘
```
- **Queue dry → safety playlist** (local files, randomised, reloaded on change). Validated.
- **No safety files → emergency loop.** Validated. Surprise: `single()` on a local file is typed **fallible** in 2.4.6, so the chain needs `mksafe` to type-check at all. Since #34 the loop is a `request.dynamic` that asks for the file again at every loop: `single()` never picks up a file that appears after boot, which the playout cache can't guarantee (measured on 2.4.6, see ADR 0007).
- **Nothing at all → `mksafe`** streams silence, `blank.detect` fires and the adapter alerts. Validated with a missing emergency file: the script still starts. `blank.detect` must sit **after** `mksafe`: before it, a chain with nothing ready produces no frames, so no silence is ever detected.
- **Boot:** for about 1 s the emergency file is on air before the safety playlist resolves (track-insensitive fallback switches as soon as it's ready). Harmless, but the station "starts" on the emergency file. #27 can delay the output's start if that matters.

### Live
- `input.harbor` on its own port and mount, `buffer=5`, `max=10`. A DJ is `connected` as soon as the login succeeds but only `ready` (able to take the air) once `buffer` seconds are buffered. `GET /v1/state` reports both.
- `live.connected` carries the source client's headers **minus `Authorization`**: the raw headers contain the DJ's Basic credentials.
- Harbor decodes what DJ software sends (MP3/Ogg/AAC over the Icecast `PUT`/`SOURCE` protocol). A raw WAV stream is rejected by its ffmpeg demuxer, so don't build test clients that way: the spike uses a second Liquidsoap as a stand-in DJ.
- **Auth:** the template calls Node's webhook (`ENGINE_LIVE_AUTH_URL`, body `{user, password, address}`, 2xx = accept). This is how multiple DJ identities (#62) stay in Node's database. The webhook runs on the harbor thread. A 2 s slow webhook did not disturb the audio.
- **Gate:** a connected DJ only takes the air when Node has opened the gate (`POST /v1/live {enabled:true}`), for example at a live slot's start. The `switch(track_sensitive=false)` + `fallback(track_sensitive=false)` pair makes the takeover (measured 146 ms from the command to `track.started`) and the hand-back on disconnect immediate, with 1 s fades. The `ondes_source=live` tag goes **above** the gate switch: below it, a DJ who connected while the gate was closed never produces metadata on air, and as-run misses the takeover.

### Metrics
`settings.prometheus.server := true` on 9599 (internal). The template adds `ondes_engine_queue_length`, `ondes_engine_on_air_source{source}`, `ondes_engine_live_connected`, `ondes_engine_blank` (all labelled `station`) and `prometheus.latency` on the final mix (`liquidsoap_*` latency gauges).

## Contract v1 (#28)
Finalised in `packages/shared/src/contracts/engine.ts`; additive over the spike draft, so the spike template still conforms.
- **Island segments:** `POST /v1/segment` above. Per-part fields are the request fields (file, cues, gain, ICY metadata); transition fields (`fade_*`, `cross_*`) apply to the whole segment, into and out of it. The template builds it as `sequence(merge=true, [...requests, source.fail()])` and tags each part with `ondes_segment_id`.
- **`segment_id`** (optional, nullable) on queued requests, on `on_air` in the state, and in `track.started` / `track.ended`. As-run stays keyed on `rid`, so each part still reports its own `track.started` with its own `item_id`.
- **`config_version`** (optional) in `GET /v1/health` and `GET /v1/state`: hash of the template and settings the script was rendered from (#27), so the api can spot a script waiting for a restart.
- **Entry ends are frame-granular** (#27 finding): at a normal crossfade boundary an entry can air up to about one frame (441 samples measured) past its `cue_out`, even with `cross_out=0`. Harmless outside island joins, but as-run and back-timing must not expect sample accuracy at entry ends.
- **Queued `uri`** is Liquidsoap's request URI, i.e. the pushed path behind the `annotate:` prefix.
- **Domain events.** The adapter publishes engine events on the RabbitMQ fanout as `engine.*` events defined in `packages/shared/src/contracts/events.ts` (camelCase, ISO times, deterministic ids from `(station, boot_id, seq)`), plus `engine.up` / `engine.down` from health polling. Wire `engine.started` becomes `engine.booted`.
- **Events endpoint:** `POST /internal/engine/stations/:stationId/events` on the api. 200 when published, 503 when it couldn't publish (the engine redelivers), 400/404/409 for wiring bugs. It can require a bearer token once the template sends one.

## Consequences
- #28 implements `EngineAdapter` over `fetch` with the schemas in `@ondes/shared`, an events endpoint (dedupe on `(boot_id, seq)`, gap backfill) and the live-auth webhook. It publishes engine events on RabbitMQ and SSE.
- #27 turns `engine/templates/station.liq` into a generated template. Its environment variables are the settings to render. Keep the route paths, metadata keys and event types in sync with the contract file; contract changes follow the `contract:` PR rule.
- The wire format is snake_case because it maps one to one onto Liquidsoap metadata; the adapter maps it to domain types.
- Open points: an engine-side gauge for "seconds of audio queued" (needs durations from Node); islands (#54) are settled by spike #12 (one merged segment, see above); per-station processing chain (#27).
