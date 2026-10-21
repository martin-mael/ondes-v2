# ADR 0016: Rotation rules and the relaxation ladder

- Status: accepted
- Date: 2026-10-21
- Issue: #38. Builds on ADR 0013 (categories) and 0015 (as-run).

## Context

Categories (#37, ADR 0013) say which songs may fill a slot. The rules say which of them should,
given what aired and what is planned: separation, rest, play caps, tag segues. The research
(`docs/research/02-music-scheduling.md`) found no published precedence model in the pro
schedulers, and CloudRadio's explicit relaxation order (album, then artist, then repeat, then
least recently played) as the one pattern worth copying. Vandale's pain in AzuraCast is exactly
this: same artists back to back, no explanation of why a song was picked.

## Decision

**One ordered rule set per station** (`rotation_rules`, jsonb, contract
`packages/shared/src/contracts/rotation-rules.ts`). No row means `DEFAULT_ROTATION_RULES`. Each
rule has an `id`, `enabled`, `priority` (1 = most important) and `breakable`, plus its own
parameters. Kinds:

| Kind | Rejects a candidate when |
|---|---|
| `song_rest` | the same asset aired (or is planned) within the category's `restMinutes`, either side of the slot |
| `max_plays` | the asset already reached its category's `maxPlaysPerDay` / `maxPlaysPerWeek` in the station-local day / Monday week |
| `search_depth` | it sits past the category's `searchDepthPercent` of the rotation order |
| `artist_separation` | an artist (all credited ones, or only the first) is within `value` minutes either side, or fewer than `value` songs before or after |
| `title_separation`, `album_separation` | same, on the title without bracketed versions, or the album (missing albums never clash) |
| `same_hour_yesterday` | it aired in the same station-local 15/30/60 min window the day before |
| `tag_run` | the `maxRun` songs before the slot all carry the tag, and so does it |
| `segue_ban` | the song before carries `from` and it carries `to` |
| `max_tag_per_hour` | `max` songs with the tag already sit in the station-local clock hour |
| `flow` (soft) | never: a BPM or energy step above the goal only moves it behind the songs that meet it |

**Artists** are compared after splitting each credit on the usual joiners (feat., ft.,
featuring, &, x, vs, comma, slash, with, avec; word-bounded, any case) and normalizing (no
accents, no punctuation, no leading "the"). The primary artist is the first name of the first
credit; `includeFeatured: false` compares primaries only.

Category-level values (rest, caps, depth, rotation order) stay on the category; the rule only
enables them and gives them a priority, so one ladder covers everything. Disabling one of these
rules ignores that setting in every category; the settings page warns about it. Gender rules are left
out: the library has no gender data. Rule groups by daypart are a later addition (a `when`
field on the rule).

**The picker is pure** (`@ondes/scheduling` `pickForSlot`, `pickSequence`): members, history
(as-run plus planned log items), rules, timezone and seed in; the pick, the relaxed rules and a
verdict per candidate out. History items of another asset type than the category's are ignored,
so a jingle doesn't break a run of songs. The api's `pickSlots` loads the snapshots;
`POST /stations/:id/rotation/pick` exposes it for the settings page and the clock preview, and
the log generator (#50) can call the picker with its own in-memory history.

**Order of a pick:**

1. Order the schedulable members: `least_recently_played` (never played first, ties by id),
   `sequential` (library order, starting after the member that played last), or
   `weighted_random` (least-recently-played order for the depth, then a draw weighted by idle
   time, capped at a week, from a seeded PRNG: same seed, same slot, same pick).
2. Check every candidate against every enabled rule. The verdicts are kept: they are the
   explanation.
3. **Relaxation ladder.** Eligible = candidates that break no active rule. If none, drop the
   enabled, breakable, non-soft rule with the highest priority number (ties by id) and try again.
   An unbreakable rule is never dropped: if it blocks everyone, the slot stays empty and the
   caller fills it otherwise (fill, safety). An empty slot reports no relaxed rule (no item
   carries them); `unfilled` says why: no schedulable member, or the unbreakable rules that
   block, with how many candidates each blocks. Once every breakable rule is dropped, the pick falls
   back to plain rotation order.
4. Among the eligible, prefer those that meet the soft `flow` goal, then take the first in
   rotation order (or the weighted draw).

**What is reported:** only the dropped rules the pick actually breaks, in ladder order, as
`RelaxedRule { rule: kind, reason }` ready for `log_item.relaxed_rules`. `reason` is English
and names the rule id and how many candidates it blocked. The UI words violations itself from
`kind` and `values`.

**Default ladder** (relaxed first to last): album separation 120 min, artist separation 70 min
(featured artists count), search depth, title separation 180 min, song rest, play caps.

## Consequences

- A slot is always filled while no unbreakable rule blocks it, and every broken rule is
  recorded and explainable.
- Time windows (days, weeks, clock hours, "same hour yesterday") are station-local, so they
  follow DST: a 23- or 25-hour day is one day. "Same hour yesterday" compares wall-clock hours
  (`zonedInstant`), and a window in the spring-forward gap is empty.
- `max_tag_per_hour` uses the clock hour around the slot, not a rolling hour.
- The api bounds the older-airings lookup to the longest rest or separation plus 30 days: a
  song idle longer than that orders like one never played.
- Picks rebuild the history index per slot: about 2 ms per slot for 400 candidates and a week
  of history, fine for a day of the log. The api loads 8 days of history around the slots
  (longer when a separation is longer), plus each member's last airing before that for long
  rests.
