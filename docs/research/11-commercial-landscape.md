# 11 - Commercial radio landscape: what paid tools offer that open source lacks

Research date: 2026-10-19. Scope: paid on-prem/pro automation suites and hosted webradio SaaS.
Confidence legend: [V] vendor page, [R] reseller/aggregator/competitor (treat with caution), [I] independent/press.
Coverage note: strongest data on mAirList, RadioKing, Radio.co, Radio Cult, Live365, SAM/Spacial, RadioBOSS, StationPlaylist, Myriad, WO Automation, ENCO DAD. Thin or missing: RCS Zetta/GSelector/Aquira pricing, Jazler RadioStar current pricing, NextKast, ProppFrexx, WinMedia, Dinesat, DAVID DigaSystem, Aeron, StreamGuys, AudioNow, Triton/Spacial enterprise, Everest/Centova current pricing. Mark these as gaps; do not assume.

---

## A) On-prem / pro automation suites

### mAirList (France/Germany/Europe, very popular)
- [V] Editions (prices excl. VAT, home-user tier) https://mairlist.com/en/home-users
  - Home Studio EUR 100: playout, cartwall, database/scheduling, streaming encoder, MIDI/USB remote, layouts/skins, voice tracking, mixdown, scripting, external DSP plugins.
  - Advanced (Home) EUR 150: + remote control for D&R and Sonifex, TCP/IP remote, Aircheck Recorder, ad scheduling, TCP/UDP logging, log import, ArtNet DMX.
  - Advanced Plus (Home) EUR 200: + DHD, Lawo, AEQ, Axia, Wheatstone and other digital consoles, Ember+ Consumer, Wheatnet-IP, Telos VX, Axel Oxygen.
  - Advanced Server (Home) EUR 200: Advanced + mAirListDB Server (shared DB over WAN), Stream Monitor (Shoutcast/Icecast rebroadcast monitoring), REST API. Excludes Advanced Plus console integrations.
- [V] Licensing: home editions are personal non-commercial only (no businesses/schools). One PC per license or dongle-bound. Sales final, no refunds. 30-day trial. Major-version upgrades paid (~50% of previous price). Community forum is the only home support. DJ/web-radio licenses require contacting sales.
- [V] Pro/commercial editions are sold through partners; prices not public in what I could fetch.
- [V] Other features listed on mairlist.com: touch-friendly multi-tab cartwall, live-assist and automation modes, voice tracking, built-in music scheduling, Shoutcast/Icecast streaming, REST API, mAirList Audio Logger (separate product, long-term recording plus web server), MusicMaster connector (requires MusicMaster Nexus server).
- [R] Directory listing shows EUR 476 starting price (unverified, does not match tiers).
- Gap: scripting language/API depth, commercial-tier prices, and forum complaints were not retrievable in this pass.

### RCS Zetta / GSelector / Aquira (RCS Sound Software)
- [V] Zetta with GSelector: music log built from scheduling rules; edits in either tool propagate. https://www.rcsworks.com/blog/nab-rcs-products-2022/ (vendor marketing)
- [V] Aquira: sales/traffic system; pushes traffic logs to Zetta or scheduler; traffic staff can change live commercial log that talent sees on air; ingests overnight as-run log for reconciliation.
- [V] GSelector 5.0: "Flex Clocks" for programmers to build clocks/grids down to the minute.
- [V] Zetta 5.24.1: announced as 470+ enhancements (date unconfirmed).
- [V] RCS Cloud: disaster-recovery cloud on AWS; backs up audio, logs and metadata via Zetta site replication.
- [V] Remote companions: Zetta2GO, Selector2GO, Aquira2GO: browser-URL access over VPN, no installed app. https://www.rcsworks.com/zetta-a-walkthrough-for-new-users/
- [V] Zetta Advanced Playout Automation page: https://www.rcsworks.com/advanced-playout-automation-zetta
- Gap: no public prices; no independent reviews found.

