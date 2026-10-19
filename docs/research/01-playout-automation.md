# 01 - Playout and Automation Engine: Research Report

Scope: clocks / hour templates, logs, hard vs soft events, time-fill and backtiming, segues and crossfades, live-assist vs automation, cart walls, voice tracking, stop sets, net joins, emergency/fallback, silence detection, multi-studio, ducking, time-stretch, and what "rock-solid" means in pro gear.

Confidence legend: [V] verified on a vendor/official page fetched in this session; [F] forum or user report (anecdotal); [S] search snippet only, not fetched; [G] general industry knowledge, not sourced here.

---

## 1. Core concepts (industry terminology)

### 1.1 Format clock (clock, hour template)
- A clock is a one-hour blueprint that fixes what airs, in what order, and at which minute marks. Songs change hour to hour; structure does not. [V] https://www.tunetrackersystems.com/articles/understanding-format-clocks.html
- Typical element types in a clock: music slots (typed by category), spot/stop-set blocks, legal ID at top of hour, news/weather cuts, imaging (sweepers, jingles), voice-track junctions, promos. [V] same source
- Music category vocabulary used by programmers: Current, Power Current, Recurrent, Power Gold, Gold, Specialty. Mainstream hour example: 4 Power Currents, 3 Currents, 2 Recurrents, 2 Power Golds, 1 Gold. [V] tunetracker
- Element counts (sample figures from the same article): talk-leaning formats ~7-8 music slots/hour, pure music 12-13; 2-4 stop sets/hour spread out (sample at ~:10, :31, :49); promos 30-60 s. [V]
- Clock design order recommended by the article: (1) set spot load, (2) place stop sets first, (3) place structural items (legal ID, news, weather), (4) set music slot count and category mix, (5) fill gaps with typed music, (6) place voice tracks/promos at clean junctions, (7) check hour totals ~60:00 and run/adjust. [V]
- Separation/rotation rules quoted as examples: a Current should not follow another Current; a Power Gold should not repeat within 4 hours; two songs by the same artist at least 90 minutes apart. [V] tunetracker
- Dayparts need different clocks (morning drive: more talk, shorter songs; overnights: almost all music). A serious station may run 15-20 clocks per week (weekend, holiday, event, custom show clocks). [V]
- Clocks are the "skeleton" of the schedule; RCS GSelector handles clock scheduling for music stations, Zetta builds News/Talk clocks. GSelector 4.9.0 added "Flex Clocks" (schedule a clock down to the minute, or over up to 24 h in a single day). [S] https://www.rcsworks.com/blog/rcs-live-building-gselector-clocks/ and RCS blog results
- PlayIt Live: clock = hour-long template; clocks are assigned to hours of the week to generate the playout log; unscheduled hours fall back to a "Playout Pattern". [V-ish: glossary/search] https://docs.playitsoftware.com/PlayItLive/218/introduction/glossary/
- Clock priority: PlayIt user request that when two clocks are scheduled in the same hour, the highest-priority clock wins (user suggestion; not confirmed built). [F] (PlayIt feature-request board, URL not captured)

Clock item types in PlayIt Live (from its clock doc): Track, Track Group, Break Note, Fixed Time Marker, Voice Track, Remote URL, Aux Input, Scheduled Event Action, Partial Clock; Advert Block, Hook Sequence and Merge Start/End require the Advanced Scheduling module. Standard clock = full hour; Partial clock = reusable mini-clock inserted into other clocks, whose fixed-time markers keep absolute positions. [V] https://docs.playitsoftware.com/PlayItLive/218/scheduling/clocks/

### 1.2 Log / playlist
- The **log** is the materialized, time-stamped list for a day/hour (what the automation executes). A clock is a template; the log is generated from clocks + music rules + fixed events. [G, consistent with PlayIt "clock generates log items" description] PlayIt: "When a clock is scheduled, the playout log generates items from the clock's items." [V]
- Log generation is typically done by a scheduler/log-generator tool (Rivendell: RDLogManager generates logs from Grids, Clocks, Events; RDLogEdit is the manual log editor) [V-ish: Rivendell 0.9.1 guide TOC via search] https://mirror.unpad.ac.id/orari/library/library-sw-hw/linux-1/broadcasting/rivendell/docs/rog-0.9.1.pdf
- Rivendell structure per its user guide: Section 7.1 Grids, 7.2 Clocks, 7.3 Events (log generation chapter). [S]
- Transitions and time types are edited per log event in RDLogEdit (Rivendell operations guide Ch. 5). [S]

