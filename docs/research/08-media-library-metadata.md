# 08 - Media library, ingest and metadata

Scope: ingest pipelines, storage formats, cue/segue detection, audio analysis (BPM/key/mood), loudness, metadata enrichment, duplicates, expiry/rights, waveform and cue editing, library scale, jingles/imaging.

Coverage note: the web search budget for this run was exhausted after about 27 searches and roughly 14 fetches. Items marked **[unverified]** come from partial or secondary sources. Items marked **[gap]** were not researched: promo-pool vendors beyond Play MPE, the jingle/imaging workflow, RadioBOSS/SAM/StationPlaylist import details, kill-date semantics in commercial tools, and large-library search performance.

---

## 1. Professional practice (how stations do it)

- **Two-tier storage.** Stations keep a lossless master (WAV/BWF, or FLAC in some workflows) and derive a playout copy (MP3/AAC at the station bitrate). The master holds the authoritative cue points and loudness data. Playout systems normally play the derived copy. [general practice, unverified against a specific vendor doc]
- **Cart and cut model (Rivendell, RadioBOSS, mAirList, ZETTA-style).** A "cart" is a logical item (a song, a jingle). A "cut" is a playable segment with its own cue points, dayparting and dates. One cart can hold several cuts. Rivendell's Operations Guide describes cut dayparting and multiple cuts per cart (https://mirror.unpad.ac.id/orari/library/library-sw-hw/linux-1/broadcasting/rivendell/docs/rog-0.9.1.pdf). Our data model should separate Item (asset) from Version/Cut (playable segment).
- **Cart Chunk / AES46.** Embeds station labels in the BWF file. Ratified as AES46-2002 on 10 June 2002, authored by Dick Pierce and Geoff Steadman (ex-Orban). Carries about 20 fields including title, length, outcue, and cart/cut identifiers. The standard's field set is not exhaustive, so vendors add private fields. It is appended as a chunk after the audio data, and some older software cannot read files with trailing chunks. Vendor compliance claims are not certified. (https://www.cartchunk.org/faq.htm ; https://www.radioworld.com/?p=90717 ; https://knowledgehub.ebu.ch/files/live/sites/tech/files/shared/tech/tech3285.pdf)
- **BWF / EBU Tech 3285.** Base format from 1997 (v0). v1 adds a SMPTE UMID. v2 adds loudness fields under EBU R 128 and folds in supplements 1 to 6. Supplements cover MPEG audio, capture reporting, peak envelope (PEAK chunk), link, axml, and Dolby dbmd. Files larger than 4 GB use RF64 (EBU Tech 3306). Library of Congress notes that iXML (IBS) is not an EBU chunk and has seen little adoption, while axml is the EBU XML chunk (2003). (https://en.wikipedia.org/wiki/Broadcast_Wave_Format ; https://tech.ebu.ch/publications/tech3285s6 ; https://www.loc.gov/preservation/digital/formats/fdd/fdd000357.shtml)
- **Loudness targets (EBU).** Program production at -23 LUFS integrated, true peak at or below -1 dBTP (EBU R 128 radio supplement). Legacy material is normalized to -23 LUFS before playout, using either re-encoded files or loudness metadata. Streaming supplement: stream unchanged at -23 LUFS with loudness metadata; interim -20 to -16 LUFS allowed for devices with limited headroom. Many stream platforms and players work near -14 to -16 LUFS, so a station may choose a playout target and encode a separate distribution loudness. (https://knowledgehub.ebu.ch/files/live/sites/tech/files/shared/r/r128s2.pdf ; https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128s3v1_0.pdf)
- **Caveat on lossy encoding.** Lossy encoding (MP3/AAC) can push true peaks above the master's true-peak ceiling. Measure true peak on the encoded playout copy, or leave headroom (for example -1.5 to -2 dBTP on the master). [general practice, unverified against a source]
- **Segue and cue vocabulary (industry terms).** Intro (vocal start, used for voice-over timing), Outro (vocal end), Hook-in/Hook-out (chorus-based cut points), Cue-in / Cue-out (trim silence), Ramp / FadeOut (in mAirList terms), Segue / Overlap (start of next track during the tail of the current one), Talk-over. Multiple intro/outro points are a competitor feature that users request from RadioBOSS.
- **Kill dates / start dates.** Stations set Start and Kill (expiry) dates per cut, so tracks drop off rotation automatically (for example after a chart run). Also used for seasonal items (Christmas) and promo windows. [general practice; commercial implementation not verified]

## 2. Open-source tools and their limits

### AzuraCast (media manager)
- Upload paths: browser uploader (drag and drop), built-in SFTP server (Docker installs only), and S3-compatible remote storage (Backblaze, DigitalOcean Spaces, Linode, AWS S3). (https://www.azuracast.com/docs/user-guide/media-management/)
- Playlist membership gates airplay: media must belong to at least one playlist. Setting a folder's playlists propagates to files added to that folder later.
- Permission "Manage Station Media" is required for media management.
- Cue in/out and autocue: AzuraCast has built-in autocue support since a May 2024 rolling release (see section 3). (https://github.com/Moonbase59/autocue)
- Known complaints from GitHub issues (titles only, status not verified): large audio uploads partially succeed with no error shown ("Big audio file uploads partly (no error is shown)"); the media upload API endpoint fails on destination path; some m4a files fail with "An ID was not generated for this object". A published write-up says a path-traversal-style vulnerability affected versions up to 0.23.5 when the default local filesystem backend is used, and that S3 storage was not affected. Verify current status before relying on it. (https://opencollective.ecosyste.ms/collectives/azuracast/issues)
- No watch-folder feature was found in the docs. Ingest is manual upload, SFTP, or S3 sync. [gap: check issue tracker for "watch folder"/"inotify"]

### Rivendell
- RDImport is a CLI batch importer with metadata. Options include `--set-user-defined` (2.6.0) and `--title-from-cartchunk-cutid` (title from CartChunk CutID). Use `man 1 rdimport` for full usage. Kill and start date handling in RDImport was not verified. (https://github.com/dklann/rivendell)
- Rivendell is the reference open-source model for cart/cut separation and CartChunk support.

### Liquidsoap (playout engine, metadata and cueing)
- **Autocue (built-in, since 2.2.5).** Enabled with `enable_autocue_metadata()`. Requires ffmpeg bindings. Computes crossfade and cue values automatically. CPU cost is higher. Credited to Moonbase59 and RM-FM (#3753, #3811). (https://www.liquidsoap.info/doc-dev/crossfade.html ; https://ocaml.org/p/liquidsoap/2.2.5/CHANGES.md.html)
- **Cue handling changed in 2.2.5.** `cue_cut` was removed. Cueing moved into the file/request decoding layer, and cue points arrive as request metadata. Upstream docs warn of pops and clicks when cue points are placed wrongly, and recommend a crossfade after a cue cut. Older scripts that use `cue_cut` with metadata `liq_cue_in` / `liq_cue_out` need migration. Metadata values are seconds in AzuraCast's docs. [unverified exact keys in 2.4+]
- **Fade metadata.** `liq_fade_in`, `liq_fade_out` override fade durations per track. Fade types: lin (default), sin, log, exp. 2.2.5 adds `curve` and `delay` parameters to the fade functions. (https://www.liquidsoap.info/doc-dev/crossfade.html ; https://www.liquidsoap.info/legacy/doc-dev/scripts/smart_crossfade.html)
- **cross.smart / crossfade helper.** Defaults: fade_in 3 s, fade_out 3 s, high -15 dB, medium -32 dB, margin 4 dB, default transition `sequence`. Uses `fade.in`/`fade.out` with type sin. Rules: both quiet and close in level gives full crossfade; incoming much louder gives fade-out of outgoing only; outgoing much louder gives fade-in of incoming only; incoming very quiet gives cut; otherwise default. Dev docs warn that crossfading is sensitive and that the `ffmpeg` dependency matters. (https://www.liquidsoap.info/doc-dev/crossfade.html)
- **Known Liquidsoap pitfall.** A 2023 fix in a community project: `crossfade` with zero-length queues gave hard cuts. Use explicit fade.in / fade.out. (https://git.congegni.net/Congegni/sintonia/commit/d2f93f7c8aef0037a87a3e8ad36ea10b2b6be9c8)
- **2.4.2 changelog** notes a change to autocue `start_next` behavior that can alter output of existing scripts, and a fix for a request-resolution loop when both autocue and replaygain metadata are enabled. (https://ocaml.org/p/liquidsoap/2.4.2/CHANGES.html)

### autocue (Moonbase59/autocue) [key reference for cue detection]
- MIT licensed. Python 3 CLI `cue_file` analyzes a file and outputs JSON (cue points, loudness, overlay data). Also ships `autocue.cue_file`, a Liquidsoap protocol integration (`autocue:` protocol). AzuraCast bundles it. (https://github.com/Moonbase59/autocue)
- Dependencies: Python 3, ffmpeg with the `ebur128` filter (tested with ffmpeg 4.4.2 to 6.1.1), mutagen (optional, extends file types and can write tags back to skip re-analysis).
- **Detection method (threshold-based, EBU R128):**
  - Cue-out: scan backward from the end for momentary loudness above silence threshold. Default threshold: integrated loudness minus 42 LU.
  - Cue-in: same threshold, trims leading silence.
  - Overlay / cross start (`liq_cross_start_next`): scan backward from cue-out for audio above overlay threshold. Default: integrated minus 8 LU.
  - Long tail rule: if overlay exceeds 15 s, recalculate with extra -12 LU offset.
  - Sustained ending rule: max loudness drop of 40% marks an ending as sustained, which triggers the same recalculation.
  - Blank skipping: optional, off by default. `-b` enables it with a 5.0 s minimum silence. Can cut spoken content (jingles, DJ sets, podcasts).
  - Loudness: ReplayGain-style gain (`liq_amplify`) toward -18 LUFS target, with optional clipping prevention (true peak below -1 dBFS).
- **Limitations:** built for Liquidsoap 2.2.5, not fully compatible with 2.3.x (author says a new version is coming). Replaygain unification requires files tagged to the same LUFS target. Very large video files are CPU and bandwidth heavy. Logs are verbose. No explicit intro/outro detection beyond the cue logic above. One open issue and one open PR at snapshot time.
- **Implication for us:** this algorithm is a good baseline to port or call (it is MIT). Its thresholds are relative to integrated loudness, which is a good design. Expose them per station and per genre.

### Mixxx (analysis reference)
- Key detection: high precision, full track by default, "Fast Analysis" option uses only the first minute. Re-analysis is triggered when the key plugin changes or when the key was written by another program. (https://manual.mixxx.org/2.5/ru/chapters/preferences/key_detection)
- Pluggable key backends exist. Plugin names not confirmed on the page.
- Third-party `mixxx-analyzer` (PyPI) reuses Mixxx BPM, key, gain and silence algorithms standalone. Gives Mixxx-consistent results outside the app. (https://pypi.org/project/mixxx-analyzer/)
- Forum complaint: the same track can read 140 BPM in one tool and 70 BPM in another (half/double-time). Always store the tempo candidate and an octave-confidence value. [anecdotal]

### Other OSS to consider [gap, names from general knowledge]
- beets (plugins: replaygain, acousticbrainz, chroma/acoustid, discogs, mbsync) is a strong CLI metadata pipeline. Its issue tracker documents R128 vs ReplayGain tag inconsistencies (https://github.com/beetbox/beets/issues/2557).
- Music Assistant has an AcoustID lookup provider and audio-analysis pipeline. (https://music-assistant.io/audio-analysis/acoustid/)
- Peaks.js (BBC) and wavesurfer.js for browser waveforms (see section 6).

## 3. Automatic cue-point and segue detection, summary

- Approach used by autocue: loudness-relative thresholds (EBU R128 momentary loudness) with heuristics for long tails and sustained endings. Good baseline, but no beat or vocal-activity analysis.
- Better signals to add (not researched in depth): voice activity detection (VAD) to find intro vocal start and outro end (AzuraCast/Liquidsoap users mostly rely on silence), beat-grid alignment so segues land on bar boundaries (Essentia BeatTrackerMultiFeature / RhythmExtractor2013), and spectral-flux onset detection for hook-in points.
- Store each cut point with a `source` field: `manual`, `auto_silence`, `auto_vad`, `auto_beat`, to allow override and re-analysis.
- Commercial tools (RadioBOSS, mAirList, SAM) expose manual Intro/Outro/Start/End plus Ramp/FadeOut markers. Users request multiple intro/outro points (RadioBOSS track editor, competitor offering up to three intros). [RadioBOSS details from forum threads, partially verified: https://www.djsoft.net/community/threads/cue-points.4815/post-23750]
- mAirList: "For IVP prep you need a library marked with Ramp, FadeOut, and ideally Outro cue points." Cue points can be imported from .cue sheet files and from Station Playlist Creator APE tags via a converter. Changed files can be re-analysed on load when normalization and cue redo options are enabled. (https://community.mairlist.com/t/suggestions-for-improving-mairlist-music-import-workflow-mainly-checking-setting-fade-points/15904 ; https://community.mairlist.com/t/station-playlist-creator-cue-points/7191)

## 4. Audio analysis: BPM, key, mood, energy

### Essentia (open source, C++ with Python/JS bindings)
- Descriptors: beat tracking and BPM (RhythmExtractor2013 and beat trackers), key and key strength (KeyExtractor), loudness (EBU R128 implementation), and classifier-based mood (valence, arousal, danceability). Auto-tagger covers 400+ tags for genre, mood, instrumentation and era (models). (https://essentia.upf.edu/index.html ; https://essentia.upf.edu/api/docs/tutorial/use-cases)
- **License:** library is AGPL per the 2013 paper; pretrained models are CC BY-NC-SA 4.0 (non-commercial). Commercial use of the pretrained tagger models is a blocker, so treat them as non-commercial unless licensed. Verify on the repo before shipping. (https://essentia.upf.edu/api/)
- A community CPU-only BPM and key detector analyses a representative window, not the full track, and notes half/double-time and key changes as main failure modes. [anecdotal]

### librosa (Python)
- BPM via `librosa.beat.beat_track` (onset-based). Key via chroma and Krumhansl-style profile matching. ISC licence. [general knowledge, not re-verified in this run]

### aubio
- Lightweight C library: tempo, onset and pitch. GPL. [general knowledge]

### Spotify-like features: cannot be assumed
- Spotify deprecated the Audio Features, Audio Analysis, Related Artists and Recommendations endpoints for new apps. Changes effective 27 November 2024. Returns 403 for apps without prior extended access. Fields lost include tempo, key, energy, danceability, valence, acousticness, instrumentalness, loudness, speechiness, liveness. (https://techcrunch.com/2024/11/27/spotify-cuts-developer-access-to-several-of-its-recommendation-features/ ; https://community.spotify.com/t5/Spotify-for-Developers/Changes-to-Web-API/m-p/6543247/highlight/true)
- **Implication:** the 13-feature Spotify vector is not a viable enrichment source for us. Compute our own features locally (Essentia / librosa / Mixxx-analyzer) or use a licensed provider.

### Deezer
- Track objects include `bpm`, `gain` and `isrc`. A `bpm` of 0 appears to mean "not analyzed", so treat 0 as null. [official API docs not confirmed; field presence from deezer-python track resource: https://deezer-python.readthedocs.io/en/stable/api_reference/resources/track.html]
- Deezer API terms restrict commercial redistribution. Check before storing.

### Practical recommendations
- Run BPM and key as an async job per track (RabbitMQ worker). Store: bpm, bpm_confidence, octave-alt candidate, key (Camelot and Open Key notation), key_confidence, analysis_version, analyzer name.
- Analyze only the first 60 to 90 s for speed, as Mixxx does, and optionally the outro window. Mixxx offers the same "first minute" trade-off.
- Re-analysis when analyzer version bumps (store analysis_version per field, mirroring Mixxx's re-analyze-on-plugin-change).

## 5. Loudness analysis at ingest

- Measure integrated LUFS, loudness range (LRA), true peak (dBTP) with EBU R 128 (ffmpeg `ebur128` filter or `loudnorm` in measure mode).
- `loudnorm` dynamic mode alters dynamics. Use two-pass linear mode for normalization. ffmpeg-normalize automates the two-pass process and writes ReplayGain tags. (https://pypi.org/project/ffmpeg-normalize/)
- **Tag formats:** ReplayGain 2.0 (REPLAYGAIN_TRACK_GAIN / PEAK, REPLAYGAIN_REFERENCE_LOUDNESS). Opus uses R128_TRACK_GAIN / R128_ALBUM_GAIN (RFC 7845), which is different. Some players (MPD) read only one family. Write both when storing Opus. (https://github.com/beetbox/beets/issues/2557 ; https://pypi.org/project/r128gain/0.3.0/ ; rsgain https://www.mankier.com/1/rsgain)
- **Liquidsoap:** reads ReplayGain tags via `amplify` metadata (`liq_amplify` from autocue, or replaygain plugin). Whether Liquidsoap reads R128_TRACK_GAIN was not confirmed. [gap]
- Store measurements in our DB (integrated, LRA, true peak, analysis version). Do not rely only on tags. Compute `liq_amplify` gain at playout time from our stored target (-18 LUFS in autocue, -23 LUFS EBU, or station policy).

## 6. Metadata enrichment and fingerprinting

### AcoustID / Chromaprint / MusicBrainz
- Chromaprint (`fpcalc`) generates a fingerprint plus duration. AcoustID maps fingerprint to MusicBrainz recording IDs.
- Endpoint: `https://api.acoustid.org/v2/lookup`. Parameters: `client` (app key, required), `fingerprint`, `duration` (required), `meta` (combine with `+`: recordings, recordingids, releases, releaseids, releasegroups, releasegroupids, tracks, compress, usermeta, sources, isrcs), `format` (json default, jsonp, xml). Lookup by `trackid` (UUID) is also accepted. (https://acoustid.org/webservice)
- Rate limit: 3 requests per second. Submission endpoint `/v2/submit` is async, with `/v2/submission_status`. Submitting requires per-user keys.
- **License:** free for non-commercial use. Commercial use requires a separate agreement via acoustid.biz. Data is crowd-sourced under a data license. **Blocker for a commercial SaaS: must contact AcoustID or use an alternative.** [verified on acoustid.org]
- ISRC: AcoustID returns ISRCs when `meta=isrcs` is requested. Lookup from ISRC to a recording goes through MusicBrainz, which stores ISRCs.
- MusicBrainz: open data (CC0 for core data), rate-limited API with User-Agent requirement. Use for canonical artist/title/release-group IDs (MBIDs). [MusicBrainz terms not re-verified in this run]

### Discogs
- Official API client exists for Python (discogs_client). Requires a unique User-Agent. Discogs API terms restrict commercial use of data dumps. Useful for label, catalogue number, year and credits. [terms not verified]

### Spotify / Deezer
- Spotify: track metadata and ISRC still available via Web API for many apps. Audio features are deprecated (see section 4).
- Deezer: ISRC and BPM fields exposed. Verify endpoints and terms.

### Enrichment pipeline recommendation
1. Hash file (SHA-256 of audio payload) and compute Chromaprint.
2. Read embedded tags and BWF/CartChunk/RIFF fields (ISRC, title, artist).
3. ISRC-first lookup (MusicBrainz), fallback to AcoustID fingerprint lookup with confidence threshold (score >= 0.9 suggested).
4. Enrich from Discogs (labels, year), Deezer (BPM candidate), cover art (Cover Art Archive via MusicBrainz release MBID).
5. Store provenance per field: `source`, `confidence`, `fetched_at`. Let operators lock fields.

## 7. Duplicate detection

- Layers: exact duplicate (SHA-256 of decoded PCM or file), near-duplicate by Chromaprint (same recording, different encode/master), same-title-different-version (remix, radio edit) via MBID vs. recording ID.
- Chromaprint similarity: compare fingerprints with bit error rate. Duplicate threshold is a tunable parameter; treat fingerprint matches as "same recording" candidates, and let operators decide.
- Keep "versions" as first-class: one work, multiple cuts (radio edit, album version, clean). Matches Rivendell cuts and Myriad "Media Packets" (groups versions of a track).
- Enforce duplicate rules at scheduling time (artist separation, title separation), not only at ingest.

## 8. Expiry, start dates and rights

- Per-cut fields: `start_at`, `kill_at` (expiry), `seasonal_window`, `daypart` restriction, `max_plays_per_day`, `min_hours_between`.
- Rights flags (general practice): territory restrictions, explicit content flag (`E`), clean version link, "do not play before" for embargoed promos, licence source (for example SACEM/PRS/ASCAP reporting). [gap: specific CMO reporting fields not researched]
- Promo pools: Play MPE (formerly Promo Only MPE; launched by Destiny Media Technologies 2004, with UMG and Clear Channel onboard) delivers near-CD-quality tracks to radio. Vetted professional access. Contacts are audited. Supports 2 free resends per pitch. Catalog promotion annual. Its MyPlay MPE product is a self-serve indie option. (https://www.plaympe.com/?p=20 ; https://blog.symphonic.com/2025/12/02/play-mpes-annual-catalog-promotion-is-back/ ; https://www.radioworld.com/tech-and-gear/my-play-mpe-delivers-songs-to-pd)
- Promo-only, Haulix and similar pools were not researched [gap]. Their typical behaviour: the station receives a download link with track metadata, and tracks have expiry dates set by the label. Model an `embargo_until` field and a `source_pool` field.

## 9. Ingest pipelines

- Channels to support: web bulk upload (resumable, chunked), watch folder (inotify/fswatch with a stability check: wait until size is constant for N seconds), SFTP drop folder (per station), S3 / object storage import (presigned URLs or event notifications), email or API ingest, promo-pool import (Play MPE / Haulix / other APIs or downloads), YouTube/Bandcamp import (legal and terms review needed; many stations use licensed downloads only).
- **AzuraCast** supports web upload, SFTP (Docker) and S3. Known complaints: big uploads fail silently, some m4a uploads fail. Design our uploader with explicit checksums and per-file status.
- **mAirList** auto-importer handles only flat folders, so artist sub-folders are ignored. Use the API for uploads instead. (https://community.mairlist.com/t/auto-importer-sub-folders-or-upload-api/11583)
- mAirList uses MMD sidecar files or file tags on Sync to create the DB entry. Once in the DB, MMD sidecars are not re-read. Decide early whether tags or our DB is the source of truth. We should use our DB as truth and write tags back as an export.
- **Processing pipeline (RabbitMQ jobs):** ingest.received -> validate (format, duration, codec, channels, sample rate) -> probe (ffprobe) -> transcode master (WAV/BWF or FLAC) -> transcode playout (MP3/AAC) -> analyze (loudness, cue, BPM/key) -> fingerprint -> enrich -> dedupe -> publish (available to playlists). Each step idempotent and keyed by content hash and analysis version.

## 10. Transcoding and storage

- Master: 24-bit WAV or BWF (with bext, optional CartChunk, axml, PEAK) or FLAC (lossless, tags, smaller). Keep one format per station policy.
- Playout copy: MP3 or AAC (ADTS or in MP4), 128 to 320 kbps. Liquidsoap decodes both through ffmpeg.
- Sample rate 44.1 or 48 kHz. Keep sample rate consistent with the playout chain (Liquidsoap resampling costs CPU and can introduce subtle artifacts).
- Embed ReplayGain/R128 tags in the playout copy only if the player expects them. Keep the authoritative loudness in the DB.
- Storage: local disk for small stations; S3-compatible object storage for large libraries and multi-node setups. Liquidsoap reads local paths, so cache or sync objects to a local volume before playout (rclone mount or prefetch).
- Checksums (SHA-256) stored in DB. Use content-addressed paths (`/{hash[0:2]}/{hash}.flac`) to avoid collisions and enable dedupe.

## 11. Waveform display and in-browser cue editor

- Precompute peaks on ingest with BBC audiowaveform (`--pixels-per-second 20 --bits 8`, `--split-channels` for stereo). Output JSON or binary .dat. (https://github.com/bbc/waveform-data.js ; https://wavesurfer.xyz/docs/peaks/)
- Client: wavesurfer.js with pre-decoded peaks plus duration, so waveforms render without downloading the full file. Peaks.js (BBC) is an alternative, with regions for cue markers.
- Cue editor UX: draggable markers (in, out, intro, outro, hook, fade in/out, segue start), snap-to-beat once BPM is known, keyboard nudging (10 ms, 100 ms), preview from cue, A/B audition of outgoing/incoming segues.
- Store cues as sample-accurate offsets (or ms with 1 ms precision). Liquidsoap cues are in seconds in metadata, so convert with care and round consistently.

## 12. Categories, tags and search at 100k+ tracks

- Taxonomy: genre (multi-valued), mood/energy (1 to 10 scale), tempo bucket, language, decade, tags (free), station category (rotation categories: current, recurrent, gold, power, etc.), daypart eligibility.
- Search backend: Postgres full-text (GIN trigram for typo tolerance) works up to about 1M rows with proper indexes. Meilisearch or OpenSearch if faceting and typo tolerance are important. Index fields: artist, title, album, isrc, tags, bpm range, key, energy.
- Use keyset pagination (not OFFSET) for large lists. Keep filter facets pre-aggregated.
- Storage of files: keep file metadata in Postgres; avoid putting audio blobs in DB.

## 13. Jingles, imaging, sweepers, liners, beds and voice tracks

[gap: the imaging/jingle search could not be run after the search budget ran out. The notes below are from general broadcast practice, not verified sources.]

- Asset types: jingle (short station ID), sweeper (very short, with station ID), liner (short spoken or musical element), bed (instrumental under voice), imaging package (set of jingles by family and voice), voice track (DJ talk segment, often with intro and outro), promo, PSA, commercial/spot.
- Library needs: asset type, voice/talent, length (duration rounded for clock slots), intro/outro cues, linked bed, allowed dayparts, expiry, version (for recorded re-takes), tags for clock slot matching.
- Voice tracks: the talent record a voice track per show. Track its intro cue (when speech ends and the song can start), outro, and the song it hands off to. This is the "IVP" (intelligent voice tracking) workflow in mAirList and RadioBOSS terms. Store the link `voice_track -> song_slot`.
- Clock/slot model: a clock (format template) defines slot types (song, jingle, liner, spot). Items are chosen by rules (rotation category, tags, length fit). Our library must support slot-fit queries by duration.

## 14. Feature checklist for our product

### Must
- Two-tier storage: lossless master plus playout copy, content-addressed, SHA-256 per file.
- Ingest: web bulk upload (resumable, chunked, checksummed), SFTP drop per station, watch folder with file-stability check, S3 import, API ingest.
- Validation and probing (ffprobe): codec, sample rate, channels, duration, errors surfaced per file.
- Loudness at ingest: integrated LUFS, LRA, true peak; store in DB; compute playout gain at play time.
- Cue points per track: cue-in, cue-out, intro, outro, fade-in, fade-out, segue/overlap start. Source tag (manual or auto). Sample-accurate in DB.
- Automatic cue detection baseline (autocue-like silence and loudness method, MIT-compatible port or wrapper). Configurable thresholds per station.
- BPM and key analysis as async job; store confidence and analyzer version; re-analysis on version bump.
- Metadata model: artist, title, album, year, ISRC, label, genre (multi), mood, energy, tags, cover art, duration, rights, explicit flag.
- Enrichment: ISRC first, MusicBrainz MBID, AcoustID fingerprint lookup (after license clearance), cover art. Provenance per field and operator lock.
- Duplicate detection: exact (hash) and near (Chromaprint), with operator review.
- Start date, kill date (expiry), and daypart restrictions per cut.
- Waveform rendering from precomputed peaks (audiowaveform) and in-browser cue editor with draggable markers.
- Search and filter: text plus facets (genre, tags, bpm range, key, energy, date added, expiry), keyset pagination, indexed.
- Jingles/imaging assets as first-class types with duration and expiry; voice-track assets with intro/outro cues.
- Audit log of edits to cue points and metadata.
- Per-tenant isolation of files and metadata (bucket prefix or per-tenant volume).

### Should
- Rights and territory flags, explicit flag, clean-version linking, embargo dates.
- Promo pool import: Play MPE or other pool downloads, with source_pool field and expiry handling.
- Versions/cuts model: one work, multiple cuts (radio edit, clean, extended), with cut-level scheduling.
- Energy scores from a local signal analyzer (no ML models).
- Multiple intro and outro points per track (competitor feature).
- Beat-grid alignment for segue points; snap-to-beat in the editor.
- Tag write-back export (ID3, Vorbis, R128 and ReplayGain for Opus).
- Bulk edit (multi-select update of genre, tags, expiry, playlists).
- Watch-folder mapping per station with rules (move to done, quarantine on error).
- Storage tiers: hot local cache for playout, cold object storage for masters.
- Search backend that scales past 100k (Postgres GIN trigram or Meilisearch).

### Could
- Voice-activity detection for intro/outro vocal start.
- Automatic key-compatibility suggestions (Camelot wheel) for song-to-song transitions.
- Spectrogram view.
- Promo pool direct API integration beyond download.
- Scheduled re-analysis of whole library after analyzer upgrade with progress UI.
- Peak envelope (BWF PEAK chunk) written into masters.

## 15. Liquidsoap implementation notes

- Metadata passed via the request: `liq_cue_in`, `liq_cue_out` (seconds), `liq_fade_in`, `liq_fade_out`, `liq_amplify` (gain), `liq_cross_start_next`. Verify exact keys for the Liquidsoap version we pin (2.2.x, 2.4.x). Autocue uses these names.
- Use `enable_autocue_metadata()` only if we adopt the autocue approach and accept its CPU cost. Otherwise compute cues in our own pipeline and push them as annotated metadata (`annotate:` protocol or the request API).
- Pin the Liquidsoap version. autocue targets 2.2.5 and is not fully compatible with 2.3.x. 2.4.2 changed autocue `start_next` behavior.
- Prefer explicit `fade.in` / `fade.out` with sin curves plus `cross` with a custom rule function, over bare `crossfade`, to avoid hard-cut edge cases with zero-length queues.
- Use `cross.smart`-style rules (dB thresholds high -15, medium -32, margin 4) as defaults; expose them per station.
- Feed Liquidsoap files from a local cache, not from object storage directly. Liquidsoap resolves paths on the local filesystem.
- Playout copy format: keep decodable by ffmpeg in Liquidsoap. Test MP3 and AAC gapless behavior in our chain before choosing.
- Monitor request resolution time; autocue adds CPU per request. Pre-analyze in our pipeline so Liquidsoap only reads metadata, and skip autocue at runtime.
- Verify whether Liquidsoap reads R128_TRACK_GAIN tags before relying on Opus loudness tags. Our own gain metadata via `liq_amplify` avoids the question.

## 16. Sources (consolidated)

- https://www.liquidsoap.info/doc-dev/crossfade.html
- https://www.liquidsoap.info/doc-2.2.5/crossfade
- https://www.liquidsoap.info/legacy/doc-dev/scripts/smart_crossfade.html
- https://ocaml.org/p/liquidsoap/2.2.5/CHANGES.md.html
- https://ocaml.org/p/liquidsoap/2.4.2/CHANGES.html
- https://github.com/Moonbase59/autocue
- https://www.azuracast.com/docs/user-guide/media-management/
- https://azuracast.com/docs/developers/liquidsoap/
- https://opencollective.ecosyste.ms/collectives/azuracast/issues
- https://www.cartchunk.org/faq.htm
- https://cartchunk.org/techview.htm
- https://www.radioworld.com/?p=90717
- https://knowledgehub.ebu.ch/files/live/sites/tech/files/shared/tech/tech3285.pdf
- https://tech.ebu.ch/publications/tech3285s6
- https://en.wikipedia.org/wiki/Broadcast_Wave_Format
- https://www.loc.gov/preservation/digital/formats/fdd/fdd000357.shtml
- https://knowledgehub.ebu.ch/files/live/sites/tech/files/shared/r/r128s2.pdf
- https://tech.ebu.ch/files/live/sites/tech/files/shared/r/r128s3v1_0.pdf
- https://github.com/dklann/rivendell
- https://mirror.unpad.ac.id/orari/library/library-sw-hw/linux-1/broadcasting/rivendell/docs/rog-0.9.1.pdf
- https://essentia.upf.edu/index.html
- https://essentia.upf.edu/api/docs/tutorial/use-cases
- https://manual.mixxx.org/2.5/ru/chapters/preferences/key_detection
- https://pypi.org/project/mixxx-analyzer/
- https://acoustid.org/webservice
- https://musicbrainz-docs-development.readthedocs.io/en/latest/terminology/terms/acoustid.html
- https://music-assistant.io/audio-analysis/acoustid/
- https://techcrunch.com/2024/11/27/spotify-cuts-developer-access-to-several-of-its-recommendation-features/
- https://community.spotify.com/t5/Spotify-for-Developers/Changes-to-Web-API/m-p/6543247/highlight/true
- https://deezer-python.readthedocs.io/en/stable/api_reference/resources/track.html
- https://github.com/beetbox/beets/issues/2557
- https://pypi.org/project/ffmpeg-normalize/
- https://pypi.org/project/r128gain/0.3.0/
- https://www.mankier.com/1/rsgain
- https://community.mairlist.com/t/auto-importer-sub-folders-or-upload-api/11583
- https://community.mairlist.com/t/suggestions-for-improving-mairlist-music-import-workflow-mainly-checking-setting-fade-points/15904
- https://community.mairlist.com/t/station-playlist-creator-cue-points/7191
- https://www.djsoft.net/community/threads/cue-points.4815/post-23750
- https://www.plaympe.com/?p=20
- https://blog.symphonic.com/2025/12/02/play-mpes-annual-catalog-promotion-is-back/
- https://www.radioworld.com/tech-and-gear/my-play-mpe-delivers-songs-to-pd
- https://github.com/bbc/waveform-data.js
- https://wavesurfer.xyz/docs/peaks/
- https://radiotoday.co.uk/2026/01/myriad-schedule-pro-launches-with-smarter-radio-scheduling/
- https://git.congegni.net/Congegni/sintonia/commit/d2f93f7c8aef0037a87a3e8ad36ea10b2b6be9c8