### WideOrbit - WO Automation for Radio (AFR)
- [V] Native clients on macOS, Windows, Linux, iOS (v5.0, March 2021). AFR Mobile iOS app: control system from anywhere; talent can run remote broadcasts without board op. https://www.wideorbit.com/press/wo-automation-for-radio-version-5/
- [V] Stop Media Asset workflow action; Content Import Prioritization (downloads urgent content first).
- [V] Integrations: WO Traffic, MusicMaster, Weatherology, vCreative, EAS encoders; custom widgets.
- [V] v3.0: multimarket file transfer, granular user rights, Canadian content calculator.
- [V] Apr 2023 Telos Alliance partnership: server components and Axia Altus virtual console run in AWS. Group Voice Tracking: one talent recording pushed to a Group of stations, or per-station variants. https://www.wideorbit.com/press/partnership-with-telos-alliance-enables-cloud-environment-wo-afr/
- [V] "Lesser-known features" webinar exists (not fetched).
- Gap: pricing not public; no independent reviews.

### ENCO DAD (formerly DADpro / DADpro32, 1997)
- [V] Multiple players/recorders, array panels, user hot keys; runs on COTS PC; software-only or turnkey. https://enco.com/products/dad
- [V] "4th Generation Live Assist Interface"; single workstation can run up to 20 simultaneous playlists (per reseller listing).
- [V] Custom commands for controlling hardware; SQL database support; ingest from news, traffic, weather, scheduling; reconciliation to billing/corporate systems.
- [V] Auto segue marker insertion (DAD AutoSegue DCL).
- [R] Licensing split: Production suite (Production, Voicetracking, Scheduling, Content Ingest, Conversion, Transfer Tools) vs on-air license adding Automation and on-air module. https://bswusa.com/enco-dad-lp-prod-package
- [V] AITrack module: AI/synthetic voice-track pre-scheduling. MOM: unified ingest, media asset management, graphics, playout platform.
- Gap: list prices not retrieved.

### Myriad (Broadcast Radio, UK)
- [V/I] Myriad Playout: manual, live-assisted or fully automated playout; dynamic automation reacting to live news and hardware events; one-click switch between automation and live assist; search songs by length; now/next dashboard; automatic sweeper timing. https://psquared.net/software/myriad-4-playout/features
- [I] Myriad 5: built-in split playout (ads/branding per region) and networking for multi-site. Remote voice tracking.
- [I] Myriad 6: web-based administration, scalable networking, remote voice tracking. https://radiotoday.co.uk/?p=312431
- [I] Myriad Playout 7: announced for IBC 2026 with listener requests and song voting; beta Sept, launch Dec 2026 (per announcement).
- [V] Myriad 5 Cloud offering exists (cloudrad.io/myriad-5).
- Gap: pricing not public.

### StationPlaylist Studio / Creator (Bluetomato / Nobex-era US/Europe market)
- [V] Studio Pro USD 299: logging, fail-safe redundancy, voice-track/song overlap. Studio Standard USD 159: no overlap, no external device integration. Separate StationPlaylist Streamer USD 98 (USD 49 for Studio owners). https://bluetomatomedia.com/buy/stationplaylist/studio and office.stationplaylist.com/studio.html
- [V] Crossfader with auto blend; manages multiple players internally; plays M3U playlists standalone (jukebox mode); video and still images.
- [R] Capterra: Creator 4.7/5 from 3 reviews. Conflicting Slashdot EUR 476 figure.

### RadioBOSS (DJSoft)
- [V] Editions: Standard USD 199, Advanced USD 249, Ultimate USD 299 (one-time). Advanced adds video and user access control; Ultimate adds time-stretch and remote voice tracking. Scheduler can trigger events at set time or on DTMF. https://www.djsoft.net/enu/radioboss_editions.htm
- [R] Aggregators list conflicting prices (EUR 75, USD 12/mo). Discount on vendor figure.

### Jazler RadioStar 2 / Jazler SOHO
- [R] Broad automation (scheduling, playlist management, audio processing, remote control); rule-based artist separation and genre limits for drive-time. Mirror site claims RadioStar 2 is EOL; unverified. Current line appears to be SOHO. No reliable price found.