### 1.3 Hard vs soft timed events (fixed-time markers)
- **Hard**: cuts off whatever is playing to hit the time exactly; the preceding item fades out. Used for top-of-hour network news / legal ID that must start on the second. [V] PlayIt clocks doc says "Hard: cuts off any playing item to hit the time exactly." Also [S] ETM "Hard" described as News/Talk option that stops audio immediately.
- **Soft**: waits for the current item to finish, then starts. Items between the current position and the soft marker are skipped. The current item is not faded; if a long song is started just before the marker, everything after it runs late. [V] PlayIt: "Soft: waits for the current item to finish." mAirList: "It will wait for the current item to finish first." Skipped items are marked for removal (trash icon). [V] https://community.mairlist.com/t/soft-timing/3800
- **Not Before** (PlayIt): following items may not start before the specified time. [V] PlayIt clocks doc
- mAirList soft-time "time frame": applies only with soft timing; caps how long the current item may run before the marker. Example: soft 01:00:00 with 60 s frame = start when current ends but no later than 01:01:00. [F/S] mAirList wiki summary in forum
- mAirList **backtimed** item: placed before a hard/soft item and pushes its end onto the fixed time. [S]
- mAirList "wait" option on hard/soft item: if reached early, inserts silence until the fixed time ("infinite silence"). [S] Note: this is a known source of dead air complaints (forum thread "mAirList inserts silence in playlists"). [S] https://community.mairlist.com/t/mairlist-inserts-silence-in-playlists/10434
- Automatic jumps to fixed-time items arrived in mAirList v2.1; v2.0 required scripting or the event scheduler. Per Torben: no v2.0 backport. [F] soft-timing thread
- Feature request to PlayIt (ID 708 "Time stretch hour when in automation") and a PlayIt request for "fade a longer track earlier or lightly stretch a shorter one so it hits the hour marker; currently a hard marker can cut a track off abruptly." [F] https://www.playitsoftware.com/Support/FeatureRequests/708/Time-stretch-hour-when-in-automation

