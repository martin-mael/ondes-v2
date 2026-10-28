# ADR 0040: Live metadata: one now-playing per live session, decided by Node, sent by the engine

- Status: accepted
- Date: 2026-10-27
- Issue: #68 (epic #62). Builds on ADR 0002 (engine control), 0007 (station template), 0023
  (harbor auth callback), 0027 (harbor pool, live sessions), 0033 (sessions bound to slots and
  events) and 0034 (on-air view). Read by #74 (public now-playing API) and #66 (handover).

## Context
While a DJ was on air the streams showed whatever their software sent, or nothing: harbor
passes the encoder's metadata through, and a DJ with no track info left the automation's last
title on some players. The issue asks for:
- a default now-playing during live: the show and episode, and the DJ;
- the DJ's encoder metadata, when enabled;
- a manual now-playing from the dashboard (a concert: the artist on stage);
- every change on the streams (Icecast metadata) and in the api.

## Decision

### One now-playing per live session, in this order
`live_now_playing` (new table, `packages/db/src/schema/live-metadata.ts`), one row per
`live_session`, deleted with it:
1. **manual**: typed on the dashboard (`PUT …/live/now-playing {title?, artist?}`,
   `engine:control`, audited `live.now_playing.set`), until cleared (`DELETE`, audited
   `live.now_playing.clear`) or the session ends;
2. **encoder**: the last metadata the DJ's software sent, when their streamer allows it;
3. **default**: title = the session's title (the show's name, or the event's title, ADR 0033)
   and ` #<episode>` when it has an episode; artist = the DJ (`live_session.streamer_name`).
   A session with neither (the shared password, an unbound DJ with no name) shows the station's
   name as title.

The row also keeps the last encoder metadata whether or not it was allowed, so allowing it or
clearing a manual text falls back on what the DJ is playing now, not on nothing.

**Per session, so a handover follows the DJ.** A new session (handover, return and back, a
reconnect) starts at its own default: a manual text typed for one DJ never sticks to the next.
#66 has nothing to do for it.

