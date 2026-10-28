# ADR 0037: Smart default VT placement

- Status: accepted
- Date: 2026-10-27
- Issue: #61 (epic #54). Builds on ADR 0017 (segues and islands), 0018 (island renderer), 0019
  (gain model), 0024 (islands on air), 0025 (VT recording) and 0032 (promo VTs, whose default
  segue this generalises).

## Context
A voice track sounds right when the voice talks over the instrumental end of A and the
instrumental start of B, and B's vocals come in as the voice ends ("hitting the post"). Placing
that by hand is the segue editor's job (#58), but most transitions should need no hand work: a
promo placed by the generator (#60), a voice picked from the library, a take recorded without
music. The issue asks for a good segue with zero manual work, from A's outro start and B's intro
end (autocue or the cue editor), with default ducking; when the voice is longer than the
instrumental parts, extend into a bed or delay B. Acceptance: 80 % of auto segues need no manual
adjustment, on 50 cases reviewed by the team.

## Decision

### One pure function: `autoPlacement` (`packages/shared/src/segues/placement.ts`)
Deterministic, markers only, no platform API, shared by the api, the web editor and the dev seed.
**No AI or ML**, not even opt-in (the owner's rule). On the segue axis (0 = A's end):
1. B's **natural start** is A's `crossStartNext` (0 without it).
2. The voices start with A's outro (`outroStart`), or at B's natural start if earlier. Without an
   outro marker, at B's natural start: the placement never puts a voice over A's vocals as far as
   the markers tell. Several voices play one after the other, 250 ms apart.
3. B starts so that its intro (`introEnd`) ends with the last voice. Without an intro marker, B
   starts as the voices end.
4. B never starts before its natural start: short voices move later instead, still ending on the
   post. Long ones **delay B**.
5. When the delay leaves the voice alone between A's end and B's start for 1.5 s or more and a
   **bed** is given (and a voice lane is free), the bed is laid under it as one more voice lane:
   −10 dB on its playout gain, fading in over 1 s under A's last second and out over 1 s once B
   has started; a shorter bed plays whole with shorter fades.
6. A and B **duck** under the voices with the owner's default (−8 dB, 300 ms ramps,
   `DEFAULT_DUCK`, the editor's first preset), through the existing `duckEnvelopes`.

Options: `maxLead` keeps the voices within a bound of A's end (promos: their 30 s air window,
ADR 0032); `voiceStart` pins the first voice (a take spoken over the music) so only B, the other
voices and the ducks follow rules 3–6; `inStart` pins B (placed by a person): the voices end on
its intro end and B is never delayed. An existing lane keeps its trim, gain trim and envelope
(moved with it). The segue's own bed lane is never dropped: with nothing to cover it stays where
it was, and a gain trim or envelope a person gave it is kept (the envelope moving with it). It returns the lanes and a **report** (`post` or `delayed`, the delay, the dry
stretch, whether a bed was laid, which markers were usable) that the tests and the review use.
Markers outside the effective cues are ignored.

`duckEnvelopes`, `DEFAULT_DUCK` and `PlacementMedia` moved here from `segues/promo.ts`;
`defaultPromoLanes` is now `autoPlacement` with `maxLead` and no bed, so every promo segue keeps
its #60 behaviour (its tests are unchanged).

### Delaying B and beds need nothing new from the renderer or the engine
A delayed B is a later `in.start`, a gap the island already renders as silence under the voice.
A bed is an ordinary voice lane (any asset with a playout copy, ADR 0017) with a trim, a gain
trim and an envelope. So the island spec, the renderer (#56) and the splice are unchanged: no
`ISLAND_SPEC_VERSION` bump, no new renderer parameter.

### Where it is the default
- **Promos (#60):** the api's placement consumer, as before, now reading the markers from
  `segueMedia` (one source for them, below) instead of its own query.
- **Segue editor, a voice from the library:** the first voice of a transition is placed by
  `autoPlacement` (B and the ducks follow it). Later voices still go after the last one: a
  second voice is a person shaping the transition. When a person already placed B (away from
  A's end and its natural start) or drew an envelope on A or B, those stay: the voice ends on
  B's intro end (`inStart`) and nothing else moves. When the voice's media can't be loaded, it
  goes after the other voices and the editor says so.
- **Recorded takes (#59):** the first voice of a transition. A take spoken over the pre-roll
  stays where it was spoken (`voiceStart`): the presenter timed it to the music, so only B and
  the ducks follow it. A take recorded without music is placed like a library voice; B and
  envelopes a person set stay, as above. The recorder passes the take's length back with it
  (`length` search parameter), because the take's media only exists after its ingest. The lane
  pins the take whole (`cueIn` 0, `cueOut` its length), so autocue's cues, found later, never
  trim its tail and leave B late; the editor clamps that cue-out to the playout copy's length
  (resampling can make it a sample shorter) when it checks and saves.
- **"Auto placement"** in the editor's envelope menu ("move the voices and the next song,
  replace the envelopes"): re-places every voice, B and the ducks, the first `bed` voice
  becoming the bed when another voice remains. An undoable edit, like every preset; when it
  would change B's start or A's or B's envelopes, the editor asks first.

The editor saves `origin: 'manual'` as before, so a segue a person saved is never re-placed.

### Markers reach the editor through the media endpoint (additive)
`segueMediaSchema` gains optional `kind` (the asset's type) and `markers` (`introEnd`,
`outroStart`, `crossStartNext`, in playout-copy samples like `cueIn`/`cueOut`, null when unset).
`GET …/segues/media` fills them; `placementMediaOf` turns one into `autoPlacement`'s input.

### The owner's review
The acceptance criterion is a listening test, done by the owner. `deploy/dev/seed/placement-review.ts`
prepares it: a draft log day (two weeks ahead by default) of 50 song pairs from the station's
library, each with an `auto` segue carrying one of its VTs. Cases come from a seeded PRNG and are
taken round-robin across the kinds the library produces (outro or not × intro or not × fits or
delays B), so the set is the same on every run and covers the edge cases the library allows. It
prints a checklist with a link to each transition's editor. `--report` gives the 80 % criterion:
over the transitions the seed wrote (and only those), the share whose segue still has the lanes
the seed created (its `segue.create` audit row). A save without a change isn't an adjustment;
a segue changed, deleted or replaced is. No song pair repeats; `--count` is 1 to 200.

## Consequences
- The quality of the default is the quality of the markers. Without any (no autocue result, or
  synthetic audio) a voice plays alone between A and B, B delayed by its whole length: a plain
  voice break. The review needs real music in the dev library, analysed by autocue.
- The delay of B is not in the log's planned times (as for promos, ADR 0032): the next anchor
  absorbs it.
- No station-wide default bed: a bed is only laid when the segue already has one (editor) or the
  caller passes one (the review's `--bed`). A station setting for a default VT bed, used by the
  generator's promo segues too, is possible later behind the same option.
- A take spoken over the music is never moved, even when it ends past B's intro: moving B is the
  only adjustment. The presenter heard B where the draft had it; the editor shows the result.
