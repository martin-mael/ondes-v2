# 09 - Audience analytics & listener engagement (research report)

Scope: streaming audience metrics and standards, how to compute them from Icecast/Liquidsoap logs, tune-out analysis, dashboards, and listener-engagement features (now-playing APIs, requests, messaging, apps, podcasts/replay, embeds, public API/webhooks, RadioDNS/SPI). Confidence notes are inline. Where a source could not be retrieved, this is stated rather than filled in from memory.

---

## 1. Professional metrics and standards

### 1.1 Vocabulary (streaming)
- **TLH (Total Listening Hours)**: total hours listened in the period, counting only sessions of at least 1 minute. Sessions under 1 minute are excluded. Triton: https://help.tritondigital.com/docs/metrics-definitions
- **AAS (Average Active Sessions)**: TLH / hours in the reporting period. Streaming-native equivalent of AQH (average concurrent audience). Triton: https://help.tritondigital.com/docs/aqh-vs-aas-listener-metrics
- **AQH (Average Quarter Hour)**: average number of people listening at a given moment, Nielsen-style. A listener counts only after at least 5 consecutive minutes within a 15-minute block. Triton's buyer's guide: https://www.tritondigital.com/blog/a-buyers-guide-to-online-audio-measurement-understanding-the-metrics . Triton began adding AQH by market to monthly online reports so advertisers could compare with analog (Radio World: https://www.radioworld.com/news-and-business/triton-digital-to-add-aqh-ratings).
- **Cume (unique listeners)**: count of unique listening agents with at least one session of at least 1 minute in the period. Not additive across stations or periods. Triton uses a different Cume method in Explore/Charts vs Audience Details, with about +/-3% variance. Triton glossary: https://help.tritondigital.com/docs/metrics-definitions
- **TSL (Time Spent per Listener)**: TLH / Cume. Triton notes this is not the same as ATSL.
- **ATSL (Average Time Spent Listening)**: total listening time / active sessions (sessions of at least 1 minute).
- **AS (Active Sessions)**: sessions active during the period regardless of start time, at least 1 minute.
- **SS (Session Starts)**: sessions that started in the period, at least 1 minute.
- **Net vs Gross**: metrics without "Gross" exclude invalid traffic (IVT). Gross includes filtered sessions.
- **Podcast metrics (IAB Podcast rules)**: Downloads (unique = one IP + user agent + episode + date; IPv6 truncated to first 64 bits), Listeners (unique IP + UA), Avg downloads per listener, Downloaded hours, Data GB (CDN only). Source: same Triton page.
- **Royalty metrics (SoundExchange)**: Play frequency and Performances (plays x unique listeners receiving each play).

Triton's "Webcast Metrics" accredited set (per RAIN/Radio World coverage): TLH, Cume (LT method), ATSL, Sessions Started, Active Sessions, AAS. Local variant "Webcast Metrics Local" was first accredited through Pandora's implementation. Triton describes the product as census-based, not sample/panel-based. Sources: https://rainnews.com/triton-digital-receives-continued-media-rating-council-accreditation-for-streaming-audio-measurement/ , https://www.radioworld.com/news-and-business/triton-digital-products-continue-mrc-accreditation . Caveat: the accreditation articles found were mostly 2011-2015; current status should be checked on the MRC accreditation list. Nothing found on IAB certification of Webcast Metrics.

