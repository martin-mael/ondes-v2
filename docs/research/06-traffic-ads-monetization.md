# 06 - Traffic, advertising & monetization (research report)

Scope: radio traffic systems, orders/spot booking, separation rules, makegoods, log reconciliation and proof of play, digital audio ad insertion (SSAI, VAST/DAAST, cue signaling), sponsorship/underwriting, listener monetization.

Confidence legend: **[V]** verified in a fetched or search-returned source in this session. **[K]** from general industry knowledge, not verified here, check before relying on it.

Research limits: several primary pages returned 404 or no useful content (Liquidsoap `cue_cut` page, IAB VAST element pages, Triton STWCue metadata guide). Searches on WideOrbit makegoods, spot rotation fairness, Rivendell affidavits and audio-only SCTE-35 returned nothing usable. Those gaps are listed at the end.

---

## 1. Professional best practices (how stations do it)

### 1.1 Vocabulary (industry terms) [K]
- **Traffic system / traffic department**: sells, schedules and bills spots. Output feeds the automation log.
- **Order / contract / campaign / flight**: an advertiser's buy. Has a start and end date, a rate, and one or more **order lines**.
- **Order line**: one spot length + product + target (daypart, station, count per week, impression goal).
- **Spot / commercial / avail / break / stop set / pod**: the unit of ad inventory. A **stop set** is the group of spots inside one scheduled break.
- **Log**: the day's ordered list of events (music, spots, liners, promos) with scheduled times. Pushed to automation.
- **Clock / hour template**: the fixed pattern of music, talk and break slots per hour.
- **Spot length**: :60, :30, :15, :10 (and :05 in some markets). ISCI/Ad-ID codes identify the creative.
- **Makegood**: a replacement spot given when an aired spot is missed, preempted or underdelivered.
- **Preemption**: a paid spot bumped by a higher-paying spot (typically "preemptable" buys are cheaper).
- **Bonus spot**: free extra spot added as goodwill.
- **Affidavit (proof of performance)**: signed report to the advertiser/agency listing the spots that aired (date, time, station, creative ID, program).
- **Proof of play (POP)**: automated evidence that a spot aired (audio capture, or log from automation).
- **Reconciliation**: matching "as scheduled" (traffic log) against "as run" (automation playout log) and resolving differences.
- **Separation rules**: minimum gap between spots of the same advertiser, same product category, or same competitor.
- **Rotation**: how spots of one order are spread across the day (even, weighted, run-of-day, daypart-specific).

### 1.2 Traffic workflow in a commercial station [K]
1. Sales books an order (advertiser, flight, spot count, length, target, rate).
2. Traffic creates the order and assigns creative (ISCI/Ad-ID) and product code.
3. Traffic runs **spot placement** (auto-schedule into clocks/stop sets according to rules).
4. Manual adjustments by traffic/programming (move, bump, pre-empt).
5. Logs are generated and **exported to automation** (Zetta, WideOrbit Automation, etc.) at a fixed cut-off, often the day before.
6. Automation plays. Playout logs go back to traffic ("as-run").
7. **Log reconciliation** runs: unplayed spots flagged, makegoods created, copy/creative issues surfaced.
8. **Affidavits** generated per order, usually weekly or per flight. Proof of play provided on request.
9. **Billing**: invoices generated from aired spots, not scheduled spots. Under-aired spots are credited or made good.

Key principle: billing is driven by **as-run**, not **as-scheduled**. Zetta's docs state that until spots are reconciled back into the traffic system, billing does not happen and revenue is lost. [V: rcsworks.com "vastly improved reconciliation options in Zetta 4.3", https://rcsworks.com/vastly-improved-reconciliation-options-in-zetta-4-3]