### 1.4 Time-fill and backtiming
- **Backtiming**: deliberately choosing/timing the last items before a fixed event so they end on the mark (historically used before network newscasts at :00). Working backward from the break's end time; the operator must know each record's *audible* length (after intro/outro trims). [V-ish] T. Carter Ross article on Radio World (https://radioworld.com/rwonline-blog/20167) calls it a "nearly lost art" that automation has made rare; gives no method or numbers.
- **Time-fill**: filling a gap of known length with items of fitting length (spots, promos, sweepers, a filler, a song of the right length). Automation systems mostly do this by:
  - user-selected filler/"time-fill" playlists,
  - playlist-generator rules that select songs to fit an exact hour (RadioBOSS user request; not confirmed built) [F],
  - backtiming with a fixed-time marker and an item that "stretches" (see 1.6).
- RadioBOSS Cloud user asked for automatic track selection so a song ends at the hour, with a filler sweeper as buffer. [F] https://www.djsoft.net/community/threads/back-timing-in-radioboss-cloud.6972/
- Practical consensus in forum threads: pre-process tracks to exact known durations (trim leading/trailing silence, since the audible length matters) so calculations are reliable. [F]

### 1.5 Segues, crossfades, cue points, mix points
Vocabulary:
- **Cue-in / cue-out (intro / outro)**: start and stop points inside a file; the audio between them is what plays. Often stored as metadata, not in the file.
- **Segue / mix point**: the point where the outgoing item's end overlaps or hands over to the incoming item's start. Voice tracks are recorded against the "segue editor", where the presenter hears the end of the previous track and the start of the next. [V] PlayIt VoiceTrack article via search.
- **Hook/intro markers**: vocal intro lengths are used to determine when a vocal can start over the outgoing song (industry practice; PlayIt "Hook Sequence" clock item). [S]
- **Ducking/overlap**: voice-over runs over the start/end of a song while song volume is lowered. Station Playlist's "automatic voice track / song overlapping" and "intelligent crossfader" [S]. A PCS forum describes the technique for StationPlaylist. [S]

Cue handling in Liquidsoap (see section 8 for details).

### 1.6 Time stretching to hit the hour
- Stretch the audio tempo by a small percentage (typically a few %, up to ~7-15% in tools discussed) to end on the mark.
- RadioBOSS 7.1 beta: top-of-hour time stretch recalculates at each track start; if the needed adjustment exceeds the configured limit (users tried 7%, 10%, 15%) it is cancelled. A user found "+4.1%" cancels it. Gap killer and trigger mix settings make the true track length unknown. Workaround: pre-process tracks with trim silence. [F] https://djsoft.net/community/threads/radioboss-7-1-beta.12390/page-13
- ProppFrexx: per-track "Initial Tempo" field in tag editor enables time-stretch; noticeable on very short clips (e.g., 35 s -> 30 s). [F]
- Forum consensus: small stretches (a few %) are tolerated; major automation systems "generally support stretching spot or hour blocks". [F] mAirList "stretching" thread https://community.mairlist.com/t/stretching/16353
- Pro practice: stretch spot blocks or the final song, not general music. Trade-off is cut-off or pitch/tempo artefacts. [G]

---

## 2. Operating modes

- **Automation (full-auto / unattended)**: playout runs entirely from log/clock; operator intervenes only on exceptions. [G]
- **Live-assist**: operator starts each item (or selects a block) and stops at breaks; automation handles the rest. StationPlaylist Studio: "Live Assist mode lets you play tracks individually, or tick checkboxes to play consecutively before stopping for a live announcement." [V-ish; vendor feature table via search] https://office.stationplaylist.com/studio.html
- **Manual**: no clock-driven log; operator plays everything. Myriad (Broadcast Radio) markets "manual, live assisted or fully automated" modes and one-click switching between automation and live assist. [S] https://psquared.net/software/myriad-4-playout
- **Mixed**: automation with a live element (e.g., live news) that adjusts log dynamically. Myriad: "automation can be dynamically adjusted for real-world events such as live news." [S]
- Mode switching is a known pain point: operators want one-click switch with no audible glitch, and the current item must finish or be faded. [G]

---

## 3. Cart walls, hot keys, jingle players

- **Cart / cart wall**: a grid of one-touch slots (carts) holding a sound/cue, typically with a name, colour, duration, and optional cue points. Rivendell's equivalent is the **Sound Panel** widget (RD AirPlay module contains Main Log + Sound Panel; RD Panel module has a larger version). [V-ish via Marshall WMUL manual] https://www.marshall.edu/wmul/files/Volume-III-Computer-Playback-2020-07-21.pdf
- mAirList default: cartwall embedded in main screen with 3 slots/players; slot count configurable. [S]
- RadioBOSS cart wall: right-click tab -> "Hot key modifier"; with Ctrl or Shift as modifier press modifier+key; with Caps Lock as modifier press Caps Lock+key; press again to stop. [S] https://manual.djsoft.net/radioboss/en/cart_wall.htm
- RadioBOSS users request single-key jingles without modifier and "jingle on one key stops previous one". [F]
- Cart players must support: multiple simultaneous players (e.g., 3+), per-cart cue in/out and ramp, play-once vs loop, "stop on press" toggle, and overlap-with-main-audio ("mix") rules. [G]
- Liquidsoap equivalents of jingle insertion (see section 8): `switch` on time predicates, `rotate(weights=...)`, `add` with time-triggered jingle sources. [V] https://www.liquidsoap.info/doc-2.2.5/sources.html / cookbook

---

## 4. Voice tracking (local and remote)

- Voice tracking (VT): presenter records speech segments ahead of time (between songs) which the automation inserts into a playlist so the show sounds live. [V] PlayIt VoiceTrack, Futuri AudioAI, Station Playlist docs; RadioCult guide.
- Time savings claim: a 3-hour show in ~30 minutes (PlayIt blog 2025). [V] https://blog.playitsoftware.com/2025/04/24/produce-3-hour-radio-shows-in-just-30-minutes-the-power-of-voice-tracking-with-playit-live/
- Recording happens in the segue editor so the presenter hears the outgoing end and incoming start; mistakes re-recorded on the spot. [V-ish]
- Zetta (RCS): Zetta 4.0 lets voice tracks include beds/assets; one-click "start a drop bed alongside recording and fade it out when recording stops"; Zetta 5.21.1 redesigned Zetta2GO Voice Tracker with audio markers Trim In, Trim Out, Volume Points; Zetta 2.8 added record-over existing VT slots in the log through IVT. [S] RCS blog https://www.rcsworks.com/blog/rcs-adds-more-muscle-to-voice-tracking/
- Remote VT: presenter records from another computer/location and sends tracks to the station's automation; server address + login from station admin; presenter assigned a slot they're allowed to voice-track into; some products run through a browser. [S] PlayIt "remote voice tracking" docs https://docs.playitsoftware.com/PlayItVoiceTrack/112/remote_voice_tracking.html; StationPlaylist remote VT page https://office.stationplaylist.com/remotevt.html
- ENCO DAD (Dash Radio): remote voice tracking + Dropbox-based file transfer for DJs outside HQ. [S] (2015-2019 era coverage)
- Permissions model: per-slot permission, per-user access to playlists/schedule; some systems let remote users add songs or edit playlists by permission. [S]
- Liveness rules: VT content must land on a clock VT slot; if no VT is loaded for a slot, the automation must fall back (e.g., skip to next music, or play a default VT/"stop"). [G]

---

## 5. Stop sets, spots, commercial structure

- **Stop set** (industry): the block of spots/promos/imaging played during a commercial break, scheduled as a unit. [S] Trade commentary: 2 stop sets/hour common; some hours 3; listeners begin tuning out around the one-minute mark, so long sets are debated. [S]
- In practice: stop set = ordered spot block with rules (no two spots from same advertiser back to back; no competitor adjacency; exact or approximate length; last item = station "back to music" sweeper). GSelector Interstitials can place a "back to the music" sweeper as second-to-last element in a break. [S] RCS
- RadioBOSS: "insert stop command" lets an operator insert a stop; forum thread debates whether scheduled items should interrupt a stop or wait in queue. [F]
- Ad-block features (advanced): PlayIt "Advert Block" (Advanced Scheduling module). [V]
- Stop set timing typically sized to the hour's remaining slack; if a long spot runs over, the hour overruns. Time-fill and stretch (1.4/1.6) apply here. [G]

---

## 6. Net joins, syndication, network logs

- **Syndicated content** (e.g., NPR Morning Edition) is ingested as a file/feed and placed in the log as fixed-time items (hard-timed to network start). [S] ENCO KDNK case
- **Network join / join-in-progress**: a local station joins a network feed at a scheduled point (a "network hit"/"join"), and returns to local after the network segment. Usually implemented as a fixed-time or hard event with an input (satellite/IP) and a return cue. [G]
- PlayIt: user request for a **master network log** feeding local stations, with locals playing their own sweepers/spots. Not confirmed as built. [F] https://www.playitsoftware.com/Support/FeatureRequests/Recent/7 (search)
- PlayIt "PlayIt Manager" is a separate server holding one set of station data that several PlayIt Live instances sync with; an instance can also sync peer-to-peer if its built-in remote access server is on. [V-ish, glossary]
- ENCO DAD: one server can drive up to 12 streams (Dash Radio); DAD positioned as network hub between on-air studio, newsroom, production, program department (KDNK). Vista Radio: 40+ stations on one ENCO system sharing content. [S]
- Scheduling-software integration: DAD integrates with MusicMaster (Cut File application exports to it). [S]
- Liquidsoap network join equivalents: `input.harbor` / `input.http` as live sources in a `fallback`/`switch`. [V] cookbook

---

## 7. Emergency, failover, silence fallback

### 7.1 Emergency playlists
- Emergency/fallback content is typically a short "emergency" playlist or single file, played when the main log/source fails. [V] Liquidsoap cookbook: `fallback(track_sensitive=false, [live, playlist, emergency])` with `emergency = single("...")`.
- RadioBOSS: silence detector action can be "load an extra playlist" (emergency playlist, e.g., `fallback.m3u8`). [V] RadioBOSS manual
- Known bug/complaint: RadioBOSS 6.2.4.2 user: after fallback triggered by silence inside a track, only the left channel played until restart; attributed to equalizer bug; still reproducible on 6.3.0.3 per user. [F] djsoft thread
- Known complaint: emergency playlists that replay already-aired tracks (Liquidsoap-based project fixed "stream: fallback only replays already-aired tracks"). [S] https://git.nemunai.re/nemunaire/radieo/commit/80f27d2795a22831fdeed87fafac6952696cd7f8 - shows a common bug class: fallback picks the same track again.

### 7.2 Silence detection
- **RadioBOSS silence detector** (manual): Settings > Options > Silence detector; detects output level below a threshold (threshold value not named on the page); duration slider (e.g., 10 s); actions: play next track, repeat playlist, or load extra playlist. Enabled via "On" checkbox. Cloud version switches live stream to cloud playlist on silence (earlier versions only on disconnect). [V] https://manual.djsoft.net/radioboss/en/silence_detector.htm and [S] djsoft cloud threads
- RadioBOSS users note silence detection on live stream: "Check silence" option disconnects live stream on silence (RadioBOSS feature). [S]
- Silence trimming: RadioBOSS "Process Tracks" trims leading/trailing silence only, not mid-track. [F]
- Pro practice: silence detection must be at the **program output**, not the source, and must distinguish intentional silence (e.g., a pause before a VT) from dead air; typical thresholds around -40 to -50 dBFS for ~5-10 s sustained. [G] (no vendor source fetched for thresholds)

### 7.3 Redundancy and "rock-solid"
- ENCO (IBC2016): "seamless failover software"; on server failure or network outage, full playlists and advertisements move to local studio operations. ENCO claims automation "rock-solid" and that broadcasters are protected with "no disruption to operations or the consumer experience". No technical detail on trigger time. [V] https://www.enco.com/blog/enco-strengthens-redundancy-across-tv-and-radio-automation-systems-at-ibc2016
- Netia AirPlayList: 1:1 or 1:N redundancy with a server pool; secondary recovers media after disaster (vendor claims). [S]
- Cold standby (Etere case, Brazil): standby automation activated manually. [S]
- Hot standby: a LAN PC mirrors the on-air folder and acts as standby. [S]
- Storage switchover can take up to 60 s with ingest/transfer/playout interrupted (Rohde & Schwarz VSA technology paper). [S] So hot standby must not depend on slow storage failover. https://scdn.rohde-schwarz.com/ur/pws/dl_downloads/dl_common_library/dl_brochures_and_datasheets/pdf_1/Technology_Paper_VSA.pdf
- "Rock-solid" in pro gear (synthesis, [G] + above): (a) deterministic log execution even when a source is late; (b) no dead air on source/network failure (fallback chain, instant switch); (c) audio never stops on server restart (hot standby, mirrored storage); (d) every event has a defined action when its source is missing (skip, substitute, or emergency); (e) hard-timed items (news, legal ID, network joins) fire on time within a few hundred ms; (f) logs/scheduling survive reboots; (g) full audit trail of what aired (as-run log); (h) monitoring of silence, level, stream status with alerts; (i) remote access for operators with failover to a local studio.

### 7.4 As-run logs
- As-run log = record of what actually aired (start time, duration, source, ID). Required for royalties (SoundExchange, performing rights), regulatory compliance, and disputes. [G] Some vendors export as-run to CSV/XML. [G]

---

## 8. Liquidsoap implementation notes (2.2.x)

Source references: [V] https://www.liquidsoap.info/doc-2.2.5/crossfade, https://www.liquidsoap.info/doc-2.2.5/sources.html, https://www.liquidsoap.info/doc-2.2.5/cookbook, https://www.liquidsoap.info/doc-dev/seek.html (search), https://www.liquidsoap.info/doc-dev/requests (search), on2 part1 tutorial (search).

### 8.1 Sources and composition
- `fallback(...)` plays children in priority order; switches to the next child when the current one is unavailable. Infallible only if at least one child is infallible. [V]
- `track_sensitive` (default: track-sensitive, i.e., switches wait for the current track to end). Setting `track_sensitive=false` allows mid-track switches for live handover. A switch cuts into a playing track only if at least one source has `track_sensitive=false`. [V/S] https://www.liquidsoap.info/doc-dev/composition
- Example: `radio = fallback(track_sensitive=false, [live, playlist, emergency])` [V]
- Live input: `live = input.harbor("live", port=8080, password="...")`; short buffer for faster switch: `input.harbor("mount", buffer=3.)` [V]
- `switch` takes `(predicate, source)` pairs; time predicates such as `predicate.activates({0m-5m})` (jingle in first 5 min of hour) and `{0m0s}` (exact top-of-hour trigger). [V] cookbook/sources
- `rotate(weights=[1,3],[jingles,music])` mixes jingles at 1:3. [V]
- `random`: picks a child at track boundaries; infallible if one child is infallible. [V]
- `add([normal, switch([({0m0s}, jingle)])])` adds a top-of-hour jingle on top of normal source. [V]
- `request.queue(id="q")` + `playlist(...)` in a fallback gives a runtime-controlled priority queue; push via telnet (enable with `-t`), commands include `push`, `queue`, `skip`, `flush_and_skip`; requests tracked by RID (request.metadata, request.trace). [S] on2 tutorial; 2.2.5 slides.
- `smooth_add(normal=..., special=...)` is used for mixing jingles with smooth starts/ends in older scripts; verify syntax for 2.2.x. [S]

### 8.2 Crossfade and transitions
- `cross(duration, transition, source)`: low-level; `transition` receives previous/next dB levels, metadata, and sources. [V]
- `cross.smart` (defined in `utils.liq`), parameters: `~fade_in` (3.0 s), `~fade_out` (3.0 s), `~high` (-15 dB), `~medium` (-32 dB), `~margin` (4 dB), `~default` (default `sequence([a,b])`). Rules: both <= medium and within margin -> crossfade both; b >= margin louder, a >= medium, b <= high -> fade out a only; a >= margin louder, b >= medium, a <= high -> fade in b only; b >= margin louder, a <= medium, b <= high -> cross without fading; else default. Fades are `fade.out/fade.in(type="sin")`. [V]
- 2.2.5 adds an automated transition mechanism ("autocue") via `enable_autocue_metadata()` if ffmpeg bindings enabled. [S]
- Note: the 1.4.x-era `smart_crossfade` in utils.liq exposed `~start_next`, `~width`, `~conservative` with -20 dB loud / -32 dB medium defaults. [S]
- Liquidsoap's own cookbook names `smart_cross` as a suitable default for most cases. [V]

### 8.3 Cue in / cue out
- Cue points are metadata-driven, applied to file-based sources via an `annotate:` URI or playlist metadata. Example from docs: `annotate:liq_cue_in="10.",liq_cue_out="45":file.mp3` applied on a playlist makes every track cue-in at 10 s and cue-out at 45 s. [S]
- **Key-name discrepancy**: requests docs use `cue_in` / `cue_out`; cue_cut docs use `liq_cue_in` / `liq_cue_out`. Config knobs `playlists.cue_in_metadata` and `playlists.cue_out_metadata` change names. Verify against the installed version. [S]
- **Cue-out reference point**: relative to start of file (not to cue-in) per AzuraCast developer notes and the requests docs. [S]
- `cue_cut` operator reportedly removed in 2.2.5, with cueing moved into file-based sources; treat cue_cut examples as version-dependent. [S] Verify before depending on it.
- `source.seek(...)` takes a **relative** offset from current position and returns the amount actually seeked; supported by file-based sources (`request.queue`, `playlist`). [S]

### 8.4 Time-based scheduling and wall-clock triggers
- Use `predicate.activates` and `{0m0s}`-style time intervals in `switch` for top-of-hour triggers. Precision depends on buffer and frame timing; test hard events on the target box. [G]
- Liquidsoap has no built-in clock/log model: the operator must build clock logic in `.liq` or feed a log via request/playlist sources (e.g., from the Node.js backend via telnet/`request.push`/HTTP). This is the key design gap for us. [G]

### 8.5 Implementation pattern suggested for our product
- Backend (Node.js) owns the **log** (compiled from clock + rules + fixed events) and pushes items to Liquidsoap just-in-time (lookahead ~2-5 items) through `request.queue` (id per station/slot) over telnet or HTTP; Liquidsoap handles sample-accurate transitions, cue points, and fallback.
- Fixed-time/hard events: schedule in backend, trigger via `switch` with `predicate.activates`, or pre-queue with `track_sensitive=false` on the hard source.
- Fallback chain per output: `fallback(track_sensitive=false, [live_harbor, request_queue_main, playlist_scheduled, emergency_single])`, then `cross.smart` / autocue for transitions, then output.
- Silence detection: Liquidsoap `skip_blank` / `blank.detect` (verify name in 2.2.x) feeding a fallback switch.

---

## 9. Paid-tool features NOT typically in open source (playout side)

| Capability | Pro tools | Open-source status |
|---|---|---|
| Format clocks with typed categories, separation rules, spot-load calc | GSelector, Zetta, PlayIt Live, Myriad, RadioBOSS | Partially: AzuraCast/LibreTime have clocks-lite; Rivendell has grids/clocks/events |
| Hard/soft/not-before fixed-time markers with time frame, backtime, reset | PlayIt, mAirList, Zetta/GSelector | Requires scripting in Liquidsoap; no UI |
| Flex clocks (minute-level, 24 h single-day) | GSelector 4.9 | no |
| Voice-track studio with IVT, drop beds, trim/volume markers, remote VT with permissions | Zetta 5.21, PlayIt VoiceTrack, StationPlaylist, DAD | Limited; AzuraCast none native; Rivendell basic |
| Interstitials (back-to-music sweeper placement) | GSelector | no |
| Network hub, MusicMaster integration | ENCO DAD | no |
| Seamless failover, mirrored storage, hot standby | ENCO, Netia, R&S/Etere | Limited to DIY |
| Time stretch to hit hour (automatic) | RadioBOSS 7.1 beta (flaky), PlayIt (request) | no |
| Multi-player cart wall with hot-key modifiers | RadioBOSS, mAirList, StationPlaylist | Rivendell Sound Panel |
| Live-assist with one-click mode switch | Myriad, StationPlaylist, mAirList | partial |

---

## 10. Open-source tool notes and known complaints

- **AzuraCast**: GitHub/feature board: "Once per X" playlists can't be time-scheduled per day (issue 1289 referenced); scheduled playlists overridden by listener requests (request for blocking during windows, "under consideration"); interrupted playlists replay last track on resume; "Start/end dates not respected by Liquidsoap playlists"; "Merge playlist: scheduling not respected"; request for artist-separation windows (licensing). [S] https://features.azuracast.com/suggestions/39041/comment/147465 ; https://features.azuracast.com/suggestions/61827/disable-song-requests-while-certain-other-playlists-are-playing ; https://features.azuracast.com/suggestions/38907/specify-a-time-when-songs-can-be-requested-from-a-given-playlist
- **AzuraCast Liquidsoap**: developer docs https://azuracast.com/docs/developers/liquidsoap/ (cue-out relative to file start per note).
- **LibreTime** (Airtime fork): maintainer says LibreTime is alpha, does not support pre-current versions; AzuraCast "does not provide the scheduling power that LT has" (maintainer opinion). [F] Cloudron forum https://forum.cloudron.io/topic/4251/libretime-radio-broadcast-automation-platform/17 . Downstream project pulls only 60 days of schedule from LibreTime because errors further out; proposes 183 days. [S] https://github.com/radiorabe/website-stack/issues/21 . Old Airtime commits: timezone mismatch warnings between server and player. [S]
- **Rivendell**: GPL v2, Linux-only (CentOS 7 documented), components RDLogManager (log generation from grids/clocks/events), RDLogEdit (log editing), RD AirPlay/Sound Panel. Could not verify its hard/soft event semantics from search. Repo: https://github.com/ElvishArtisan/rivendell [S]

### Other tools (paid) - summary of what was verified vs not
- **RCS Zetta / GSelector**: clocks, Flex Clocks, Interstitials, voice tracker (IVT, drop beds, trim/volume markers), 2-stop-set standard design. [S] Vendor blogs.
- **PlayIt Live / VoiceTrack / Manager**: clock items, hard/soft/not-before markers, partial clocks, Advanced Scheduling module, remote VT, Manager multi-instance sync. [V] docs.playitsoftware.com
- **mAirList**: soft/hard/backtimed/silence-insert items; soft time frame; cartwall with 3 default slots; v2.1 auto-jumps to fixed-time items. [V/F] community.mairlist.com
- **RadioBOSS**: silence detector (threshold, duration, actions), cart wall with hot-key modifiers, time stretch to hit hour (7.1 beta), cloud silence fallback. [V/F] manual.djsoft.net
- **StationPlaylist Studio**: Live Assist mode with checkbox consecutive play; automatic VT overlapping; intelligent crossfader; requires StationPlaylist Creator for automation; Standard $159. [S] office.stationplaylist.com
- **Myriad (Broadcast Radio)**: manual/live-assist/automation with one-click switch; "Future Moves" moves songs between playlists; Myriad Schedule Pro (2026) standalone or alongside third-party playout. [S] radiotoday.co.uk/2026/01 ; psquared.net
- **ENCO DAD**: redundancy/seamless failover, up to 12 streams per workstation, remote VT with Dropbox transfer, network hub, MusicMaster integration. [S, 2015-2019 era coverage]
- **Jazler**: could not find authoritative docs; low-quality marketing pages mention music scheduler with airplay tracking and Final Log generator, preloading ~2 h ahead, mix-point editing. Treat as unverified.
- **Zara / ZaraStudio**: not researched sufficiently; skip.

---

## 11. Feature checklist for our product

### MUST (launch-blocking)
- Format clock editor: hour template with typed slots (music category, spot block, ID, news, VT, imaging, fixed-time markers), partial clocks, weekly clock assignment by daypart, playout pattern fallback for unscheduled hours.
- Log generation: compile clocks + music rules + fixed events into a time-stamped log per station per day; regenerate on change; show a conflict report (overruns, unfillable gaps, hour totals != 60:00).
- Fixed-time markers: `hard` (cut to hit time) and `soft` (wait for current item to end, skip intervening items), plus `not before`; a configurable soft time-frame cap.
- Time-fill: fill a gap of known length with eligible filler; spot-block length calc.
- Cue in / cue out and intro/outro (segue) metadata per track, with per-track override and a preview of the transition.
- Crossfade/segue engine with default transition (`cross.smart`-style rules) and per-track override; no dead air during transitions.
- Live-assist vs full-auto mode per station/output with one-click switch that does not interrupt the current item (or does so only by explicit choice).
- Fallback chain per output: live input > request queue > scheduled log > emergency playlist > emergency single file; `track_sensitive` configurable for instant live takeover.
- Silence detection on the program output with threshold + duration + action (next track, repeat, emergency playlist), alerts on triggering.
- Cart wall / jingle players: at least 3 simultaneous carts, one-touch and hot-key triggering, stop/ramp options.
- Voice tracking: record in-browser against a segue view with trim in/out, drop beds, re-record slot, assignment of VT slots to clocks.
- As-run log: record what actually aired (start, duration, source, track id, mode) for reporting/royalties.
- Multi-tenant isolation: per-station logs, clocks, carts, permissions; a station cannot touch another station's output.
- Monitoring: stream status, log lag (how far ahead the queue is), current item, next item, silence, last error.

### SHOULD
- Backtiming helper (show required length to hit the next fixed time; list candidates).
- Automatic time-stretch limited to a configured percent (e.g., max 4%) applied to last item before a hard marker; disabled by default.
- Stop-set builder: spot-load rules, advertiser separation, back-to-music sweeper placement.
- Separation/rotation rules: artist and title separation (minutes/hours), category separation (e.g., no Current after Current), day-part rules.
- Remote voice tracking with per-slot permissions and a web recorder.
- Network join scheduling: fixed-time input join with return cue; master/network log feeding local stations with local spot insertion.
- Hot standby/recovery: restart the playout worker without audio gap; mirrored media store; documented failover RTO.
- Clock priority rule when two clocks overlap in one hour.
- Import/export of clocks and logs (CSV/XML) and an as-run export.

### COULD
- Ducking/overlap editor (voice-over over song intro with automatic volume drop).
- Hook/intro-length-aware segue suggestions (vocal intro detection).
- Scheduling-software integrations (MusicMaster/GSelector-style imports).
- Syndication/affiliate delivery (feed of a master log to affiliates).
- Ad-insert markers (SCTE/cue tones) and metadata push to streams (RadioCult-style).
- Analytics on clock adherence (planned vs as-run deviation per hour).

---

## 12. Liquidsoap implementation notes (summary of gotchas)
- Default fallback is track-sensitive: a switch to live waits for the current track end unless `track_sensitive=false`. Set it on the live branch, and expect a short mid-track cut when used.
- Transition level thresholds (-15 / -32 dB / margin 4 dB) are tuned for mainstream music; expose them per station.
- Cue point key names vary by version (`cue_in` vs `liq_cue_in`); pin the version and test.
- Cue-out is measured from file start, not from cue-in.
- `seek` is relative.
- `cue_cut` reportedly removed in 2.2.5; check before using.
- Feed logs via `request.queue` (RIDs) rather than writing playlists to disk; expose RID-based metadata for as-run logs.
- Use separate sources per station; avoid one global `output` pipeline across tenants.

---

## Source list (primary URLs visited or surfaced)
- https://www.tunetrackersystems.com/articles/understanding-format-clocks.html [fetched]
- https://docs.playitsoftware.com/PlayItLive/218/scheduling/clocks/ [fetched]
- https://community.mairlist.com/t/soft-timing/3800 [fetched]
- https://radioworld.com/rwonline-blog/20167 [fetched]
- https://www.liquidsoap.info/doc-2.2.5/crossfade [fetched]
- https://www.liquidsoap.info/doc-2.2.5/cookbook [fetched]
- https://www.liquidsoap.info/doc-2.2.5/sources.html [fetched]
- https://manual.djsoft.net/radioboss/en/silence_detector.htm [fetched]
- https://www.enco.com/blog/enco-strengthens-redundancy-across-tv-and-radio-automation-systems-at-ibc2016 [fetched]
- https://djsoft.net/community/threads/radioboss-7-1-beta.12390/page-13 [search]
- https://www.rcsworks.com/blog/rcs-adds-more-muscle-to-voice-tracking/ [search]
- https://office.stationplaylist.com/studio.html [search]
- https://features.azuracast.com/suggestions/39041/comment/147465 [search]
- https://forum.cloudron.io/topic/4251/libretime-radio-broadcast-automation-platform/17 [search]
- https://github.com/radiorabe/website-stack/issues/21 [search]
- https://www.marshall.edu/wmul/files/Volume-III-Computer-Playback-2020-07-21.pdf [search]
- https://manual.djsoft.net/radioboss/en/cart_wall.htm [search]
- https://www.liquidsoap.info/doc-dev/composition [search]
- https://www.playitsoftware.com/Support/FeatureRequests/708/Time-stretch-hour-when-in-automation [search]
- https://www.rcsworks.com/blog/rcs-live-building-gselector-clocks/ [search]
- https://radiotoday.co.uk/2026/01/myriad-schedule-pro-launches-with-smarter-radio-scheduling/ [search]
- https://www.psquared.net/software/myriad-4-playout/features [search]
- https://blog.playitsoftware.com/2025/04/24/produce-3-hour-radio-shows-in-just-30-minutes-the-power-of-voice-tracking-with-playit-live/ [search]

## Known gaps (not resolved in this pass)
- Rivendell hard/soft event semantics not verified (search returned no relevant results; read the 0.9.1 PDF and GitHub source directly).
- mAirList "not before" marker: not confirmed as a mAirList term; PlayIt has it.
- Jazler, Zara, Myriad fallback/emergency playlist: no authoritative docs found.
- Liquidsoap `cue_cut` / `smart_cross` / `enable_autocue_metadata` and `request.queue` push API: verify signatures against the installed 2.2.x.
- Silence-detection thresholds: no vendor-stated defaults found; test on hardware.
- Net join / join-in-progress mechanics across pro systems: no concrete docs found.
