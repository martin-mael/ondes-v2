# 03 - Audio processing & loudness (research report)

Scope: loudness standards for streaming radio, ingest normalization (LUFS/ReplayGain), broadcast processing chains, Liquidsoap audio operators, Stereo Tool / Omnia / Orban / Breakaway / Thimeo, codec-aware processing, silence detection, metering.

Verification legend: [V] verified on a fetched primary/vendor page. [S] secondary source or forum, treat as unconfirmed. [G] gap, not verified.

---

## 1. Standards and target levels

### 1.1 EBU R 128 (broadcast, base reference)
- Programme loudness target: **-23 LUFS integrated**, **-1 dBTP** max true peak. [S] (https://community.mairlist.com/t/normalize-setting/16624 quoting EBU; also https://www.production-expert.com/home-page/ebu-loudness-standard-updated)
- Measurement: ITU-R BS.1770 (K-weighted, gated), EBU Tech 3341 (meter) and 3342 (LRA). [S]
- Tolerance for ±1 LU around target is typical broadcast practice. [G, not fetched]
- Loudness range (LRA) is reported alongside, used for dynamics control. [S]

### 1.2 EBU R 128 s2 (streaming supplement, 2023)
- Official PDF (https://tech.ebu.ch/docs/r/r128s2.pdf) returned as compressed binary, **not readable via WebFetch**. [G] Must be verified by hand against the PDF before we hardcode numbers.
- Secondary reports (https://ibc.org/trends/ebu-tackles-loudness-in-streaming-with-r128-update/6830.article, https://www.production-expert.com/home-page/ebu-loudness-standard-updated):
  - Base streaming target remains -23 LUFS.
  - s2 permits a higher integrated loudness for streaming when the broadcaster controls dynamics; interim figure **-18 LUFS**; music-heavy programmes with PLR <= 15 dB may reach **-16 LUFS**.
  - True peak ceiling **-1 dBTP**; ±0.3 dB leeway for content band-limited to 20 kHz.
- A forum post (https://community.mairlist.com/t/normalize-setting/16624/3) claims a revised s2 range of **-20 to -16 LUFS**. [S] Unconfirmed.
- Metadata: s2 emphasises loudness metadata so playback devices can apply gain. [S]

### 1.3 AES TD1004 (2015) -> AES TD1008 (2021)
- TD1004.1.15-10 (2015): window **-16 to -20 LUFS**, max TP **-1 dBTP**. Superseded. (https://www.production-expert.com/home-page/2015/11/17/aes-release-recommendations-for-loudness-of-audio-streaming-and-network-file-playback)
- **TD1008 (AESTD1008.1.21-9, Sept 2021)** supersedes TD1004. Scope: internet radio and on-demand services only (YouTube, Spotify, TIDAL); not for artists/mastering. (https://productionadvice.co.uk/td1008/, https://bibliotheek.ehb.be:2187/wp-content/uploads/2024/01/20210924_TD1008_v3.13.pdf)
- TD1008 "Distribution Loudness" values [V via productionadvice.co.uk, secondary to AES]:
  - Speech-only / assorted (podcasts, radio-style): **-18 LUFS**
  - Interstitials (ads, trailers) and virtual assistant audio: **-18 LUFS**
  - Music: **-16 LUFS** (track-normalised, or album-normalised with loudest track near -14 LUFS)
  - Per-genre table cited by a second source: News/Talk -18, Pop Music -16, Mixed Format -17, Sports -17, Drama -18. [S]
- TD1008 true-peak figure: **not found** [G]. The -3 dBTP argument (lossy codecs cannot handle peaks above about -3 dBTP) appears only as a commentator's critique of TD1004. [S]

### 1.4 ATSC A/85 (US)
- Recommended practice, default target **-24 LKFS** when no metadata/agreement; tolerance about ±2 dB; "should not be targeted to the high or low side". (https://www.tvtechnology.com/news/atsc-tackles-audio-loudness)
- Measurement per ITU-R BS.1770. Mandatory only for commercial advertising under the CALM Act (FCC). (https://www.tvtechnology.com/opinions/lkfs-amp-the-calm-act)
- A single secondary source reports a July 2026 revision extending guidance to streaming. [S] Verify on atsc.org.
- Relevance for us: low. TV-focused. Use only if we target US over-the-air or CALM-compliant ad content.

### 1.5 Practical target recommendation for our engine
- Ingest normalisation target: **-16 LUFS integrated** for music streams, **-18 LUFS** for talk/speech stations (matches TD1008 and R128 s2 interim). Make it per-station configurable.
- True-peak ceiling: **-1 dBTP** (industry default). Consider **-2 dBTP** headroom for lossy AAC/Opus encodes, since inter-sample peaks grow after encoding. [S, practitioner advice, not verified in a standard]
- Plausible presets to expose: "Music -16", "Talk -18", "Broadcast -23 (EBU)", "ATSC -24" with an explicit override field.

---

## 2. Ingest normalisation: ReplayGain vs LUFS vs dynamic normalize

### 2.1 Liquidsoap official guidance [V] (https://www.liquidsoap.info/doc-2.3.3/replay_gain, https://www.liquidsoap.info/doc-dev/loudness_normalization.html)
- `normalize` operator = dynamic, targets constant average volume on a live stream. Docs warn it "cannot guess the volume of the whole stream", reacts poorly to rapid level changes, and can overshoot, undershoot, oscillate or saturate. Use only as a last resort.
- For file-based playout, **precomputed per-track gain** is recommended over `normalize`.
- ReplayGain (track gain) is supported via:
  - `enable_replaygain_metadata()` (metadata resolver, off by default). Writes `replaygain_track_gain`.
  - `replaygain:` protocol prefix per file, chainable with `annotate:`.
  - `amplify(override="replaygain_track_gain", ...)`; `replaygain(...)` wraps it.
  - Caveat: resolver runs on every remote download unless values are precomputed; CPU cost.
  - Only track-based, no album-gain handling documented.
- LUFS-based per-track correction (dev docs, 2.5.x):
  - Settings: `settings.lufs.track_gain_target` (example -23; default not stated), `settings.lufs.integrated_metadata` (default `"liq_integrated_lufs"`, values like `"-23 dB"`), `settings.normalize_track_gain_metadata`.
  - Enablers: `enable_lufs_track_gain_metadata()`, protocol `lufs_track_gain:uri`.
  - Apply: `normalize_track_gain(s)` (wrapper around `amplify`). Example: target -23, gain = target - measured (a -23 LUFS track with -16 target gets +7 dB).
  - No standard metadata field for LUFS, so files should be pre-tagged, typically via ffmpeg `ebur128`/`loudnorm` analysis. Runtime computation causes CPU spikes.

### 2.2 mAirList (commercial playout) [S, forum posts]
- Since v6.2: built-in EBU R128 normalisation to a configurable target (default cited: -23 LUFS / -1 dBTP). Analysis runs on file import; mass-edit for existing items. (https://community.mairlist.com/t/normalize-setting/16624)
- Separates "Loudness" (measure only, reference) from "Normalize" (apply playout gain). Normalize auto-measures if no prior loudness value. Cue-point calculation independent of normalisation. (https://community.mairlist.com/t/loudness-normalization/11677)
- Option "Prevent clipping when using ReplayGain amplification". Some operators run mp3Gain and do not want the playout engine altering gain. Lesson: make normalisation **a stored, auditable value** that can be disabled per item.

### 2.3 AzuraCast / Sintonia-Airtime [S]
- AzuraCast UI offers a fixed normalisation/compression preset; a feature request asks for adjustable boost/attack/decay (https://features.azuracast.com/suggestions/44561/comment/377447). Advanced config is in Liquidsoap.
- Sintonia (Airtime fork) reads replay gain from the DB and applies `amplify(override="replay_gain")` in Liquidsoap (https://git.congegni.net/Congegni/sintonia/commit/5c1af49252167504882c3e69584ed18c16130b81). Confirms the DB-stored gain pattern.

### 2.4 Recommended ingest pipeline for our product
1. On upload (RabbitMQ job, worker): decode with ffmpeg, run BS.1770-4 measurement: integrated LUFS, LRA, true peak (4x oversampled), store in DB per track.
2. Compute `gain_db = target_LUFS - integrated_LUFS`, clamp so that `true_peak + gain_db <= ceiling_dBTP`. Store `gain_db` and `limiter_needed` flag.
3. Write tags on the file copy used for playout (`R128_TRACK_GAIN` in Opus/Ogg, `REPLAYGAIN_TRACK_GAIN`/`liq_integrated_lufs` for Liquidsoap resolver). Keep DB as source of truth.
4. Playout: apply precomputed gain (`amplify` with override from DB/metadata), then processing chain (section 3).
5. If the peak clamp cannot be met, apply a limiter with gain reduction instead of raising ceiling. Log the delta.

---

## 3. Broadcast processing chain (what real stations do)

### 3.1 Canonical chain (FM/stream processors) [V from Orban/Omnia descriptions]
1. Input trim / declipper (Omnia.9 "Undo" declipper) [V: https://7bd.com listing, technic2radio]
2. Wideband AGC, typically 2-3 stages with adjustable side-chain EQ (Omnia.9: "three-stage wideband AGC") [V]
3. Multiband downward expansion (noise gate for hiss) [V]
4. Multiband compression (program-dependent, 4-7 bands) [V]
5. Multiband look-ahead limiter, true-peak aware [V]
6. Stereo enhancement / matrix (M/S processing, stereo width) [V]
7. Phase/skew correction (Optimod-PCN "phase skew correction") [V]
8. Final clipper / peak control to target ceiling [V]
9. Pre-emphasis / pre-processing for FM (not needed for streaming) [V, Breakaway pre-emphasis forum]

### 3.2 Streaming-specific points
- Streams have no pre-emphasis or MPX constraint; skip FM-specific stages and the 75us pre-emphasis.
- Lossy codecs: keep true-peak ceiling about 1-2 dB below 0 dBTP to avoid codec-induced overs. [S, practitioner]
- Dynamic range: music streams tolerate less dynamic range than broadcast; talk streams need more intelligibility compression on speech bands.
- Mono compatibility: check mono-sum (phase cancellation) before limiting; Optimod phase-skew and stereo modes are the commercial approach.

### 3.3 "Signature sound" [S]
- Commercial processors are sold on a preset-dependent sound. Forum consensus: preset choice matters more than the product. Omnia has a long-running reputation for punch; Stereo Tool users praise cost and flexibility.
- Practical implication: ship **named presets** (Music Pop, Talk, Classical/Jazz, Dance) plus an advanced parameter set, not a single chain.

---

## 4. Products

### 4.1 Stereo Tool (Thimeo) [V: https://www.thimeo.com/stereo-tool/download/]
- Latest version: **11.05 (dated 2026-09-07)**; v11 rewrote the I/O code; fallback to 10.75 offered.
- Builds: Windows (stand-alone, VST2/VST3, Winamp, libStereoTool SDK, CLI); Linux x86/64 (ALSA/JACK stand-alone, streaming libs, SDK, 32/64-bit CLI); macOS 10.14+ universal; ARM Linux (Raspberry Pi 3/4/5 image, CLI).
- CLI input: 16 or 24-bit stereo WAV or raw PCM. Run `-h` for help.
- **libStereoTool SDK** is the vendor-supported integration path. Vendor lists Liquidsoap, StreamEncoder PRO, mAirList, GML as target uses. License model and price not stated on the page [G].
- Liquidsoap integration (community, 2017-2022, [S]):
  - Pipe approach using the CLI: Liquidsoap writes PCM to a named pipe, Stereo Tool reads and writes a second pipe, with a `.sts` preset file.
  - One-liner (AzuraCast feature thread, [S]): `radio = mksafe(pipe(process='/etc/stereotool/stereo_tool_cmd_64 - - -s /etc/stereotool/preset.sts -q -k "<key>"', radio))`
  - Known issue (2021 forum, [S]): HTTP-URL input through `mksafe(input.http(...))` produced broken pipes and silence. Test with our input type.
- Caveats: CLI flags and licence-key handling may have changed in v11; verify with `-h` on the binary before relying on this.
- Forum link for comparison: https://forums.stereotool.com/viewtopic.php?p=43844

### 4.2 Orban Optimod / Omnia (Telos Alliance) [V/S]
- **Omnia.9** (hardware, 3 RU): multiband downward expansion, 3-stage wideband AGC with side-chain EQ, program-dependent multiband compression, multiband look-ahead limiter, declipper, multiband expander. Dual-path (FM + HD1-3). "Undo" declipping. (https://7bd.com/radio/..., https://technic2radio.fr/omnia-9)
- **Omnia.8x**: marketed for streaming. [S] (https://www.telosalliance.com/news/Omnia-Audio-Broadcast-Processing-at-Broadcast-Asia-2010 is 2010, dated)
- **Optimod-PCN 1600** (software/PC on DSP card, Windows only, DSP56367 x3): phase skew correction, stereo enhancement, intelligent AGC, EQ, multiband gain, peak control, smart loudness control. Use cases listed: live internet streaming, DAB+, HD, TV. (https://www.redtech.pro/optimod-pcn-1600-brings-audio-processing-virtual/, https://orban.com/indepth-optimodpc1101e)
- Omnia docs for streaming: https://docs.telosalliance.com/docs/understanding-loudness-for-streaming-audio [G, not fetched]

### 4.3 Breakaway / BreakawayOne (Thimeo) [S]
- FM/streaming processor, pre-emphasis option praised in forums. Stand-alone trial available; works with RadioBoss routing. (https://forums.stereotool.com/viewtopic.php?p=62755 and related)
- No verified feature sheet fetched [G].

### 4.4 Other relevant
- Omnia 9 is also used via RadioBoss routing (https://www.djsoft.net/community/threads/how-to-use-omnia-9-ptn-with-radioboss.7717/latest) [S].

### 4.5 Free metering and loudness tools [V: https://www.production-expert.com/production-expert-1/free-metering-and-loudness-plugins-for-broadcast-and-streaming-2026]
- Youlean Loudness Meter 2: LU, INT, TP, LRA, PLR, DR; free tier, VST2/3, AU, AAX; macOS/Windows. No logging stated.
- TBProAudio dpMeter5: R128, DIAL gating, integrated/short-term/LRA/TP; can record metering to automation data (not a logger we can script).
- Berry FX Ripeness: LUFS/TP vs six targets incl. streaming and radio; 5-min loudness history; Windows 10+ / macOS 10.15+.
- Awesonix Simple Meter: TP, RMS, short-term loudness, DR; CLAP/VST3/AU/AAX; Linux kernel 5.4+ mentioned; requires account.
- These are DAW plugins, not server-side. For our backend use ffmpeg `ebur128` (see section 6).

---

## 5. What the open-source stacks do and their limits

- **Liquidsoap** (see section 6): full control, but built-in dynamics are considered weak by at least one third-party guide that replaces `compress`/`limit` with LADSPA plugins (https://github.com/mkpascal/mk_liquidsoap_processing). [S]
- **AzuraCast**: fixed normalisation/compression preset in UI; users request tuning (feature request above). Silence detection was removed after reports of erroneous fading and high CPU. (https://features.azuracast.com/suggestions/51605/monitoring-silence-detection) [S]
- **Airtime/LibreTime/Sintonia**: ReplayGain stored in DB and applied via `amplify(override=...)`. [S]
- **Rivendell, Mixxx**: not researched in this pass [G].

Limitations to design around:
- No open-source UI for multiband AGC/limiter tuning. We must provide one, or ship preset chains.
- No built-in LUFS logger per playout item. We should store loudness and peak per item and per hour.
- Liquidsoap's `normalize` alone causes pumping; use precomputed gain.

---

## 6. Liquidsoap implementation notes

### 6.1 Verified operators [V]
- `normalize` (dynamic, live). Overshoot and saturation risk per docs. https://www.liquidsoap.info/doc-2.3.3/replay_gain
- `amplify(override=..., ...)` applies metadata gain. Place directly on the basic track source, before transitions.
- `replaygain(...)`, `replaygain:` protocol, `enable_replaygain_metadata()`.
- `normalize_track_gain(...)`, `enable_lufs_track_gain_metadata()`, `lufs_track_gain:` protocol, settings `settings.lufs.track_gain_target`, `settings.lufs.integrated_metadata` (default `"liq_integrated_lufs"`), `settings.normalize_track_gain_metadata`.
- `blank.detect(...)`: parameters `id` (null), `max_blank` (20.0 s), `min_noise` (0.0), `start_blank` (false), `threshold` (-40.0 dB), `track_sensitive` (true). Calls handler on blank. Attach via `s.on_blank(...)`; the docs show `process.run` for external actions. [V, 2.4.5 reference via WebFetch]
- `blank.strip(...)`: same parameters, makes the source unavailable during blank. Use in `fallback([blank.strip(max_blank=5., live), interlude])`. [V]
- `mksafe(id=..., s)`: makes a source infallible by inserting silence. [V]
- `compress` maps to an `Effect.compress` class: hard-knee, RMS look-ahead envelope, attack and release in seconds, ratio n:1, threshold and knee in dB, `rms_window`, `gain` pre-gain. [S] (https://www.liquidsoap.info/liquidsoap/mm/Mm/Audio/Effect/class-compress/index.html). Exact operator signature and defaults not verified [G].
- `pipe(process=..., s)`: external process filter (used for Stereo Tool). [S, community]

### 6.2 Not verified [G]
- Exact signatures and defaults for `normalize`, `compress`, `compress.exp`, `limit`, `limit.ffmpeg`, `amplify`, `smooth`, `nrj`, `ladspa.*`, `lv2`, `ffmpeg.filter.audio`. The 2.4.5 reference was truncated at 100k of 212k chars. Next step: fetch `https://www.liquidsoap.info/doc-2.4.5/reference/source-track-processing` with offset 100000, or run `liquidsoap -h normalize`, `liquidsoap -h compress`, `liquidsoap -h limit` on the target version.
- Whether Liquidsoap 2.x ships `limit.ffmpeg` (ffmpeg-based true-peak limiter) as stated in some community scripts. Verify.

### 6.3 Recommended Liquidsoap chain (to validate on a real install)
```
# playout source, per-track precomputed gain from DB via metadata override
s = amplify(override="liq_gain_db", playlist(...))   # or normalize_track_gain(...)
# processing (choose one dynamics path: LADSPA/LV2 or ffmpeg, or external Stereo Tool)
s = pipe(process='stereo_tool - - -s preset.sts', s)  # optional, Stereo Tool CLI
s = compress(...)                                     # AGC-style, tuned per preset
s = limit(...)                                        # true-peak ceiling, verify operator
# safety
s = blank.strip(max_blank=...) fallback with backup source
s = mksafe(s)
```
- Keep exact operator names to be validated against the target Liquidsoap version, see 6.2.

### 6.4 Metering and silence
- Measure with ffmpeg: `ffmpeg -i in -af ebur128=peak=true -f null -` (library-standard; not fetched, verify).
- Silence/dead-air: use `blank.detect` (handler) for alerts; `blank.strip` + `fallback` for automatic failover. Tune `threshold` (-40 dB default) and `max_blank` per station; cookbook recommends tuning, not defaults. [V]

### 6.5 Liquidsoap metadata keys
- `replaygain_track_gain` documented. `R128_TRACK_GAIN` not documented; do not rely on it [G].
- Use our own override key (e.g. `liq_gain_db`) written at ingest.

---

## 7. Codec-aware processing (Opus / AAC)

- Opus recommended bitrates [V: https://wiki.xiph.org/Opus_Recommended_Settings]:
  - Speech/podcast: mono 24 kb/s, stereo 32 kb/s.
  - Music streaming/radio: stereo **64-96 kb/s**. Storage: 96-128 kb/s VBR "pretty much transparent" at 128.
  - Bandwidth thresholds: FullBand (20 kHz) needs about 14-16 kb/s; mono/stereo downmix by default around 19 kb/s and below.
  - Frame size default 20 ms; complexity default 10 (CPU/quality).
- Xiph page does not discuss pre-encode loudness or dynamics. [V gap]
- Practitioner advice (unverified): compress/limit *before* encoding, keep true peak at or below -1 dBTP post-encode test, and avoid aggressive HF boost before low-bitrate encoding because it costs bits. [S/G]
- Pre-emphasis is an FM concern. Do not apply it to streams.
- AAC at 64-128 kb/s: similar advice; no source fetched [G].
- Browser and hardware player support for Opus is limited on some devices (https://www.cloudrad.io/help/bitrates-and-codecs). Offer AAC as fallback.

---

## 8. Mono/phase compatibility, monitoring, live mic

- Mono-sum check: needed for phase correlation (some processors do phase skew correction, Optimod-PCN). [S]
- Live DJ mic processing: commercial tools (Omnia, Stereo Tool, mAirList) run mic-channel chains: gate, de-esser, compressor, EQ, ducking of music. Not researched in depth [G]. Liquidsoap can do ducking via `smooth` / `amplify` on sidechain-like inputs; verify.
- Metering: integrated LUFS, short-term LUFS, LRA, true peak per channel, correlation. Log per minute/hour for compliance.

---

## 9. Gaps and next steps
1. Read the EBU R128 s2 PDF by hand (WebFetch returns binary). Confirm -18 / -16 / -20 range and measurement method.
2. Confirm TD1008 true-peak limit (PDF at ehb.be link, or aes.org).
3. Fetch Liquidsoap reference with offset to get `normalize`, `compress`, `limit`, `ladspa`, `lv2`, `ffmpeg.filter.audio` signatures and defaults. Run `liquidsoap -h <op>` in a container for the version we pin.
4. Test Stereo Tool v11.05 CLI in a Linux container with Liquidsoap, and check the libStereoTool licence terms before shipping it in a product.
5. Decide whether to ship server-side ffmpeg-based analysis (ebur128) or a node library (e.g. loudness measurement in Node) for ingest.

---

## Feature checklist for our product

### Must
- Per-track ingest measurement: integrated LUFS, LRA, true peak (BS.1770-4, 4x oversampling), stored in DB.
- Per-station normalisation target (presets: Music -16 LUFS, Talk/Podcast -18 LUFS, EBU -23, ATSC -24, custom), with -1 dBTP (configurable) ceiling.
- Precomputed gain applied at playout (no runtime `normalize` on file playout); auditable value stored per item; ability to disable per item.
- True-peak safety: if `true_peak + gain > ceiling`, apply limiting and log the delta.
- Silence/dead-air detection with alert and automatic failover to a backup source (`blank.detect` + `blank.strip` + `fallback`).
- Per-station processing preset (chain on/off, AGC/compressor/limiter parameters) with a sensible default.
- Loudness/peak logging per playout hour (for compliance and debugging).
- Codec settings: Opus 64-96 kb/s stereo default for music, 24-32 kb/s for speech, plus AAC fallback.

### Should
- Stereo Tool (libStereoTool or CLI) as optional external processor per station, with licence check.
- Mono-sum / phase correlation meter; warning on phase cancellation.
- Stereo width control (M/S) and phase skew correction option.
- ReplayGain tag writing as alternative to DB-only gain (interop with other players).
- Mic/DJ processing chain: gate, de-esser, compressor, EQ, music ducking.
- Loudness distribution graph and LRA per track in admin UI.
- Presets library (Pop, Talk, Classical, Dance) exposed in the UI.
- Pre-emphasis disabled by default (streaming), available only for FM-simulation use.

### Could
- Multiband AGC/limiter tuning UI (commercial Omnia/Orban parity).
- Declipper / source restoration stage.
- Album-gain computation (TD1008 album normalisation option).
- Real-time LUFS meter in the web UI via WebSocket.
- A/B preset comparison with listening test samples.
- Integration with Auphonic or similar cloud loudness service for offline batch normalisation.

---

## Sources used (inline above; consolidated)
- https://tech.ebu.ch/docs/r/r128s2.pdf (unreadable via WebFetch)
- https://ibc.org/trends/ebu-tackles-loudness-in-streaming-with-r128-update/6830.article
- https://www.production-expert.com/home-page/ebu-loudness-standard-updated
- https://www.production-expert.com/home-page/2015/11/17/aes-release-recommendations-for-loudness-of-audio-streaming-and-network-file-playback
- https://productionadvice.co.uk/td1008/
- https://bibliotheek.ehb.be:2187/wp-content/uploads/2024/01/20210924_TD1008_v3.13.pdf
- https://www.tvtechnology.com/news/atsc-tackles-audio-loudness
- https://www.tvtechnology.com/opinions/lkfs-amp-the-calm-act
- https://www.liquidsoap.info/doc-2.3.3/replay_gain
- https://www.liquidsoap.info/doc-dev/loudness_normalization.html
- https://www.liquidsoap.info/doc-2.4.5/reference/source-track-processing
- https://www.liquidsoap.info/doc-dev/blank.html
- https://www.liquidsoap.info/liquidsoap/mm/Mm/Audio/Effect/class-compress/index.html
- https://www.thimeo.com/stereo-tool/download/
- https://forums.stereotool.com/viewtopic.php?p=43844
- https://features.azuracast.com/suggestions/111122/comment/308307
- https://community.mairlist.com/t/normalize-setting/16624
- https://community.mairlist.com/t/loudness-normalization/11677
- https://git.congegni.net/Congegni/sintonia/commit/5c1af49252167504882c3e69584ed18c16130b81
- https://features.azuracast.com/suggestions/44561/comment/377447
- https://features.azuracast.com/suggestions/51605/monitoring-silence-detection
- https://www.redtech.pro/optimod-pcn-1600-brings-audio-processing-virtual/
- https://technic2radio.fr/omnia-9
- https://www.production-expert.com/production-expert-1/free-metering-and-loudness-plugins-for-broadcast-and-streaming-2026
- https://wiki.xiph.org/Opus_Recommended_Settings
- https://www.cloudrad.io/help/bitrates-and-codecs
- https://github.com/mkpascal/mk_liquidsoap_processing