### SAM Broadcaster Pro / SAM Cloud (Spacial)
- [R] SAM Broadcaster Pro USD 299 one-time (Slashdot), free trial. Built-in audio processing (EQ, gated AGC, stereo expander, 5-band and 2-band processors). Streams to Icecast/Shoutcast. Windows only (Spacial FAQ: not compatible with Mac). Interface described as overwhelming.
- [V] SAM Broadcaster Cloud: Silver USD 30/mo (1 station, 5 extra DJs, 120 listeners); Gold USD 90/mo (3 stations, 15 DJs, 360 listeners); 14-day trial; Bronze/Silver/Gold/Enterprise tiers; can run alongside desktop SAM. https://spacial.com/pricing/ and https://spacialaudio.com/about-us/
- [I] Trustpilot 2023: support complaints, refund not honored. SourceForge 2026 review: station offline despite payments.

### Radio Assist (NETIA, France/Europe; also Algeria, Mongolia, Sky News Radio)
- [V/I] Radio-Assist family covers acquisition, audio editing (Snippet/Snippet+), production, newsroom, scheduling, multicasting, admin.
- [V] v8.2 (2014): integrated music scheduling app, video editing in same UI; FederAll playlist module generates playlists from rules and sequencing constraints. Lightweight laptop mode for small operations. Logitek AoIP integration.
- [I] Sources mostly 2013-2015; current version/pricing unverified. Gap: needs NETIA site.

### Other gap list (not researched in depth)
- WinMedia, Dinesat, NextKast, ProppFrexx ONAIR (alternative listings only), DAVID DigaSystem, Aeron, OnAir Studio, Cloudcast, Sonicast. Treat as gaps.

---

## B) Hosted webradio SaaS

### RadioKing (France, NRJ group partner)
- [V] Help page (FR): Radio Start EUR 29/mo, Radio Pro EUR 54/mo, Radio Business EUR 99/mo; 2 months free on annual. Start: 20,000 listening hours/mo, 5 GB storage, live broadcast, player and widgets. Pro: 150,000 h, 10 GB, audio dedications, weekly audience report. Business: 500,000 h, 20 GB, unlimited concurrent listeners, MP3/AAC up to 320 kbps. https://help.radioking.com/hc/fr/articles/23366446903825-Comment-bien-choisir-mon-offre-radio-et-%C3%A0-quel-prix
- [V] Price page date stamp 2024-04-02, so may be stale. Not verified against live tarifs page (404 on fetch).
- [V] Partnership: diffuses 600+ NRJ group stations under "RadioKing Pro Solutions" (themedialeader). Claims 2,500+ stations in 120 countries (self-reported).
- [V] StudioKing desktop software: RadioKing stopped maintaining it from 2023-06-01, now beta. Recommends third-party broadcast software. Help center lists common issues: stream not starting, scheduling problems, dropouts, live-connection failures.
- Gap: no independent reviews or forum threads found in this pass.

### Radio.co
- [V] radio.co/pricing not fetched successfully. [R] Competitor-cited figures (early 2026): Lite USD 35 (500 listeners, 2GB, 18k h), Standard USD 59 (20k listeners, 20GB, 360k h), Plus USD 139 (500k listeners, 75GB, 875k h), Premium USD 199 (unlimited, 300GB, 1.3M h). 14-day trial. Music licensing not included.
- [R] Icecast-style HTTP streaming, no adaptive bitrate. Mobile-first broadcasting, branded listener app. Source: cloudrad.io, nobex and iradeo comparisons (commercially biased).

### Radio Cult (UK, automation-first SaaS)
- [V] Fetched pricing: Starter USD 33/mo (3 users, 5GB, 5TB, 192k); Growth USD 57 (20 users, 25GB, 20TB, 320k Studio); Premium USD 97 (50 users, 80GB, 30TB, 3 custom roles); Business USD 163 (unlimited users, 200GB, 60TB, 50 custom roles). Annual = 2 months free. https://www.radiocult.fm/pricing
- [V] Across all plans: live and automated broadcasting, calendar-based scheduling, station and presenter management, real-time analytics, read-only data API, mobile app, embeddable player. Write API and AI agents: included on Premium/Business, add-on USD 29/mo on lower tiers. Alexa skill USD 10/mo; 24/7 music recognition USD 49/mo.
- [V] Mixcloud/SoundCloud integration, recording and archival from Growth up. 7-day trial requires card.

