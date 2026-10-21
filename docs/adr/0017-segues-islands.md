# ADR 0017: Segues and islands

- Status: accepted
- Date: 2026-10-21
- Issue: #55 (epic #54). Builds on ADR 0002 (island joins, from spike #12), 0004 (playout
  copies), 0006 (durable event consumers) and the log model (#100). Consumers: the renderer
  (#56), engine support (#57), the segue editor (#58), VT recording (#59), promo VTs (#60),
  smart default placement (#61).

## Context
A voice track between two songs is a transition the presenter shapes by hand: when the voice
starts, how far A ducks and when it fades, when B comes in and how it rises. Spike #12 showed
that the engine can only play such a transition sample-exactly when it is rendered offline
into one FLAC "island" from the exact playout copies, spliced as `A body → island → B body`
in one merged segment, with B's join on its FLAC block grid and no micro-crossfade. "What you
preview is what airs" means the editor, the renderer and the feeder must agree to the sample
on what an island contains.

## Decision

### A segue is a transition between two log items
- `segue` (`packages/db/src/schema/segues.ts`) joins **A → B**: two consecutive top-level items
  of the same log day that play an asset (song, vt, jingle, bed, fill). One segue per
  transition (unique on A and on B). The voice is **not** a log item: it is a lane of the
  segue, so moving or replacing the music doesn't leave an orphan VT in the log.
- **Lanes**, all on one axis in integer samples at 44.1 kHz, **0 = A's end** (its effective
  cue-out: log override, else asset cue, else file end):
  - `out`: A's envelope (ducking, fade-out);
  - `in`: B's `start` (the "next start": negative overlaps A, positive leaves a gap) and its
    envelope;
  - `voices` (up to 4): an asset with a playout copy (a VT from #59, a promo from #60), its
    `start`, an optional trim (`cueIn`/`cueOut`, default the asset's cues), a gain trim and an
    envelope.
- **Envelopes** are gain points `(at, gainDb)`: linear interpolation **in amplitude** between
  points, holding before the first and after the last, empty = 0 dB, −90 dB = silence. Fades,
  ducks and cuts are all envelopes; there is no separate fade field. Gains are relative to the
  asset's playout gain (`getPlayoutGain`, with the log item's `gainDb` override), which is what
  the engine applies to the bodies as `liq_amplify`, so the splice is continuous.
- Lanes are jsonb on the row (the editor saves them as a whole; `version` gives optimistic
  concurrency, `PUT` with a stale version is a 409).

### An island is derived, versioned and content-addressed
- `deriveIslands` (`packages/shared/src/segues/island.ts`, pure, no platform APIs) turns a chain
  of segues into island plans. Per segue:
  - start = 10 ms handle before the first deviation from "A plays normally" (A's envelope
    leaving 0 dB, a voice starting, B starting, or A's end);
  - end = 10 ms handle after B plays alone at full volume (B's envelope back at 0 dB for good,
    every voice ended);
  - B's join is moved **up** to B's next 1024-sample block boundary (sample-exact seek);
    A's join is a cue-out and needs no snapping;
  - a body shorter than 1 s is absorbed: the whole item goes into the island.
- **Overlapping islands merge.** Segues that share an item form a chain; when the body left
  between two islands is under 1 s, the shared item is rendered whole and the islands become
  one (`A > VT1 > B(short) > VT2 > C` is one island, `A … C`). A middle item gets both its
  envelopes (product).
- The **spec** (`islandSpecSchema`, `ISLAND_SPEC_VERSION` = 1) holds only what the renderer
  needs: the output format (FLAC, 44.1 kHz, stereo, 24-bit, 1024 blocks), the length, and the
  sources (playout file sha256 and key, sample range, island position, static gain, envelopes in
  island samples). No log or segue ids, so equal audio has an equal spec. Envelopes are clipped
  to the island, so edits that change nothing audible don't change it.
- Its **hash** is SHA-256 of its canonical JSON (`stableStringify`); the file lives at
  `org/<orgId>/islands/v<version>/<hash>.flac` (`islandStorageKey`). Bumping the spec version
  re-renders everything.
- `island` rows are one per head item: spec, hash, joins (`head`/`tail`: item, asset, join
  sample, whether a body remains), covered items and segues, and the render status
  `pending → rendering → ready | failed`. A new hash resets the row to `pending` (or straight
  to `ready` when another island of the station already rendered that hash); an unchanged hash
  keeps its render. Islands are never written through the api.

### Invalidation: re-derive, compare hashes
- Every segue write re-syncs its chains in the same audited transaction. A durable consumer
  (`segues` queue, ADR 0006) re-syncs on `log.updated` (the days it touched, plus segues that
  lost an item) and `asset.ingested`. Syncs of a station are serialised by an advisory lock.
- Sync sets each segue's **status**: `ready` (has an island), `waiting` (a playout copy is
  missing), `detached` (A or B deleted, no longer consecutive, or playing another asset than
  when the segue was saved), `invalid` (the lanes don't fit the media: B or a voice before A, a
  voice outlasting B). Only `ready` segues have islands; islands no segue points at are
  deleted. Deleting A or B keeps the segue and its voice lanes (`detached`, listed by
  `?status=detached`); saving it again re-attaches it.
- Library cue and loudness edits publish no event yet, so they don't trigger a sync. The
  feeder (#57) must therefore re-derive the spec at push time and play the island only if its
  hash matches a `ready` island; otherwise the transition airs as the degraded crossfade.

### API and permissions
`/api/v1/stations/:stationId/segues` (list by item, status or planned range; get; create; put;
delete) and `…/islands` (list by status, get with spec). `voice_track:read` reads;
`voice_track:write` writes any segue; `voice_track:write_own` (presenters) writes a segue whose
A or B comes from a show they host, or one they created. Events: `segue.changed`,
`island.updated` (status `pending` = render it), `island.removed`.

## Consequences
- **Renderer (#56):** render `pending` islands from `island.updated` plus a sweep of
  `GET …/islands?status=pending`; mix each source as specified (gain × product of envelopes,
  `envelopeGainAt` is the reference), write `format`, store at `islandStorageKey`, then set
  `ready`/`storage_key`/`rendered_at` **only where the row still has that hash** (the spec may
  have changed meanwhile). Skip the work when the key already exists. Orphan files are
  content-addressed, so a GC can drop keys no island references.
- **Engine (#57):** push `A body (cue-out = head.joinSample) → island → B body (cue-in =
  tail.joinSample)` as one segment with the ADR 0002 half-sample bias; no body when
  `hasBody` is false; a merged island spans several items.
- **Log timing:** the log's retiming doesn't read segues yet. B's real start is `in.start`
  relative to A's end, which `crossOutMs` can only express when it is an overlap. Wiring the
  segue into retiming (and into the generator, which rewrites a day with new item ids and so
  detaches its segues) is follow-up work for the log and the generator.
- **Editor (#58), VT recording (#59), promos (#60), smart placement (#61)** build on the lanes
  as they are: a recorded VT is a voice lane on a new asset; a promo is a voice lane on an
  existing one; `origin: auto` marks segues placed by #61, which may move them.