### 1.3 Separation and conflict rules [V for Marketron, K for the rest]
- Marketron (VT 4.40 help) warns the operator when a manual placement breaks:
  - a time or event target,
  - **product code separation**,
  - or minimum spacing between spots from the same order line. [V: https://www.marketron.com/Help/VT/VT440/WebHelp/html_files/VTUI06EditPlacementWarnings.htm]
- Separation is set **per order line**. There is a **station-wide advertiser separation default**, with a **per-advertiser override** for advertisers that need unique separation. [V: same Marketron source]
- Marketron's **Log Conflicts Report** lists spots that broke advertiser, product or pattern separation through manual placement. It only reflects the last time conflicts were regenerated, so conflicts must be regenerated before the report is run. [V: https://marketron.com/Help/VT/VT440/WebHelp/html_files/reportcenter/rc_log_logconflictsreport.htm]
- Marketron also has a **Spot Placement Discrepancy** report. [V: https://marketron.com/Help/VT/VT440/WebHelp/html_files/reportcenter/rc_log_spotplacementdiscrepancy.htm]
- WideOrbit WO Traffic (WO Network 2022): changed Placer logic for **Product Code separation** and **Max Spots/Break** to reduce manual spot movement. Added **Advanced Log Rules** (customer-defined separation rules, described as TV/network-oriented). [V: https://wideorbit.com/blog/wo-network-22/]
- WO Traffic v23.0: **Order Validation** module enforces broadcaster business rules at order entry. [V: https://business.minstercommunitypost.com/... press release, June 2023]
- Typical separation rule types [K]:
  - same advertiser min minutes (e.g. 15 min or 1 break)
  - same product category / competitor category (e.g. two banks, two car dealers)
  - same creative not in same break
  - max spots per break and per hour
  - max spots per hour per advertiser
  - daypart restrictions (e.g. no alcohol before 22:00)
  - "no-adjacent" rule (no two spots of same advertiser in one stop set)

### 1.4 Stop sets and placement [K]
- A stop set is a break inserted into the clock. Each has a length (seconds) and a max spot count.
- Placement algorithms fill breaks by **weight** (sold rate, priority, preemption class), then apply separation rules, then **fill-to-length** using sweeper/PSA/station promo filler.
- Typical ordering inside a break: **position** rules (opener, closer, first-in-break, second-in-break). Premium positions (first/last) are often sold at higher rates.
- Spot placement is usually **batch** (end-of-day or nightly) with a **manual pass** before log cut-off.
- Zetta 4.0 can send break length information from a master station to split stations so that spot block sizing follows the most sold-out break. [V: https://rcsworks.com/rcs-adds-more-muscle-to-voice-tracking, Zetta 4.0 note]

### 1.5 Makegoods [K, partly V]
- Makegoods are issued for: preempted spots, unaired spots (missed by automation), copy-error spots, and underdelivery against the contracted count or impressions.
- Common policy [K]: makegood at **same or better** daypart and length, within flight, often at a **ratio** (e.g. 1:1 for preempts, 1.25:1 or 1.5:1 for system failures), tracked in a makegood ledger.
- Agency-side view: makegoods for preempted broadcast spots are tracked separately, and underdelivery is often buried in aggregate billing totals. [V: https://invoicedataextraction.com/blog/advertising-agency-invoice-reconciliation, general]
- Spot TV industry article: makegood offers compare advertiser needs against available inventory, and can take weeks. [V, TV-focused: https://advertisingweek.com/how-advertisers-can-use-automation-to-streamline-spot-tv-transactions/]
- Rules for makegood credit, ratio and expiry are contract-specific. No radio-specific source confirmed here.

### 1.6 Spot rotation fairness [K]
- Goal: spread an order's spots evenly across the flight and dayparts so the advertiser gets reach and frequency as bought.
- Methods [K]:
  - **Even rotation**: one spot per X minutes, computed across the order's weekly count.
  - **Weighted**: more spots in drive time, fewer overnight.
  - **Run-of-station (ROS)**: any slot in the flight, placed by the algorithm.
  - **Frequency caps**: max exposures per listener (only relevant with ad-server targeting, see section 3).
- Known issues [K]: starvation of low-priority orders during heavy preemption, and clustering of one advertiser at the same time each day (solved by a "rotation index" or random-offset rule).
- No verified source on WideOrbit or Marketron rotation algorithms was found in this session.

### 1.7 Proof of play, as-run and affidavits [V partly]
- **As-run logs**: automation writes what actually played. Marketron's VT system compares an automation audit file against the original log and alerts the operator to spots that did not play, with the option to bump them. [V: https://marketron.com/Help/VT/VT440/WebHelp/html_files/Log_Reconcile.htm]
- Reconciliation statuses seen in a commercial traffic product: "No Air Log", "# Left to Reconcile", "Needs Posting". [V: https://docs.radioworkflow.com/docs/reconcile-your-logs]
- Reconciliation resolution options seen in a commercial product: **Bump**, **Scratch**, **Bill as Scheduled**. [V: same source]
- **Proof of play via audio capture**: Power Link's Proof of Play records the client station's audio onto a server, matches it against submitted as-run data, and reconciles aired media with orders. [V: https://www.radioworld.com/news-and-business/power-link-adds-power-play]
- Affidavit content [V via station proof-of-performance requirement]: call letters, advertiser, air dates and times, ISCI codes, rates, and the schedule that ran.
- Some stations (and agencies) require **audio proof-of-performance** per spot in addition to a log affidavit. [K]

### 1.8 Billing and invoicing [K]
- Invoice from as-run spots, after reconciliation, at contracted rate (rate card, package or CPM for audio).
- Credits for underdelivery, makegoods issued as credit or free spots.
- Agency commission (typically 15%) and sales commissions handled in the billing module.
- Revenue recognition by flight and by month.
- Common audit trail requirement [K]: every invoice line traces to an order line, a log event, and an as-run record.

### 1.9 Standards and identifiers [K]
- **ISCI** (Industry Standard Commercial Identifier): creative code for spots (legacy, still widely used in radio).
- **Ad-ID**: newer creative identifier used in TV and increasingly in radio.
- **SCTE-35 / SCTE-104**: ad-insertion cue standards (video, see section 3.4).
- **CAB / RAB** guidance on affidavits and log formats (not verified in this session).

---

## 2. Open-source tools (and their limits)

### 2.1 AzuraCast [V partly]
- Has scheduled playlists and Liquidsoap-based AutoDJ. Does not have a traffic system, order management, separation rules or billing.
- **Feature request (not confirmed as implemented)**: "Create scheduled events for a specified time range within an hour" (7 votes). Users want commercial breaks at fixed minutes within each hour. Current workarounds: custom Liquidsoap scripting, or creating dozens of scheduled events. Noted limitation: AutoDJ ignores custom scheduling outside its own playlist scheduling. [V: https://features.azuracast.com/suggestions/106904/create-scheduled-events-for-a-specified-time-range-within-an-hour]
- **Feature request**: "Interrupt AutoDJ and Live Streams with Advertising / Jingle playlist" (GitHub issue, open for 5+ years per aggregator listing). [V: opencollective.ecosyste.ms listing, status unverified, check github.com/AzuraCast/AzuraCast directly]
- **Feature request**: passthrough relay of external MP3/AAC streams without re-encoding, with optional local ad insertion. [V: features.azuracast.com]
- Playlist scheduling request: "day of month" and similar scheduling options. [V: ecosyste.ms listing]
- Net: no ad server integration, no cue-out signalling, no spot order model. Ads are typically done by putting ad files in a scheduled playlist.

### 2.2 LibreTime / Airtime [K]
- Airtime/LibreTime: show scheduling, playlists, smartblocks, a live-broadcast mode. No traffic or ad-insertion module. Ads are scheduled as playlists or shows. No verified sources in this session.

### 2.3 Rivendell (open source, GPL) [V partly]
- GPL-licensed radio automation. Includes **log generation and reconciliation** (electronic reconciliation, configurable for music and traffic logs since 0.9.82). Can import schedules from third-party traffic/music systems. [V: https://github.com/WMFO/rivendell, https://lwn.net/Articles/251231/ (2007 announcement), openSUSE package description]
- Affidavit generation: **not confirmed** in this session. This is the most relevant open-source baseline for our needs.
- Community forks exist (WMFO, edgeradio993fm, dklann). Forks indicate production use but also fragmentation.

### 2.4 Liquidsoap (audio engine) [V partly, gaps]
- Used for AzuraCast AutoDJ and many community stations.
- Has request queues ("Queuing of user requests; editable queues") and metadata rewriting/insertion. [V: https://www.liquidsoap.info/doc-2.2.5/]
- The **cue_cut** page (cue-in/cue-out handling) returned HTTP 404 in this session. Liquidsoap has built-in cue handling, but exact key names and examples were not verified here. **Action: read the Liquidsoap source or reference for cue_in / cue_out metadata before design.** See section 6.

### 2.5 Mixxx, Icecast/Shoutcast (context only) [K]
- Mixxx is a DJ tool, not traffic. Icecast/Shoutcast carry metadata including cue-like fields (Shoutcast V2 TXXX ad_type etc.), see section 3.2.

### 2.6 Known complaints across open-source radio tools [K, plus V where cited]
- No order/contract model, no affidavit output, no billing.
- Ad breaks handled as playlists, so no real stop-set placement engine, no separation rules, no makegood logic.
- Metadata-based ad triggers require custom scripting.
- Limited reporting for advertisers (listens, impressions).

---

## 3. Digital audio ads: SSAI, VAST/DAAST, cue signalling, targeting

### 3.1 Server-side ad insertion (SSAI) for radio streams [V]
- SSAI: ad decisions are made on the server, and the ad is stitched into the stream for each listener. Works around ad blockers and gives a single stream to the player.
- **Triton Digital TAP** (Triton Advertising Platform): server-side ad insertion for radio, live, on-demand and podcast. Integrated with Triton DAI. [V: https://tritondigital.com/solutions/audio-advertising/tap, https://help.tritondigital.com/docs/ad-triggers-cue-points]
- **AdsWizz** (SiriusXM-owned): claims first one-to-one targeted server-side ad insertion for online radio, in 2010. Pitch: SSAI for major streaming servers, client-side for standard players. Insertion suite supports pre-, mid- and post-roll in live simulcasts and on-demand. [V, vendor marketing: https://www.adswizz.com/publishers/insertion-suite/ and https://adswizz.com/wp-content/endurance-page-cache/about/who-we-are/_index.html]
- **StreamGuys**: SSAI for SGrewind (time-shifting) via AdsWizz, reusing ad-trigger metadata from the original live stream. On-demand (podcast) ad insertion at request time with location, demographic and behavioral targeting. SGmetadata enhanced metadata triggers. [V: streamguys.com/services/monetization/adinsertion and press pages 2017-2019]
- **TargetSpot**: named as the ad-serving partner in StreamGuys' VAST-compliant player. [V]
- **Radio.co / RadioKing / Live365**: primarily ad-free hosting or injected ads; no verified first-party SSAI detail in this session. Radio.co pricing (third-party comparison): $35, $59, $139, $199 per month. [V, third-party]

### 3.2 Cue signalling in audio streams [V for Triton, K for generic]
- **Triton STWCue / AndoXML / Shoutcast V2 cue points** [V: https://help.tritondigital.com/docs/ad-triggers-cue-points]:
  - Cue type: `ad` (STWCue), `Ad` (AndoXML), `TXXX cue_type="ad"` (Shoutcast V2).
  - Unique ad ID: `ad_id` / `BREAKADID` / `TXXX ad_id`.
  - Ad sub-type (required): `ad_type` = `break`, `endbreak`, `targetspot`. (AndoXML: `BREAK`, `ENDBREAK`, `TARGETSPOT`.)
  - Title (optional, shown to listener): `cue_title` / `Title` / `TIT2`.
  - Duration (optional): `cue_time_duration` in **milliseconds** (AndoXML `Time` in seconds, Shoutcast `TLEN`).
  - Companion banner: `ad_url` / `IMGURL` (legacy), `ad_vast_url` (remote VAST 2.0), `ad_vast` (inline VAST 2.0). Precedence: `ad_vast`, then `ad_vast_url`, then `ad_url`.
- **Live-stream flow**: cue points must be triggered from the radio automation system. Triggers are caught and mapped to a Triton cue point via **RAS Adapter** in Station Manager, or via custom STWCue integration. Mapped points can be targeted as content tags. For livestreams this is described as working for mid-roll and pre-roll ads. [V: https://help.tritondigital.com/docs/using-content-targeting-cue-points-to-target-a-livestream-show]
- **Automation-to-cue mapping is the key integration point** for our product: automation must emit a break-start/break-end event with an ad ID and duration.
- **SCTE-35 (video standard)** [V]:
  - `splice_insert` marks break start/return. `time_signal` + `segmentation_descriptor` carries richer labels. Commands also include `splice_null`, `splice_schedule`, `bandwidth_reservation`. Descriptors include `segmentation`, `avail`, `DTMF`, `time`, `audio`. [V: docs.rs/scte35-splice, bitmovin]
  - Converted to HLS `#EXT-OATCLS-SCTE35` / CUE-OUT / CUE-IN tags by live packagers. Google Ad Manager example uses segmentation type 34 (break start) and 35 (break end), with `EXT-X-DATERANGE` `PLANNED-DURATION`. [V: https://support.google.com/admanager/answer/13049027, https://docs.cloud.google.com/livestream/docs/scte-ad-break-markers]
  - AWS MediaTailor supports either `time_signal` with `segmentation_descriptor`, or `splice_insert` with basic break metadata. [V: https://docs.aws.amazon.com/en_us/mediatailor/latest/ug/ca-scte-35-messages.html]
  - **Gap**: no verified source for SCTE-35 in audio-only/ADTS/AAC/MP3 Icecast streams. Most real radio ad cue signalling is **metadata-based (ICY/Shoutcast/Icecast metadata)** rather than in-band SCTE-35. [K]
- **In-band cue tones** (the physical 1 kHz/ DTMF-style tones used in analog and some legacy digital systems): [K] still used by some networks and by automation vendors for local insertion; not verified here.

### 3.3 VAST / DAAST [partly V]
- **VAST** (Video Ad Serving Template, IAB Tech Lab, launched 2008): XML schema for passing ad metadata from ad server to player. Elements include `Ad`, `InLine`, `Wrapper`, `MediaFile`, `Tracking`, `Impression`, `Verification`. [K for element names, the IAB page did not list them, check https://iabtechlab.com/standards/vast/]
- **DAAST** (Digital Audio Ad Serving Template, IAB Tech Lab): audio-specific companion to VAST, used for audio ads in players and streams. [K, not verified in session. The AdsWizz/StreamGuys sources did not confirm DAAST support.]
- Practical use for our product [K]: VAST/DAAST-compatible ad tag handling in the player or the stream's ad server, so we can plug into existing SSPs and ad servers (AdsWizz, Triton, Google Ad Manager, Adswizz Dynamic Creative Optimization).

### 3.4 Geo-targeted and per-listener ads [V partly]
- AdsWizz podcast product: user-level targeting by geo, day-part, device, contextual, behavioral profiles, weather. [V, third-party listing]
- StreamGuys: targeting by device, geo-location, user profile, any attribute. [V]
- Per-listener SSAI requires: a per-session ad decision, a tracking ID, and a cue-compatible stream manifest or player SDK.
- Frequency caps and privacy compliance (GDPR/ePrivacy consent, IAB TCF) [K] required for EU deployments.

### 3.5 Measurement and reporting [K]
- Impressions, completion rate, starts, skip rate (audio), listen-through, geo and device breakdown.
- Verification: IAS, DoubleVerify, MOAT style verification (video-heavy, audio-light) [K].
- Proof of play for SSAI: server-side logs of ad ID served + playback confirmation via tracking pixels/beacons (VAST `Tracking` events: start, firstQuartile, midpoint, thirdQuartile, complete) [K].

---

## 4. Sponsorship, underwriting, listener monetization

### 4.1 Underwriting (non-commercial stations, US) [V partly]
- FCC underwriting rules (47 CFR § 73.503 and Communications Act § 399B) apply to noncommercial educational (NCE) stations. Current rule text not fetched; sources in this session range 2001-2011. [V: https://www.broadcastlawblog.com/2011/02/articles/fcc-underwriting-rules-for-noncommercial-radio-and-tv-a-seminar-on-the-issues/]
- Permitted: sponsor identification, business type, location (including a web address), in non-promotional wording.
- Prohibited: calls to action, price or savings information, qualitative claims ("best", "leading"), inducements to buy, sell, rent or lease.
- Good-faith latitude: "reasonable, good faith judgment" in close cases. [V]
- Enforcement examples: a consent decree with a $115,000 penalty and a one-year moratorium on commercial underwriting (per commentary). Fines also apply to spots in outside-produced programming even when the station received no compensation. [V]
- Interruptions: underwriting must not interrupt regular programming. [V, secondary]
- Station-level limits (e.g. WMBR): length caps, contract-term caps. [V: https://wmbr.mit.edu/www/underwriting]
- Radio underwriting credit length often cited as up to 20 seconds [V, secondary, verify].
- **Implication for our product**: a rule engine needs a "content check" for underwriting copy (promotional language flags), plus a per-station policy file. Compliance reporting per announcement.

### 4.2 Sponsorship and program underwriting (commercial / community) [K]
- Program sponsorship: "The morning show is brought to you by X". Pricing per week/month, often flat-rate.
- Sponsored segments/sections (weather, traffic, news) and sponsored playlists/shows.
- Sponsor logos on the website/app. Sponsor pages.
- Contract: sponsor name, term, deliverables (number of mentions per show), approvals.

### 4.3 Listener donations, memberships and ad-free tiers [V partly]
- **RadioKing**: central monetization dashboard, customer data and analytics; suggests premium memberships with ad-free listening, bonus shows, VIP access. In-app paid features via Google/Apple billing. Donations via third parties (PayPal, Tipeee, Buy Me a Coffee), no native donations feature found. [V: radioking.com/blog/monetize-your-radio-mobile-application]
- **Live365**: paid model since 2001, commercial-free "VIP" tier since 2003 (snippet only). Ad monetization listed in some overviews. [V, partial: en.wikipedia.org/wiki/Live365]
- **Radio.co**: sponsorship advice (land sponsors early, time launch around Q4 ad spikes), 25% setup discount promo. No verified donation or ad-free tier details. [V: https://www.radio.co/blog/launch-radio-station-save-money]
- Common patterns [K]: donation button (one-time and recurring), membership tiers (ad-free, early access, exclusive shows), gift subscriptions, "pledge drives" for community/NCE stations (on-air fundraising, which is separate from underwriting rules).

---

## 5. Paid professional tools: what they do that open source does not

| Capability | Commercial (examples) | Open source baseline |
|---|---|---|
| Order/contract/flight model with rate cards | WideOrbit WO Traffic, Marketron VT, Zetta/traffic partners, Radio Workflow | none |
| Spot placement engine (clocks, stop sets, weights, preempt classes) | WO Traffic Placer, Marketron | none (playlist-level only) |
| Separation / conflict rules with reports | Marketron Log Conflicts, WO Advanced Log Rules | none |
| Order validation at entry | WO Traffic v23 Order Validation | none |
| Log export to automation | all major traffic systems | Rivendell (log tooling) |
| As-run reconciliation | Zetta/GSelector link, Marketron audit compare, Radio Workflow | Rivendell reconciliation (partial) |
| Proof of play with audio capture | Power Link POP | none verified |
| Affidavits and billing | traffic/billing modules | none verified |
| SSAI and cue handling | Triton TAP, AdsWizz, StreamGuys | none (custom Liquidsoap) |

Notes on named products:
- **WideOrbit**: traffic, automation and sales/billing suite; WO Network release notes (2022) and WO Traffic v23 (2023) document the features above. [V]
- **Marketron (VT)**: traffic and billing for radio and TV. Help docs at VT 4.40. [V]
- **Zetta / GSelector (RCS)**: automation (Zetta) and music scheduling (GSelector). Zetta links to GSelector so that an event's status is set to 'playing' when fired; reconciliation improved in Zetta 4.3. Flex Clocks schedule down to the minute. [V: rcsworks.com]
- **Radio Workflow**: commercial reconciliation product (Bump, Scratch, Bill as Scheduled). [V]
- **Power Link**: Proof of Play with audio capture. [V]
- **Triton TAP, AdsWizz, StreamGuys**: ad insertion and monetization. [V]
- Not researched in depth (no sources fetched): mAirList, ENCO DAD, Myriad, PlayoutONE, StationPlaylist, RadioBOSS, SAM Broadcaster, Jazler, OnAir/Aeron, DAVID Systems. [gap]

---

## 6. Liquidsoap implementation notes (for ads, cues and stop sets)

- Liquidsoap is the audio engine. Ad breaks can be implemented with:
  - a **request source** (`request.dynamic` / `request.queue`) fed from our Node.js service or RabbitMQ, returning the ad file URI for the next spot;
  - **`switch` / `fallback` with `track_sensitive`** to switch between the music source and the ad source at break boundaries;
  - **metadata-driven cue handling**: Liquidsoap can read and write metadata per track (`insert_metadata`, `on_metadata`, `add_skip_cmd` in 2.x [K, verify names in the reference]), and cue handling is documented in the `cue_cut` family [K, page 404 in session, verify].
- Recommended approach [K]:
  1. Keep a **stop set** as a Liquidsoap `source` built from a dynamic request source that asks our backend for "next break content" at each break start.
  2. Emit **break-start/break-end metadata** (ad_id, duration_ms, ad_type break/endbreak) in the stream, in ICY metadata form, matching Triton's field names so downstream SSAI partners can parse it.
  3. Keep the **ad decision and scheduling** in our Node.js service, not in Liquidsoap. Liquidsoap only plays the file it is handed.
  4. Use **smooth transitions** (`smooth_add` / crossfade) for break boundaries, and enforce exact break length by padding with station-ID/sweepers.
  5. Pre-fetch ad files before the break (e.g. 30 s before) to avoid stalls. Cache them locally.
  6. Log every as-run event (start time, file ID, ad ID) back to RabbitMQ for reconciliation.
- Gaps to verify before committing: exact cue_in/cue_out metadata keys in Liquidsoap 2.x, the request-source API for dynamic ad fetch, and whether it can emit SCTE-35 (almost certainly not natively for audio-only streams).

---

## 7. Feature checklist for our product

### Must (MVP)
- Order / campaign / flight model: advertiser, order lines, spot length, rate, flight dates, target count per day/week.
- Creative library with ISCI-style IDs, length, and status (approved / pending / retired).
- Spot placement into stop sets: weight by priority, respect break length, fill with filler.
- Separation rules: per advertiser (station default + per-advertiser override), per product category, max per break, max per hour, no-adjacent.
- Preemption classes (cheaper preemptable buys vs. fixed-position buys).
- Export a log that automation (Liquidsoap) consumes, with a cut-off time.
- Break-start / break-end events (ad ID, duration_ms) emitted to the stream as metadata, matched to Triton-style fields for SSAI interop.
- As-run capture from Liquidsoap (what played, when) returned over RabbitMQ.
- Reconciliation: scheduled vs. as-run, flag unplayed spots, offer bump/scratch/bill-as-scheduled actions.
- Makegood ledger: create makegood from a missed spot, track ratio and expiry.
- Affidavit export (PDF/CSV) per order and per flight: date, time, station, creative ID, rate.
- Basic proof of play: as-run log with timestamps and ad ID (no audio capture yet).
- Underwriting copy checks for NCE stations (flag promotional terms, price, calls to action) and a station policy file.

### Should
- Rotation fairness: even rotation, weighted by daypart, random offset to avoid clustering.
- Order validation at entry (rules engine: rates, lengths, dayparts, competitor category).
- Log conflicts report (regenerate on demand, show separation breaches).
- Billing: invoices from as-run spots, agency commission (e.g. 15%), credits for underdelivery.
- Program sponsorship objects (sponsor, term, mentions per show, approvals) and sponsor pages.
- Listener donations (one-time and recurring), membership tiers with ad-free listening.
- VAST / DAAST-compatible ad tag handling for external ad servers and SSPs.
- Pre-fetch and cache of ad files before break.
- Advertiser reporting: impressions, completions, geo/device breakdown (for SSAI or stream-level ads).
- Audit trail: every invoice line traces to order line, log event and as-run record.

### Could
- Audio capture proof of play (store segments per spot, match with as-run via audio fingerprint or ID).
- Per-listener SSAI with geo/daypart/device targeting and frequency caps (needs player SDK or stitched HLS).
- Real-time bid/programmatic supply via an ad exchange.
- SCTE-35 output for HLS/DASH video streams (only if we add video).
- Make-good offer tool (inventory vs. advertiser need).
- Consent management (IAB TCF) and privacy modes for EU listeners.
- Podcast ad insertion at request time (on-demand SSAI).
- Sponsor-linked promo content generation (voice tracking of sponsor messages).

---

## 8. Open questions and gaps (for follow-up)

1. Liquidsoap cue handling: exact metadata keys and request-source API for dynamic ad fetch (cue_cut page returned 404). Check liquidsoap.info reference and source tree.
2. WideOrbit, Marketron and Zetta makegood policy, rotation algorithms and stop-set fill rules: no source fetched. Check vendor help sites and trade press (Radio World, Radio Ink).
3. Rivendell affidavit / billing features: not confirmed. Check Rivendell documentation and mailing list.
4. SCTE-35 or cue signalling for audio-only (ADTS/AAC, Icecast) streams: no source found. Check Icecast/Shoutcast metadata specs and Triton STWCue Detailed Metadata Guide (client success manager access).
5. IAB VAST and DAAST element definitions and versions: IAB page did not list elements. Use https://iabtechlab.com/standards/vast/ and DAAST spec.
6. Triton automation-to-cue mapping limits: STWCue guide not public.
7. StreamGuys and AdsWizz current product docs (2017-2019 press releases are dated).
8. Listener donation / membership features of RadioKing, Live365, Radio.co: first-party pricing and monetization pages not fetched.
9. Commercial tools not covered: mAirList, ENCO DAD, Myriad, PlayoutONE, StationPlaylist, RadioBOSS, SAM Broadcaster, Jazler, OnAir/Aeron, DAVID Systems.
10. FCC underwriting current text: 47 CFR § 73.503 and the 2011+ decisions. Check eCFR directly. Note that this is US-only and the product may target EU markets too.
11. AzuraCast GitHub issue states (opened 5+ years ago, open or closed?). Check github.com/AzuraCast/AzuraCast directly.

---

## Source URLs (consolidated)

- Marketron placement warnings: https://www.marketron.com/Help/VT/VT440/WebHelp/html_files/VTUI06EditPlacementWarnings.htm
- Marketron log conflicts report: https://www.marketron.com/Help/VT/VT440/WebHelp/html_files/reportcenter/rc_log_logconflictsreport.htm
- Marketron spot placement discrepancy: https://marketron.com/Help/VT/VT440/WebHelp/html_files/reportcenter/rc_log_spotplacementdiscrepancy.htm
- Marketron log reconcile: https://marketron.com/Help/VT/VT440/WebHelp/html_files/Log_Reconcile.htm
- WideOrbit WO Network 22: https://wideorbit.com/blog/wo-network-22/
- WideOrbit WO Traffic v23 press release: https://business.minstercommunitypost.com/minstercommunitypost/article/gnwcq-2023-6-27-wideorbit-introduces-widespread-benefits-in-wo-traffic-v230
- WideOrbit WO Traffic product overview: https://theiabm.org/wp-content/uploads/2021/05/WO_Traffic_Product_Overview.pdf
- RCS Zetta 4.3 reconciliation: https://rcsworks.com/vastly-improved-reconciliation-options-in-zetta-4-3
- Radio Workflow reconcile: https://docs.radioworkflow.com/docs/reconcile-your-logs
- Power Link Proof of Play: https://www.radioworld.com/news-and-business/power-link-adds-power-play
- Rivendell (WMFO fork): https://github.com/WMFO/rivendell
- Rivendell 2007 announcement: https://lwn.net/Articles/251231/
- Liquidsoap docs 2.2.5: https://www.liquidsoap.info/doc-2.2.5/
- AzuraCast feature board (scheduled events): https://features.azuracast.com/suggestions/106904/create-scheduled-events-for-a-specified-time-range-within-an-hour
- AzuraCast feature feed: https://features.azuracast.com/feed
- Triton ad triggers and cue points: https://help.tritondigital.com/docs/ad-triggers-cue-points
- Triton livestream cue targeting: https://help.tritondigital.com/docs/using-content-targeting-cue-points-to-target-a-livestream-show
- Triton TAP: https://tritondigital.com/solutions/audio-advertising/tap
- AdsWizz insertion suite: https://adswizz.com/publishers/insertion-suite/
- AdsWizz DCO announcement: https://www.adswizz.com/adswizz-adds-dynamic-creative-optimization-capabilities-to-its-audio-advertising-platforms/
- StreamGuys ad insertion: https://streamguys.com/services/monetization/adinsertion
- StreamGuys SGrewind ads (press): https://www.streamguys.com/?p=2831
- StreamGuys on-demand DAI (press): https://www.streamguys.com/?p=2814
- SCTE-35 AWS MediaTailor: https://docs.aws.amazon.com/en_us/mediatailor/latest/ug/ca-scte-35-messages.html
- SCTE-35 live ad break markers (Google): https://docs.cloud.google.com/livestream/docs/scte-ad-break-markers
- Google Ad Manager SCTE-35 HLS: https://support.google.com/admanager/answer/13049027
- SCTE-35 parser (docs.rs): https://docs.rs/scte35-splice
- RadioKing monetization blog: https://www.radioking.com/blog/monetize-your-radio-mobile-application
- Radio.co launch blog: https://www.radio.co/blog/launch-radio-station-save-money
- Live365 (Wikipedia): https://en.wikipedia.org/wiki/Live365
- FCC underwriting overview (broadcast law blog): https://www.broadcastlawblog.com/2011/02/articles/fcc-underwriting-rules-for-noncommercial-radio-and-tv-a-seminar-on-the-issues/
- WMBR underwriting policy: https://wmbr.mit.edu/www/underwriting
- IAB VAST: https://www.iab.com/guidelines/vast/ (full spec at https://iabtechlab.com/standards/vast/)