### Zeno.fm
- [R] Paid only since Jan 2025 (free signups paused). Starter USD 35/mo (1 station, 128k), Prime USD 60 (3 stations, 192k), Premier USD 280 (5 stations, 320k). Automation only from USD 60 tier. (Nobex lists USD 28; conflicting.)

### Live365
- [R] Competitor-reported 2026 increases effective 2026-09-01: Broadcast 1 USD 59 to 65; Broadcast 2 99 to 109; Broadcast 3 199 to 219; Broadcast 4 499 to 549; Broadcast 5 999 to 1,099. https://www.radioking.com/blog/?p=37973 (competitor source; verify).
- [I] Historical: music licensing (ASCAP, BMI, SESAC, SoundExchange) bundled; ad insertion and revenue share; unlimited listeners and bandwidth; 192kbps. RBR coverage of earlier shutdown/return ("Live365 is No More", rainnews). Platform continuity risk.

### Centova Cast / SonicPanel / Everest Panel (Shoutcast/Icecast control panels)
- [R] Roughly USD 3.95/mo entry for Centova Cast and SonicPanel; Everest Panel USD 6.95/mo; Everest UK entry GBP 6.99 (150 listeners, 10GB, 128k). Hired Hosting, MyAutoDJ, Online Audience.
- [R] Features: AutoDJ, crossfade, SHOUTcast v1/v2 and Icecast, SSL streaming, DJ accounts, scheduled playlists, strong statistics (Centova). SonicPanel lacks Centova-level reporting per one reviewer.

### Mixlr
- [I/R] Live broadcast with no time limits, recording/archive, ad-free embed, listener analytics, live chat, scheduling with fallback to pre-recorded content, donations, RTMP ingest. Critical review: no video, limited production tools.

### Triton Digital (Spacial/Triton streaming) and StreamGuys, AudioNow
- [I/R] Triton: unlimited listeners and bandwidth in Australian CBAA materials; desktop player; analytics; 24/7 monitoring; TAP sponsorship integration; CDN. StreamGuys and AudioNow: no usable data retrieved. Gap.

### Listen2MyRadio
- [R] AlternativeTo: free tier plus USD 6-18/mo paid. Unverified.

---

## 1) Features pros have that open source lacks (by domain)

Automation and log engine
- Clock/grid designers with minute-level granularity and flex clocks (GSelector 5.0).
- Rule-based music scheduling integrated with the playout log (GSelector, FederAll, Myriad, Radio-Assist, RadioStar artist separation and genre limits).
- Automatic reconciliation of as-run logs back to traffic/billing systems (Aquira ingest, DAD reconciliation).
- Event triggers by time, DTMF, news feeds, EAS (RadioBOSS DTMF, DAD EAS, Myriad live news dynamic automation).
- Split playout for regional ad/branding insertion and multi-site networking (Myriad 5/6).
- Fail-safe redundancy and automatic fallback to pre-recorded content (StationPlaylist Studio Pro, Mixlr scheduling fallback).
- Overlap playout of voice track over songs with auto-crossfader (StationPlaylist, RadioBOSS, Myriad).
- Time-stretch and segue markers (RadioBOSS Ultimate, DAD AutoSegue).

Traffic, sales and music scheduling
- Dedicated traffic/sales system (Aquira, WO Traffic) feeding the on-air log; live commercial edits visible to talent.
- Ad scheduling and spot rules, Canadian content and other regulatory counters (WO Automation Canadian calculator; mAirList ad scheduling).
- Music scheduler integrations: MusicMaster (mAirList, WO), PowerGold (DAD), GSelector.

