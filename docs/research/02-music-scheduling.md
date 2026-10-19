# 02 - Music scheduling (the "music director" side)

Scope: how professional music schedulers model rotation, clocks, rules and burn; how open-source tools (AzuraCast, LibreTime, mAirList-style, Liquidsoap-based) handle "smart" playlists; where they fall short; algorithmic/AI trends.

Caveat on sources: much of the vendor material found is vendor blog content (RCS Works, MusicMaster, PowerGold, NextKast). Several vendor pages returned HTTP 403 to WebFetch (RCS "priority list" and "John Bonou" posts, MusicMaster p=165 page, INFORMS paper), so those claims come from search snippets only. Items marked [unverified] are snippet-level. Numbers are vendor or consultant claims, not standards.

---

## 1. Professional terminology and core model

### 1.1 The vocabulary
- **Category** (a.k.a. "rotation", "list", "bucket"): a set of songs that share a scheduling policy. Typical programmer categories: Power Current, Secondary Current, Power Recurrent, Recurrent, Gold, Sweepers/Imaging, Jingles, Positioners, Liners, Spots. Sources: powergold callout tips https://www.powergold.com/?p=1053 ; radioiloveit callout series.
- **Category group** (GSelector): a bundle of categories scheduled together, e.g., "Powers", "Secondary", "Recurrents" (one programmer's approach). Source: https://www.rcsworks.com/blog/gselector-priority-list-scheduling-tips/ [unverified snippet].
- **Clock / format clock / hour template**: the fixed sequence of positions (slots) per hour, each slot naming a category (e.g., "Power 1", "Secondary 2", "Sweeper", "Spot Break"). Multiple clocks per daypart.
- **Power rotation / heavy rotation**: the top-N songs played most often (historically 9, then 7, then 5, then 2–3 as consensus hits narrowed). Source: https://radioinsight.com/blogs/338527/what-power-rotation-says-about-top-40-in-2026 (via search snippet).
- **Recurrent**: songs moved off current status after a run (typical trigger in snippets: out of Top 10, losing spins for consecutive weeks, roughly week 20 on chart). Source: https://frontsidegroup.com/what-does-recurrent-mean/ (snippet).
- **Gold / Oldies**: older catalog, placed mostly by auditorium testing.
- **Burn / burnout**: listener fatigue from over-repetition ("hearing the same song roughly every 1:10 for nine months" per Sean Ross description). Source: https://www.powergold.com/?p=1801
- **Lunar rotation**: songs placed only in off-peak hours (late night).
- **Sound code / sound coding**: attribute tags (mood, tempo, era, energy, "fringe" codes) used to govern transitions (segue bans) and flow. Terminology confirmed in GSelector materials.
- **Segue**: transition between two songs; governed by sound-code bans.
- **Twofer**: a pairing of two songs scheduled as a unit (GSelector).
- **Search depth**: how far down a category's ordered list the scheduler looks (100% = whole category; 75% = 3/4). GSelector. Search depth 1 forces sequential play. MusicMaster and GSelector both use depth as a core knob. Also "Song Error Log" in NextKast flags search depth under 30% as the target.
- **Pass order / schedule order**: order in which categories are scheduled. Primary categories first; a Twofer scheduled before a category is placed first. Source: GSelector tips (snippet).
- **Hypothetical / dry-run playlist**: simulate schedule without publishing (NextKast "Hypothetical Playlist Generation", MusicMaster "Analysis" hypothetical rotation view).
- **Log / reconciliation**: the generated schedule sent to automation, later compared with "as-aired" logs.

### 1.2 Typical workflow in a professional station (synthesis of vendor docs)
1. Build the library: import tracks; set attributes (artist, title, category, era, tempo, mood/sound codes, gender, vocal type, primary artist for duets/features, featured artists).
2. Assign each song to a category and set its place in the rotation (add/drop dates, current/recurrent transitions).
3. Build clocks per daypart (e.g., overnight clock, morning drive clock, middays).
4. Define rules: separation, kicks, segue bans, rule groups per daypart.
5. Generate the schedule (auto-fill from clocks; scheduler picks songs by search depth, demand, separation, sound codes).
6. Manually edit the generated log (replace songs, check flow, fix conflicts and dead air); the human "finish" pass is standard.
7. Push to automation (Music Master, GSelector, PowerGold export to Zetta/ENCO/WideOrbit/mAirList etc.).
8. Reconcile: compare the generated log with the as-aired log (from automation logging) to find skipped/unplayed songs, overplays, and missed rules; feed corrections back.
9. Analyse: rotation analysis, average repeat times, AutoBurn, property goals, share/turnover projection.
10. Research feedback loop: callout/AMT data updates song scores and category placement.

---

## 2. Paid professional tools: how they work and what they do that open source does not

### 2.1 RCS Selector / GSelector (Radio Computing Services)
- Goal-based scheduling. Per RCS: "instead of writing rules to avoid bad outcomes... you tell the software what you want and it automatically figures out the rules." https://www.rcsworks.com/press/battle-of-the-music-scheduling-systems-software/ (snippet/search; vendor marketing).
- Demand-based placement: songs are placed according to inherent demand, driven by clocks, stations, and song coding (G2 listing paraphrase). https://g2.com/products/rcs-gselector/discuss
- Multi-station on one shared library (one library, many channels).
- Sound-code segue bans with separate ban priorities: setup path Setup > Station > Features > Advanced > "Separate Ban Priorities" [snippet]. Example: Pop->Pop breakable, Pop->Pop->Pop unbreakable.
- Color-coded fringe sound codes, tempo and era values in the Editor for spotting flow problems.
- Category groups instead of individual categories for clock placement.
- Airplay Starvation goal under Setup > Station > Features > Advanced; works in a 150%–200% window of expected rotation [snippet]; not for tight categories with heavy turnover.
- Spread Goals: disable with Scheduler: Slotted to schedule in a predefined order.
- Kicks and Kick Override: available with Slotted or Kick categories.
- Projected Turnover column and Category Share/Shift as the tuning knobs (instead of raw song counts).
- Web products: Selector Cloud (browser-based: library, clocks, policy, log editing, transfer to automation, analysis) and Selector2GO (browser UI for core scheduling, schedule editing, rotation analysis). https://tw.rcsworks.com/press/the-selector-cloud/
- Sources: https://www.rcsworks.com/blog/gselector-priority-list-scheduling-tips/ [403 on fetch; snippet]; https://rcsworks.com/gselector-priority-list-scheduling-tip [snippet]; https://www.rcsworks.com/blog/rcs-live-gselector-kicks-category-group-settings/ (fetched, partial).

### 2.2 MusicMaster (Myriad / Broadcast Radio family; often called "MusicMaster" by programmers)
- Rule Tree with nested Rule Groups (apply only in given dayparts or conditions; e.g., 1-hour rest overnight, 3-hour rest in day).
- Song/History Rules > Hour Rotation Rules. Key rule: **Auto Kick**: stops a song replaying in the same time window on consecutive days. Window sizes: Full Hour, Half Hour, Quarter Hour (four 15-min segments). Full Hour ~ Day Offset window rule of 1 day + 1 hour. Options: "Ignore other categories" (skip plays logged in other categories). Scope: all categories, specific categories, or rule group. Source: https://musicmaster.com/?p=7147 family; fetched https://musicmaster.com/?p=7147 (partial).
- **Hour Rotation Position Kick** (added v7.0.10): prevents a category appearing in the same spot twice within an hour, with window size (16 min example). Advice: do not put it under All Categories.
- **All Category Bypass**: isolates All-Category rules from category rules.
- **Flex Rules / Migrating positions**: a category can move between clock slots hour-to-hour while keeping overall rotation, instead of being locked to one slot.
- **Format Lists**: alternative to many separate clocks for irregular patterns.
- **Search depth 1** in schedule properties = sequential play of the category.
- **Pass order** and stacked pass orders/depths visible in the Advanced tab.
- **Schedule Order** dragging, and "Arrange Category" juggle/optimize functions.
- **Analysis**: hypothetical rotation view (songs and slots only, except AutoBurn), Format Clock Category Usage view for clock/category inconsistencies.
- Powers placement: if a Power does not land where the clock places it, remove that category's rules and bypass from All Categories (relies on well-designed clock). Source: https://musicmaster.com/?p=165 family (snippet).
- Artist separation benchmark: MusicMaster material calls **1 hour 10 minutes** an industry-standard starting point, with lots of programmers starting around 1:10; per-artist overrides (one core artist 1 hour, a light one 2h40m). Vendor claim, not a standard. Sources: https://musicmaster.com/?p=11068 and https://musicmaster.com/?p=7959 (search snippets).
- Sources: https://musicmaster.com/?p=7147 ; https://musicmaster.com/?p=165 ; https://musicmaster.com/tourfeatures.php (search).

### 2.3 PowerGold (Micropower / RCS family per some listings; verify)
- Per vendor: Powergold NXT built on Microsoft SQL. Features: rule optimization, schedule snapshots, element merge functions, music-research imports, improved undo. https://www.radioworld.com/tech-and-gear/products/powergold-rolls-out-nxt (snippet)
- **Instant Analysis**: set property goals (e.g., % female, tempo mix) and compare schedule segments, including across sister stations.
- **Analysis Suite**: average repeat times for groups of songs.
- **Playout Substitution**: maps multiple versions (edits, radio mixes) to a master song record so rotation counts stay correct. Important for multi-version libraries.
- **Workflow Manager**: task grid. **Format Control**: prepares database for scheduling.
- Cross-station rules and cross-station history reporting; Priority Rules with "Flexible Core" (2016 release per search).
- Callout/AMT import and research-driven scoring (see section 4).
- Sources: https://www.powergold.com/?p=2373 ; https://www.powergold.com/?p=93 ; https://www.powergold.com/?p=1801 (fetched).
- Note: one listicle claims PowerGold is part of RCS; not verified. Do not rely on it.

### 2.4 Other commercial selectors (search-level findings only; deeper detail not retrieved)
- **Prophet Systems MusicGen Pro**: hourly stacking method with a different stack per hour (so a song played at noon today sits at the bottom of the noon stack tomorrow); "multiplay" rules for theme/list events; custom coding and rules; integrates with most automation. https://www.radioworld.com/news-and-business/prophet-adds-musicgen-pro
- **mAirList** (automation with scheduling, popular with small/medium stations): separation per artist and per title in hours, fully customizable since v7.3; featured artists detected and blocked; scheduling is "single-dimensional" by folders (attributes can be hard folders, not a second rotation dimension). Gender separation workaround: define Gender as a standard attribute and filter, or copy tracks into separate male/female virtual folders and alternate (template approx. 2/3 : 1/3). Developer says multi-dimensional scheduling would be "too complex and slow" and points users to MusicMaster. Separation only applies to scheduled playlists, not to live host picks. Sources: https://community.mairlist.com/t/gender-seperation/12914 ; https://community.mairlist.com/t/scheduling-rules/18982 ; https://community.mairlist.com/t/title-separation/15885
- **NextKast onAir**: Repeat protection, artist separation, gender balance, tempo as Advanced Rules (Settings > Advanced Rules). Multi-Pass Scheduling (iPass) separating artists with a power bias combined with track ratings; Randomized Picker; Hour Control (track types and limits per hour); Category Filters and Subfilters (feel, tempo); Clock Builder with "Simplify Clock Structure"; Dayparts; Day Segments (spread playtime evenly across dayparts); Song Error Log (search depth; <30% optimal); Hypothetical Playlist Generation (Settings > Advanced > Debug Mode). Source: https://www.nextkast.com/onAir/knowledge-base/advanced-music-scheduling/ (fetched).
- **CloudRadio** (AutoDJ-style): Track repeat protection (on, matches exact recording), artist separation (off by default), album separation (off by default). All in minutes, range 10–1440; track repeat commonly 120–180 min; artist example 60 min. Exempt tag "Exempt from separation rules". Tracks with blank artist/album don't block. Relaxation order when unsatisfiable: album separation, then artist separation, then allow earlier repeat, final safeguard: least-recently-aired track. Source: https://www.cloudrad.io/help/separation-rules (fetched). This relaxation ladder is a useful design pattern for us.
- **PlayIt Live**: per-track-group separation (e.g., songs 2 h, jingles 10 min). https://docs.playitsoftware.com/PlayItLive/218/playout-policies/overview/ (snippet)
- SAM Broadcaster, RadioBOSS, StationPlaylist, Jazler, Myriad, WideOrbit, ENCO, Zetta: no primary material retrieved in this pass. Gap to fill (see Section 8).

---

## 3. Rule types and what professional systems typically support

Consolidated from the sources above (MusicMaster, GSelector, NextKast, CloudRadio, mAirList, PlayIt):

- **Artist separation**: minutes or hours (common starts: 60–90 min; 1:10 cited as industry start; per-artist overrides). Scope: artist, featured artist, or "core" artists.
- **Title separation**: separate from artist; used for same-named different tracks (e.g., "Jingle Bells" versions). mAirList: no simple "not in 24h" by default in that thread.
- **Track/recording repeat protection**: exact recording (edit vs. album version distinct).
- **Album separation**: block tracks from same album.
- **Category kick / hour-window kick (Auto Kick)**: same song not in same time window on consecutive days (MusicMaster).
- **Position kick**: a category not twice in same position/hour.
- **Day offset window rules**: e.g., "1 day plus 1 hour" window.
- **Segue / sound-code bans**: pairs and triples (e.g., Pop->Pop->Pop banned, Pop->Pop allowed); separate ban priorities.
- **Gender balance**: target ratios (e.g., 2:1 female:male in examples), usually enforced via property goals or folders. mAirList and NextKast treat it as a rule or attribute.
- **Tempo / energy / mood / "feel"**: filters or sound codes; avoid back-to-back slow songs (75–85 BPM example in mAirList forum; no built-in answer there).
- **Era / decade**: balanced by property goals (% of 80s, 90s etc.).
- **Duets / features**: primary artist designation (mAirList: feat. artists blocked as artist).
- **Vocal type / instrumental**: attribute.
- **Hour control / share goals**: quotas per hour (e.g., NextKast Hour Control; GSelector Category Share/Shift).
- **Airplay starvation goal**: boost songs that have not played as they near expected rotation window (GSelector 150–200%).
- **Demand/turnover-based placement**: GSelector "Projected Turnover" drives placement instead of song counts.
- **Priority / ranking of rules**: most systems do not publish a full precedence order. CloudRadio gives an explicit relaxation order; MusicMaster rule groups scope them; GSelector has separate ban priorities. Unresolved: a general, documented "rule priority and breaking" model. We should design an explicit one (see Section 7).
- **Exempt tags**: bypass separation for specific tracks (CloudRadio tag "Exempt from separation rules"; PlayIt track groups).
- **Missing-metadata handling**: blank artist/album should not block others (CloudRadio). Blank artist/title causes scheduling errors (NextKast).
- **Live-host exemption**: live shows bypass rules (CloudRadio Studio/Guest DJ; mAirList Show host can pull duplicates).

---

## 4. Research data: callout and auditorium testing (AMT)

- **AMT (auditorium music test)**: snapshot of song popularity at one time, with hooks and stop/keep scores; expensive; typically once or twice a year for all but the largest stations. Best suited to gold-heavy formats. https://www.radioworld.com/?p=7771 ; https://radioiloveit.com/radio-music-research-music-scheduling-software/radio-research-auditorium-music-testing-and-callout-research/ (search snippets)
- **Callout**: phone survey of listeners with song hooks; tracks a song's life cycle; run more often (can catch week-to-week shifts). Best suited to current/recurrent-heavy formats. Test rule of thumb: if most clock positions are Current and Recurrent use callout; if most are older Recurrent and Gold, use AMT. Source: radioiloveit callout series (search snippet). https://www.worldradiohistory.com/research_callout.htm
- **Callout song-list build order**: Power Currents first, then Power Recurrents, then Secondary Currents; Gold left to AMT because callout slots are limited. Source: powergold callout tips https://www.powergold.com/?p=1355 and https://www.powergold.com/?p=1053 (snippets).
- New songs should have been played a couple of weeks before callout to ensure familiarity. (Same source, snippet.)
- **Data flow into scheduling**: research scores set category placement (power vs. secondary vs. recurrent), and burn/tune-out rules are informed by scores. PowerGold imports research directly.
- **Burn and fatigue**: Sean Ross (PowerGold analysis of 78 CHRs, August monthly): average top power rotation 119 spins/week; ~100 spins/week proposed sweet spot ("still aggressive and hit-driven, but not draconian"); share falls as spins rise (3.0 share at 130+ spins, 5.5 share under 100 spins, n=5 stations). Caveats: morning show structure confounds spin counts. Source: https://www.powergold.com/?p=1801 (fetched). This gives concrete defaults for a "max top-spin per week" target.
- **Clustered artists**: two powers by the same artist within 30 minutes amplifies burn; artist-level separation addresses this. Source: same.
- Fatigue measurement is contested (consultant commentary). Source: https://radioinsight.com (snippet) and https://jacobsmedia.com (snippet on PDs/MDs vs listeners).

---

## 5. Open-source tools: how they do "smart" scheduling and their limitations

### 5.1 AzuraCast
- Playlist types: General Rotation (plays throughout day with weight, default weight 3 per azuracastpy wrapper), "every X songs", "every X minutes", scheduled playlists (time blocks, date ranges). Order: shuffle by default; sequential available. Avoid-duplicates flag (default on) applies to artists and titles. Source: https://azuracastpy.readthedocs.io/en/latest/azuracastpy_models/models/station/playlist_helper.html (wrapper docs, snippet) and https://www.azuracast.com/docs/user-guide/playlists/ (not fetched; docs-level behavior should be verified).
- Duplicate prevention: maintainer says AutoDJ "strongly tries" to avoid artist/title repeats within short span, but cannot always succeed with tiny playlists or single-artist playlists. Users asked for separate intervals for track, artist, title, album: feature requests, not confirmed built.
- Limitations and open issues (features.azuracast.com):
  - Smart playlists (criteria-based auto-population by release date or custom field, manual or scheduled): "under consideration"; not built as of the thread seen. https://features.azuracast.com/suggestions/84750/smart-playlists
  - "Once per X" playlists not schedulable by day/time; maintainer said may not be possible within Liquidsoap (linked GitHub issue #1289). https://features.azuracast.com/suggestions/39041/comment/147465
  - Multiple schedule entries per playlist: historically one scheduled time per playlist (except every-hour/every-day/every-x-minutes); multi-entry requested and marked done. https://features.azuracast.com/suggestions/38780/allow-multiple-schedule-entries-for-a-single-playlist
  - "Once per X songs" playlist plays one file at a time in some reports; merge option could make Liquidsoap ignore the playlist and break the schedule. Source: https://features.azuracast.com/suggestions/159484/add-an-option-to-play-the-entire-playlist-once-per-x-songs-or-once-per-x-minutes
  - Song requests override scheduled playlists; requests to disable requests during jingles/podcasts (open). https://features.azuracast.com/suggestions/61827/disable-song-requests-while-certain-other-playlists-are-playing ; https://features.azuracast.com/suggestions/38907/specify-a-time-when-songs-can-be-requested-from-a-given-playlist
  - Priority fix in v0.20.3 (Nov 2024): playlist and request priority; higher priority wins when two overlap. https://www.client.magicstreams.services/announcements/147/AzuraCast-0.20.3-Nov-17-2024.html (third-party announcement mirror).
- Gaps vs pro tools: no clock/position model, no per-category kicks, no sound-code segue bans, no gender/tempo/era rules, no property goals, no burn analysis, no research import, no hypothetical dry-run, no reconciliation with as-aired logs.

### 5.2 LibreTime (Airtime fork lineage)
- **Smart Blocks**: criteria-based block generated from library by rules (e.g., genre, BPM, length, etc.); blocks combined into playlists; time limits.
- Time limit behavior: by default, a block may come in under its time limit if no track fits the remainder; "allow overflow" option schedules one final track that overflows (may be cut off at show end). Labels vary by version. Source: https://git.congegni.net/Congegni/sintonia/commit/e7c7f215d5bea1e4a36134d50b6734efaddf441f?files=docs (fork docs, snippet); https://libretime.org/docs/user-manual/playlists/ (snippet).
- **No artist separation**: forum thread (July 2020; GitHub issue #1369 "Smartblocks: add 'Artist Last Played' criteria", Sept 2021). Problem: 4-track blocks play two same-artist tracks back to back. Workarounds proposed: time-window SQL filter on cc_playout_history joining cc_files; creator "last played before X hours" criterion; post-processing in Block.php substituting tracks. Still feature requests. Sources: https://discourse.libretime.org/t/how-to-avoid-2-tracks-of-the-same-artist/611 (fetched).
- Random selection with no artist-level filter; "last played" stored per track not per artist; queries ignore track order.
- Ads a fixed number of times per day: user reports no working method (https://discourse.libretime.org/t/advert-scheduling/396).
- No sub-genre grouping; bulk metadata editing absent (tutorial snippet). Metadata cleanup before upload.
- Smart blocks schedule about an hour before show air time (playlists containing smart blocks). Source: LibreTime docs snippet.

### 5.3 Other open-source/hobbyist references
- Centova Cast "Playlist Manager": sequential vs random (general reference only, different product). https://centova.com/doc/cast/user_manual/02_reference_manual/12_playlist
- Liquidsoap itself: the engine layer (see the Liquidsoap research file); scheduling "policy" is user-written logic. Our scheduler would generate the playlist, and Liquidsoap plays it.
- Rivendell, Airtime (original), Mixxx, Icecast: not researched in this pass (Rivendell is strong in log/clock models, to check).

### 5.4 Pattern summary: where open source is weak
1. No clock/position abstraction with categories per slot (AzuraCast/LibreTime use "pool of tracks" per block; no slot model).
2. No artist/title/album separation at the proper granularity with relaxation policy (CloudRadio does better; AzuraCast partial; LibreTime none in core).
3. No multi-dimensional attributes (mood, tempo, gender, era) as first-class scheduling constraints.
4. No burn analysis, property goals, rotation analysis, or research import.
5. No dry-run/hypothetical generation with diff against previous schedule.
6. No reconciliation with as-aired logs.
7. Time-window and daypart rules limited (AzuraCast: one-time schedule per playlist historically; priority added late).
8. Manual editing after generation: supported only generically (edit log); no lock/hold of songs, no re-optimise of remainder of hour.

---

## 6. Algorithmic / AI trends

- **INFORMS Journal of Applied Analytics / Interfaces 2025 (DOI 10.1287/inte.2025.0248)**, "Optimizing Music Station Playlists on Broadcast Radio": optimization engine for 24/7 playlists using song metadata (tempo, mood), ML research results and listenership data, balancing strength (hits) and diversity; reportedly deployed in production and a finalist for the 2024 Wagner Prize. The paper itself returned 403; claims from snippets. Also describes business rules such as avoiding back-to-back slow songs and time separation between same-artist plays. https://pubsonline.informs.org/doi/10.1287/inte.2025.0248
- Furini (2021): analyses a favourite station's week of programming to build a personal playlist. https://iris.unimo.it/handle/11380/1278437 (snippet)
- **Super Hi-Fi "Neuron"** (announced April 2026): AI scheduling engine claiming neuroscience and listening-data basis for music selection, rotation and sequencing for broadcast and digital; positions as "radio operating system" (what plays, when, transitions). Vendor claim; independent review (Aug 2026) is promotional. https://jackrighteous.com/es-gb/blogs/ai-creator-tools/super-hi-fi-review-2026-ai-radio-music-scheduling-production
- RadioKing blog: AI automates much playlist curation previously done by PDs/MDs. https://www.radioking.com/blog/ (snippet)
- Market: QYResearch music scheduling software 2026-2032 report (snippet; no pricing).
- Trend observations:
  - Attribute-driven selection (tempo, mood, energy embeddings) replacing hand-coded sound codes.
  - Optimization (constraint programming / MIP / local search) replacing greedy pick-by-pick scheduling.
  - Listener-data feedback (skip rates, completion, tune-in) replacing or augmenting callout.
  - LLM-based metadata enrichment (mood/era/gender tags) to reduce manual coding; unverified in our sources.
- Limitation to remember: AI generation without human "music director" judgment has been criticised by consultants; research and PD goals remain the control surface.

---

## 7. Feature checklist for our product

Priority legend: Must (MVP), Should (v1.x), Could (later).

### Must
- Library model with per-track attributes: artist, featured artists/primary artist, title, album, version/edit (distinct recordings), length, tempo (BPM), era/year, gender of lead vocal, vocal/instrumental, mood/energy (1–5 or enum), sound codes (multi-valued), category (one or more), start/end dates, add/drop dates, status (active/inactive/recurrent).
- Categories with: name, type (music/non-music), per-category rotation size (power rotation count), search depth (percentage and 1 = sequential), pass order, share target.
- Clocks: named clocks with ordered positions, each position = category (or sweeper/spot/jingle slot) plus optional fixed items; per-hour clock assignment; dayparts and clock-by-daypart.
- Separation rules (configurable per scope): track/recording repeat, artist (incl. featured), title, album, each in minutes with min 10 max 1440 default; per-artist overrides; exempt tag.
- Hour/day window rules: "same song not twice in same time window on consecutive days" (Auto Kick equivalent) with window sizes (hour, half hour, quarter hour) and "not twice in the same clock position within an hour".
- Relaxation ladder when constraints unsatisfiable (documented, deterministic): e.g., relax album, then artist separation, then least-recently-played fallback. Log each relaxation.
- Sound-code segue bans with n-gram semantics (pair breakable, triple unbreakable) and separate ban priorities.
- Schedule generation: deterministic seed; dry-run ("hypothetical") mode producing a log without publishing; diff against previous generation.
- Manual editing of generated log: replace song at slot, lock slot, regenerate remainder of hour; validation warnings for violated rules (highlight in red).
- Playout history / as-aired reconciliation: ingest "as played" log (from Liquidsoap logging), compare with scheduled log, report skipped, extra, and replaced items; use it to update last-played and burn counters.
- Burn/fatigue counters per song: plays per week, per day, per hour, last played, time since last play; configurable target (e.g., top power <= 100–120 spins/week as a starting default, cite PowerGold analysis).
- Multi-tenant isolation: each station has its own library, categories, clocks, rules, history.
- Role model: programmer/music director, DJ/host, viewer. Audit log of rule and clock changes.
- Import/export: CSV/XLSX for library and clocks; export log in common formats (e.g., Liquidsoap playlist M3U or JSON).
- New music add/drop workflow: add a song to a category with an add date and initial spin target (e.g., add to Secondary, then promote to Power after N weeks), and drop workflow (move to recurrent or inactive after N weeks).

### Should
- Property goals (percentage targets): gender ratio, era distribution, tempo mix, sound-code mix, per hour or per daypart; reported with progress vs. target (PowerGold Instant Analysis, NextKast Hour Control).
- Airplay starvation goal (boost songs as they near expected rotation window) (GSelector 150–200% window idea).
- Rotation analysis: average repeat time for a category/song group; top-power spin count distribution; projected turnover.
- Playout substitution: map multiple versions of a song (radio edit, album, live) to a master for counting.
- Rule groups by daypart/condition (overnight rest 1 h vs. daytime 3 h).
- Research import: callout and AMT scores into song rank/category recommendation; A/B for category placement changes.
- Duets/feat handling: a song counted under its primary artist for separation, with featured artists also protected.
- Kick override and "slotted" mode for fixed order (e.g., specialty countdowns).
- Hypothetical analysis view by slot.
- Rule-breaking report: show which rules were broken and why (with the relaxation step applied).
- Multi-station shared library, station-specific clocks and rules.
- Specialty shows: separate clocks, separate categories, separate library subsets, with optional "request-only" or "theme" lists (themed multiplay from Prophet MusicGen Pro).
- Live-override awareness: scheduled playlist vs. live host picks; warn when live picks break separation (mAirList and CloudRadio both note the gap).
- Scheduler API surface to Node backend: job per station per day, RabbitMQ job for generation, idempotent output IDs.

### Could
- AI/ML scoring for next-track suggestion (tempo/mood embeddings; listener skip/completion feedback); keep it as a suggestion layer with explicit rule enforcement underneath.
- Listener-data ingestion (Icecast/Liquidsoap logs, tune-in or skip data) to update song scores.
- Smart playlists (criteria-based auto-population) for non-music uses (e.g., "all 80s female-vocal Currents").
- Lunar rotation and off-peak placement rules.
- Heavy rotation visual analytics (clock heatmap, repeat-time histograms).
- Export to third-party automation (Zetta/ENCO/WideOrbit style) via standard log formats.

---

## 8. Liquidsoap implementation notes (scheduling side)

- Liquidsoap should be the playout engine only; generate the log in our Node service and feed Liquidsoap through a playlist/request or a generated M3U or JSON feed.
- Liquidsoap's `playlist()` with `mode="randomize"` or `normal` only enforces ordering; it cannot enforce artist separation. Enforce separation before the playlist reaches Liquidsoap, not inside it.
- Use Liquidsoap's `request.dynamic` or `request.queue` only for live requests and overrides, and keep them rule-aware (AzuraCast's priority bug shows the cost of mixing request and schedule without priorities).
- Liquidsoap `switch`/`fallback` for daypart switching is simple; our scheduler should output one log per hour with explicit slot IDs for reconciliation.
- Log played items (Liquidsoap `on_track`/`on_metadata` callbacks or `log` output) and push to the as-aired store for reconciliation.
- Handle "once per X songs" and "every X minutes" insertion (AzuraCast issue) by generating them into the log, not by runtime triggers; runtime triggers failed in AzuraCast.
- Keep rule-breaking decisions in our service, and pass Liquidsoap a flat schedule with start times and durations so timing and cross-fade are predictable.

---

## 9. Gaps and next research

- Pull the Music Master PDF manuals, GSelector Help (RCS Works), and PowerGold docs (403 in this session).
- Verify Myriad (Broadcast Radio), WideOrbit, ENCO DAD, SAM Broadcaster, RadioBOSS, StationPlaylist, Jazler, Zetta rule sets (only search level).
- Fetch the INFORMS paper through a different route (403 here).
- Check AzuraCast docs for current playlist types, weight, and order (docs fetch not done).
- Rivendell (clock/log model) for comparison.
- Confirm "1:10" artist separation claim against more than vendor material.
- Look for published burn-threshold research beyond the PowerGold analysis.

## Sources (inline above; consolidated)
- https://www.powergold.com/?p=1801
- https://www.powergold.com/?p=1053
- https://www.powergold.com/?p=1355
- https://www.powergold.com/?p=2373
- https://www.powergold.com/?p=93
- https://www.radioworld.com/tech-and-gear/products/powergold-rolls-out-nxt
- https://www.rcsworks.com/blog/gselector-priority-list-scheduling-tips/
- https://www.rcsworks.com/blog/rcs-live-gselector-kicks-category-group-settings/
- https://www.rcsworks.com/press/battle-of-the-music-scheduling-systems-software/
- https://tw.rcsworks.com/press/the-selector-cloud/
- https://g2.com/products/rcs-gselector/discuss
- https://musicmaster.com/?p=7147
- https://musicmaster.com/?p=165
- https://musicmaster.com/?p=11068
- https://musicmaster.com/?p=7959
- https://www.nextkast.com/onAir/knowledge-base/advanced-music-scheduling/
- https://www.cloudrad.io/help/separation-rules
- https://community.mairlist.com/t/gender-seperation/12914
- https://community.mairlist.com/t/scheduling-rules/18982
- https://community.mairlist.com/t/title-separation/15885
- https://docs.playitsoftware.com/PlayItLive/218/playout-policies/overview/
- https://www.radioworld.com/news-and-business/prophet-adds-musicgen-pro
- https://features.azuracast.com/suggestions/84750/smart-playlists
- https://features.azuracast.com/suggestions/39041/comment/147465
- https://features.azuracast.com/suggestions/38780/allow-multiple-schedule-entries-for-a-single-playlist
- https://features.azuracast.com/suggestions/159484/add-an-option-to-play-the-entire-playlist-once-per-x-songs-or-once-per-x-minutes
- https://features.azuracast.com/suggestions/61827/disable-song-requests-while-certain-other-playlists-are-playing
- https://features.azuracast.com/suggestions/38907/specify-a-time-when-songs-can-be-requested-from-a-given-playlist
- https://www.client.magicstreams.services/announcements/147/AzuraCast-0.20.3-Nov-17-2024.html
- https://azuracastpy.readthedocs.io/en/latest/azuracastpy_models/models/station/playlist_helper.html
- https://discourse.libretime.org/t/how-to-avoid-2-tracks-of-the-same-artist/611
- https://discourse.libretime.org/t/advert-scheduling/396
- https://libretime.org/docs/user-manual/playlists/
- https://pubsonline.informs.org/doi/10.1287/inte.2025.0248
- https://jackrighteous.com/es-gb/blogs/ai-creator-tools/super-hi-fi-review-2026-ai-radio-music-scheduling-production
- https://www.radioinsight.com/blogs/338527/what-power-rotation-says-about-top-40-in-2026 (as radioinsight.com/blogs/338527/...)
- https://frontsidegroup.com/what-does-recurrent-mean/
- https://www.worldradiohistory.com/research_callout.htm
- https://radioiloveit.com/radio-music-research-music-scheduling-software/radio-research-auditorium-music-testing-and-callout-research/
- https://centova.com/doc/cast/user_manual/02_reference_manual/12_playlist
