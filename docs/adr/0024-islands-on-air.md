# ADR 0024: Islands on air

- Status: accepted
- Date: 2026-10-23
- Issue: #57 (epic #54). Builds on ADR 0002 (engine control, island joins), 0004 (playout
  cache), 0012 (log feeder), 0015 (as-run), 0017 (segues and islands), 0018 (island renderer).

## Context
The renderer (#56) turns a segue into a FLAC island, content-addressed by its spec hash. Spike
#12 fixed how the engine can play it without a seam: `A body → island → B body` as one merged
segment, per-request gains, cue-ins on the playout copy's packet grid, half-sample-biased cue
points, nothing at the joins. The feeder has to decide, at push time, whether an island can air,
and do something sensible when it can't. The as-run has to say what aired.

## Decision

### An island chain is one queue entry, under its head item's id
- At every sync the feeder re-derives the islands of the items from 30 min back to the end of its
  window (`deriveIslandsFor`, ADR 0017) and checks the render's cache state
  (`loadFeedIslands`). Never a stored plan: a change not synced yet can't air a stale render.
- An island airs as a **chain** when its render is `ready` with that exact hash, its file is in
  the station's playout cache (and the engine hasn't refused it in the last minute), and every
  item it covers can play. Items after the head must be `flow`: the chain airs at the head's
  time, an item inside it can't keep an anchor of its own. Islands that follow one another
  (`A > I1 > B > I2 > C`) join one chain.
- The chain is one planner entry (kind `segment`, id = the head item's id, slot = the sum of the
  items' slots, never trimmed) pushed as one `POST /v1/segment` with that id as `segment_id`.
  Using the head's id keeps the entry id the same whether the transition airs as a chain or as
  the fallback, so a change of mind re-pushes it as a normal edit (fingerprint differs).
- Parts (`buildPushChain`, push.ts):
  - **bodies**: own gain (`liq_amplify`); A's cue-in moved **up** to the next 1024-sample
    boundary (ADR 0018 "Grid snapping"; it only shortens A's body, never the island), A's cue-out
    = the head join; B's cue-in = the tail join (already on B's grid); all biased by half a
    sample (`(n − ½)/sr` with a cue-in, `(n + ½)/sr` without). A body is left out when the
    island covers the whole item (`hasBody: false`).
  - **the island**: `item_id` `island:<spec hash>`, `liq_amplify="0. dB"` explicitly, no cue
    points, B's title and artist (the transition leads into B).
  - fades and crossfades only into and out of the chain (A's fade-in if A starts at its own
    cue-in, B's natural cross-out).
- **Locked shape.** An item on air or aired in this boot never starts a chain any more, and the
  chain on air keeps the shape it was pushed with, whatever the islands say now: its items
  come from `feeder_push.parts` (or, without the record, from the island on air or the head up
  to the item on air). So an edit during the transition can't make B air twice.

### The fallback: crossfade plus a voice overlay in the engine
When an island can't air (not rendered, not cached, refused, B not playable, an anchored B, or
the head already on air), the items air as usual with the standard crossfade, and the island's
**voices** are laid over the transition out of the head item:
- `overlay` (contract `engineOverlayVoiceSchema`) on `POST /v1/queue` and `/v1/segment`: per
  voice its file, `at` (seconds after the entry's last request goes on air), `duration`, its trim
  (biased cue points), its gain (playout gain + lane trim) and `duck_db`.
- The feeder computes them from the derived spec: a voice's start on the segue axis (0 = A's
  end), plus the length of A as pushed; the duck is A's envelope at the voice's start (B's after
  A's end), floored at −40 dB.
- The template keeps the overlay against the entry's last request and starts each voice when
  that request goes on air (the as-run callback), on a separate `request.queue` mixed after the
  crossfade: `add([amplify(duck, auto), voices])`. The duck ramps over about 100 ms. Voices carry
  no metadata (`metadata.map(strip=true)`), so the as-run never sees them as items. A skip
  cancels the voices of the item it ends. The duck's `amplify` has `override=null`: the default
  (`liq_amplify`) would apply every request's gain a second time.
- Degraded, by design (spike #12): frame-granular timing (measured: the voice 60 ms late), one
  duck level per voice instead of the envelope, B's own `in` lane ignored. It is not "what you
  preview is what airs"; it is "the voice airs". Voices whose file isn't cached are fetched
  urgently and skipped until they are.

### Files on the engine's disk
The cache horizon (ADR 0004, `listCacheHorizon`) now also lists, with the item they air after:
the `ready` render of an island whose head is in the window, and the playout copies of the
voices of its `ready` segues (for the fallback). They are kept and fetched like the item's own
file but not counted in readiness (`transition: true`). The urgent fetch still takes an asset
file id, so a voice file can be fetched urgently and an island render can't: a render the cache
doesn't have airs as the fallback until the next pass (the renderer also places it, ADR 0018).

### As-run: the transition is on the entry
- `feeder_push.parts` (jsonb) records, per request of an island chain or of an entry with an
  overlay, its engine `item_id`, its planned length inside the chain and the transition it
  carries. The as-run reads it when a request starts (by boot and entry id).
- An island airs as its own entry (`log_item_id` null, `engine_item_id` `island:<hash>`, B's
  title) with `transition: { rendered: true, islandId, hash, segueIds, voices }`: the VT play,
  with each voice's asset, offset and length. A fallback head gets `transition: { rendered:
  false, … }` with the voices' offsets from its start.
- Bodies of a chain are planned to their island (`planned_duration_ms` = the body's length), so
  a body that played to its join is `complete`, not `cut`.
- Whether a voice really aired is read from the entry's end, like every as-run outcome: a voice
  starting after the entry left the air early didn't.

## Consequences
- **Live (#64):** a live takeover during a chain cuts the chain (the live branch is above the
  queue); voices are mixed under the live switch, so they never air over a DJ.
- **Log timing:** the chain's slot is the sum of its items' log slots; the segue's real timing
  (B's `in.start`) still isn't in the log's retiming (ADR 0017). Drift shows against anchors as
  before.
- **Skipping inside a chain** skips the whole chain (ADR 0002), B included.
- **Log vs as-run (#53):** an entry with `log_item_id` null and `transition.rendered` is the
  transition between the items around it, not an unplanned item.
- **Follow-ups:** an urgent fetch for island renders (by file hash); a fallback that follows the
  out/in envelopes instead of one duck level.
