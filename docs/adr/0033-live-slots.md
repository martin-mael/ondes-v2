# ADR 0033: Live slots, ad-hoc live and events

- Status: accepted
- Date: 2026-10-23
- Issue: #65 (epic #62). Builds on ADR 0012 (log feeder), 0014 (show recurrence, episode
  numbers), 0015 (as-run), 0022 (missing-episode fallbacks), 0023 (DJ identities) and 0027
  (harbor pool, live sessions). Read by #66 (handover UI), #67 (live recording), #70 (on-air
  view), #71 (health panel), #72 (dashboard quick actions), #101 (log regeneration).

## Context
#64 put a DJ on air when they connected during a live slot of one of their shows, and left
the rest to #65:
- a live slot is a show slot of type `live`, but going on air in it made no episode, so the
  as-run couldn't say which show and episode a live session was;
- nobody decided what happens when the DJ doesn't come: the feeder holds the log for the whole
  slot (ADR 0012) and the safety playlist covers it;
- a DJ who connects early (ADR 0023 lets them, 15 min) always waited;
- a DJ outside their slots (any-time streamers) stayed connected and off air, with no way for a
  manager to be asked;
- a one-off live block that isn't a show (a concert, a festival stage) had no home.

## Decision

### Live slot settings on the slot
Two nullable columns on `show_slot`, set exactly on live slots (like a rerun slot's strategy,
ADR 0028; a check constraint ties them to `type = 'live'`). The contract's slot gains
`live: { graceMs, earlyConnect } | null`, and the occurrence `live` (absent on other types).
A live slot written before #65 reads as the defaults.
- `graceMs` (0–60 min, default 5 min): how long after the start the slot waits for its DJ.
- `earlyConnect`: `wait` (default; connected, off air until the start) or `go_live` (on air as
  soon as they connect, from 15 min before).

Rejected: settings per show (a show's weekly slot and its one-off special want different
grace), or per streamer (the slot is what the programmer plans).

### What a connected DJ may do: their standing (`live/standing.ts`)
For each connected streamer, in order:
1. **slot**: a live slot of one of their shows runs now (`startsAt ≤ now < endsAt`), or starts
   within 15 min with `go_live`;
2. **event**: an event that lists them runs now; or one listing nobody, if their ad-hoc
   policy is `allowed`. An event open to anyone doesn't override the approval gate: an
   `approval` DJ asks, and an approved session is bound to that event;
3. **waiting**: a live slot or listed event of theirs starts within 15 min;
4. **ad-hoc**: none of these. Their streamer's new `ad_hoc` policy decides: `approval`
   (default) or `allowed`.

**Live slots only.** Since #65 the auth callback admits a show's DJ around its *live* slots
only (ADR 0023 admitted any non-rerun occurrence): a pre-recorded slot takes no DJ, and a DJ
admitted there would only raise an ad-hoc request, which `any_time` streamers are for.

Occurrences come from the shows module, so station time and DST are ADR 0014's: a 02:30 slot
on the last Sunday of March airs at 03:30, on the last Sunday of October at the first 02:30
(tests pin both). Reruns never count.

### Arbitration (the switcher's takeover, extended)
On `engine.live.connected` and on every 5 s sweep (ADR 0027), per station:
- a **slot** or **event** DJ takes the air when nobody is on, from an **ad-hoc** session, or
  from a slot or event session whose own slot or event is over. Never from a DJ a manager put
  on air by hand (`manual`). A manual return still holds (ADR 0027), now from the slot's (or
  the early window's, or the event's) opening;
- an **allowed** ad-hoc DJ takes the air only when nobody is on, and a manual return holds
  until they log in again;
- an **approval** ad-hoc DJ raises a **request**.

When several DJs may take the air, a slot DJ wins over an event DJ, then the lower input.

