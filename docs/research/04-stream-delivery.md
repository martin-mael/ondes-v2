# 04 - Stream delivery and distribution

Scope: Icecast / Shoutcast / Icecast-KH, HLS and Liquidsoap HLS output, DASH, codecs and bitrates, ICY and HLS metadata, relays and CDNs, listener auth, fallback and intro, directories, DAB+/FM feed, bandwidth math, TLS, embeds.

Confidence legend: [V] verified from a primary doc fetched in this session. [S] secondary or vendor source, or old mailing-list post. [?] not found / unverified.

---

## 1. Server software: Icecast vs Shoutcast vs Icecast-KH

- **Icecast 2.4 (xiph.org)** - GPL, open source, the reference open-source ICY/HTTP stream server. Current docs in use: https://icecast.org/docs/icecast-2.4.1/config-file.html [V]. Icecast-KH (Karl Heyes fork, 2012+) is the de facto hosting-industry build (per [S] https://www.shoutcastnet.com/blog/shoutcast-vs-icecast.php and https://www.cloudrad.io/help/shoutcast-vs-icecast-vs-hls); it adds listener auth and internal fixes. AzuraCast ships a derivative of Icecast-KH (per [S] https://opencollective.ecosyste.ms/projects/15603/commits?page=7). Sources disagree on which build is "the" standard, so plan for Icecast 2.4.x (Liquidsoap docs and its `icy_metadata` tests target 2.4.x, see Liquidsoap discussion below).
- **SHOUTcast DNAS v1** - legacy, not updated since ~2004 per [S] vendor blog. Still needed only for very old clients. Supports ICY 1.x sources.
- **SHOUTcast DNAS v2** - proprietary (Nullsoft/AOL lineage, now StreamSentry). Single binary, easy install, multi-stream in one instance (since v2.0), built-in directory connection via an "authhash" (free, must be kept secret), listener-side auth not documented in results [?]. Last documented server builds around 2.5.x (https://sc-mirror.shoutca.st/docs/DNAS_Server.html) [S]. Licensing: sources conflict on commercial use; verify before depending on it [?].
- Practical verdict: open-source self-host = Icecast 2.4.x. SHOUTcast only if directory listing via SHOUTcast directory is a hard requirement.

## 2. Icecast 2.4 configuration: the knobs that matter

Source: https://icecast.org/docs/icecast-2.4.1/config-file.html [V]

Global limits
- `<limits><clients>` default 100 (all connections incl. listeners, file and stats requests). Raise for production.
- `<sources>` default 2 (includes active relays).
- `<queue-size>` listener backlog; listeners lagging beyond it are dropped. Overridable per mount.
- `<burst-size>` default 65536 bytes (64 KB) pre-buffer sent at connect. Must stay below queue-size or connections fail. `burst-on-connect` is deprecated alias.
- `<header-timeout>` (example 15 s), `<source-timeout>` (example 10 s): drops a source that stops sending.
- `<client-timeout>` documented as unused.

Identity
- `<hostname>`: used for directory lookups and generated playlists when no Host header. Must be set to the public name.
- `<fileserve>` default 1 (static files from webroot).

TLS
- Listen socket: `<ssl>1</ssl>` + `<ssl-certificate>` (single PEM with key and cert, readable by icecast user). `<ssl-allowed-ciphers>` override exists, documented as "only if you know what you're doing".
- Note: Icecast's own TLS is one listen socket per port. Common production pattern is terminating TLS at nginx/Caddy or the CDN and proxying plain HTTP to Icecast on localhost (see Cloudflare section; SSL-through-reverse-proxy noted as "the hard part" in [S] https://lists.xiph.org/pipermail/icecast/2019-April/014574.html).

Auth (global)
- `source-password` (default source username "source"), `admin-user`/`admin-password`, `relay-user`/`relay-password`.

Directory (YP)
- `<yp-url>` supplied by the directory operator; multiple `<directory>` blocks allowed; `yp-url-timeout` (example 15 s).

Relaying (master/slave)
- `master-server`, `master-server-port`, `master-update-interval` (example 120 s), `master-username`/`master-password` (default "relay"), `relays-on-demand`.
- Relay mount block: `server`, `port`, `mount`, `local-mount`, `username`, `password`, `on-demand`.

Mount-level
- `burst-size`, `queue-size`, `max-listeners`, `max-listener-duration` (auth can override).
- Fallback: `fallback-mount` (same format, same server, chains allowed; can point to a webroot file that loops until stream returns; doc warns not to use file fallback on master streams because relays drift). `fallback-override` (returning source moves listeners back). `fallback-when-full` = 1 sends new listeners to fallback when max-listeners reached.
- `intro`: file sent to new listeners before live audio. Path relative to webroot, must match stream format (MP3 intro for MP3 mount, Ogg for Ogg mount). This is the standard "jingle before stream" feature.
- `public` (-1 = source decides, 0 = hide from YP, 1 = force list). `hidden` (1 = hide from status page). `no-yp` deprecated.
- `authentication type="htpasswd"` or `type="url"` per mount (see Section 9).
- `username`/`password` per mount source credentials (default username "source").
- Advertised metadata overrides: `stream-name`, `stream-description`, `stream-url`, `genre`, `bitrate`, `type`, `subtype`.
- ICY: `mp3-metadata-interval` (bytes between in-stream title blocks; applies to new listeners only); `charset` (non-Ogg assumed Latin-1 unless set); `relay-shoutcast-metadata` (on by default).
- Scripts: `on-connect` / `on-disconnect` (run program when source starts/ends; not on Win32).
- Headers: `<http-headers>` global (status attribute allowed) and per-mount (200 only). Default config sends `Access-Control-Allow-Origin: *`. Warning: do not put comments inside `<http-headers>`.
- Not covered by this doc: `limit-rate`, `mount-auth`. Check 2.4.4 docs for changes [?].

Pitfall to test: `<burst-size>` larger than `<queue-size>` silently breaks connections (doc warning [V]).

## 3. Icecast admin / stats API

Source: https://www.icecast.org/docs/icecast-trunk/admin_interface/ (search summary) [S], old admin docs [S].
- `/admin/stats` (XML; XSL transform powers web UI; stats for mounts, listeners per mount) [S].
- `/admin/listclients?mount=/x` (XML; needs admin or mount credentials) [S].
- `/admin/metadata?mount=/x&mode=updinfo&song=Artist - Title` (the `song` parameter drives StreamTitle; a `StreamTitle=` param reportedly did not work in a 2005 post) [S]. Verify on 2.4.x.
- No official JSON output [S]. You will need to parse XML or build a parser in the Node layer. Stats polling is a common Node-side task.
- Mount-specific admin calls accept either admin creds or the mount's own source creds [S].

## 4. Liquidsoap -> Icecast output and metadata

Sources: https://github.com/savonet/liquidsoap/discussions/4154 [V], https://www.liquidsoap.info/doc-dev/icy_metadata.html [S search summary].

- `output.icecast` has `send_icy_metadata` (null/true/false; default on for MP3, AAC, WAV; off for Ogg).
- `icy_song` parameter takes a function returning the string; returning null disables metadata.
- Three metadata layers (per maintainer answer): (1) connect-time fixed fields (icy-name, icy-url, icy-pub, icy-genre, icy-br) set once and not updateable; (2) updates the source client sends to Icecast; (3) what listeners receive. Icecast and listeners mostly use the derived `StreamTitle`.
- The `icy_metadata` list controls which fields go out in updates; for listener-visible change, `StreamTitle` (from artist/title or `song`) is what matters.
- Manual pushing: `icy.update_metadata` operator (params: host default localhost, port default 8000, user default source, password, mount). Set `send_icy_metadata=false` to avoid double sends. Note on request protocol: ICY for Shoutcast/Icecast 1, HTTP for Icecast 2.
- Ogg: in-band metadata via container; Ogg/FLAC metadata updates were reported to be ignored by one client and to disrupt playback [S], so test each target player.

## 5. HLS and DASH

### 5.1 Liquidsoap HLS output
Source: https://www.liquidsoap.info/doc-dev/hls_output.html [V].
- Operators: `output.file.hls` (since 1.4.0) writes segments and playlists to disk. `output.harbor.hls` serves HLS directly from Liquidsoap (same options plus `port`, `path`); docs do not recommend it for listener-facing scale, but it fits behind a CDN cache.
- Parameters: `streams` (list of (name, encoder) pairs; name generates each media playlist); `segment_duration` (example 2.0 s); `segments` (count in media playlist); `segments_overhead` (extra segments kept for lagging clients); `persist_at` (state file kept across restarts); `segment_name` (function receiving stream_name, duration, position, extname); `playlist` (e.g. live.m3u8); `on_file_change` (hook for pushing segments/playlists to S3 or similar).
- Segment formats: MPEG-TS, fragmented MP4, or packed audio (AAC, MP3, AC3, E-AC3). Only `%ffmpeg` produces MPEG-TS today per docs. fMP4 supported since 2.4.3 (per doc).
- Example encoder syntax from doc: `%ffmpeg(format = "mpegts", %audio(codec = "aac", channels = 2, ar = 44100, b = "96k"))`. For MP3 in HLS, format "mp3" with codec "libmp3lame" [V].
- Keyframes: Liquidsoap tries to split on keyframes and logs when it cannot; it forces split at target duration. For video set keyint; for audio-only it is not a concern [V].
- Timed metadata: `%ffmpeg` with mpegts routes metadata through a `timed_id3` logical stream. ID3 is used for adts, mp3, ac3, eac3 with %ffmpeg; natively with %mp3, %shine, %fdkaac. MP4 has no in-stream metadata support. Encoder options: `id3` (default true), `id3_version`, `replay_id3` (default true: latest metadata inserted at start of each segment) [V].
- Versions: 2.x examples omit `streams_info`; 1.4.x required `streams_info` (bandwidth/codec/extension) for %ffmpeg streams [S].
- Operational: `persist_at` is essential for restarts without listener-visible gaps (segment continuity).

### 5.2 HLS spec
- Apple HLS Authoring Spec page did not render for the fetch [?]; use RFC 8216 and the Apple spec directly.
- RFC 8216 rules that matter: EXT-X-TARGETDURATION >= longest segment rounded; EXT-X-DATERANGE requires unique ID and START-DATE (ISO 8601); END-ON-NEXT only with CLASS; X- prefix and reverse-DNS for custom attributes [S via Google Cast and Pantos draft references].
- Latency: HLS typical 15-30 s vs ICY 2-5 s per vendor source [S]. Shorter segments (2 s, low `segments`) reduce latency at cost of request load. Low-Latency HLS (LL-HLS, partial segments) is not documented in these results [?].
- Audio-only HLS renditions: use AAC (mp4a.40.2 for AAC-LC, mp4a.40.5 HE-AAC v1) and MP3 (mp4a.40.34) with BANDWIDTH/AVERAGE-BANDWIDTH per variant [S].

### 5.3 HLS timed metadata for ads and now-playing
- EXT-X-DATERANGE carries interstitial/ad markers and timed metadata; SCTE-35 attributes exist [S].
- ID3 PRIV frames inside TS audio carry now-playing text; in players it fires metadata events (JW Player, Cast HlsTimedMetadata) [S].

### 5.4 DASH
- Not researched in depth. DASH audio-only is rare in web radio; most radio apps use HLS or ICY. Recommend skipping DASH for v1 [?].

## 6. Codecs and bitrates (2025-2026 guidance)

- **Xiph Opus recommended settings** (most authoritative in results): 64-96 kb/s stereo for music streaming and radio, beats MP3/AAC/Vorbis at those rates; 24 kb/s for speech/audiobook/podcast (fullband). Source: https://wiki.xiph.org/Opus_Recommended_Settings [S-authoritative]. Client support is the caveat: many hardware players, car radios, and directories still lack Opus [S].
- **HE-AAC v2 (AAC+)**: parametric stereo; useful 16-48 kb/s; talk 24-64 kb/s; music 96-128 kb/s. Vendor rule of thumb: 96 kb/s AAC+ or 128 kb/s MP3 is the sweet spot for general web radio in 2026 [S, shoutcastnet and similar].
- **AAC-LC**: good music quality 96-256 kb/s [S].
- **MP3 128 kb/s**: universal compatibility, car radios and old hardware [S].
- **FLAC**: lossless, high bandwidth; no Icecast-specific guidance found; use only for archive/high-fidelity mounts [?].
- Recommended ladder for a station (rule-of-thumb, to validate with listening tests):
  - Primary, universal: MP3 128 kb/s stereo (ICY, widest compatibility), or AAC-LC 128 kb/s.
  - Mobile/data-saving: HE-AAC v2 48-64 kb/s (speech) or 64 kb/s (mixed).
  - Modern: Opus 96 kb/s (music) or 24-32 kb/s (talk), delivered as Ogg/Opus over Icecast, only where clients support it.
  - Low tier: MP3/AAC 32-48 kb/s for very poor links (talk only).
- Liquidsoap encoders: %mp3 (libmp3lame / shine), %fdkaac (HE-AAC v2 via fdk), %ffmpeg for mpegts HLS, %opus (ogg) built-in [S, Liquidsoap encoder docs; not fully verified this session].

## 7. Multi-bitrate and multi-mount strategy

- Icecast does not do adaptive bitrate. Each bitrate is a separate mount, each with its own source (or a relay of the master mount). Pattern: `/main.mp3` 128k, `/main-aac.aac` 64k, `/main-opus.ogg` 96k, `/mobile.aac` 48k.
- One encoder per format in Liquidsoap, fed from the same mixed source, so timing and metadata are identical across mounts (Liquidsoap `output.icecast` multiple times with one source, or one `output.icecast` per encoder).
- HLS variants: a master playlist with multiple `#EXT-X-STREAM-INF` (or audio `#EXT-X-MEDIA` groups) gives ABR. Liquidsoap HLS output takes multiple (name, encoder) pairs and produces per-variant playlists; a master playlist must be written by the app or by a separate step [?].
- Fallback chain per mount: primary -> fallback mount (same format) -> intro/loop file. Keep fallback mounts in the same format.

## 8. ICY metadata and HLS ID3 timed metadata

- ICY (SHOUTcast metadata protocol): listener sends `Icy-MetaData: 1`; server inserts a length byte plus `StreamTitle='...';StreamUrl='...';` every mp3-metadata-interval bytes (default 16000 is common; server-side config per mount). Charset: Latin-1 default in Icecast (utf-8 needs charset param) [V for charset note].
- StreamTitle is loosely defined; no reliable multi-field parsing. Use "Artist - Title" convention.
- Icecast admin metadata update is the only documented out-of-band route for live-updated titles; Liquidsoap `icy.update_metadata` covers the push side [S].
- HLS: ID3 TXXX/PRIV/TIT2/TPE1 frames in TS with segment-aligned metadata (replay_id3 default true). DATERANGE for longer-range events/interstitials.
- Recommended design: single canonical "now playing" event bus in the app (RabbitMQ or in-process), fan out to (a) Icecast admin metadata endpoint for ICY, (b) Liquidsoap ID3 via `%ffmpeg`/mpegts path for HLS, (c) a JSON now-playing endpoint for web/app clients. Icecast/ICY titles are not the source of truth.

## 9. Listener auth, tokens, geo-blocking

- Icecast 2.4 listener auth (per mount `<authentication>`): `htpasswd` (file-based basic auth) or `url` (Icecast calls an external endpoint with mount, IP, user; response header `icecast-auth-user: 1` default; configurable with `auth_header`). Source: https://svn.xiph.org/websites/icecast.org/docs/icecast-2.4.0/auth.html [S via search]. Auth applies to listeners, including those on intro/fallback streams [S].
- URL-auth is the hook for signed-token listener auth: your Node service validates a token passed as query or basic auth and returns 200/401. Keep tokens short-lived and never log them.
- Triton Secure Token pattern (industry reference): JWT/JWS signed with per-customer secret, short validity, access token named `tdtok`; keys per customer [S: https://help.tritondigital.com/docs/triton-digital-secure-token].
- Geo-blocking: commercial CDNs (Triton, Radio Mast) enforce it at the edge; no Icecast-native geo-block. Implement via: edge (Cloudflare Worker/CDN rule) or the Icecast URL-auth endpoint checking GeoIP. Licensing requirements often drive geo-block (e.g. CBAA-Triton streams) [S].
- Hotlink protection: signed URLs with expiry, and per-IP connection caps via `max-listeners`.
- Do not put personal data in stream URLs/query params (privacy).

## 10. CDN, relays, edge

- Icecast relays: master/slave via `<relay>`; relays-on-demand avoid pulling unused streams; relays add upstream load per relay link.
- Triton Media Relays accept only Icecast v2 sources; encoder settings must match Triton CDN config exactly; each source connects through a Triton-assigned DNS hostname [S: https://help.tritondigital.com/docs/direct-icecast].
- NetActuate and similar: Icecast relays on edge PoPs to reduce buffering [S].
- Cloudflare: generally does not cache live audio; use Cache Bypass rules for stream paths (`/radio/*`, `/listen/*`, `/hls/*`) (AzuraCast docs: https://docs.azuracast.com/en/administration/cloudflare) [S]. Cloudflare only forwards 80/443 for non-enterprise; non-web stream ports need a reverse proxy on 80/443 (AzuraCast/MediaCP stream proxy) [S]. Cloudflare Stream Live supports RTMPS/SRT/WHIP ingest with HLS/DASH delivery, not Icecast [S].
- Recommended for us: nginx (or Caddy) on 443 reverse-proxies `/stream/*` to Icecast on 127.0.0.1 with buffering off and long timeouts; HLS segments go to object storage or a CDN with cache-friendly TTL (segment TTL at least segment_duration x segments).

## 11. Intro files and fallback

- Icecast `intro` = file played before live audio for each new listener (per-mount) [V].
- Fallback mount in same format; `fallback-when-full` for overflow [V].
- Fallback to a file in webroot loops until the stream returns [V]. Keep one fallback per format.
- Liquidsoap-side fallback: `fallback([live, playlist])` with `track_sensitive=false` for source-level fallback; duplicate at the output so Icecast-side fallback is only a second layer [?].
- Ad insertion ready: HLS with DATERANGE / SCTE-35 markers; for Icecast, server-side ad insertion is done in Liquidsoap (break from playlist) so the stream stays a single continuous feed.

## 12. Directory submission

- **radio-browser.info** (open, community): anyone can add a station via POST /json/add; resolve all.api.radio-browser.info then use a mirror (e.g. de1.api.radio-browser.info) [S]. Requires descriptive User-Agent (appname/appversion) [S]. Voting limited to 1 per station per IP per 10 min; clicks aggregated once per station per IP per 24 h [S]. Official API docs not retrieved; request body fields not verified [?]. Also the best free open directory to seed and to query for our own station search.
- **TuneIn**: status contradictory (2020 says closed; 2025-2026 sources say accepting via Broadcaster Portal / TuneIn On Air, with 1-4 weeks manual review). Rejects podcasts as streams, intermittent streams, and duplicates of existing terrestrial listings (US/CA/UK terrestrial already listed) [S]. Image specs: 1200x1200 logo and 1024x300 cover (conflicting numbers in sources; use TuneIn's own) [S]. AIR API needs partner ID/key from TuneIn; station ID is the s###### code [S]. Verify on https://tunein.com/broadcasters/api/ before planning.
- **Radioline**: distribution to 90k+ stations claimed; feeds smart TVs, connected cars, partner apps; submit via contact form or free account [S]. Requirements not verified.
- **Radio.net**: Germany-based, 60k+ stations, submission form, no criteria found [S].
- **RadioKing/RadioCult/CloudRadio directory lists**: community-ranked lists of 2026 directories [S].
- **iHeartRadio**: requires FCC call letters; internet-only excluded at time of source [S].
- **Smart speakers and car**: Alexa, Google Assistant, and most voice catalogs ingest via TuneIn or Radioline-style aggregators, not direct submission [S]. CarPlay and Android Auto integrate at the app level (media session), not via a public stream directory [S]. Apple Music / Podcasts radio requirements not found [?].
- Directory checklist (for our product): stream URL (direct, stable, no redirect loops), station logo, description, genre, country, language, contact, website, stream bitrate and codec metadata, licensing ID (SoundExchange / SOCAN / PRS / GEMA as applicable) [S].

## 13. DAB+ / FM feed (where webradio joins broadcast)

- ODR-AudioEnc (Opendigitalradio): DAB and DAB+ encoder for ODR-mmbTools; input via libVLC (-v) or GStreamer (-G), so an Icecast/HTTP URL can be the source; output EDI and ZMQ compatible with ODR-DabMux [S: https://mpb.li/git/ODR-AudioEnc/plain/README.md]. Supports DLS text via `-w` ICY-Text file read by ODR-PadEnc (not reliable for all Ogg sources) [S]. Clock drift compensation `-D` for webstreams with slightly wrong bitrate [S].
- Example: `odr-audioenc -G $URL -r 32000 -c 2 -e $DST -l -b $BITRATE` [S].
- FM: webradio does not typically feed FM directly; broadcast chains use an audio feed (AES/AoIP/Livewire/Dante or a stream to a broadcast chain) into a processor and exciter. Not researched further [?].
- Practical path for us: Liquidsoap -> Icecast (or direct to ODR-AudioEnc via a local TCP/ZMQ feed) -> DAB+ mux. Test with ODR-AudioEnc drift compensation.

## 14. Bandwidth math and scaling

- Formula: upstream per Icecast = bitrate x listeners x overhead. Overhead factor 1.1-1.2 for TCP/IP and Ethernet [S, 2013 list post]. Bitrate from codec settings is a floor; MP3 is often understated; VBR should be planned on average bitrate with peak headroom [S].
- Examples:
  - 128 kb/s x 1,000 listeners = 128 Mb/s, x1.15 = ~147 Mb/s upstream from origin (no relay).
  - 64 kb/s x 10,000 = 640 Mb/s, x1.15 = ~736 Mb/s.
  - 48 kb/s HE-AAC x 10,000 = 480 Mb/s, x1.15 = ~552 Mb/s.
  - Transfer volume: 128 kb/s = 57.6 MB per listener-hour. 1,000 listeners x 1 h/day x 30 days = ~1.73 TB/month.
- Ceiling anecdote: vanilla Icecast reported degrading around ~24,000 listeners on one server (Rocket Broadcaster 2021 benchmark, not retrieved in full) [S]. Plan: relay tier + CDN before 5-10k concurrent.
- Anecdote: ~40 listeners per Mb/s at 32 kb/s (2011) [S].
- HLS: bandwidth per listener similar to bitrate, plus HTTP overhead per segment; CDN offload is the scaling lever.

## 15. Other notes

- Icecast `clients` limit default 100 - production must raise it (in config, first thing to check on incident) [V].
- Stats via `/admin/stats` and `/admin/listclients` (XML) - needs parsing layer [S].
- Liquidsoap/Icecast: avoid burst-size > queue-size [V].
- AzuraCast: HLS available via web UI since a recent Rolling Release; enabled from AutoDJ tab, sub-streams configured under Broadcasting [S]. Relays with per-relay listener counts not readily exposed (feature request for load balancer) [S].
- LibreTime: concurrent capacity limited by bandwidth; no HLS story found [S].

## 16. Player embeds

- HTML5 `<audio>` with `preload="none"`, Icy-MetaData handled by server, HLS via hls.js on non-Safari (Safari native) [?, widely known; not verified here].
- Embeds: iframe player with CORS `Access-Control-Allow-Origin` header (Icecast default is `*`, see Section 2) [V].
- Now-playing JSON endpoint (our own) for embeds, polled every 10-15 s, not ICY parsing in browsers.

---

## Feature checklist for our product

### Must
- Icecast 2.4.x mounts per format: MP3 128k, HE-AAC v2 48-64k (mobile) or AAC-LC 96-128k, Opus Ogg 96k (opt-in per client support).
- Per-mount `burst-size` < `queue-size`, `max-listeners`, `fallback-mount` in same format, `fallback-when-full`, `intro` file per mount.
- Raise and monitor `<clients>` and `<sources>` limits; `source-timeout`, `header-timeout`.
- TLS termination at reverse proxy (nginx/Caddy) on 443; Icecast listens on loopback; cache-bypass rules for stream paths behind any CDN.
- Canonical now-playing model in the app; push to Icecast via `/admin/metadata` (`song`) and to Liquidsoap ICY via `icy.update_metadata`; per-mount `send_icy_metadata`.
- Listener auth via Icecast URL-auth endpoint (token validation by our Node service); short-lived tokens; no PII in URLs.
- Per-tenant mount namespace (`/tenant/station/format`) and per-tenant source password; admin creds never shared with tenants.
- Stats poller (Node) reading `/admin/stats` and `/admin/listclients` (XML parse) into the DB; listener counts per tenant/mount.
- HLS output via Liquidsoap `output.file.hls` (AAC mpegts, 2 s segments, `persist_at`, `segments_overhead`), plus a master playlist written by us.
- Bandwidth/quota guardrails: per-tenant listener cap and monthly transfer estimate using the formula above.
- Liquidsoap fallback chain (live -> playlist/jingle -> silence) so Icecast never has an empty source.
- Directory: submit to radio-browser.info via POST /json/add (with descriptive User-Agent); pre-fill station metadata (name, URL, genre, country, language, bitrate, codec, logo, website, contact).

### Should
- HLS ladder: AAC 64k and 128k variants with a master playlist; ID3 now-playing via `%ffmpeg` mpegts `timed_id3`; `replay_id3` default on.
- Opus Ogg mount (96k music / 24-32k talk) with client-compat warnings in UI.
- Geo-blocking rule per tenant via URL-auth GeoIP check or CDN rule; sensible default off.
- Stream health monitor: source connected? bitrate within tolerance? silence detection; alert via RabbitMQ.
- TuneIn submission workflow (manual, per tenant, track status) - check current acceptance first.
- Radioline and Radio.net submission workflow via tenant form (manual).
- ICY and HLS embed snippet for tenant websites (iframe + JSON now-playing).
- Relay node support (Icecast master/slave) for scaling beyond one VPS.

### Could
- DAB+ feed via ODR-AudioEnc with EDI output to ODR-DabMux (for a tenant with broadcast licence).
- Icecast URL-auth backed by signed JWT (Triton-style `tdtok`).
- LL-HLS partial segments for lower latency (not researched).
- DASH output (low value for audio radio).
- Ad-insertion markers in HLS (EXT-X-DATERANGE) and SCTE-35.
- FLAC archive mount.
- Smart speaker/CarPlay/Android Auto integration via aggregators (TuneIn/Radioline) only.

---

## Liquidsoap implementation notes

- Use one source per station, feed multiple encoders:
  - `output.icecast(%mp3(bitrate=128), host=..., port=8000, mount="/t/s/main.mp3", password=..., send_icy_metadata=true, icy_song=..., fallible=true, on_connect=..., on_disconnect=...)` (exact arg names: verify on liquidsoap.info reference for the pinned version).
  - Second `output.icecast` with `%fdkaac` (HE-AAC) and third with `%opus`.
- Fallback: `fallback(track_sensitive=false, [live, playlist, blank])` at source level; `fallible=true` on outputs.
- Metadata: set `title`/`artist` on tracks; `icy_song` for custom "Artist - Title" string; `icy.update_metadata` for on-demand pushes; `send_icy_metadata=false` if you push manually to avoid doubles.
- HLS: `output.file.hls(streams=[("aac96", %ffmpeg(format="mpegts", %audio(codec="aac", channels=2, ar=44100, b="96k")))], segment_duration=2.0, segments=10, segments_overhead=5, persist_at="...", playlist="live.m3u8", directory="...", ...)`. Check 2.5.x signature; `streams_info` only needed on 1.4.x.
- `persist_at` for restart continuity; `on_file_change` to push to S3/object storage for CDN.
- Keep HLS keyframe alignment in mind for video only; audio-only segments split at target duration.
- Pin the Liquidsoap version (2.2.x vs 2.4.x vs 2.5.x) because HLS option names and fMP4 support changed.

---

## Gaps and things to verify before design freeze

- TuneIn current acceptance status and AIR API terms.
- Radioline and Radio.net submission fields.
- Icecast 2.4.4 admin JSON (none; XML only).
- Apple HLS Authoring Spec numbers (not retrieved).
- LL-HLS and DASH (not researched).
- Opus client support matrix for car radios and smart speakers.
- Shoutcast licensing for commercial use.
- Geo-blocking enforcement mechanics at Triton edges.
- Radio-browser.info full POST /json/add body and response format.

## Sources (inline above; key ones)

- https://icecast.org/docs/icecast-2.4.1/config-file.html
- https://svn.xiph.org/websites/icecast.org/docs/icecast-2.4.0/auth.html
- https://www.liquidsoap.info/doc-dev/hls_output.html
- https://github.com/savonet/liquidsoap/discussions/4154
- https://www.liquidsoap.info/doc-dev/icy_metadata.html
- https://wiki.xiph.org/Opus_Recommended_Settings
- https://help.tritondigital.com/docs/triton-digital-secure-token
- https://help.tritondigital.com/docs/direct-icecast
- https://docs.azuracast.com/en/administration/cloudflare
- https://mpb.li/git/ODR-AudioEnc/plain/README.md
- https://sc-mirror.shoutca.st/docs/DNAS_Server.html
- https://www.shoutcastnet.com/blog/shoutcast-vs-icecast.php (vendor, biased)
- https://www.cloudrad.io/help/shoutcast-vs-icecast-vs-hls
- https://lists.xiph.org/pipermail/icecast/2019-April/014574.html
- https://lists.xiph.org/pipermail/icecast/2005-July/009619.html (bandwidth)
- https://www.rocketbroadcaster.com/help/icecast-vs-shoutcast
- https://tunein.com/broadcasters/api/
- https://broadcaster-help.tunein.com/ (rejection reasons)
