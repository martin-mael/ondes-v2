# 07 - Legal compliance, royalties & logging (webradio)

Scope: France/EU first (user is French), then UK, then US. Each claim is tagged:
**[V]** verified in a fetched source during this research, **[P]** partially verified (search snippet only), **[U]** unverified / background knowledge that must be checked before shipping. Dates reflect a search run in October 2026; several rate and form details change yearly.

---

## 1. France

### 1.1 Musical rights: SACEM (compositions) and SPRE (neighbouring rights)

- **Two separate rights.** A webradio playing music needs (a) author/publisher rights for the composition (SACEM, or the relevant society) and (b) neighbouring rights for the recording (producers and performers), which are collected through the statutory *rémunération équitable* scheme. [P]
- **SACEM webradio offer** (page on sacem.lu, the Luxembourg branch, which covers France, Luxembourg and Monaco). [V] https://www.sacem.lu/en/music-users/internet-multimedia/webradio-webtv
  - **Small internet radio:** flat fee **80 EUR excl. VAT per broadcast channel per year**, payable in advance (VAT 3%). Eligibility: private individuals, associations, foundations, local authorities, public bodies with **no income and yearly expenses <= 20,000 EUR excl. VAT, or yearly income <= 20,000 EUR excl. VAT**.
  - **Corporate internet radio:** **12% of income** (advertising, partnerships, sponsoring included), **minimum 60 EUR excl. VAT per channel**.
  - **WebTV:** "according to your project" (no public tariff).
  - Licence scope: reproduction + performing rights for streaming. **Listeners must not be able to download, alter the programme's composition, or select parts of it on demand** (= no on-demand/replay features without a different licence). Brand-linked promotional webradio requires a separate licence.
  - If commercial recordings are used (incl. self-produced singles/albums), a licence from the producers is **also** required. [V]
  - **Playlist declaration / reporting frequency / record retention: not stated on the page.** [V, gap] -> must be confirmed by contacting SACEM directly.
- **SPRE declaration (*bordereau de déclaration radio*).** SPRE publishes a yearly radio declaration form (version seen dated 12/2018 on spre.fr). It states that a declaration without supporting documents is not accepted, and that SPRE retains the data **10 years** after the accounting year closes. [P] https://www.spre.fr/wp-content/uploads/2021/09/Bordereau-de-declaration-radio.pdf
- **Rémunération équitable (art. L214-1 CPI).** Created 1985. Extended to internet radio by **Law 2016-925 of 7 July 2016**. Minister's order of 13 Feb 2017 set up the webradio specialised formation. Constitutionality upheld 4 Aug 2017 (Conseil constitutionnel); Conseil d'État rejected SCPP/SPPF challenge on 30 May 2018 (CE, n° 408785). [V] https://cms.law/en/fra/publication/mise-en-aeuvre-du-dispositif-de-remuneration-equitable-pour-les-webradios
  - Payers pay the **SPRE** (Société pour la perception de la rémunération équitable). Money is split 50% performers (ADAMI, SPEDIDAM), 50% producers (SCPP, SPPF). [P]
  - Webradio tariffs are set by a specialised commission; amounts were not found. [U]
  - **Action:** check the current SPRE tariff for "webradio" and whether there is a small-operator flat rate or minimum; the 2024-2026 barème was not retrieved.

### 1.2 Arcom (ex-CSA) status of a webradio

- A radio distributed on networks **not using hertzian frequencies** (internet, cable, satellite, ADSL) is not licensed but **declared** to Arcom. [V] https://www.arcom.fr/sites/default/files/2022-12/Formulaire_declaration_webradio.pdf (7-page form, Word, Sept 2022; the contents are binary-encoded in the PDF and could not be extracted, so the field list below is from search snippets [P]).
  - Declaration file contents [P]: **detailed programme grid (grille des programmes)** of the service, dated and signed articles of association (statuts), proof of legal existence of the publishing entity, **annual forecast budget**, and **previous financial year's accounts**.
  - Arcom decides within **2 months** of receiving a complete file. Submission preferably by email to **webradio@arcom.fr**, otherwise by post. [P]
  - Arcom publishes "web radio X declared" acknowledgements on its site (e.g. Izotop, Ondes bleues, Réa FM, Radio Hondelatte, Hits 1) - useful as examples of the outcome. [P]
