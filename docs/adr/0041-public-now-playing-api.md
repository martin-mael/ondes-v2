# ADR 0041: Public now-playing API: one shared snapshot per station, an anonymous stream, OpenAPI from the contracts

- Status: accepted
- Date: 2026-10-27
- Issue: #74 (epic #73). Builds on ADR 0034 (on-air view), 0015 (as-run), 0027 / 0033 (live),
  0010 (station slugs in public URLs). Built on by: the schedule API and ICS (#75), widgets (#76).

## Context
The station website (vandaleradio.org first) needs what is on air, what is next, what aired, and
a live update, with no account. The internal on-air snapshot (ADR 0034) has everything but is
authenticated, keyed by station id, and full of internal data: as-run and log item ids, the
engine's source, cue markers, the next jingles and VTs by their internal names. The internal
SSE stream checks a credential and permissions per client and carries alerts and log edits.
A public endpoint can be hit by every listener's browser at once, and by scrapers.

## Decision

### Routes: `/api/v1/public/stations/:slug/…`, anonymous, by slug
- `GET …/now-playing`: `station` (slug, name, timezone), `mode` (`automation`, `show`, `live`,
  `off_air`), `live` (flag), `current` (kind, title, artist, `startedAt` on the engine clock,
  `durationMs`), `show` (name, colour, artwork, block times, episode number and title, rerun),
  `liveInfo` (DJ name, event or show title) and `next` (up to 3 tracks or episodes, with their
  estimated start).
- `GET …/history?limit=` (1–50, default 20): tracks, episodes and live blocks that left the air,
  newest first.
- `GET …/events`: now playing over SSE.
- `GET /api/v1/public/openapi.json`.

The station is named by `station.slug`, already globally unique and public (it is in the
Icecast mount names, ADR 0010). Ids never appear: not the station's, nor any as-run, log item,
session, show or user id. The schedule API (#75) adds its routes under the same prefix.

### The public cut
`apps/api/src/modules/public/service.ts` maps the on-air snapshot and the as-run, and every
snapshot is parsed through `packages/shared/src/contracts/public.ts` before it is cached, so a
field that isn't in the public contract can't leak even if the internal shapes grow.
- Safety playlist → `automation` (music is playing). The emergency loop → `off_air` (it's the
  "we'll be back" file) with no `current`.
- Jingles, VTs, beds, fills and promos are `interlude` with no title or artist: their titles are
  the station's internal names ("VT Marie 14h"). `next` and history keep only songs and
  episodes (plus live blocks in history); history drops `skipped` entries and the item on air.
- Live: `current.kind` is `live`; its title and artist come from live metadata (#68, below),
  else null. `liveInfo` has the DJ (the as-run entry's snapshot, else the open session's) and
  the event's title, else the show's name.

### One shared snapshot per station, rebuilt on events
`snapshot.ts` keeps one serialised body per station per process, with a strong ETag. Concurrent
readers wait for the same build; nothing is queried per request. A snapshot is rebuilt when:
- an event for its station arrives on the RabbitMQ event fanout (the same subscription kind as
  the SSE plugin): `asrun.*`, `engine.up/down/booted/track.started`, `log.updated`,
  `log.item.changed`, `feeder.item.passed_over`, `live.session.*`, `live.metadata.changed`,
  `asset.updated`, `station.updated` (which also drops the slug lookups);
- its TTL runs out (30 s) or the show block it shows ends (no event marks that, ADR 0034).
History is a second snapshot (last 50, sliced per `limit`, each slice serialised once),
invalidated by `asrun.ended`. Slug lookups are cached for 60 s, misses included.

The ETag hashes the content without the snapshot's own `at`, so a rebuild with nothing new is a
304 and no new SSE frame. Responses carry `Cache-Control: public, max-age=5` (history 15) with
`stale-while-revalidate`, so a CDN in front can absorb more.

Each replica keeps its own snapshots, fed by the same fanout: N replicas cost N builds per
change, not one per listener. Rejected: a query per request (a listener spike is a database
spike), and a snapshot in Postgres or Redis (one more moving part for a few kB that the fanout
already keeps fresh).

### The public stream
`stream.ts`, not the internal SSE plugin: no credentials, no permission filter, no replay. A
listener gets the current snapshot on connect, then a `now_playing` event (whole object, `id` =
ETag) whenever the content changes. Per station, a change is debounced 250 ms (edits come in
bursts), the snapshot is rebuilt once from the cache and the same frame is written to every
listener. One process-wide timer sends heartbeats and ends streams after ~30 min (minus up to
10 %, spreading reconnects over replicas). No `Last-Event-ID` replay: the first frame is the
whole state. Caps: 10 open streams per client IP (429), 10 000 per process (503), slow
listeners (256 kB unflushed) dropped.

Rejected: reusing the internal plugin with a "public" permission set. Its events are internal
shapes (as-run entries with ids); a public variant of each would be the same work as one public
snapshot, and its per-client revalidation and replay buffers make no sense for anonymous
listeners.

### CORS, rate limits
- `Access-Control-Allow-Origin: *`, no credentials, `ETag` and rate-limit headers exposed. An
  `OPTIONS` handler answers preflights (`If-None-Match` and `Last-Event-ID` aren't safelisted).
  Hand-rolled in the module's scope rather than `@fastify/cors`: one origin rule, three headers.
- `@fastify/rate-limit` (already registered by the auth plugin, `global: false`) per client IP
  (`trustProxy` behind Caddy): 120 requests/min on REST routes, 20 stream connections/min.
  Options in `AppOptions.publicApi`.

### OpenAPI: generated from the zod contracts
`openapi.ts` holds `publicOperations`: path, summary, description, params/query schemas and
responses. `plugin.ts` registers the routes from those very schemas, and `buildOpenApi()` turns
them into an OpenAPI 3.1 document with zod 4's `z.toJSONSchema` (shared shapes, `.meta({ id })`,
hoisted into `components.schemas`). Descriptions live on the contract fields (`.meta`).
Rejected: a hand-written YAML file (drifts from the code silently) and `@fastify/swagger` (a
dependency and a route-introspection layer for three routes; it would also see internal routes).
#75 appends its operations to `publicOperations`; `openapi.test.ts` checks every `$ref`
resolves and `public.int.test.ts` that each documented route exists.

### Live metadata (#68)
`PublicPluginOptions.liveNowPlaying: (db, scope) => Promise<LiveNowPlaying | null>` with
`{ title, artist, source: 'default' | 'encoder' | 'manual', updatedAt }`, called only while the
station is live. Default: none (the live item shows the DJ and the show). #68 provides the
reader (`getLiveNowPlaying` in `apps/api/src/modules/live/metadata.ts`: its `default` source is
the show and episode as title, the DJ as artist; `encoder` and `manual` override it) and emits
`live.metadata.changed` (only `type` and `stationId` are read, loosely, so the
event doesn't have to be in the contract first); the wiring in `app.ts`/`main.ts` lands at
integration.

## Consequences
- Every station with a slug is public. A per-station switch (hide `next`, hide the API
  entirely) is a follow-up if a tenant asks.
- Shows have no slug yet; #75 needs one for show pages and adds it.
- Changes with no event (calendar edits, a DJ's display name) show at the next item change or
  within the 30 s TTL.
- Estimates in `next` are ADR 0034's; while the item on air overruns they slide at each rebuild.
- A CDN or Caddy cache in front is optional; the api alone serves the expected load (one build
  per change, then memory writes).