### 1.2 Standards
- **MRC Audio Measurement Guidelines (Jan 2018)** are the governing standard for streaming audio. The IAB Tech Lab podcast v2.3 counting rules explicitly exclude true streaming audio and defer to MRC (https://ppc.land/iab-tech-lab-finalises-v2-3-podcast-counting-rules-covering-video/). The MRC text itself was not retrievable in this research; read it directly before writing spec-level definitions.
- **IAB Podcast Measurement Guidelines**: used for podcast downloads and listener de-duplication (IP + UA; IAB filtering of bots and data-center traffic; 1-minute minimum for downloads per Triton).
- **Session concept (industry practice)**: one user consuming one piece of content; session expires after inactivity. For live streams, one vendor expires sessions 30 minutes after the last request, consistent with the IAB internet "visit" definition (source: https://support.iono.fm/docs/analytics-overview-v2 and https://iono.document360.io/docs/analytics-measuring-sessions).
- **Thresholds differ by vendor**: Triton 1 minute for TLH/sessions; AQH/Cume 5 minutes in 15-minute block; Spotify counts a stream at 60 s; IAB Australia glossary counts a play after 1 second. Pick one and document it. Recommendation for us: 1-minute session minimum for TLH/sessions (matches Triton, so numbers are comparable), 5-min/15-min rule for AQH.
- **ACPM (France)**: ACPM measures digital radio from server logs. A representative said they do not ask people what they listen to; they "verify digital fingerprints of listening" (source: https://fr.themedialeader.com/evolution-de-la-mesure-daudience-radio-vers-une-precision-accrue-et-une-monetisation-optimisee/ ). ACPM's podcast certification uses three methods: server-side collection, stream tags, redirect links (ACPM podcast certification from 1 Jan 2020: https://lareclame.fr/acpm-podcast-certification-228307).
- **Medimetrie (France)**: radio audience measured by the EAR survey (about 100,000 interviews a year) with automatic metering (boxes/watches) being deployed to replace declarative surveys, aiming to indicate listening medium (FM, DAB+, digital). Digital is about one quarter of radio listening time per Medimetrie. Medimetrie and ACPM announced harmonised podcast methodology (undated article). Sources: https://fr.themedialeader.com/?p=101990 , https://www.ozap.com/actu/-l-une-des-plus-controlees-de-france-mediametrie-balaie-les-critiques-contre-sa-mesure-de-l-audience-de-la-radio/629474 . Gap: concrete ACPM rules for streaming radio (thresholds, IVT filtering) were not found. Action: fetch the ACPM "certification digital" method documents directly before implementing French reporting.
- **XiTi**: French web audience measurement (ATInternet). Not researched in depth; relevant only for web player pages if the client wants a French-accredited tag. Treat as optional.

### 1.3 How real stations/vendors report
- Monthly reports by station: TLH, AAS, Cume, TSL, hour-of-day and day-of-week profiles, top markets (Triton Explore / Charts).
- Geographic breakdown via IP geolocation (country, city, region). City-level geolocation is imprecise; RadioKing's own help center admits this.
- Device/player breakdown (Android, iOS, desktop, embedded player, smart speaker) is standard in hosted platforms (e.g. Zeno-style reporting, Radio Mast Analytics add-on at about $10/month with country/city/player drill-down: https://www.radiomast.io/blog/analytics-better-listener-statistics-for-radio.html ). Unverified whether RadioKing exposes device breakdown.

---

## 2. Computing metrics from Icecast / Liquidsoap logs

### 2.1 What Icecast gives you
- Icecast distinguishes **clients** (any HTTP request, including failed ones and browser/phone parallel probes) from **listeners** (clients pulling a mount). Listener counts exist only while the source is connected. Source: Icecast mailing list, maintainer comments (https://lists.xiph.org/pipermail/icecast/2019-March/014517.html).
- Icecast has no native unique-listener count (2006 thread: https://lists.xiph.org/pipermail/icecast/2006-June/010522.html). Stats are exposed via `/status-json.xsl` and `/admin/listclients`, which give IP, UA, connect time (`connected` seconds) and listener id (`lid`) per connection. Verify field names against your Icecast version (2.4.x).
- Icecast access log (`access.log`, combined-like) gives one line per request with timestamp, IP, UA, bytes sent, duration in seconds on disconnect. This is the best source for session length.

### 2.2 Recommended algorithm
1. Parse the access log per mount. Each line = one connection (session candidate).
2. Drop bots/spiders/data-center IPs (UA list, ASN list). Drop 0-byte or failed requests.
3. Dedupe into **unique listener** key = hash(IP (IPv6 truncated to /64), UA). Use `lid` where Icecast supplies it. Expect undercount from NAT/CGNAT and overcount when a player reconnects after a drop (see 2.3).
4. **Session**: consecutive connections from the same key with gap <= 30 min merge into one session (IAB-style visit). Session duration = sum of connection durations.
5. Count only sessions >= 60 s for TLH, AS, SS, ATSL, Cume (Triton-aligned).
6. **TLH** = sum(session durations >= 60 s) / 3600.
7. **AAS** = TLH / hours in period. Compute exactly from per-second concurrency, not snapshots.
8. **AQH**: for each 15-min block, for each listener, mark if >= 5 min within block; AQH = sum of marked listeners / number of blocks... i.e. average over blocks of the number of qualifying listeners (Nielsen rule).
9. **Cume** = count of unique keys with >= 1 qualifying session in period. Do not sum across mounts/stations.
10. Keep both gross and net (IVT-filtered) figures, and label them.

### 2.3 Pitfalls (from community threads)
- Polling `status-json` every 60-90 s misses short listens; a 2014 developer thread recommends building sessions from the full connection log and polling only for live display (https://lists.xiph.org/pipermail/icecast-dev/2014-November/002367.html).
- Duplicate connections from one player are identifiable by overlapping/adjacent connect times (https://lists.xiph.org/pipermail/icecast/2019-December/014882.html).
- Listener stats have been reported with wrong IPs behind proxies (https://lists.xiph.org/pipermail/icecast/2012-November/012281.html). Use the real client IP from the reverse proxy header only if you control the proxy.
- Shout-cast/Icecast 2 metadata is limited; per-listener data is not in metadata.

### 2.4 Per-song tune-out analysis
- Join the log against the **play history** (what was playing at each second on that mount). Requires precise track start times from Liquidsoap (`on_track`/`on_metadata` hooks or the request log) and a station-side `played_at` for each track.
- Compute per track: **listeners at start**, **listeners at end**, **tune-out count** (sessions ending during the track), **tune-out rate per minute**, **average session length starting in that track**, **tune-in count** (sessions starting during track).
- Benchmarks: Spotify skip data (Paul Lamere, Music Machinery) shows skip probability of 24% in the first 5 s, 35% by 30 s, 48.6% before the end (https://musicmachinery.com/2014/05/02/the-skip/). Radio analogues: Edison surveys: 70% change station when they dislike a song, 56% after too many repeats (https://radioink.com/2016/04/11/3540/ ). No direct published study tying Spotify skip to radio tune-out was found (Jacobs Media raises the question: https://jacobsmedia.com/turn-on-tune-in-drop-out ).
- Flag "dead air" and ad/jingle breaks as tune-out events separately.

### 2.5 Geo, device and player breakdowns
- Geo: MaxMind GeoLite2 (or equivalent) at IP level, country + region. City is noisy.
- Device/player: parse UA (ua-parser / device detection). Distinguish browser embed player (`Referer`/origin), native app (custom UA), smart speaker, media players (VLC, Winamp, Kodi), and bots.
- Store aggregates per hour per mount per country/device to keep storage small; keep raw logs for a short retention window (privacy: IP retention should be limited; hash or truncate IP after dedupe window).

### 2.6 Real-time dashboards
- Live listener count: poll Icecast `status-json.xsl` every 5-15 s, or read Liquidsoap/AzuraCast feeds.
- Live map: store GeoIP per connection, push to dashboard via SSE/WebSocket. RadioKing "At the moment" tab shows live listeners on an interactive world map with IP/player, country, total listening time (https://www.radioking.com/blog/?p=27825).
- RadioKing statistics module tabs: At the moment, Unique listeners, Sessions, Session duration, Location, Music, Sources (https://help.radioking.com/hc/en-us/sections/4408643541009-Statistics). Unique listeners counted per day (repeat connections same day = 1). This is a useful baseline definition for our "daily unique" metric.

---

## 3. Open-source reference points

- **AzuraCast** (https://www.azuracast.com/docs/developers/now-playing-data/): the most complete reference for listener-facing data.
  - Endpoints: `/api/nowplaying` (all public stations), `/api/nowplaying/{shortcode|id}`, `/api/nowplaying_static/{shortcode}.json` (cached, slightly delayed), `/api/nowplaying_static/{shortcode}.txt` ("Artist - Title"), `/api/time` (server UNIX time).
  - Realtime: Centrifugo WebSocket at `wss://<host>/api/live/nowplaying/websocket` (subscribe with `{"subs":{"station:<name>":{"recover":true}}}`), and SSE at `/api/live/nowplaying/sse?cf_connect=TOKEN`. Updates carry `pub.data.np`.
  - Fields described: station info and mounts, listeners (total and unique), `now_playing` (`played_at`, `duration`, source playlist/request/live), `elapsed`/`remaining` computed client-side, live DJ connected + name, history (default about 5, configurable).
  - Client timing recipe: elapsed = server_time - played_at, clamped to [0, duration]; poll nowplaying every 15 s, sync `/api/time` every 10 min. Responses cached a few seconds server-side.
  - Auth: Bearer token from "My API Keys". Note: exact JSON key names are not documented on the page; inspect a live response before coding against it.
  - **Webhooks**: AzuraCast docs say you can connect a station to Slack, Discord, TuneIn, Twitter "and more" via webhooks (https://azuracast.com/docs). Telegram not confirmed. The outbound webhook event payload schema was NOT found. Check the `/api` page of your install (generated OpenAPI docs) and the GitHub source (`backend/src/Entity/StationWebhook*` and `Webhook` connectors) before designing our webhook schema.
  - **Requests**: listeners request from playlists via API or public page. Priority setting for requests (added in 0.20.3, Nov 2024) lets requests be lower priority than scheduled playlists (https://client.magicstreams.services/en/announcements/147/azuracast-0-20-3-nov-17-2024.html). Known gaps (open feature requests): per-listener/per-song request caps (e.g. one song twice an hour), time windows for requests, blocking requests during certain playlists (https://features.azuracast.com/suggestions/38907/specify-a-time-when-songs-can-be-requested-from-a-given-playlist , https://features.azuracast.com/suggestions/61827/disable-song-requests-while-certain-other-playlists-are-playing). No built-in request abuse protection found. `NGINX_BLOCK_BOTS` blocks crawlers at the web layer only.
  - Also: the Live Now-Playing API does not accept station IDs in at least one wrapper plugin (WordPress plugin note), so use shortcodes.
- **Liquidsoap**: no built-in listener-stats endpoint. Metadata can be pushed out via `on_metadata`, `server.insert_metadata` (`ID.insert key="value"` over telnet) and `output.icecast` (re-sends last metadata on connect unless `send_last_metadata_on_connect` is disabled, 2.4.2). Icecast legacy protocol only carries `song` reliably. Source: https://www.liquidsoap.info/doc-dev/metadata , https://ocaml.org/p/liquidsoap/2.4.2/CHANGES.html . Telnet/server interface is local-only by default.
- **Icecast**: listener data via `status-json.xsl` and `admin/listclients` (see 2.1).
- **Limitations seen in community**: no unique count, NAT undercount, stats polling misses short sessions, shoutcast-compat metadata thin.

---

## 4. Commercial tools: what they do that open source does not

- **Triton Digital (Webcast Metrics, Explore, Charts)**: MRC-accredited, census-based, cross-platform cume with IVT filtering, market-level AQH. Open source cannot claim accreditation. This is the buyer-facing standard for ad sales.
- **Radio Mast Analytics** (optional add-on, about $10/month): country/city/player drill-downs (https://radiomast.io/solutions/analytics).
- **RadioKing Statistics module** (7 tabs, daily-unique counting, live map, exports). Mobile app builder with white-label options, push notification allowances tied to pricing tiers (https://www.radioking.com/pricing-mobile-app).
- **Nobex Partners** (apps & push): push messaging with automatic onboarding messages showing app features (https://www.nobexpartners.com/?p=20944); shoutouts with approval queue and "mark as played" (https://nobexpartners.hc.ferndesk.com/shoutouts-nyhhf).
- **SAM Broadcaster Cloud**: player and web widgets for song request and dedication, default 10-minute delay before a request airs (https://spacial.com/using-song-requests-engage-audience/).
- **Buildfire / Nstreamz / Cir.st**: white-label app builders with song requests, dedications, push notifications (https://radioapps.buildfire.com/ ; https://cir.st/?p=7910).
- **Iono.fm / Audioboom**: podcast analytics with IAB-style counting, session expiry (https://api.iono.fm/docs2/data/metrics/).
- **Radio.co**: white-label app listed in its platform overview, but feature specifics (push, requests) were NOT verified from search results. Check Radio.co pricing page directly before claiming parity.
- **Not researched in depth** (limited search results): Edison Research (Infinite Dial, Share of Ear), Triton Podcast metrics beyond the above, Live365, StreamGuys, Zeno, Myriad, WideOrbit analytics. Mark as gaps.

---

## 5. Engagement features (landscape)

### 5.1 Now-playing APIs and widgets
- Standard pattern: REST snapshot + push feed (WebSocket/SSE). AzuraCast offers both (section 3). Clients compute elapsed time locally from `played_at` and server time to avoid polling.
- Embeds: now-playing widget (iframe or JS), WordPress plugins, "static text" endpoint for OBS/stream overlays.

### 5.2 Website player, song history, schedule
- Player: HTML5 audio with Icecast/HLS fallback; show current track, artwork, next up, last 5 played.
- Song history: API returning last N (default 5 in AzuraCast; allow configurable N and time range). Keep track `played_at` and duration for analytics.
- Program guide / schedule pages: day grid with show, presenter, time; exported as ICS and as SPI schedule (see 5.8).
- Show and presenter pages: bio, photo, past episodes, podcast link.

### 5.3 Song requests and dedications
- Patterns found: web widget and player widget with library search (SAM Cloud); approval queue + mark as played (Nobex); text/SMS/WhatsApp request with DJ reply time estimate; DJ-presented dedications (Pro Radio form with staff approval).
- Scheduling: requests typically have delay (SAM: 10 min), priority lower than scheduled playlists (AzuraCast priority, 0.20.3).
- **Request abuse protection** (no mature OSS implementation found): per-IP/per-account rate limits (e.g. 1 request per song per 2 hours, N per hour), captcha on public widget, banned song list, recently-played exclusion, moderation queue, block during certain playlists or time windows (all requested as AzuraCast features, not built).
- Requests need a Liquidsoap path: Liquidsoap `request.queue()` pushed via telnet/HTTP (see Liquidsoap section).

### 5.4 Likes, votes
- Per-track like button in player and app; weighted by listener session; used to feed programming (favourite lists). Keep anti-spam: one vote per track per device/session with cooldown.

### 5.5 Listener chat, messaging (SMS, WhatsApp)
- SMS: shortcode/long number, opt-in required, keywords (e.g. "REQUEST"); burst-type vendors cite higher response vs call-in contests (https://blog.burstsms.com.au/sms-marketing/3-ways-radio-stations-can-engage-their-listeners-with-sms/). Commercial SMS requires compliance (opt-in, STOP handling, sender registration in France/EU).
- WhatsApp: vendor-app claims only; no mature radio automation WhatsApp integration found. Treat as later-phase, via WhatsApp Business API provider.
- On-air chat: moderation queue, DJ-only view, profanity filter.

### 5.6 Contests and polls
- Formats: name-that-tune, trivia at fixed weekly time, SMS vote. Needs a contest entry table, double-entry prevention (IP + phone + email), winner draw with audit log.

### 5.7 Push notifications and mobile apps
- White-label apps: RadioKing (white-label, push allowance by tier), Nobex (push automation for onboarding), Buildfire, Radio.co (unverified), Zeno. Push features: "station live now", "your request is next", show reminders.
- Push needs FCM/APNs and per-user token storage; keep opt-in.

### 5.8 Podcasts, catch-up and replay
- Record every live show (Liquidsoap `output.file` with hourly rotation, or a separate recorder output); auto-cut into episodes at show boundaries using the schedule; publish RSS (podcast 2.0 tags, `<podcast:...>`) and on-demand pages.
- Metadata: show title, presenter, artwork, chapter markers from track history.
- Analytics: podcast downloads counted with IAB rules (section 1.1).

### 5.9 Social auto-posting
- Post now-playing or "on air now" to Twitter/X, Mastodon, Facebook, Discord, Telegram via webhooks or APIs (AzuraCast webhooks list Slack, Discord, TuneIn, Twitter as examples). Throttle to avoid spamming; allow per-playlist opt-in.

### 5.10 Public API and webhooks (design guidance)
- AzuraCast public API: REST JSON, Bearer key, OpenAPI per install. Now-playing public endpoints need no auth.
- Webhook design lessons: sign payloads (HMAC), retry with backoff, dead-letter, event list (`track.started`, `track.ended`, `show.started`, `listeners.changed` (throttled), `request.created`, `request.played`, `dj.connected`, `stream.down`), idempotency key per event.
- Our product: event bus already planned on RabbitMQ; expose webhooks as a consumer of the same events.

### 5.11 RadioDNS, RadioVIS / Slideshow, SPI (hybrid radio)
- **RadioDNS** (https://radiodns.org/technical/documentation/): bearer-agnostic lookup. TS 103 270 defines a DNS-based lookup from station identifiers (FQDN from FM/DAB/HD/DRM/AMSS IDs) that returns IP service resources.
- **SPI** (TS 102 818, current v3.5.1): station metadata (logos in sizes), programme info, schedule (for current day recommended), on-demand index (https://radiodns.org/news-events/news/2022/05/14/service-and-programme-information-standard-updated/ ). Over air on DAB via MOT in an ensemble SPI service (https://www.worlddab.org/standards/data-applications/service-and-programme-information).
- **RadioVIS** (renamed Slideshow, TS 101 499 v3.2.1): dynamic visuals and text over IP alongside broadcast. Relevant for providing station logos/now-playing images to car and hybrid receivers.
- Practical scope for us: publish SPI XML at the RadioDNS-defined paths for each station (logo, schedule, programme), plus a Slideshow/now-playing image endpoint. Low priority unless the client targets DAB/FM hybrid receivers.
- Gap: how a receiver picks between over-air and IP logos was not found; read the RadioDNS docs and ETSI specs before implementing.

---

## 6. Feature checklist for our product

### Must
- Icecast/Liquidsoap log ingestion with dedupe key (IP/64 + UA), 30-min session merge, 60-s minimum session.
- Metrics: TLH, AAS, Cume (per period, not summed), TSL, AS, SS, ATSL. Gross and net (IVT-filtered) labelled.
- Daily/hourly aggregates per mount, per country, per device/player class; hour-of-day and day-of-week profiles.
- Live listener count and live map (poll Icecast status; push via SSE).
- Bot/spider and data-center filtering; documented methodology page (thresholds and definitions visible to clients).
- Now-playing API (REST + SSE/WebSocket) with `played_at`, duration, next track, last N history, live DJ flag.
- Song history with played-at times (also the source for analytics joins).
- Per-track tune-out report (listeners at start/end, tune-outs per track).
- Song request (web widget, approval/queue, priority below scheduled programming) with basic rate limit per IP/session.
- Public API with API keys and rate limits; event webhooks with HMAC signing and retries.
- Data retention and IP anonymisation policy (GDPR; hash IP after dedupe window).

### Should
- AQH computed from 15-min blocks (5-min rule), for ad-sales alignment.
- Podcast/replay: auto-record shows, cut episodes, RSS feed, download counts with IAB rules.
- Embeddable player and now-playing widget (iframe + JS), schedule/program guide pages (ICS export), show and presenter pages.
- Request moderation: banned songs, recently-played exclusion, time windows, captcha on public widget.
- Social auto-posting of "on air now" with throttle and per-playlist opt-in.
- White-label mobile app or PWA with push for "live now" and "your request is next".
- Contests and polls with duplicate-entry prevention.
- Client-facing monthly PDF/CSV report exports.

### Could
- Triton-style MRC accreditation path (costly; only if ad sales require it).
- SMS and WhatsApp messaging with opt-in and STOP handling (compliance first).
- Likes/votes feeding programming.
- RadioDNS/SPI and Slideshow for DAB/FM hybrid receivers.
- ACPM / Medimetrie-aligned French reporting for FR stations.
- XiTi tag support for French web players.
- Live chat with DJ moderation.

---

## 7. Liquidsoap implementation notes

- Log track starts with a `on_track` or `on_metadata` handler that writes `played_at`, duration, artist, title, source (playlist/request/live) to our DB (or pushes to RabbitMQ). Do the write asynchronously so the audio thread is not blocked.
- Use `server.insert_metadata` (or `on_metadata` into an output) to publish now-playing metadata to Icecast (`output.icecast`). Remember Icecast legacy protocol only carries `song` reliably; use Icecast 2.4 with `send_last_metadata_on_connect` as needed.
- Requests: create a `request.queue()` per priority tier; the request endpoint pushes URIs via telnet or the Liquidsoap HTTP/Harbor interface. Enforce rate limits in our API before pushing; Liquidsoap has no notion of listener identity.
- Telnet/server interface is local-only by default; expose it only inside the Docker network to our Node backend.
- Listener counts come from Icecast (status-json / listclients), not Liquidsoap. Confirm with a live server.
- Record per-hour archives with `output.file` (rotation by hour) for replay and podcast cutting.

---

## 8. Known gaps (not verified)
- MRC Audio Measurement Guidelines text (thresholds, IVT rules) - must read directly.
- ACPM and Medimetrie streaming-radio technical rules and current certification status.
- AzuraCast webhook event names and payload schema; Telegram support.
- Radio.co white-label app feature list.
- Radio device breakdown in RadioKing.
- RadioDNS over-air vs IP logo precedence.
- Edison Research and Triton podcast metrics detail.
- WhatsApp integration patterns for radio automation.