Live assist and voice tracking
- One-click switch between automation and live assist (Myriad).
- Remote voice tracking from browser or app (Myriad 5/6, RadioBOSS Ultimate, WO AFR Mobile).
- Group voice tracking: one recording to many stations (WO, April 2023).
- AI voice track pre-scheduling with synthetic voices (DAD AITrack).

Hardware and console control
- Native console integrations: DHD, Lawo, AEQ, Axia, Telos VX, Wheatnet-IP, Wheatstone, Sonifex, D&R (mAirList Advanced Plus, Ember+).
- Logitek AoIP integration (Radio-Assist). Axia Altus virtual console in AWS (WO).
- DTMF and MIDI remote control. ArtNet DMX for studio lights (mAirList).
- EAS encoder integration (WO, DAD).

Reliability, DR and ops
- Cloud disaster recovery with site replication (RCS Cloud on AWS).
- Stream Monitor and rebroadcast monitoring (mAirList Advanced Server).
- Long-term audio logger with web UI (mAirList Audio Logger).
- Sharing a database over WAN with a server edition (mAirListDB).

Audio processing
- Built-in processors: EQ, gated AGC, stereo expander, multiband (SAM Broadcaster Pro); EDGE audio processor add-on (Radio Cult).
- Mixdown and external DSP plugin hosting (mAirList).

Hosted SaaS features
- Listener apps with CarPlay/Android Auto and Alexa skills (Radio.co Plus, Radio Cult add-on).
- Track requests and listener voting (Myriad 7 in beta; Radio.co Standard).
- Automatic recording and archive of live shows (Radio Cult, Mixlr, Radio.co).
- Mixcloud/SoundCloud sync (Radio Cult).
- Concurrent-listener and bandwidth tiers, analytics, weekly audience reports (RadioKing Pro).
- Sponsorship insertion and ad platforms (Triton TAP, Live365 ad insertion and revenue share).
- Royalty licensing bundled (Live365 historically, SoundExchange/ASCAP/BMI/SESAC).
- White-label and reseller tiers with custom roles and write APIs (Radio Cult Business, RadioKing Pro Solutions).
- Remote companion apps in a browser over VPN (RCS Zetta2GO, Aquira2GO).
- Multi-station management with per-station plans (Radio.co, Radio Cult, Zeno).

Multi-user and rights
- Granular user rights, custom roles (WO v3.0; Radio Cult custom roles 3-50).
- DJ and presenter accounts with per-station permissions (SAM Cloud, Radio Cult).

---

## 2) UX and power-user patterns worth copying

- Cartwall/hot-key grid: DAD hot keys and array panels; mAirList touch-friendly multi-tab cartwall; RadioBOSS and StationPlaylist hotkeys. Pattern: multiple tabbed pads, colored, configurable per show.
- Live-assist layout: now/next dashboard, time remaining, next-up queue, one-click automation/live toggle (Myriad).
- Search by duration and tag, e.g. find a song that fits a given slot length (Myriad).
- Countdown and sweeper timing computed automatically (Myriad).
- Flex clocks: grid editor down to the minute, with drag-to-reorder slots (GSelector 5).
- Browser-based remote companions with minimal install, reachable via VPN (Zetta2GO, AFR Mobile).
- Native cross-platform desktop clients (WO v5, macOS/Win/Linux/iOS).
- Dual edition model: Standard vs Pro vs Ultimate with clear feature gating (RadioBOSS, StationPlaylist, mAirList).
- Traffic change visible to on-air talent immediately (Aquira to Zetta).
- Pre-scheduling with automatic voice-track generation and preview (DAD AITrack).
- Event triggers via DTMF or schedule and an automatic fallback to stored content on stream drop (Mixlr, RadioBOSS).
- Dashboard for stream health and listener count, plus weekly audience reports (RadioKing Pro).
- Reconciliation view that compares planned vs as-run logs (Aquira, DAD).
- Per-station plan switch and one login for multiple stations (Radio.co, Radio Cult).
- Drag-and-drop log editing and colored categories (common in mAirList, StationPlaylist; not verified in this pass; check vendor screenshots before copying specifics).
- Keyboard-first operation for live shows: hotkeys for cart triggers, fade, next, mic on/off (DAD hot keys, RadioBOSS).