**A DJ on air unbound (ad hoc, or put on air by hand) whose own slot or event starts** keeps
the air in the same session, which is **bound in place**: trigger, show, occurrence, episode
(created or taken as below), title and scheduled end are set on it (audited
`live.session.bind`), with no gate change. Re-tagging through a gate reopen on the same input
was rejected: it risks a glitch for a label. Their live as-run entry still on air takes the
same snapshot (`bindLiveEntries`), the one exception to as-run's append-only rule (an open
entry, updated to what its session now is).

**A session the engine has but Node doesn't** (an engine call that failed after the engine
applied it, a row closed under it): the go-live first asks the engine whether it took the new
session and keeps the row if so; otherwise the sweep closes a gate that is open on a session
id Node has no open row for (`live.gate.close`). Sessions are inserted before the engine call,
so this never races another replica's go-live. A gate with no session id (an engine rendered
before #64) is left alone.

### Sessions bound to what they air
`live_session` gains `show_id`, `slot_id` + `occurrence_date`, `episode_id` +
`episode_number`, `event_id`, `title` (the show's name or the event's title), `streamer_name`
and `scheduled_end_at` (the slot's or event's end, for the takeover rule). Plain columns, no
foreign keys: a session is history and outlives a deleted slot, episode or event; the names
are snapshots so a renamed DJ or show doesn't rewrite the past. Triggers gain `ad_hoc` and
`event`. A manual `PUT …/live/on-air` (and an approval) binds to the DJ's running slot or event
when they have one.