### Where the encoder switch lives: on the streamer
`streamer.encoder_metadata` (boolean, default off), in the streamer dialog ("Show what their DJ
software sends"). Whether an encoder sends usable titles is a property of a DJ's setup (one
fills in Mixxx's track info, another streams "Unknown - Unknown" from OBS), not of a show or a
slot. The station-wide case (a venue's own encoder at a festival) is the manual text.
Rejected: on the slot (ADR 0033 put live settings there, but a slot has many DJs over time and
a show's guest DJ would inherit the resident's choice), on the station (one bad encoder turns it
off for everyone). Changing it mid-set applies at once: the streamer `PATCH` re-derives the
now-playing and sends it to the engine even when its text is the same (the engine's `encoder`
flag changes with it), without waiting for the sweep.

### The engine: Node decides, the template applies (a delimited block in `station.liq`)
- `POST /v1/live/metadata {title, artist, encoder}` sets the now-playing and inserts it on the
  live branch at once if the gate is open (else at the next takeover). `GET /v1/state`
  `live.now_playing` reports what the engine holds.
- A `metadata.map` on the live branch, after the session tags, rewrites every metadata the DJ's
  encoder sends with Node's now-playing, unless `encoder` is on. Node's own inserts carry
  `ondes_live_np` and pass untouched. It sets `song` too: the Icecast output sends `song` as is
  when a track has one (DJ software often sends only that), else `artist - title`.
- Whatever the encoder sends on the input on air is reported, allowed or not: wire event
  `live.metadata {input, session_id, streamer_id, title, artist}` → domain
  `engine.live.metadata`. `title` is the ICY `song` when there is no title. Title and artist
  are capped at 500 characters (`LIVE_ENCODER_TEXT_MAX`): by the template (`String.sub`, on
  what it reports and on what it lets through) and again by the contract
  (`liveEncoderTextSchema`), so a runaway encoder never fills the database or the dashboard.
- With `encoder` on, the encoder's track changes reach the streams by themselves, without a
  round trip through Node (which then stores them and sends the same text back).
- The takeover (`to_live`) inserts the now-playing with the session tags. A new session id on
  `POST /v1/live` clears it, so a handover never shows the previous DJ's text while Node's
  push for the new session is on the way (a blank title for a few ms instead).
- **The DJ's own track info, without loosening the auth callback.** MP3 and AAC sources send
  their track info through harbor's `/admin/metadata` (Shoutcast: `/admin.cgi`), which runs
  the auth callback like a connection; ADR 0027's "refuse any login on a taken input" refused
  it, so encoder metadata never arrived for MP3 DJs. The callback can't tell the two apart (it
  gets user, password and address, not the path), so it stays as it was: **any** login on a
  taken input is refused, the connected DJ's own included. Instead the template registers its
  own `GET`/`POST /admin/metadata` and `GET /admin.cgi` on `live_port` (harbor tries registered
  handlers before its built-in ones). They accept `mode=updinfo` only from the DJ connected to
  that mount: a digest of their credentials is kept from the accepted login until they hang up
  (HTTP Basic, or `user`/`pass` in the query; a Shoutcast `user:password` password is also
  tried split, as harbor's ICY login splits it). Anything else is a 401: another DJ, a wrong
  password, a free mount. Like harbor, `song` becomes the title when neither title nor artist
  is sent, and the metadata is inserted on the input once its buffer has played (it goes with
  the audio the DJ is sending now, as harbor's buffer does; inserted at once it would lead that
  audio and could share a frame with a now-playing Node just sent, which would hide it). These
  requests never reach Node's auth webhook, so they are neither audited nor rate-limited, and
  the charset is taken as UTF-8 (harbor's guess for ISO-8859-1 encoders is lost).
  `live-auth.engine.int.test.ts` checks the connected DJ's own login, another DJ's and a wrong
  one are refused as sources on a taken input, and only the connected DJ's track info is taken.

### Node (`apps/api/src/modules/live/metadata.ts`)
- On `live.session.started`: the session's default, sent to the engine.
- On `engine.live.metadata` for the open session: stored; on air if allowed. Metadata of
  another session (a late event after a handover) or of none is ignored.
- Events apply one at a time per station, in the order they arrived on this replica: an
  encoder's track never overtakes the session start before it.
- Every read and write is scoped to the station and its org (`whereStation`, `org_id`); the
  events, which carry a station id only, resolve the scope from the station first.
- A manual set or clear reads the session inside its own transaction. One that changes
  nothing (clearing with no manual text, typing the text already on air) writes nothing, audits
  nothing and sends nothing.
- Every api replica receives the events and runs the 5 s switch sweep (ADR 0027), which also
  calls `metadata.sweep` for the stations with a live session open (one query for all
  stations first; the others cost nothing, not even an engine state request): it fills in a session whose start event was missed, picks up a
  session bound to its slot in place (ADR 0033, no event: its default title changes), and
  re-sends the now-playing when the engine's `now_playing` differs from what Node wants (a
  failed push). The row update only matches when the now-playing actually changes
  (`… where (title, artist, source) is distinct from …`), so one replica publishes and pushes.
- `getLiveNowPlaying(db, scope)`: the now-playing of the session on air, null when nobody is.

### The api and real time
- `GET …/live/now-playing` (`live:read`): `{nowPlaying: LiveNowPlaying | null}`;
  `PUT` / `DELETE` (`engine:control`), 409 `live_not_on_air` when nobody is on air.
- `LiveNowPlaying` (`packages/shared/src/contracts/live-metadata.ts`): session, input, title,
  artist, source, `encoderAllowed`, `updatedAt`.
- SSE `live.metadata.changed` (data: `LiveNowPlaying`), `engine:read` in
  `realtimeEventPermissions`, like the other `live.*` events; `engine.live.metadata` too.
- The on-air snapshot (ADR 0034) gains `live` (optional) and, while live, `current.title` /
  `current.artist` read the now-playing instead of the as-run's first tags. The as-run itself
  is unchanged: live entries are keyed on session and input (ADR 0027), so title updates never
  split them. The dashboard refetches on `live.metadata.changed`.
- **#74** reads `getLiveNowPlaying` and listens to `live.metadata.changed` and
  `live.session.started` / `ended`.

### Dashboard
A widget under the on-air one, for `engine:control`, shown only while a DJ is on air: what the
streams show with its source, and artist / title fields to type a manual now-playing; "Back to
automatic" when one is set. Guarded by `useUnsavedChanges` while something is typed.

## Consequences
- Migration `*_live-metadata`: the new table and `streamer.encoder_metadata`. Contract changes
  are additive: `POST /v1/live/metadata`, `live.now_playing` in the engine state, the
  `live.metadata` wire event, `engine.live.metadata` and `live.metadata.changed` domain events,
  `encoderMetadata` on streamers (defaults to false), `live` on the on-air snapshot. Every
  station's engine restarts once for the new template.
- No new engine setting, so no new template combo; `pnpm test:engine` checks the template.
- Tests: `live-metadata.engine.int.test.ts` (engine project) runs the template with an MP3 and
  a Vorbis output to its own Icecast and a stand-in DJ, and reads `status-json.xsl`: automation
  → default → intruders refused (track info and source logins) → encoder refused (reported,
  not on air) → a runaway title capped → encoder allowed → manual over the encoder → a new
  session starts blank → automation. `live-auth.engine.int.test.ts` covers the same refusals
  with the auth webhook. `metadata.int.test.ts` covers the order, two replicas, the streamer
  switch, the audit, a handover, 409, the sweep, per-station ordering, events with no session,
  the cap and tenant scoping against a real database; `metadata.routes.int.test.ts` the routes
  (permissions, tenants, 409, validation, no-op audit, the streamer switch reaching the engine
  at once); `onair.int.test.ts` the on-air snapshot; `adapter.test.ts` the engine command and
  event; `live-now-playing.test.tsx` and `live.test.tsx` the dashboard widget and the streamer
  setting.
- A manual text lasts one session. A concert with several DJs on several inputs needs it typed
  again after a handover; keeping it per occurrence or per event can be added on the row
  without changing the engine side.
- The encoder's own `artist` / `title` split is kept when it sends one; ICY `song` alone
  ("Artist - Title") is kept as the title, never parsed.