- **French-language song quota (40%)**: Law of 30 Sept 1986 art. 28 applies to *services authorised by Arcom* (hertzian and similar). Arcom's quota pages (2022-2025 decisions) only describe private radio. [V on the quota text] The search found **no source saying the quota applies to declared webradios**. My reading: because a declared webradio is not an authorised service, the 40% quota does not apply to it; **[U] - confirm with Arcom (webradio@arcom.fr) in writing.** Quota facts for reference: 40% French-expression songs, half from new talent/new productions, during significant listening hours (06:30-22:30 Mon-Fri, 08:00-22:30 weekends); reduced quota for music-dominant services down to 35% / 30%; "chanson d'expression française" = more than half of the duration is sung text in French or a regional language used in France. [V] https://www.arcom.fr/en/about-us-our-missions/promoting-and-protecting-content-creation-production-and-distribution/song-quotas-radio
- **Recording / air-check retention in France: NOT FOUND.** Searches returned Romania (30 days), North Macedonia (60 days), Canada (4 weeks for CRTC logs as of 2015-2026), and an old US FCC proposal (60-90 days). **[U] No French rule was located.** Practical recommendation (not a legal claim): keep a full-audio air-check plus the as-run log for at least **the period a complaint or Arcom request can reasonably arrive (suggest 3 months)**, and confirm with Arcom and a lawyer; see section 6.

### 1.3 GDPR / ePrivacy / cookies / listener data

- **CNIL audience-measurement exemption** (sheet n°16, updated July 2025): an audience-measurement tracker is exempt from consent (opt-out regime instead) only if strict conditions hold: purpose limited to measuring the publisher's own audience, anonymous statistics only, no cross-referencing with other processing, no third-party sharing, no tracking across sites/apps, last byte of IP truncated, lifetime capped at **13 months**, user informed and able to object. [V] https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications and https://www.cnil.fr/fr/solutions-pour-la-mesure-daudience
  - No CNIL guidance specific to audio players/webradio was found. [P]
  - **Implication:** the listener-facing player must not embed third-party ad/analytics trackers (e.g. Google Analytics without consent, Spotify-style pixels) unless consent is collected. Server-side, first-party, anonymised counters (listener count per mount) fit the exemption.
- **Logs contain personal data**: IP addresses in Icecast/Liquidsoap listener logs are personal data. Define a retention period (suggest 13 months max or shorter), document in the RoPA (art. 30 GDPR), and pseudonymise / truncate IPs for analytics.
- **DSA** (EU Digital Services Act): mostly relevant if user-generated content (listener requests, comments, chat) is hosted. [U] Not researched further.

### 1.4 Other French obligations (not researched, flagged)
- SIREN / legal entity for the publisher; **director of publication** (directeur de publication) requirement for online media; mentions légales on the site (LCEN art. 6). [U]
- Accessibility (RGAA) if the management app is offered to third parties; public-sector clients. [U]
- Multi-tenant: each tenant (station) is its own declared service, its own SACEM/SPRE/Arcom file and its own SoundExchange/UK filings if applicable. Product implication: tenant-level compliance profile.

---

## 2. EU (other countries)