**The episode is made when the DJ goes on air**, in the session's transaction, under the
show's row lock (the lock `createEpisode` takes): the episode planned for the occurrence if
there is one, else a new `live` episode numbered from `show.next_episode_number`. It is marked
`aired` from that moment. A DJ who reconnects in the same occurrence gets the same episode.
If the engine refuses the gate, the compensating transaction (ADR 0027) deletes the new
episode (its number isn't reused: the counter only grows) or gives the planned one its status
back, unless another session already uses the episode. Rejected: numbering at slot start whether or not anyone came (a missed slot would burn
a number), or at the end (the dashboard wants the number while on air).

### As-run
A live entry snapshots its session when it's recorded: the slot's episode in the existing
`episode_id` / `show_id` / `episode_number` columns (#48), and new `live_dj_name` and
`live_title`. The DTO gains `live: { sessionId, djName, title } | null` (optional). So the
as-run shows the live session with show, episode and DJ, the issue's acceptance, without
joins at read time.

### Grace period and fallback (`live/slot-check.ts`)
Each api replica's switch sweep also checks the live occurrences of each running station:
- **Missed**: still running, past `startsAt + graceMs`, and no DJ was on air in it: no
  session bound to it, and no live session of one of the show's streamers overlapping it
  (a DJ the switcher hasn't bound yet). Checked again once the step is claimed (released if
  a DJ came meanwhile) and after the alert is raised (resolved if a DJ came meanwhile).
  The `live.slot_missed` alert is raised (`warning`; `critical` when nothing could stand in),
  and the show's fallback (ADR 0022's `fallbackPolicy`, through `resolveFallback`, for the rest
  of the slot) goes into the log: the `live_slot` item is replaced by a `live_slot` that ends
  now, and the fallback items are inserted after it, marked in `log_item_fallback` like ADR
  0022 (the as-run copies the mark). The feeder stops holding at the shortened item's end and
  queues the fallback (ADR 0012). Edits go through the log repository in one transaction,
  audited as the system actor `live-slot-check`, and are published (`log.updated`).
- **A DJ who comes later still takes the air**: live overrides the queue, and after their show
  the feeder resumes the log at the current time (ADR 0027). Their session resolves the alert
  (`dj_on_air`).
- **Closed**: the occurrence ended. No DJ ever went on air: its planned episode, if any, turns
  `missing` (the status #44 reserved); the alert resolves (`occurrence_ended`). Ended
  occurrences of the last 24 h are closed, and a check row still open is closed whatever its
  age (an outage longer than that).
- Each step runs once across replicas: a `live_slot_check` row per occurrence, claimed with
  `update … where missed_at is null` / `closed_at is null`.

The safety playlist still covers the grace period itself: the log has nothing inside a live
slot to play. Rejected: deciding the fallback ahead (ADR 0022 does at T−1h for files): for a
live slot we only know at the start whether the DJ comes. The fallback file may not be cached
yet; the feeder skips an uncached item and alerts (`feeder.items_skipped`), and the cache sync
follows `log.item.changed`. Rejected too: a fallback planned inside every live slot by the log
generator and dropped when the DJ comes, which would make every live slot a log edit.

### Ad-hoc requests
`live_request`: one row per **connection** (`streamer`, `input`, the streamer's
`last_connected_at` when it was raised; unique, so replicas raise it once). Pending until a
member with `engine:control` approves (`POST …/live/requests/:id/approve`: the DJ goes on air,
a handover if someone is on) or refuses (`…/refuse`: they stay connected, off air, and aren't
asked about again until they log in again). The sweep cancels a pending request whose DJ hung
up, went on air or now has a slot. Deciding claims the pending row, so two managers can't both
approve; the second gets 409. Approving checks the DJ is still the one connected on that
input. The pending row stays locked (`FOR UPDATE`) while the DJ goes on air: a second manager
waits and gets 409; if going on air fails, the approval rolls back and the request stays
pending, so the prompt stays. **No self-approval**: a manager linked to the streamer can't
approve their own request while another member who may decide (owner, admin, station manager)
exists (403 `live_self_approval`); alone, they may. Real-time: `live.request.created` /
`live.request.decided` (`engine:read`). Audited as `live_request.raise|approve|refuse|cancel`.

**The prompt** is `LiveRequestPrompt` (`apps/web/src/features/live/live-requests.tsx`),
self-contained (station id only): it fetches `GET …/live/requests`, refetches on the two
events, and renders nothing for members without `engine:control` or when nobody waits. The
Live page mounts it; the on-air view (#70) mounts it on its page.

### Events
`live_event` (title, start, end ≤ 24 h, station-scoped) and `live_event_streamer` (composite
keys both sides; none listed: open to any of the station's streamers, `approval` DJs through a
request as above). CRUD under `…/live/events`
(`live:read` lists those not over, `live:manage` writes, audited `live_event.*`). The auth
callback lets an event's streamers connect from 15 min before until its end; the switcher puts
them on air at its start with `trigger: event` and the title on the session and the as-run.
An event isn't in the log: automation plays under it until a DJ takes the air, and the feeder
resumes at the current time after. Rejected: modelling an event as a show with a one-off slot
(it would need a show, an episode and a log item for something that isn't a show).

## Consequences
- Migration `*_live-slots`: new tables `live_request`, `live_event`, `live_event_streamer`,
  `live_slot_check`; new columns on `show_slot`, `streamer`, `live_session`, `asrun_entry`.
  All additive; old rows read as defaults.
- Contract changes are additive: optional `live` on slots, occurrences and as-run entries;
  optional session fields; new trigger values (`ad_hoc`, `event`) on an output enum; new
  `adHoc` on streamers (defaults to `approval`); new routes, alert type and SSE events.
- The log regeneration (#101) must leave items of an occurrence that has started alone (the
  missed-slot edit is a `manual` item there).
- Tests: `live/live-slots.int.test.ts` (settings, standing across both DST Sundays, slot
  takeover with episode numbering and the as-run acceptance, early connect, slot over ad-hoc,
  ad-hoc allowed and approval, refuse and cancel, events, the missed-slot fallback and the
  missing episode); `live.int.test.ts` (events and requests routes, permissions, audit, the
  auth window around an event); web tests for the prompt, events and slot settings.
- Follow-ups: live recording (#67) joins a slot's sessions into its episode's audio.
