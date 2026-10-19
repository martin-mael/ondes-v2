# 05 - Live shows and remote contribution

Scope: how DJs and presenters go live on a webradio, how the live feed hands over to automation and back, recording, metadata, remote guests, codecs and studio AoIP. Research pass done 2026-10-19 from web sources. Confidence notes are inline. Gaps are listed at the end.

---

## 1. Professional practice (how stations do it)

- **Live-to-automation chain**: every broadcast chain has a "live-assist / automation" split. Automation plays the log; a live source (studio console, codec, or a DJ software over IP) is fed into a priority switcher that drops automation for the duration of the live segment and returns to automation at the end (in broadcast terms: "air chain", "ducking", "take/return"). Real stations also keep a "last-resort" source (silence, a jingle loop, or an emergency file) in the bottom of the chain.
- **Live-assist vs. voice-tracking vs. automation**: live-assist = presenter starts each item manually from a playlist; voice-tracking = presenter records links in advance and automation plays them between music; automation = fully unattended log. mAirList explicitly supports switching a playlist between live-assist and automation modes at any time (https://mairlist.com/en/products/radio-automation).
- **Air-check / aircheck**: recording of the on-air program for compliance, quality control and programme review. Rivendell calls its recorder RDCatch (https://www.radioworld.com/?p=59741 and https://lwn.net/Articles/63641/ for context). mAirList has an "Aircheck Recorder" module that records a soundcard input (search snippet only, not fully verified).
- **Terminology to reuse**: source client (the DJ's encoder), mount point (Icecast stream path), harbor (Liquidsoap input port for source clients), contribution (studio/remote to playout), distribution (playout to listeners), IFB (interruptible foldback, the audio a remote guest hears of the studio), mix-minus / clean feed (the studio mix without the remote guest, to prevent echo), hybrid (telephone-to-audio interface), codec pair (two codec units that talk to each other over IP), talkback (private intercom from control room to talent), tally (on-air light).
- **Mix-minus is mandatory for any remote guest**: the guest must not hear their own voice delayed back. Vendor guidance (Comrex, Tieline, Sonifex) is to build a dedicated mix bus without the guest; many consoles have one, otherwise use a spare group/aux output. A common fault is a studio output knob that feeds the board back to the codec (https://www.comrex.com/wp-content/uploads/2018/01/Mix-Minus-and-eliminating-Echo.pdf, https://tieline.com/configuring-mix-minus-feeds/, https://www.sonifex.co.uk/company/logos-images/catalogues/redbox-singlepages/rb-mm1.pdf).
- **Remote guests in practice**: audio-only, browser-based guest tools (Cleanfeed, Riverside, SquadCast, Zencastr) are used for podcast and interview work because they record each participant locally. For live radio the bottleneck is the guest's connection and microphone, not the platform (https://www.quillpodcasting.com/blog-posts/top-remote-recording-softwares-for-podcasters, https://www.provideocoalition.com/cleanfeed-much-better-than-zoom-us-for-48-khz-remote-audio-recordings-or-live-broadcast/). Pro studios use dedicated codec hardware or Source-Connect instead (search gave little data on Source-Connect).
- **Latency reality**: conversation feels unnatural above ~150 ms one-way (Zoom's own stated target, cited in https://www.provideocoalition.com/cleanfeed-much-better-than-zoom-us-for-48-khz-remote-audio-recordings-or-live-broadcast/). Internet-stream listeners add 5-10 s or more of player buffer, so the studio and the stream are never in sync. Stations accept that and use the stream delay only for listeners.
- **Compliance**: keep a log of every live source, every switch and every recorded program segment; keep recordings for the regulator's required period (country-specific; not researched here).

## 2. Open-source tools and their live mechanics

### 2.1 Liquidsoap (the engine behind AzuraCast and most open stacks)

Verified from the Liquidsoap 2.3.3 docs and cookbook (https://www.liquidsoap.info/doc-2.3.3/harbor, https://www.liquidsoap.info/doc-2.3.3/cookbook.html).

- **input.harbor("mount", port=..., user=..., password=..., buffer=..., icy=..., auth=...)**: listens for Icecast (and optionally ICY/Shoutcast) source clients. The source is *fallible*: available only while a client is connected.
  - `auth` is a function `{user, password, address}` returning bool.
  - Shoutcast/ICY clients on a custom port `n` must connect to `n+1` (quirk).
  - Mount points are scoped per port.
  - `input.harbor.dynamic` detects the format at connect time (dev docs; not fully verified here).
  - `buffer=3.` (seconds) is the documented example for faster reconnect after an unstable link.
- **Global settings** (`liquidsoap --list-settings`): `harbor.bind_addr` (default "0.0.0.0"), `harbor.timeout` (30 s), `harbor.verbose` (logs source passwords, leave off), `harbor.reverse_dns` (true), `harbor.icy_formats`. SSL via `harbor.ssl.certificate`, `harbor.ssl.private_key`, `harbor.ssl.password`. Note: the 2.x docs example uses `settings.harbor.bind_addrs := [...]` while the list says `harbor.bind_addr`; check the exact version you install.
- **Live takeover**: `fallback(track_sensitive=false, [live, playlist, emergency])` switches to the live source as soon as it connects, without waiting for the current track to end. Without `track_sensitive=false` the switch waits for the track boundary (documented, cookbook).
- **Silence-aware switching**: `blank.strip(input.http(...))` makes a source unavailable during silence; wrap the normal programme with `blank.strip` too, so the fallback can flip when the live feed is quiet. Tune `threshold` and `length` (1.4.x names: `strip_blank`, `skip_blank`).
- **Transitions**: `fallback(transitions=[to_live, to_playlist], ...)` lets you plug a function per direction. The RadioPi example does fade-out/fade-in and says it does NOT skip the current song because reloading sources at live start is CPU-expensive (https://www.liquidsoap.info/doc-2.2.5/radiopi). The cookbook shows a "play 5 s silence when leaving harbor" pattern using `append` + `source.skip()` to avoid a hard cut into the playlist.
- **Recording**: `output.file(%mp3, {time.string("/archive/%Y-%m-%d/%H_%M_%S.mp3")}, s, reopen_when={0m})` gives hourly segment files; `reopen_on_metadata=true` starts a new file on each metadata change, which is useful for per-track archives. Cookbook suggests a `thread.run` job to purge archives older than 31 days. No `record` operator is documented on that page.
- **Metadata**: the Icecast source sends metadata on the source connection; Liquidsoap exposes it through source callbacks (`on_metadata`, `on_connect`, `on_disconnect`). 2.5.0-rc1 changed callbacks to return a release method so they can be unregistered (https://newreleases.io/project/github/savonet/liquidsoap/release/v2.5.0-rc1). 2.4.6 made `output.harbor` clients receive ICY metadata when they request it (https://newreleases.io/project/github/savonet/liquidsoap/release/v2.4.6).
- **Known gap I could not verify**: exact behaviour of `on_metadata` on a harbor source that drops mid-track. Test before relying on it.

Version pitfalls: 1.4.x vs 2.x renamed `strip_blank`/`skip_blank` to `blank.strip`/`blank.skip`; `set("harbor.bind_addr", ...)` became settings-based.

### 2.2 AzuraCast (Docker-based, Liquidsoap-driven)

- **Streamer / DJ accounts**: enabled per station ("Enable Streamers"); creating accounts needs the "Manage Station Streamers" permission (https://azuracast.com/docs/en/user-guide/streamers-and-djs, fetched via redirect).
- **Connection**: DJ software connects directly to Liquidsoap (via Icecast or Shoutcast source protocol). The docs state this gives a "seamless transition" between live DJ and AutoDJ. They do NOT document an explicit priority or buffer. Live connection details (host, port, mount, login) are in the streamer's connection info page; the mount is often just "/" for Shoutcast clients.
- **Broadcast history per DJ**, and **recording** enabled in the station profile (format and bitrate chosen there), with downloads from each streamer's "Broadcasts" menu.
- **Scheduling of streamers**: not in official docs. A third-party guide claims allowed days/time can be set; I could not confirm it. A feature request "Allow streamer/DJ to schedule themselves" was in the AzuraCast feedback board and not implemented at last check (https://features.azuracast.com/suggestions/100312/allow-streamerdj-to-schedule-themselves). Treat self-scheduling as a gap.
- **WebDJ**: built-in browser DJ tool (Streamer/DJ account, mic + two decks, load tracks from the media library, switch between mic and deck audio, needs mic permission). Guides: https://onlineaudience.co.uk/blog/how-to-broadcast-live-using-azuracast-web-dj and https://help.streamerr.co/article/using-the-webdj/ (the latter is from 2021). Transport is NOT confirmed. The netactuate listing only says browser audio goes out over Icecast/SHOUTcast. Do not assume WebRTC without checking the source.
- **Known complaints (from issue titles and feedback board, not read in full)**:
  - "Playlist AutoDJ mixed up after LIVE programme" (AutoDJ queue gets scrambled after a live show).
  - "Recording Lost after DJ Disconnected" (recording not flushed on disconnect).
  - "Live DJ Streamer not detected".
  - Feature request: AutoDJ should not jump back to the previous song when the live DJ stops; still open for ~5 years per the comment on the board.
  - Feature request: "Automatically Record Live DJ Streams" (https://features.azuracast.com/suggestions/38931).
  - Feature request: better cross-fade for interrupting playlists (https://features.azuracast.com/suggestions/56517).
  - 0.20.3 fixed a bug where the "Live Connected" webhook fired on disconnect (https://www.client.magicstreams.services/announcements/147/AzuraCast-0.20.3-Nov-17-2024.html).
- Source of issue list: https://opencollective.ecosyste.ms/collectives/azuracast/issues (titles only).

### 2.3 LibreTime (Airtime fork, PHP + Liquidsoap)

- **Live input**: Mixxx 1.9.0+ (Icecast 2 in Live Broadcasting prefs) or BUTT 0.1.17+ (Icecast server type, port 8002, mount `/show`). Source: https://libretime.org/docs/user-manual/live-broadcast/.
- **Two live sources**: "Show Source" (scheduled show) and "Master Source" (station-wide). Toggle on the Source Streams panel; grey = not connected, orange "Live Show" = connected.
- **Auto-connect** is a per-station setting. Scheduling is in the calendar; the docs do not describe handover in detail.
- **BUTT** can record locally to MP3 (date/time name, saved in home dir) (same doc).
- **Known complaints**: "Hand Over Dead Air Issue" thread: 5-7 s silence between DJs at handover; the community workaround is an underlying bed track. "Disconnection time" thread (https://discourse.libretime.org/t/hand-over-dead-air-issue/861 and https://discourse.libretime.org/t/disconnection-time/1362).

### 2.4 Rivendell (GPL, Linux, mature, desk-oriented)

- Live-assist and walk-away playout; RDCatch automatic recorder for incoming feeds; voice tracker chapter in the 0.9.x manual; airchecking. Caveat: Linux-centric; latest dev status not verified. Sources: https://www.radioworld.com/tech-and-gear/free-rivendell-is-on-version-20, https://www.radioworld.com/?p=59741.

### 2.5 Mixxx (DJ software)

- Built-in Live Broadcasting (Icecast 2 / SHOUTcast); Ogg Vorbis output is recommended for AzuraCast/Liquidsoap because Mixxx does not ship the LAME MP3 encoder; Liquidsoap transcodes. Oriented to music DJs, works for speech shows with manual playout. Sources: LibreTime and AzuraCast guides above.

### 2.6 Icecast metadata push (applies to any source, including Liquidsoap)

- Admin GET endpoint with `mode=updinfo`, `mount`, `song` (plus `+` for spaces, Artist first), auth via the admin or source credentials. Source client or external program can call it.
- Limits from old docs: only song title; historically MP3-only; Ogg needed a build flag in 2004-era threads. Verify on your Icecast version.
- Requests from a different IP than the source can be rejected.
- "Source does not exist" = wrong mount name. Test with curl and `--user admin:password`.
- Source: https://icecast.org/docs/icecast-2.0.2/admin-interface.html, https://lists.xiph.org/pipermail/icecast/2004-October/007696.html.

## 3. Source clients (what DJs use to go live)

| Client | Protocol to Icecast/SHOUTcast | Notes |
|---|---|---|
| BUTT (Broadcast Using This Tool) | Icecast or Shoutcast mode; Shoutcast mode adds 1 to port | Built-in local recording (MP3). Min 0.1.17 for LibreTime. Icecast mode recommended by AzuraCast. |
| Mixxx | Icecast 2 | Ogg Vorbis recommended. No LAME in build. |
| OBS | SRT or RTMP, not native Icecast | OBS SRT latency default 120 ms (120 000 us); set at least 2.5x RTT. Needs a relay to get into Icecast (inference, not confirmed). |
| Traktor / Rekordbox / Serato | Not researched in depth | Generally via Icecast/Shoutcast plug-in or an external encoder (BUTT, Icecast-Source) |
| Browser WebDJ (AzuraCast) | Browser to server, transport unconfirmed | Needs mic permission. |

## 4. Transport and codecs (contribution and IP studios)

- **Icecast/Shoutcast source protocol**: TCP, HTTP-like PUT/SOURCE. Simple, but no loss recovery and encoder-side buffer; end-to-end delay is dominated by the listener buffer.
- **SRT** (Secure Reliable Transport): UDP with ARQ (NACK + ACK), point-to-point, encryption. Tunable receive latency (default 120 ms). Strong at low-medium loss (OBS wiki cites ~15%). Good endpoint availability. Sources: https://obsproject.com/wiki/Streaming-With-SRT-Or-RIST-Protocols, https://www.thebroadcastbridge.com/content/entry/21937/network-traffic-engineering-rist-srt-the-success-of-arq-based-protocols.
- **RIST** (VSF-defined profiles): UDP with NACK-only ARQ, multicast and multi-link, better on bad links (claims up to 55% sustained loss, 86% short term; vendor/test-dependent). Better for formal interoperability. Source: https://www.sportsvideo.org/2026/06/17/bbright-white-paper-srt-vs-rist-for-professional-video-contribution-and-distribution/.
- **Audio-first codecs on hardware**:
  - Telos Zephyr/IP: AAC-ELD default since 2008, usable down to ~24 kbps, excellent at 64 kbps+, on-the-fly bitrate change, tolerates up to 20% packet loss (vendor claim, https://www.radioworld.com/?p=71730). Telos ACT senses network conditions and adapts (https://www.radioworld.com/?p=6127 area).
  - Telos Z/IPStream 9X/2: AAC-LC, HE-AAC v1/v2, MP3 (Fraunhofer); not Opus (https://www.radioworld.com/?p=29772).
  - Comrex ACCESS: AAC (~69 ms coding delay per Comrex chart) and HE-AAC (~146 ms); best on non-constrained networks (https://www.comrex.com/resources/algorithm-chart).
  - Comrex BRIC-Link: Opus modes ~41 ms coding delay; Opus included mainly for WebRTC/softphone compatibility.
  - Tieline: Opus Voice 9.6-64 kbps (speech) and Opus Stereo 64-256 kbps; AAC-LD recommended at 96 kbps+ for stereo; AAC-ELD v2 better than v1 below 48 kbps stereo (https://tieline.com/manuals/TLR5200D/en/v2_14/selecting_an_algorithm.htm). Vendor claim: Opus beat AAC-ELD in blind tests (not independent).
  - 2wcom matrix: AAC-ELD 24-128 kbps, ~20-32 ms algorithmic delay (https://www.2wcom.com/wp-content/uploads/2wcom_Audio_Codec_Matrix.pdf).
  - OBE article claims Opus ~ MP2 quality at 96-128 kbps and usable at 32 kbps (https://www.obe.tv/?p=6980). Single-source.
- **Practical rule (from vendor material)**: speech contribution at 24-64 kbps with a low-delay codec (AAC-ELD or Opus voice); music/stereo at 96-128 kbps+. Tune buffer vs loss tolerance; both SRT and RIST expose a latency buffer.

## 5. Remote guests and multi-host shows

- Remote guest options: Cleanfeed (browser, guest needs no install, speech 48 kHz, multitrack on paid Pro tier; one review says Pro about $36/mo, verify), Riverside (local multitrack recording, video), SquadCast and Zencastr (local recording). Zoom: hidden 48 kHz mode (music focus), sensitive to Wi-Fi (https://www.provideocoalition.com/cleanfeed-much-better-than-zoom-us-for-48-khz-remote-audio-recordings-or-live-broadcast/).
- Pro path: codec hardware (Comrex, Tieline, Telos) with mix-minus and IFB; or Source-Connect (not researched in depth).
- **Multi-host live**: each host needs their own feed into the mixer (either console channels or a software mixer). Liquidsoap can mix multiple harbor inputs with `add` or `sum`; no standard "multi-DJ" UI in AzuraCast/LibreTime (presumed; not verified).

## 6. AoIP in radio studios

- **AES67**: transport standard (24-bit, 48 kHz, 1 ms packets as the minimum interop baseline). Defines transport and sync only; discovery/control is left to vendors. Source: https://blogs.telosalliance.com/understanding-the-implications-of-aes67-and-livewire-aes67-on-the-aoip-market.
- **SMPTE ST 2110-30**: AES67-based audio for broadcast/video.
- **Dante (Audinate)**: discovery and control, AES67 mode, ST 2110 compatible, Dante Domain Manager for broadcast (https://go.audinate.com/hubfs/campaign/DDM/broadcast/audinate-dante-domain-manager-broadcast-aes67-smpte-2110-interoperability-wp.pdf).
- **Livewire+ (Telos)**: AES67 compatible; NAB 2017 demos with AES67 gear (https://blogs.qsc.com/systems/?p=275 for context).
- **WheatNet-IP** (Wheatstone): proprietary AoIP.
- **Gateways**: Tieline Gateway codecs bridge Livewire+, WheatNet-IP and AES67/ST 2110-30; support NMOS IS-04 and IS-05 for discovery and control (https://tieline.com/livewire-added-to-gateway/).
- **Caveat**: most sources are vendor or trade-body; several are 2017-2019. No independent radio-studio head-to-head found.
- **For our product (not a studio)**: AoIP is out of scope; the relevant boundary is an AES67-capable or Icecast/SRT input. If a station has a studio, the studio hardware talks to our platform through an encoder (Icecast source or SRT).

## 7. Commercial vs open-source: what paid tools do that OSS usually does not

Paid/pro tools named in the brief (RCS Zetta, WideOrbit, ENCO, PlayoutONE, StationPlaylist, RadioBOSS, SAM Broadcaster, Jazler, OnAir/Aeron, Radio.co, RadioKing, Live365, Triton) were not deeply researched in this pass. What I did confirm:

- **mAirList**: live-assist and automation playlists switchable at any time; Aircheck Recorder on soundcard input (https://mairlist.com/en/products/radio-automation).
- **RadioBOSS**: Windows automation, broadcast recording and live streaming (directory description only).
- **SAM Broadcaster**: automated and live broadcasting, live DJ mixing, PAL scripting, scheduling and licensing reports (directory description only).
- Hardware/codec vendors (Comrex, Tieline, Telos) provide the remote, mix-minus and AoIP gear, which OSS does not cover.

Typically paid tools have (from general industry knowledge, verify before publishing): true broadcast-grade failover with redundant playout servers; hardware-integrated talkback and tally; phone hybrids with on-air caller screening; integrated music licensing and royalty reporting (SoundExchange, PRS, etc.); regulated logging; GPIO and hardware control; per-DJ clocks and rotation rules; voice-track workflows with headless recording; RDS/DAB metadata injection. Each is a candidate "should" for our product (see section 9).

## 8. Gaps and unknowns

- **WebRTC for AzuraCast WebDJ**: not confirmed. The claim is unverified.
- **Live-to-automation handover dead air**: documented in LibreTime (5-7 s) and reported in AzuraCast issues. A "bed" track workaround is common. Exact timing vs Liquidsoap settings not measured.
- **Per-streamer scheduling in AzuraCast**: not in official docs; feature request still open.
- **Liquidsoap `on_metadata` on a dropped harbor source**: needs testing.
- **Telos Zephyr Opus support in 2025-2026**: not confirmed.
- **Source-Connect**: barely researched.
- **Paid tools feature detail**: not researched; list in section 7 is from general knowledge.

---

## 9. Feature checklist for our product

### Must (MVP, live contribution)

- DJ/presenter accounts with a per-show source credential (Icecast source user/password per mount).
- Icecast/Shoutcast source endpoint (Liquidsoap `input.harbor`), one mount per live slot or per DJ, with `auth` callback validating against our database.
- Automatic fallback: `fallback(track_sensitive=false, [live, playlist, emergency])` so the switch to live is immediate and the return to automation is clean (no mid-track cut on the live side; decide policy for returning mid-track).
- Dead-air protection on handover: a short silence or jingle when leaving the live source (cookbook pattern), and a configurable "bed" track.
- Live-source health: detect connect/disconnect (`on_connect`, `on_disconnect`) and push events to the app through RabbitMQ.
- Scheduled live slots: calendar with start/stop; auto-connect expectation; "go live" status for the DJ; reminders before start (email or in-app).
- Ad-hoc live: a DJ can connect outside a slot, with an admin override to take it or refuse it.
- Automatic recording of every live show (Liquidsoap `output.file` with time-based naming and `reopen_when`), stored per show, with retention policy (cookbook suggests 31 days default; make it configurable).
- Live metadata: DJ sets now-playing title; push to Icecast via `mode=updinfo` or via Liquidsoap source metadata; store history.
- Browser-based DJ connection info page: host, port, mount, login, and copy-paste settings for BUTT, Mixxx, OBS (note the Shoutcast port+1 gotcha).
- Live stream stats: listeners, source bitrate, connection state, last metadata.
- Auth and per-DJ permissions (only DJs assigned to a show can connect to its mount).
- Logs of every live source switch with timestamps (compliance).

### Should

- Browser WebDJ (in-browser mic + decks) for DJs without a desktop encoder (AzuraCast-style). Verify transport first (WebRTC vs Icecast over WebSocket).
- Multi-host show: several DJs share a live slot; define who is on-air (priority or PTT-style "push to talk" via the app).
- Telephone or remote guest integration: start with third-party (Cleanfeed, Riverside) and feed their output into a harbor or SRT ingest; avoid building our own WebRTC mixer in MVP.
- SRT ingest option (Liquidsoap `input.srt` or relay, or a dedicated SRT gateway) for studios with IP codecs.
- Mix-minus guidance in the DJ/studio help: a short document on how to avoid echo with remote guests.
- Talkback/cue: a private channel from producer to DJ (e.g., a second Icecast mount). Lower priority.
- Per-show recording download, with waveform preview; podcast export (RSS) from a recorded show.
- Voice-tracking: record intros in advance, auto-insert between music (Rivendell and mAirList both have this).
- Priority rules: admin can override live sources, mute or kick a DJ.
- Webhooks for live start/stop (AzuraCast-style "Live Connected" event). Be careful about firing on disconnect (AzuraCast bug fixed in 0.20.3).

### Could

- Live-assist mode in the browser (DJ starts each item from a playlist manually).
- Scheduled guest-invite flow with a link and a consent step.
- AES67 or AoIP ingest (out of scope unless a studio customer needs it).
- Silence detection and alerts (blank.strip thresholds) surfaced to admins.
- Chat or listener call-in integrated with live shows (phone hybrid; needs telephony vendor).
- Automatic "on-air now" widget with show artwork and DJ bio.
- Multi-codec output per show (Opus, AAC, MP3) via Liquidsoap encoders.

---

## 10. Liquidsoap implementation notes

Versions: target Liquidsoap 2.x. Settings use `settings.harbor.*`. Verify exact names with `liquidsoap --list-settings` on the installed build.

Skeleton (adapted from the 2.3.3 cookbook; treat as a sketch, not tested in this pass):

```liquidsoap
settings.harbor.bind_addrs := ["0.0.0.0"]

emergency = single("/srv/ondes/emergency.ogg")
playlist  = playlist("/srv/ondes/playlists/default.m3u")

live = input.harbor(
  "live",
  port=8080,
  password="...",          # replace by auth callback in prod
  buffer=3.,
  icy=true
)

radio = fallback(track_sensitive=false, [live, playlist, emergency])

output.icecast(
  %mp3(bitrate=128),
  mount="stream",
  host="...",
  port=8000,
  password="...",
  radio
)
```

Notes:

- `track_sensitive=false` is the main switch; without it the live source waits for the track boundary.
- Use `auth=` (function returning bool) to validate DJs against our database rather than a shared password.
- Use `on_connect` / `on_disconnect` on the harbor source to publish live state to RabbitMQ.
- For a handover silence or bed track, use `append` and `source.skip()` (cookbook "Play a short silence when transitioning out of input.harbor").
- Strip silence from live feeds with `blank.strip` only if the station wants that behaviour; tune `threshold` and `length`.
- Record with `output.file(%mp3, {time.string("/archive/%Y-%m-%d/%H_%M_%S.mp3")}, s, reopen_when={0m})`; use `reopen_on_metadata=true` for per-track archives.
- Metadata: prefer pushing now-playing via Icecast `mode=updinfo` from our backend if we need to control it; use Liquidsoap `on_metadata` for in-engine changes. Test drop behaviour.
- Shoutcast source clients on a custom port must connect to `port+1`.
- Icecast default buffer (64 KB) adds ~4 s at 128 kbps; this is a listener-side delay, not controllable from the source.
- Do not set `harbor.verbose=true` in production (logs source passwords).

---

## Source list (inline above, consolidated)

- https://www.liquidsoap.info/doc-2.3.3/harbor
- https://www.liquidsoap.info/doc-2.3.3/cookbook.html
- https://www.liquidsoap.info/doc-2.2.5/radiopi
- https://newreleases.io/project/github/savonet/liquidsoap/release/v2.5.0-rc1
- https://newreleases.io/project/github/savonet/liquidsoap/release/v2.4.6
- https://azuracast.com/docs/en/user-guide/streamers-and-djs
- https://features.azuracast.com/suggestions/100312/allow-streamerdj-to-schedule-themselves
- https://features.azuracast.com/suggestions/38931
- https://features.azuracast.com/suggestions/56517
- https://www.client.magicstreams.services/announcements/147/AzuraCast-0.20.3-Nov-17-2024.html
- https://onlineaudience.co.uk/blog/how-to-broadcast-live-using-azuracast-web-dj
- https://help.streamerr.co/article/using-the-webdj/
- https://libretime.org/docs/user-manual/live-broadcast/
- https://discourse.libretime.org/t/hand-over-dead-air-issue/861
- https://discourse.libretime.org/t/disconnection-time/1362
- https://www.radioworld.com/?p=59741
- https://lwn.net/Articles/63641/
- https://mairlist.com/en/products/radio-automation
- https://icecast.org/docs/icecast-2.0.2/admin-interface.html
- https://lists.xiph.org/pipermail/icecast/2004-October/007696.html
- https://obsproject.com/wiki/Streaming-With-SRT-Or-RIST-Protocols
- https://obsproject.com/kb/srt-protocol-streaming-guide
- https://www.thebroadcastbridge.com/content/entry/21937/network-traffic-engineering-rist-srt-the-success-of-arq-based-protocols
- https://www.sportsvideo.org/2026/06/17/bbright-white-paper-srt-vs-rist-for-professional-video-contribution-and-distribution/
- https://www.radioworld.com/?p=71730
- https://www.radioworld.com/?p=29772
- https://www.comrex.com/resources/algorithm-chart
- https://tieline.com/manuals/TLR5200D/en/v2_14/selecting_an_algorithm.htm
- https://www.2wcom.com/wp-content/uploads/2wcom_Audio_Codec_Matrix.pdf
- https://www.obe.tv/?p=6980
- https://www.comrex.com/wp-content/uploads/2018/01/Mix-Minus-and-eliminating-Echo.pdf
- https://tieline.com/configuring-mix-minus-feeds/
- https://www.sonifex.co.uk/company/logos-images/catalogues/redbox-singlepages/rb-mm1.pdf
- https://www.provideocoalition.com/cleanfeed-much-better-than-zoom-us-for-48-khz-remote-audio-recordings-or-live-broadcast/
- https://www.quillpodcasting.com/blog-posts/top-remote-recording-softwares-for-podcasters
- https://blogs.telosalliance.com/understanding-the-implications-of-aes67-and-livewire-aes67-on-the-aoip-market
- https://go.audinate.com/hubfs/campaign/DDM/broadcast/audinate-dante-domain-manager-broadcast-aes67-smpte-2110-interoperability-wp.pdf
- https://tieline.com/livewire-added-to-gateway/
- https://opencollective.ecosyste.ms/collectives/azuracast/issues