### 2.1 Germany - GEMA + GVL
- A German webradio playing works of GEMA members (or of foreign sister societies' repertoire not covered by the platform) needs a GEMA licence in addition to the platform's; OLG Munich and LG Cologne/Munich confirmed this in 2015. [P] https://www.teltarif.de/intern/action/print/internetradio-multimedia-streaming/news/60123.html
- Operators must register with **GEMA** (compositions) and **GVL** (recordings). [V] https://gvl.de/en/rights-users/licensing-gvl/web-radio-and-instore-radio
- Current GEMA webradio tariff and playlist-reporting format: **not found** [U]. Check gema.de "Webradio" tariff page.

### 2.2 Other EU societies (SABAM, SIAE, SGAE, etc.)
- Not researched in depth. General principle: each territory of reception needs a licence. Geo-restricted streams (IP-blocking outside the licensed territory, typically France/Lux/Monaco for SACEM) are the usual approach. [U]
- Cross-border: a French SACEM licence covers only the territories of the licence. An EU-wide webradio needs multi-territory licensing (often via a platform such as Live365 or Triton with rights in several countries). [U]

### 2.3 Reporting in EU
- Most EU societies require a **playlist/programme declaration** (titles, authors/ISWC, performers, label/producer, ISRC, duration, start time, channel) for distribution, typically monthly or quarterly. Exact formats per society were not retrieved. [U]
- Practical standard: ISRC for recordings, ISWC for works, plus duration and start time, which covers almost every format. [U]

---

## 3. United Kingdom

- **PRS for Music - Internet Radio Licence** (compositions). [P] Consultation proposed: annual minimum fee for hobbyist stations (no reporting after purchase, number of streams covered aligned to PPL's 150,000 streams/year). Over-allowance stations pay per stream and **report quarterly**. Final summary: ad-supported stations move to a **listener-hour** basis instead of per-stream reporting; new Internet Radio Licence launched **1 October 2025**; reporting templates sent after application. The annual minimum figure differs between consultation and final summary (GBP 188 vs 193 quoted) - verify on prsformusic.com. Sources: https://prsformusic.com/-/media/files/prs-for-music/consultations/internet-radio-consultation.pdf and https://www.prsformusic.com/-/media/files/prs-for-music/consultations/internet-radio-licence-consultation-response-summary.pdf
  - PRS may ask for a **6- or 12-month report** from stations inside the minimum fee to verify.
- **PPL - Linear Webcast Licence** (recordings). [P] https://www.ppluk.com/licensing/playing-music-online/linear-webcast-licence/
  - Reporting depends on the licence band: **Bands 1 and 2 report twice a year, Band 3 quarterly**. Band 3 also needs **quarterly music usage reports**, usually exported from the playout system. PPL emails when reporting is due.
- UK webradios generally need **both** PRS and PPL. [P]

---

## 4. United States

### 4.1 Statutory licence (SoundExchange) - sound recordings (performance right, 17 USC 114 / 37 CFR Part 370, 380)
- **Who:** non-interactive, internet-only webcasters (commercial). The statutory licence covers the performance of sound recordings **only**, not compositions (those need ASCAP/BMI/SESAC/GMR). It does **not** cover on-demand or interactive services. [P]
- **Report of Use content** (37 CFR 370.4(d)(2), as quoted from the rules) [V] https://www.law.cornell.edu/cfr/text/37/370.4 - fields, in this order, for each recording:
  1. name of the service (and filing entity if different),
  2. category transmission code,
  3. featured artist,
  4. sound recording title,
  5. **ISRC**, or if none, **album title + marketing label**,
  6. **actual total performances** of the recording in the period (most services), or for eligible small/minimum-fee services: total performances **or** Aggregate Tuning Hours (ATH) + channel/programme name + play frequency ("spins").
  - A performance = each instance in which any part of a recording is transmitted to a unique listener. **Listener-based counting, not play-based.** [V] https://www.soundexchange.com/service-provider/reporting-requirements/
  - A **signed officer statement "under penalty of perjury"** is required (name, title, date). [V]
- **Frequency:** Track identification / Reports of Use are monthly. Deadline-in-days was not confirmed on the SoundExchange page; the monthly memos cited in search snippets say **45 days after month end** [P] (https://www.soundexchange.com/wp-content/uploads/2022/11/Memo-to-Commercial-Webcasters-Re-2021-Obligations_Final-7-28-2021.pdf). Some memos state 2023-2024 year-round census reporting for most commercial webcasters, with aggregate ATH not accepted for them. [P]
- **Formats:** ASCII text files; no hard copy. Upload via Licensee Direct portal; email attachment if < 200,000 lines; **FTP** if larger (credentials by email). Excel template exists but must be exported to text by its macro. [V]
- **Late fees:** 1.5%/month (1.0% for business establishment services) on late payments/statements. [V]
- **Retention:** 37 CFR 370.4(d)(6) requires keeping a copy of each Report of Use **at least 3 years** from service/posting. Server logs for noncommercial educational webcasters must also be kept for 3 years (370.4 subsection on logs; same 3-year figure in search snippets). [V for ROU; P for logs] Practical: keep logs and ROUs for **at least 3 years**.
- **ISRC lookup:** SoundExchange free ISRC Search site (isrc.soundexchange.com), bulk Repertoire Matching Service via Licensee Direct, and a Repertoire Search API on request. [V]
- **Minimum fee / rates:** per-station minimum fees and per-performance rates are updated by CRB cost-of-living adjustments (Federal Register notice 2023-26221 referenced for webcaster rates). [P] Exact 2026 values not retrieved.
- **Election / waiver:** some categories can waive Reports of Use by paying an election/waiver fee. [V]
- **Noncommercial educational webcasters** may use sample-based reporting. [P]

### 4.2 Sound recording performance complement ("DMCA limits")
- Source: 17 USC 114(d)(2)(C) [V] https://askcbi.org/webcasting-information/sound-recording-performance-complement/
  - In any **3-hour period on a given channel**:
  - **No more than 3 selections from any one album/box set/phonorecord**, and **no more than 2 of them consecutively**.
  - **No more than 4 selections by the same featured artist**, or from a set/compilation distributed as a unit, and **no more than 3 consecutively**.
  - **Intent clause:** going over these numbers still qualifies if the programming was "not willfully intended to avoid the numerical limitations" (for multi-album playlists).
  - Pre-announcing the next track (titles/times) is restricted by the DMCA (not verified on this page; standard webcaster rule [U]).
- Implementation implication: the scheduler must enforce these limits per channel per rolling 3-hour window (album, artist, consecutive rules). Tie to ISRC/album metadata and a "rule engine" in the playlist generator, not just a post-hoc check.
- Note: the statute's performance-complement limits apply to non-interactive streams; on-demand/replay is out of scope of the statutory licence. [P]
- Compilations and tribute shows can hit the limits; a 2014 comment asked Congress for relief. [P]

### 4.3 US composition licences (ASCAP, BMI, SESAC, GMR)
- Not researched in detail. Webcasters typically license compositions from all four PROs; GMR and others added over time. Live365's bundled coverage list (2025) includes ASCAP, BMI, SESAC, GMR, Word Collections, AllTrack. [P]
- Census/reporting formats for PROs (ASCAP/BMI "cue sheets" and per-play logs, typically monthly or quarterly; "census" = full play log) were **not verified** [U].

---

## 5. Logging & as-run data: what to record

Minimum per-play record (union of French, UK, US needs). Recommend storing as a `playlog` table (one row per play per channel, with `started_at` UTC + timezone, `ended_at`/`duration`):

| Field | Why | Source |
|---|---|---|
| channel/station id, mount | multi-tenant, per-channel limits | our system |
| started_at (UTC), duration, timezone | Reports of Use, PRS/SACEM, complaints | Liquidsoap `on_metadata`/`on_track` callbacks |
| title, artist, featured artist, album, label | SoundExchange report, SACEM/SPRE declarations | file tags / library DB |
| **ISRC** (recording) | SoundExchange ROU preferred identifier; PPL/PRS | library DB, ISRC lookup |
| **ISWC** (composition) | SACEM/PRS/GEMA composition reporting | library DB / society database |
| composer/author, publisher, performer, producer | SACEM/PRS/GEMA lists | library DB |
| source type (playlist / jingle / live / voice-track / ad) | rights vs non-music separation; jingles and ads are exempt from music reporting | playout origin tag |
| listener count at start (or per-performance listener events) | SoundExchange **listener-based** performance counting | listener stats (Icecast/Liquidsoap) |
| channel transmission category / rule-set id | SoundExchange category codes | config |
| file hash / file id | dispute resolution, proof | library DB |
| signed as-run export id | audit trail | generated |

- **As-run log**: the exact log of what aired (including jingles, ads, live segments, interruptions, failed/skipped tracks). Keep in an append-only table; never overwrite. Needed for SACEM/SPRE disputes, Arcom requests and CRB audits.
- **Air-check / recording** (full audio of what was broadcast): record each channel continuously (e.g. Liquidsoap `output.file` with hourly rotation, or a separate recorder). Retention **[U]**: no French rule found; propose 30 days hot + 3 months cold, configurable per tenant, with legal-hold flag. This is the "logger" function that professional systems (ENCO, WideOrbit, mAirList/Myriad) provide.
- **Timestamp discipline**: store UTC, keep the exact on-air instant (Liquidsoap clock), and align the listener-count log to the same clock. LibreTime users report that playout history and listener stats do not line up by timestamp (forum thread), which breaks per-performance counts. [P]
- **Counting rule**: SoundExchange counts **per unique listener per performance**. Our listener stats must support: start timestamp, end timestamp, anonymous listener id (e.g. hashed session key, not IP), so distinct listeners per track can be computed. Requires sessions with stable IDs, not just connection counts. [V on rule, U on implementation]

---

## 6. Open-source tools and royalty reporting

- **AzuraCast**: no built-in SoundExchange Report of Use export was found. A GitHub feature request titled "Generate SoundExchange report for broadcast royalty payments" (opened ~7 years ago, maintainer-raised) exists; its status was not confirmed. [P] Check AzuraCast's GitHub issues / release notes before assuming. Its play-history data can serve as a base.
- **LibreTime**: forum thread (discourse.libretime.org/t/generating-reports-for-soundexchange-bmi-etc/165) says SoundExchange and PRO reports are **manual**; the playout-history and listener-stat exports do not correspond by timestamp, making per-listener counts hard. No merged feature was found. [P]
- **Liquidsoap** itself: no royalty reporting; you build it from metadata callbacks (see section 8). [U]
- **mAirList** (commercial): community thread on exporting played-track metadata to CSV for collecting societies (fields: title, artist, label, air date/time, duration, ISRC) via custom attributes; no official SoundExchange export confirmed. [P] https://community.mairlist.com/t/exporting-metadata-to-csv-for-collecting-societies-reporting-log-file-line-format/18561
- **ENCO DAD**: has built-in SoundExchange report formatting (per search snippet). [P]
- **PlayIt Software**: feature request for a SoundExchange/Spinitron log export with ISRC was marked complete in newer versions that store ISRC on tracks. [P]

---

## 7. Commercial services that bundle licensing / reporting

| Service | Licensing bundled? | Reporting | Notes |
|---|---|---|---|
| **Live365** | Yes, in royalty-included plans. US: SoundExchange, ASCAP, BMI, SESAC, GMR, Word, AllTrack; plus UK, Canada, Mexico rights bodies (2025 letter). Also accepts the station's own SoundExchange licence. [P] | Platform-side | Coverage ends with the subscription; need own licences before leaving. Entry tier $59 cited; 2026 price change effective 1 Sept 2026 [P]. |
| **Triton Digital** | Via its royalty product for broadcasters | Royalty Explore query + export; broadcaster admins submit directly to SoundExchange; exports include inclusions only [P] | https://help.tritondigital.com/docs/royalty-reporting |
| **Radio.co** | **No** - vendor blog says the broadcaster must obtain its own webcasting licences (SoundExchange plus ASCAP, BMI, SESAC). [P] | No SoundExchange auto-report confirmed. [U] | |
| **SoundStack** | n/a | Automated monthly SoundExchange submissions over FTP, from its Insights platform [P] | https://rainnews.com/?p=47289 |
| **Nobex (Spinitron/ Nobex Partners)** | n/a | Play-history export to CSV Report of Use draft; pulls ISRCs from library tags; draft to verify, not a final filing [P] | |
| **RadioKing** | Unknown (no evidence found either way) [U] | | |
| **SoundExchange Direct / Licensee Direct** | Licence itself | Portal upload; usage indicator in My Catalog [P] | |

Product implication: most small operators outsource royalty reporting to a platform bundle or a SoundStack-style service. Our product can differentiate by (1) generating the **SoundExchange Report of Use file** (ASCII, correct field order) and the **SACEM/SPRE/PRS/PPL** monthly/quarterly exports, (2) enforcing the 3-hour performance complement at scheduling time, and (3) exposing per-tenant "licence profile" (which societies apply, which territories, which reporting cadence).

---

## 8. Liquidsoap implementation notes (logging & compliance)

These are design suggestions, not verified against the Liquidsoap docs in this session. [U] Verify function names in the Liquidsoap manual before implementing.

- **Metadata capture**: attach an `on_metadata` / `on_track` handler on each source to push a playlog row (title, artist, ISRC, file id, started_at) to the Node backend or RabbitMQ. Use `request.metadata` / `m["isrc"]` if ISRC is tagged in the file (ID3 TSRC frame / Vorbis ISRC). [U]
- **Source classification**: tag sources (`playlist`, `jingle`, `ad`, `voice`, `live`) so non-music is excluded from the music reports. [U]
- **Air-check**: `output.file` with `reopen_on_metadata` or hourly rotation (`%Y-%m-%d-%H.mp3`) per channel; keep separate from the stream encoder so a stream outage does not lose the recording. [U]
- **Listener stats**: Icecast's `listeners` stats + per-listener events (connect/disconnect with session id) rather than polling counts only; align with the Liquidsoap clock (`time.unix()`). [U]
- **Enforcing performance complement**: implement in the playlist generator (the "request/rule" source or the Node scheduler) rather than inside Liquidsoap; Liquidsoap's `playlist` modes (randomize, `reload`) do not know album/artist counts, so the scheduler must pre-compute the sequence and push it.
- **Clock/timezone**: run everything in UTC; convert to Europe/Paris only for display and for SACEM/Arcom report periods.

---

## 9. Feature checklist for our product

### MUST
- Per-tenant **compliance profile**: societies applicable (SACEM/SPRE, GEMA/GVL, PRS/PPL, SoundExchange, ASCAP/BMI/SESAC/GMR), territories, reporting cadence, licence numbers, expiry dates with alerts.
- **Append-only as-run / playlog** with UTC timestamps, ISRC, ISWC, composer, publisher, performer, producer, album, label, duration, source type, channel id, file hash.
- **Music vs non-music separation** (jingles, ads, voice-tracks, live segments excluded from music reports).
- **Performance complement enforcement** (US): max 3 per album, max 2 consecutive; max 4 per featured artist, max 3 consecutive; per channel, per rolling 3-hour window; no pre-announcing / no on-demand selection on the statutory channel.
- **Listener-based performance counting** (distinct listener per track) for SoundExchange; anonymous session ids; no IP storage beyond the retention period.
- **SoundExchange Report of Use generator**: ASCII file, exact field order (service name, category code, featured artist, title, ISRC or album+label, actual total performances or ATH/spins), monthly, signed officer statement, 3-year retention.
- **Air-check recording** per channel with retention policy (configurable, legal hold).
- **Retention policy** per data class (logs, air-checks, ROUs = 3 years min for US; SPRE data 10 years on their side; personal data minimised per GDPR).
- **Cookie-free player by default**; any analytics must meet the CNIL audience-measurement exemption (13-month lifetime, anonymous, first-party), else consent banner (decline by default).
- **Audit export** (as-run log + ROU + SACEM/SPRE declaration) per period, signed-off by the operator.

### SHOULD
- **Auto-generated SACEM / SPRE declarations** (CSV/XLS per the forms; confirm formats with SACEM/SPRE first).
- **PRS/PPL** monthly/quarterly/half-yearly report templates by licence band; listener-hour computation.
- **GEMA / GVL** reporting templates (once tariffs and formats are confirmed).
- **Geo-blocking** by listener country (licensed territories only) and per-territory play logs.
- **ISRC/ISWC enrichment** (lookup via SoundExchange ISRC search/API; ISWC lookup via society databases) and a missing-metadata queue before filing.
- **Deadline calendar** with reminders (SoundExchange monthly, PPL/PRS per band, Arcom annual declaration updates).
- **Rule engine** for the 3-hour complement and for French-song quotas (in case a tenant is an Arcom-authorised service, quota reporting = 40%, significant hours 06:30-22:30 Mon-Fri, 08:00-22:30 weekends).

### COULD
- Automated **Arcom declaration pack** (statuts, budget, accounts templates) for webradio applicants.
- **Pre-filled Arcom/SPRE forms** from tenant data.
- **DSA** moderation hooks if listeners can post requests or comments.
- **Automatic SoundExchange Direct submission** via API (only if SoundExchange exposes it - not verified).
- **Spinitron / Nobex-compatible exports** for interoperability.

---

## 10. Gaps and next steps (must be closed before go-live)

1. **Confirm with Arcom (webradio@arcom.fr)** whether the 40% French-song quota and any recording/retention duty apply to a declared webradio. [Highest priority]
2. **Confirm with SACEM** the webradio playlist declaration format, frequency and retention (the sacem.lu page omits them).
3. **Get current SPRE webradio tariff and declaration deadlines** (spre.fr).
4. **Confirm the French air-check retention rule** (Légifrance; Arcom "conservation des enregistrements").
5. **Pull the current 37 CFR 370.4 / 380 texts** (eCFR redirect was not followed; Federal Register 2026 version is the reference) and the **2026 SoundExchange monthly memo** (PDFs were binary-encoded and unreadable through WebFetch; open them in a PDF tool).
6. **GEMA** webradio tariff and playlist format; **PRS** current Internet Radio Licence page (figures differ between consultation and final).
7. **ASCAP / BMI / SESAC / GMR** webcaster reporting formats (not researched).
8. **Liquidsoap** metadata/ISRC tag support and callback names (verify in the manual).
9. Consult a French media lawyer for the director-of-publication, mentions légales and retention questions.

## Sources (inline above). Key primary links:
- SACEM webradio: https://www.sacem.lu/en/music-users/internet-multimedia/webradio-webtv
- Arcom webradio declaration form: https://www.arcom.fr/sites/default/files/2022-12/Formulaire_declaration_webradio.pdf
- Arcom song quotas: https://www.arcom.fr/en/about-us-our-missions/promoting-and-protecting-content-creation-production-and-distribution/song-quotas-radio
- SPRE radio form: https://www.spre.fr/wp-content/uploads/2021/09/Bordereau-de-declaration-radio.pdf
- CMS on rémunération équitable: https://cms.law/en/fra/publication/mise-en-aeuvre-du-dispositif-de-remuneration-equitable-pour-les-webradios
- CNIL sheet 16: https://www.cnil.fr/en/sheet-ndeg16-use-analytics-your-websites-and-applications
- 37 CFR 370.4 (Cornell): https://www.law.cornell.edu/cfr/text/37/370.4
- SoundExchange reporting requirements: https://www.soundexchange.com/service-provider/reporting-requirements/
- Performance complement (CBI): https://askcbi.org/webcasting-information/sound-recording-performance-complement/
- PRS internet radio consultation: https://prsformusic.com/-/media/files/prs-for-music/consultations/internet-radio-consultation.pdf
- PPL linear webcast: https://www.ppluk.com/licensing/playing-music-online/linear-webcast-licence/
- GVL webradio: https://gvl.de/en/rights-users/licensing-gvl/web-radio-and-instore-radio
- LibreTime forum: https://discourse.libretime.org/t/generating-reports-for-soundexchange-bmi-etc/165
- mAirList forum: https://community.mairlist.com/t/exporting-metadata-to-csv-for-collecting-societies-reporting-log-file-line-format/18561