---

## 3) What users complain about (verified signals only)

- Support quality and billing: Spacial/SAM Trustpilot 2023 (2/5, support careless, refund not honored); SourceForge 2026 review of SAM Cloud (station offline despite payments, cut off after feedback). [I]
- Dated UI and code-based scheduling: SAM Broadcaster described as dated; scheduling needs code. [I/R]
- Overwhelming interface for newcomers: SAM Broadcaster Pro (FileHorse). [R]
- Platform continuity risk: Live365 shutdown and return; RadioKing dropped StudioKing maintenance (2023), now beta. [I/V]
- Price increases: Live365 2026 increase (competitor report); RadioKing and mAirList upgrade costs. [R]
- Feature gaps in lower tiers: Radio.co and Radio Cult automation or voice tracking gated to Standard+; Zeno automation from USD 60. [V/R]
- Mac support missing: SAM Broadcaster Pro is Windows only. [V]
- Home vs commercial license friction: mAirList home licenses forbid business use, one PC per license, no refunds. [V]
- Sparse/weak feedback overall: few reviews on RCS, WideOrbit, ENCO, Myriad. Market is opaque; expect limited user voice.
- Hosted-stream dependency: live stream interrupts automation; no adaptive bitrate on Radio.co. [R]
- Stale product pages: RadioKing pricing dated 2024; Radio-Assist sources 2013-2015. [V]

Gaps: no mAirList forum complaints retrieved; no RadioKing user reviews retrieved.

---

## 4) Market gap for a modern multi-tenant web-based pro tool

Observed gaps:
1. Pro automation is still desktop-first, Windows-first (SAM, StationPlaylist, RadioBOSS, mAirList, DAD). Web-native live-assist with proper hardware-console support is rare. WO and RCS have browser/mobile companions, but mostly as remote add-ons, not as the primary UI.
2. Hosted SaaS (Radio Cult, Radio.co, RadioKing, Zeno) covers streaming, scheduling and apps, but is thin on pro traffic/ad sales, as-run reconciliation, audio processing and console integration. Enterprise pro tools are priced for stations with budgets.
3. Pricing is opaque and per-station; tiers gate automation, voice tracking and API behind expensive plans (Radio Cult Growth to Premium; Radio.co Lite lacks voice tracking; Zeno automation USD 60+). A transparent, per-tenant or per-seat model with automation included is an opening.
4. Multi-tenant networks (groups of stations sharing voice tracks, music libraries, ad inventory and reporting) are served mainly by enterprise suites (Myriad split playout, WO groups, RCS Cloud). Modern SaaS for network groups is underserved.
5. Licensing and royalty reporting (SoundExchange, SACEM/ASCAP-style, GEMA) is only bundled by Live365 historically; automated royalty logging per tenant is a gap.
6. Modern voice AI (TTS voice tracks, AI-generated news/weather) is only now appearing (DAD AITrack, Radio Cult AI agents add-on). Room for web-first, multi-tenant AI voice tracking with human approval.
7. Open-source alternatives (AzuraCast, LibreTime, Rivendell) cover hosting and basic automation but lack: console integrations, traffic/ad sales, as-run reconciliation, polished live-assist UI, and multi-station network features. A multi-tenant web app that closes these while staying self-hostable would sit between the two groups.
8. Trust and support: reviews show billing and support pain. Transparent status, exportable data and a clear refund/outage policy are differentiators.

Suggested priorities for our design (derived from this research, not verified by vendor testing):
- Web live-assist console with keyboard hotkeys, now/next, countdown, drag-drop log editing, colored categories.
- Log/clock engine with minute-level grids, rules-based scheduling and fallback content.
- As-run log capture and reconciliation as a first-class export.
- A plugin/API surface (REST + webhooks) for console and traffic integrations; start with Ember+/Telos/Axia/DHD only if demanded.
- Multi-tenant networks: shared media, per-station overrides, split ad insertion.
- Priced per seat or per tenant with automation included in every tier.
