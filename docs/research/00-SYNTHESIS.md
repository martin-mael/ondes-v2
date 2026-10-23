# Ondes v2: professional radio research synthesis

Twelve parallel Haiku research agents produced the topic reports in this folder (01–12), each with sources, a Must/Should/Could checklist and Liquidsoap notes. This file condenses them.

**Reliability caveat:** many vendor pages (RCS, MusicMaster, PowerGold, some Liquidsoap docs, EBU PDFs) returned 403/404, so some claims rest on search snippets. The reports mark these `[unverified]` / `[gap]`. Re-check anything load-bearing, especially Liquidsoap function signatures, against the version we pin.

---

## 1. The big picture: what a pro station runs

A professional station is not "a playlist plus a stream". It is a chain of systems that hand off to each other:

```
Library/ingest ─► Music scheduler ─┐
                                   ├─► Log (the day, second by second) ─► Playout engine ─► Processing ─► Encoders/CDN ─► Listeners
Traffic (ads)  ─► Spot scheduler ──┘            ▲                                 │
                                                │                                 ▼
Live studios / remote DJs / voice tracks ───────┘                      As-run log ─► Reconciliation ─► Billing, royalties, analytics
```

- **The log is the central artifact.** Music scheduling and traffic both write into it, playout executes it, and the as-run log is compared against it afterwards. Rivendell, Zetta, Myriad and mAirList are all log-centric.
- AzuraCast and LibreTime are **playlist-centric**: they pick tracks at runtime. That is the root of their best-known bugs (AzuraCast #2631 "playlist not playing at scheduled time", the most-discussed issue in the repo) and of why they can't do separation rules, time-fill or reconciliation properly.
- **Design consequence for us:** Node owns the clock, log and rules engine. Liquidsoap is a pure, infallible executor that receives the log just-in-time (`request.queue`) and reports what it actually played.

---

## 2. Findings by domain

### 2.1 Playout & automation ([01](01-playout-automation.md))
- **Format clocks:** hour templates with typed slots (music category, stop set, station ID, news, voice track, imaging), partial clocks, and weekly assignment by daypart. Typical hour: 2–4 stop sets.
- **Fixed-time markers, three modes:**
  - *Hard:* cuts the playing item to hit the time.
  - *Soft:* waits for the item to end and skips intervening items, within a cap (mAirList "time frame").
  - *Not before.*
  - Hard cuts are a recurring user complaint.
- **Backtiming / time-fill / time-stretch to hit the hour:** poorly automated almost everywhere. RadioBOSS's stretch is flaky. This is an opportunity.
- **Modes:** full-auto vs live-assist, with a one-click switch that doesn't interrupt the current item.
- **Live-assist tools:**
  - Cart walls with at least 3 simultaneous carts and hotkeys.
  - Voice tracking recorded against a segue view, local and remote.
  - Group voice tracking: one voice track pushed to many stations (WideOrbit).
- **Fallback chain:** live → requests → log → emergency playlist → emergency single file. Add silence detection with an automatic action and an alert.
- **"Rock-solid" means two things:** no dead air ever, and failover that doesn't depend on slow storage switchover (ENCO quotes up to 60 s for storage, which is too long).
- **Liquidsoap facts:**
  - `fallback(track_sensitive=false, …)` gives an instant live takeover.
  - `cross.smart` defaults are -15 / -32 dB with a 4 dB margin.
  - `switch` + `predicate.activates` handles top-of-hour triggers.
  - Cue key names changed across versions (`cue_in` vs `liq_cue_in`), and `cue_cut` was removed in 2.2.5. **Pin the version.**

### 2.2 Music scheduling ([02](02-music-scheduling.md))
- **Pro model:**
  - Categories (Power/Secondary Current, Recurrent, Gold, …), each with a rotation size, search depth and pass order.
  - Clocks per daypart.
  - Rules (detailed below).
  - Generate the log, hand-edit it, then reconcile it against what aired.
- **Rules are the core of the product:**
  - Artist, title, album and recording separation in minutes, with exemptions.
  - MusicMaster "Auto Kick": not in the same hour window on consecutive days, with hour, half-hour or quarter-hour windows.
  - Position kick.
  - Sound-code segue bans with n-gram semantics. Example: Pop→Pop is breakable, Pop→Pop→Pop is not.
  - Gender, tempo, era and energy goals.
  - GSelector "airplay starvation" boost.
  - Rule groups by daypart.
- **Unsatisfiable constraints:** use a deterministic, logged **relaxation ladder** plus a dry-run/diff mode.
- **Burn control:**
  - Counters per song (plays per week, day and hour).
  - PowerGold's analysis of 78 CHR stations suggests about 100 top-power spins per week.
  - Research imports: callout scores for currents, AMT (auditorium music tests) for gold.
- **Open-source gap:**
  - AzuraCast has no clocks.
  - LibreTime smart blocks have no artist separation (issue #1369, open since 2021).
  - "Once per X" insertion is unreliable when done at runtime. Generate it into the log instead.
- **Trend:** ML/optimizer scheduling (INFORMS 2025, Super Hi-Fi). Treat it as a suggestion layer on top of hard rules.

### 2.3 Audio processing & loudness ([03](03-audio-processing-loudness.md))
- **Targets:**
  - EBU R128: -23 LUFS / -1 dBTP.
  - R128 s2 (streaming): interim -18 to -16 LUFS.
  - AES TD1008: -16 LUFS for music, -18 LUFS for speech.
  - Ship station presets: Music -16, Talk -18, EBU -23, Custom.
- **Normalization:**
  - Measure BS.1770 integrated loudness, LRA and true peak **at ingest**, and store them in the DB.
  - Apply the precomputed gain at playout via `liq_amplify`.
  - Clamp gain to the true-peak ceiling.
  - Avoid runtime `normalize`; its docs warn it pumps.
- **Processing chain:** reference designs are Omnia and Optimod (AGC → multiband → look-ahead limiter, phase correction).
  - **Stereo Tool** has a Linux CLI and a libStereoTool SDK usable with Liquidsoap. Make it an optional per-station processor; its licence must be checked.
  - "Signature sound" in practice means named presets.
- **Codecs:** Opus 64–96 kb/s for music, 24–32 kb/s for speech. Pre-emphasis off (it's FM-only).
- **Logging:** log loudness per hour.
- **Live mic chain:** gate, de-esser, compressor, ducking.

### 2.4 Stream delivery ([04](04-stream-delivery.md))
- **Server:** Icecast 2.4.x (or the KH build) behind Caddy/nginx for TLS on 443.
  - Its admin API is **XML only**, so Node needs an XML poller.
  - Per-mount knobs: `burst-size` < `queue-size`, `fallback-mount` in the same format, `fallback-override`, `intro`.
  - Raise `<clients>` from its default of 100.
- **Mount ladder:**
  - MP3 128k (compatibility).
  - AAC-LC 96–128k, or HE-AAC v2 48–64k for mobile.
  - Opus (opt-in).
  - HLS via Liquidsoap `output.file.hls`: AAC in MPEG-TS, 2 s segments, `persist_at` for seamless restarts, ID3 timed metadata.
- **Auth & metadata:**
  - Listener auth through Icecast URL-auth, backed by short-lived tokens issued by Node. This also covers geo-blocking and paid streams.
  - Keep one canonical now-playing record in the app and push it to ICY and HLS ID3.
- **Bandwidth:** about bitrate × listeners × 1.15. Cloudflare doesn't cache live audio, so bypass it.
- **Directories:**
  - radio-browser.info has an API (`POST /json/add`).
  - TuneIn's acceptance status is unclear.
  - Smart speakers, CarPlay and Android Auto are mostly reached through aggregators.
- **DAB+ bridge:** ODR-AudioEnc can pull an Icecast URL and feed ODR-DabMux.

### 2.5 Live & remote broadcasting ([05](05-live-remote-broadcasting.md))
- **Input:** `input.harbor` with an `auth` callback against our DB, one credential per DJ/show, and `fallback(track_sensitive=false)` for an instant takeover.
  - Shoutcast clients connect on port+1.
  - Since 2.4.4, a mountpoint that's already taken returns 403.
- **Handover pain is universal:**
  - LibreTime: 5–7 s of dead air.
  - AzuraCast: AutoDJ queue scrambled or jumping back to the previous track after a live show; recordings lost on disconnect.
  - Fix: a bed or jingle on return, plus a deliberate policy for resuming the log.
- **Must-haves:**
  - Scheduled and ad-hoc slots, with an admin override and kick.
  - `on_connect` / `on_disconnect` events into RabbitMQ.
  - Automatic recording of every show with retention.
  - DJ-set metadata.
  - A connection-info page with copy-paste settings for BUTT, Mixxx and OBS.
  - A log of every source switch.
- **Should:**
  - Browser WebDJ.
  - SRT ingest for IP-codec studios (Comrex, Tieline, Telos).
  - Remote guests through third parties (Cleanfeed, Riverside); don't build our own WebRTC mixer.
  - Mix-minus guidance.
  - Multi-host shows.
- **Out of scope:** AoIP (AES67/Dante/Livewire), unless a studio customer needs it.

### 2.6 Traffic, ads & monetization ([06](06-traffic-ads-monetization.md))
- **Billing runs on the as-run log, not the plan.** Unreconciled spots block billing (Zetta docs).
- **Model:**
  - Order → order lines/flights → creatives (ISCI-style IDs).
  - Stop-set placement with separation (advertiser, product category, max per break/hour, no-adjacent) and preemption classes.
  - Reconciliation actions (bump, scratch, bill-as-scheduled), a makegood ledger, affidavits/proof of play, and invoicing with agency commission.
- **Digital ads:**
  - Emit break-start/break-end cue metadata in the stream, mirroring Triton TAP fields (`ad_id`, `cue_time_duration` in ms, VAST URL). This makes us SSAI-ready (Triton, AdsWizz, Targetspot).
  - Audio-only SCTE-35 is not a real-world practice; in-band metadata is.
- **Non-profit / community:**
  - Underwriting copy checks: no calls to action or prices (US NCE).
  - Sponsorships.
  - Memberships with an ad-free stream (token-authed mount).
- **Open source has zero traffic model.** This is a large differentiator.

### 2.7 Compliance, royalties & logging ([07](07-compliance-royalties-logging.md))
- **France:**
  - **SACEM** webradio licence: about €80/channel/year flat for small radios (≤ €20k income/expenses); otherwise 12% of income, minimum €60. Listeners must not be able to pick tracks on demand.
  - **SPRE** collects rémunération équitable for webradios (since Law 2016-925), split 50/50 between performers and producers.
  - **Arcom:** a webradio is *declared*, not licensed. The file needs a programme grid, statutes and a budget.
  - The 40% French-song quota is likely not applicable to declared webradios. **Unverified: confirm with Arcom.**
  - **CNIL:** the cookie-free audience-measurement exemption requires anonymous, first-party, 13-month cookies.
- **US:**
  - SoundExchange monthly Report of Use (ASCII; ISRC; actual total performances), kept 3 years.
  - **DMCA performance complement** per channel per rolling 3 h: max 3 tracks per album (2 consecutive), max 4 per artist (3 consecutive), no pre-announcing.
- **UK / Germany:** PRS Internet Radio Licence (Oct 2025) + PPL; GEMA + GVL.
- **Product implications:**
  - Per-tenant compliance profile.
  - **Append-only as-run log** with ISRC/ISWC.
  - Music vs non-music separation in reports.
  - Complement enforcement inside the scheduler.
  - Report generators.
  - Air-check logger with retention and legal hold.
- **Paid tools:** Live365 bundles licensing; ENCO formats SoundExchange reports. Automated per-tenant royalty reporting is a market gap.

### 2.8 Media library & metadata ([08](08-media-library-metadata.md))
- **Storage:** two tiers. A lossless master (FLAC/BWF) plus a playout copy, content-addressed (SHA-256), with a local hot cache for Liquidsoap (never stream from S3 directly).
- **Ingest:** resumable web upload, SFTP, stability-checked watch folders, S3, API, and promo pools (Play MPE).
- **Cues:**
  - **autocue** (Moonbase59, MIT) uses loudness-relative thresholds: cue-out at -42 LU, overlay at -8 LU, plus a long-tail rule.
  - Port or wrap it in our analysis worker and push `liq_cue_in/out`, `liq_cross_start_next` and `liq_amplify` as request metadata. Don't run autocue at runtime (CPU cost).
- **Analysis:**
  - BPM and key with confidence scores and the analyzer version.
  - Spotify audio-features was deprecated in Nov 2024.
  - Essentia's models are **non-commercial** (CC BY-NC-SA).
  - AcoustID commercial use needs a paid plan.
  - Enrichment order: ISRC → MusicBrainz → fingerprint, with per-field provenance and operator lock.
- **Library hygiene:** duplicate detection (hash plus Chromaprint), start/kill dates, daypart restrictions, and versions/cuts (radio edit, clean, extended).
- **Editor & search:** waveform cue editor (audiowaveform peaks plus wavesurfer.js or Peaks.js). Faceted search that scales past 100k tracks (Postgres trigram or Meilisearch).
- **Asset types:** jingles, imaging and voice tracks are first-class, with expiry.

### 2.9 Analytics & engagement ([09](09-analytics-engagement.md))
- **Metrics:**
  - TLH = sum of sessions ≥ 1 min.
  - Cume = unique listeners, not additive across stations.
  - AQH uses the 5-minutes-within-15 rule.
  - TSL, ATSL, AAS.
  - Triton Webcast Metrics is MRC-accredited. In France, the references are ACPM (server logs) and Médiamétrie.
- **How to compute:**
  - Build sessions from Icecast access-log connect/disconnect events (not status polling).
  - Dedupe on IP /64 + user agent, merge gaps ≤ 30 min, filter bots and data centers.
  - Publish the methodology.
- **Per-track tune-out:** join sessions with the as-run log. Almost nobody does this well, so it's a differentiator.
- **Engagement:**
  - Now-playing REST + SSE.
  - Song history and requests with moderation and rate limits. AzuraCast lacks request limits.
  - Embeddable player and widgets, program guide with ICS, show/presenter pages.
  - Podcast/replay generated from recordings.
  - Social auto-posting.
  - PWA or white-label app.
  - HMAC-signed webhooks.
  - Public API with keys.
- **Later:** RadioDNS SPI.

### 2.10 Open-source landscape ([10](10-open-source-landscape.md))
| | AzuraCast | LibreTime | Rivendell |
|---|---|---|---|
| Model | Playlists + priorities | Show calendar | **Log / clocks / carts** |
| Stack | PHP, Liquidsoap, Icecast-KH, MariaDB, Redis, Centrifugo, one container + supervisord | Python (pypo), Liquidsoap, **RabbitMQ** | C++/Qt desktop, Linux |
| Strength | Easy install (`docker.sh`), multi-station, API/webhooks, WebDJ | Pre-downloads 24 h, validated media | Real FM-grade automation |
| Weakness | Schedule-boundary bugs, no clocks, no traffic, no separation | Handover gaps, stalled project | Desktop-only, dated UX |

- **Copy:**
  - The installer UX: install, update, backup, restore, rollback, doctor.
  - The playlist-priority taxonomy as a simple mode.
  - LibreTime's scheduler / playout / analyzer split over a queue.
  - Rivendell's log/cart model.
- **Avoid:**
  - Everything in one supervisord container.
  - Runtime scheduling decisions.
  - Licensing ambiguity.

### 2.11 Commercial landscape ([11](11-commercial-landscape.md))
- **Prices:**
  - mAirList: €100–200 (home licences, non-commercial).
  - RadioKing: €29 / €54 / €99 per month.
  - Radio Cult: $33–163 per month; write API and AI agents only on the top tiers.
  - RadioBOSS, SAM Broadcaster and StationPlaylist: about $200–300 one-time.
  - RCS, WideOrbit, ENCO and Myriad: quote only.
- **What pros have that open source lacks:**
  - Traffic and as-run reconciliation.
  - Minute-level flex clocks.
  - Split playout for regional ads (Myriad).
  - Console integration (DHD, Lawo, Axia, Wheatstone via Ember+).
  - Cloud disaster recovery.
  - Group and remote voice tracking.
  - Audio logger and stream monitor.
  - EAS/DTMF triggers.
- **UX to copy:**
  - Tabbed, colored cart walls with hotkeys.
  - Now/next view with countdown to the next hard event.
  - Find-by-duration search ("what fits 3:12?").
  - Drag-drop log editing with colored categories.
  - Keyboard-first live operation.
  - Planned-vs-as-run view.
- **Complaints:**
  - Support and billing (Spacial).
  - Dated, Windows-only UIs.
  - Platform continuity (Live365, StudioKing).
  - Features gated behind expensive tiers.
- **Market gap:** a **web-first, multi-tenant, self-hostable pro tool** that bundles clocks and scheduling, live-assist, traffic and reconciliation, royalty reporting and network features, with transparent pricing. Nobody currently sits between "AzuraCast" and "Zetta".

### 2.12 Platform, ops & multi-tenancy ([12](12-platform-ops-multitenancy.md))
- **Engine:**
  - **One Liquidsoap container per station** with cgroup limits.
  - Generated from a versioned template, always infallible: inputs → `single()` safety loop → `mksafe`.
  - Reference implementation: **Radio France `rf-liquidsoap`** (77 stations). It uses SRT inputs with fallback, Prometheus gauges (`is_playing`, `is_blank`, `unready_duration`) and a small HTTP control API.
- **Two-layer emergency audio:** a Liquidsoap safety loop plus an Icecast fallback-mount. Pair it with an external stream probe and a restart-storm guard.
- **Security:** Liquidsoap's telnet and harbor have no auth, so keep them internal-only behind a typed, audited Node shim.
- **Sizing:** AzuraCast reports about 10% of a core per encoder; budget 0.5 vCPU and 0.5–1 GB per station. A 4 vCPU / 8 GB VPS is a reasonable start.
- **Tenancy & identity:**
  - Org → stations → users, with role presets: Owner, Station Manager, Program Director, Music Director, Presenter/DJ, Producer/Traffic, Analyst.
  - Granular `resource:action` permissions and an audit log.
  - OIDC, TOTP/WebAuthn and scoped API keys.
- **Queues & real time:**
  - RabbitMQ quorum queues, a dead-letter exchange, TTL retry tiers, separate high and bulk queues, and idempotent jobs keyed by content hash.
  - Control commands are synchronous API calls, not queued.
  - SSE for now-playing, status and meters; WebSocket only for the DJ console.
- **Installer & ops:**
  - Idempotent bash installer: `install | update | backup | restore | doctor | uninstall`.
  - Pinned image digests, generated secrets, Caddy for TLS (on-demand for custom domains).
  - Docker bypasses UFW, so use the provider's firewall.
  - Backups: Postgres PITR plus restic, with restore drills.
  - Canary upgrades with rollback on silence.
  - Observability: Prometheus, Grafana and Loki.

---

## 3. Consolidated "Must" list (MVP-grade professional)

1. **Library:** two-tier storage, ingest at loudness, auto-cues, waveform cue editor, rich metadata (ISRC), kill dates, first-class jingle/imaging/voice-track assets.
2. **Scheduling:** categories, clocks per daypart, separation/kick rules, relaxation ladder, log generation with dry-run, manual log editing, burn counters.
3. **Log & playout:** hard/soft/not-before events, time-fill, stop sets, fallback chain, silence detection, smart crossfades, full-auto and live-assist.
4. **Live:** harbor with DB auth, scheduled and ad-hoc slots, instant takeover with clean return, auto-recording, connection page, voice tracking in the browser.
5. **Processing:** per-station loudness target with precomputed gain, true-peak safety, processing presets.
6. **Delivery:** Icecast mount ladder (MP3/AAC/Opus) + HLS, TLS, URL-auth tokens, canonical now-playing metadata, fallback mounts.
7. **As-run log:** append-only. Feeds royalties (SACEM/SPRE/SoundExchange/PRS-PPL), reconciliation, analytics and the air-check logger.
8. **Analytics:** session-based TLH/Cume/AQH, live listeners, per-track tune-out, GDPR-safe.
9. **Public surface:** now-playing API/SSE, widgets/player, requests with moderation, webhooks, schedule pages.
10. **Platform:** org/station RBAC, audit log, per-station container, two-layer failover, Prometheus monitoring, one-script install/update/backup.

**Strong differentiators (Should):** traffic and ads with reconciliation and SSAI cue metadata, network/group features (shared library and voice tracks, split ads), royalty report generators, podcast/replay from recordings, Stereo Tool integration, SRT ingest, find-by-duration, keyboard-first live-assist UI.

---

## 4. Open questions to resolve before design freeze
- **Liquidsoap version pin** (2.4.x stable vs 2.5.x). Verify `request.queue`, the annotate keys, the harbor HTTP API, the `server` interface, `output.file.hls` args and the cue metadata names against that version.
- **Arcom:** quota and retention obligations for declared webradios. **SACEM/SPRE:** declaration formats and cadence.
- **Licences:** Stereo Tool (per station?), AcoustID (commercial), Essentia (non-commercial models).
- **TuneIn:** current submission policy.
- **Hot standby across hosts:** not covered by any source.
- **Benchmarks:** per-station CPU and RAM with 3–4 encoders + HLS.
