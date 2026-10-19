# Research 12: Platform architecture, reliability, operations and multi-tenancy (radio SaaS / self-hosted)

Scope: reliability and monitoring, running many Liquidsoap instances, multi-tenancy and RBAC, Node.js + RabbitMQ job design, deployment (installer, Docker, TLS, backups, sizing).

Confidence legend: **[V]** verified in a fetched primary/official source; **[S]** search-snippet only; **[K]** from general knowledge, not verified in this session.

---

## 1. Reliability and "broadcast-grade" operation

### 1.1 What uptime means
- **[K]** Broadcast practice: the target is "no dead air" rather than an abstract uptime percentage. A station is considered off-air the moment the output stops or goes silent, so the relevant metric is continuous-output time and time-to-recover (MTTR in seconds), not monthly availability. Plan for seconds-level failover, not minutes.
- **[V]** Liquidsoap's own model enforces this: outputs require an *infallible* source. On startup each output checks its input's liveness type and errors if it is fallible. Outputs must stay infallible so the stream keeps running. Source: https://www.liquidsoap.info/doc-dev/sources.html
- **[V]** `fallible=true` on an output lets it run with a fallible source, but the output then stops when the source fails and restarts when it is ready again. This is an explicit gap in the stream, so use it only where a gap is acceptable. Same source.

### 1.2 Redundancy patterns for Liquidsoap
- **[V] Ordered source fallback inside the script** (the core pattern): `fallback()` plays the first available input; the last element is an infallible "security" source (for example `single()` on a local file). `mksafe()` turns a fallible source into silence on failure. `playlist.safe()` is a checked-playlist alternative. Source: https://www.liquidsoap.info/doc-dev/sources.html
- **[V] Radio France's production pattern** (`radiofrance/rf-liquidsoap`, 77 stations): each station runs one Liquidsoap process fed by *several SRT inputs taking different network paths*. An ordered auto-fallback loop picks the first healthy input; some inputs are excluded from auto-fallback and switched manually for maintenance. With no input at all, the main loop emits blank audio so the output stays up. Output chain: SRT inputs -> fallback selection -> one `radio_prod` source -> encoders (several profiles: mp3, aac, libfdk-aac) -> outputs in parallel (Icecast push, HLS segments written locally and served by nginx; optional push to an external segment forwarder). Source: https://github.com/radiofrance/rf-liquidsoap/blob/master/README.md
- **[V] Harbor (live input) priority**: a `fallback` with a live harbor source before a music source, with `track_sensitive=false`, gives live input priority when present. Source: https://www.shoutcastnet.com/school/liquidsoap.php (via search snippet [S]); harbor docs https://www.liquidsoap.info/doc-2.4.5/harbor
- **[S] Hot standby (second Liquidsoap instance taking over automatically)**: no authoritative documentation found in this session. Practical options: (a) run two Liquidsoap instances in *separate containers on separate hosts* each pulling the same SRT/Icecast feed and expose a "which one is live" flag at the Icecast level (Icecast `fallback-mount` chaining, see 1.3); (b) Radio France's approach at the input level (redundant *inputs*, not redundant *engines*). Recommendation: prefer (b) inside one engine plus (a) only for hardware/host failure.
- **[K] Dual encoders**: a second encoder to a different Icecast mount or a separate mount "backup" is simplest; encoding is cheap relative to decoding (see 2.4).

### 1.3 Icecast-level failover ("emergency audio at the Icecast level")
- **[V] Glossary**: a fallback mountpoint is configured with a parent mountpoint; if the parent drops, Icecast moves all clients connected to it onto the fallback mount. Source: https://www.icecast.org/docs/icecast-2.4.1/glossary.html
- **[V] Chaining**: fallbacks can cascade across several mounts (multi-level fallback). Source: https://lists.xiph.org/pipermail/commits/2004-October/006138.html (2004 commit, old but the mechanism is still present).
- **[V] `fallback-override`**: when the primary mount reconnects, listeners are moved back to it. Without it, listeners must reconnect manually. Sources: https://lists.xiph.org/pipermail/icecast/2015-November/013565.html ; LibreTime handover guide https://git.congegni.net/Congegni/sintonia/src/commit/0766b91cde4bce4ad9a2d4d4d7706d646bb38a86/docs/manual/icecast-handover/index.md
- **[V] Three-tier pattern (LibreTime handover)**: public stream -> live mount (if available) -> playout mount (Liquidsoap automation as last resort). Same guide.
- **[S] Gotchas from the Icecast list**: mount and fallback should be the **same format/bitrate**; mismatches confuse players and Icecast may refuse to switch (https://lists.xiph.org/pipermail/icecast/2017-May/013928.html). `fallback-override` reportedly did not work on a *relay* mount with a local fallback on 2.4.1 (https://lists.xiph.org/pipermail/icecast/2018-August/014277.html); the docs advise file-based fallback on relay slaves, not the master. Some players do not handle a mid-stream switch gracefully (https://lists.xiph.org/pipermail/icecast/2019-April/014591.html).
- **[K] Practical design**: keep the emergency loop *in Liquidsoap* (a `single()` infallible file with station-branded "we'll be right back" audio) and make Icecast's job just the last-resort mount. Do not rely on Icecast's own fallback alone for silence/bad audio, because it only triggers when the *source disconnects*, not when audio is silent.

### 1.4 Automatic restart / watchdogs
- **[V] Liquidsoap Icecast output**: `restart=true` controls output reconnection, not request sources. Liquidsoap tries once to reconnect, then fails and shuts down unless a more tolerant mode is set. Source: https://www.liquidsoap.info/doc-2.2.5/quick_start (via search [S]).
- **[S] `request.dynamic` / `request.queue` failure semantics**: NOT documented in what I could read. A failed request prepared from a request queue falls through to the next fallback input (playlist), so the stream does not go dead, but I could not confirm the exact restart behaviour. Verify against the Liquidsoap reference for request sources.
- **[S] systemd**: `Restart=on-failure` + `StartLimitIntervalSec=300s` / `StartLimitBurst=5` to prevent restart storms; `WatchdogSec=` requires the process to send `sd_notify("WATCHDOG=1")`, which Liquidsoap does not do natively (wrapper needed). Known issue: an `ExecStop` may not run after a watchdog-triggered failure, which can leave duplicates (https://bugs.freedesktop.org/show_bug.cgi?id=56109). Sources: https://www.schelstraete.org/post/systemd-automatically-restart-after-failure
- **[K] Recommendation**: run each Liquidsoap process under a supervisor that restarts on exit and on *functional* health failure (metrics-based: `liquidsoap_source_is_playing == 0` or `..._is_blank == 1` for N seconds triggers restart of that station's container). Docker `restart: unless-stopped` covers crashes only; a `HEALTHCHECK` plus an external controller covers silence/hangs. No Liquidsoap-specific Docker HEALTHCHECK example was found.

### 1.5 Monitoring, alerting, logging
- **[V] Liquidsoap built-in Prometheus exporter** (optional build with mirage/prometheus). Enable via `settings.prometheus.server := true` and `settings.prometheus.server.port := <port>`. Default port differs in docs: 9599 (dev docs) vs 9090 (2.2.5 docs). Custom metrics via `prometheus.gauge`, `prometheus.counter`, `prometheus.summary`; built-in `prometheus.latency` produces `liquidsoap_input_latency` / output / overall mean/max/peak. The docs say enabling metrics has a CPU cost that grows with the number of tracked sources. Sources: https://www.liquidsoap.info/doc-dev/prometheus.html ; https://www.liquidsoap.info/doc-2.2.5/prometheus.html
- **[V] Metric names used in production (Radio France)**: `liquidsoap_source_is_blank`, `liquidsoap_source_is_playing`, `liquidsoap_source_is_ready`, `liquidsoap_source_is_preferred_livesource` (gauges); `liquidsoap_source_unready_duration_seconds` (counter); `liquidsoap_time_of_last_data_timestamp` (gauge); `liquidsoap_output_lufs_5s` (gauge, loudness); `liquidsoap_hlssegment_sent` (counter); `liquidsoap_srt_input_*` (buffer, bytes available, packet loss, drops). Source: https://github.com/radiofrance/rf-liquidsoap/blob/master/README.md
- **[V] Radio France stack**: Prometheus (9090), Grafana (3000, provisioned example dashboards), Alertmanager (example container). Radio France's HTTP control API on port 7000 exposes `GET /livesource` (preferred output, input list, actual output, blank flag) and `POST` to switch the preferred input. Same README. Dashboards are not a standard import; build per-station panels.
- **[V] Silence / stream checkers**:
  - `streammonitor` (github.com/mdisabato/streammonitor): Python on Alpine, Docker, checks Icecast/AzuraCast streams for availability and silence; publishes **MQTT with Home Assistant discovery** (`binary_sensor.*_status`, `*_silence`), not an HTTP API as originally assumed. 120 commits, MIT, 0 stars, brief README, no release history. Good reference, not a production dependency. Source: https://github.com/mdisabato/streammonitor (fetched page at the AzuraCast-owned mirror path returned summary; repo URL itself returned 404 in fetch, verify).
  - Hosted: Radio Mast (uptime every minute, configurable silence detector, email/Slack/PagerDuty; https://www.radiomast.io/docs/stream-monitoring/quickstart.html), NodePing audio check (paid volume detection; https://nodeping.com/audio_check.html), IsMyStreamUp (StreamGuys) [S].
- **[K] Commercial broadcast monitors** (Inovonics, Sophia) are hardware/IP monitors used for compliance-grade silence/program-loss logging; for SaaS, build "program loss" alerts from Liquidsoap's own `is_blank` gauge plus an external probe (independent HTTP fetch + short decode + level check) so that a failure in the engine itself is still detected from outside.
- **[K] Logging**: Liquidsoap logs to stdout/log file; ship via Docker's logging driver or Loki/Promtail; keep per-station log labels.

**Architectural implication**: alert on (a) the external probe (outside the engine), (b) Liquidsoap blank/unready gauges, (c) Icecast mount listeners = 0 for a live mount, (d) RabbitMQ queue depth and consumer count.

---

## 2. Running many Liquidsoap instances

### 2.1 Process model
- **[V] Radio France**: "supposedly one per station", i.e. one Liquidsoap process per station, started from a per-station script file in `docker-compose.yml`. Shared logic in `scripts/` is a versioned template used by all stations; per-station files define inputs, ports and formats, generated by an external templating tool. Source: https://github.com/radiofrance/rf-liquidsoap/blob/master/README.md
- **[V] AzuraCast**: each station's AutoDJ is a Liquidsoap process; station ports are allocated from a range. Official docs: only the first 50 stations' ports are exposed by default; automatic station port range defaults to 8000–8499 (env-configurable, and ports must be forwarded in docker-compose); custom ports are an advanced feature hidden by default. Sources: https://docs.azuracast.com (search [S]); https://azuracast.com/docs/administration/advanced-features . Supervisord-per-station internals were **not** confirmed in this session [K-unverified]; AzuraCast runs all stations in its single "stations" container with an internal process supervisor.
- **[V] Liquidsoap docs** say the AutoDJ is optimized for producing the broadcast, while listeners connect to the Icecast/SHOUTcast frontend. AzuraCast ensures both are configured and kept running. Source: https://www.azuracast.com/docs/user-guide/station-management/ (search [S]).

### 2.2 Container-per-station vs process-per-station
- **Container per station** (Radio France style, and the SaaS-friendly choice): clean isolation of CPU/RAM (cgroups), independent restarts, per-station port mapping, simple resource accounting; cost is more Docker overhead and more ports to manage (use an internal Docker network and only publish Icecast/HLS through the reverse proxy).
- **Process per station inside one container** (AzuraCast style): fewer containers, lower overhead, but a crash/OOM domain shared across stations and harder per-tenant cgroup limits.
- **[K] Recommendation for us**: one container per station (or per station *pipeline*: Liquidsoap + its local Icecast mount proxy), managed by the Node.js control plane via the Docker Engine API. Keep Icecast as a shared multi-mount server in a separate service if the mount count is manageable; AzuraCast-style single Icecast per host is fine up to dozens of mounts.

### 2.3 Port allocation
- Use an **internal** Docker network for Liquidsoap control (telnet/harbor/metrics) and SRT/harbor inputs; publish only the public listener ports (Icecast/HLS) through Caddy or a shared Icecast front. Radio France exposes control on fixed per-station ports (7000 API, 9090/9599 metrics) which does not scale to thousands of stations without a registry; prefer allocating from a DB-backed pool (AzuraCast-style range, e.g. 8000–8499 with a 50-station default exposure).
- Harbor inputs: `harbor.bind_addr` defaults to `0.0.0.0` (all interfaces), so bind to the internal network explicitly. [V] https://www.liquidsoap.info/doc-2.4.5/harbor (search snippet [S] for the default).

### 2.4 Resource usage per station (what is known)
- **[V] AzuraCast**: each broadcast destination (local mount or push relay) adds about **10% of one CPU core** steady load; listener connections cost far less than transcoding. Ten mounts on one station ≈ one full core; ten stations with one mount each ≈ one full core. Pull relays (AzuraRelay) do not count toward the CPU budget; push relays do. Keep sustained load ≤ 50% of capacity to avoid throttling on shared CPU. Biggest per-station costs: Stereo Tool-style audio processing and extra mount points. Source: https://www.azuracast.com/docs/getting-started/scaling/ (fetched).
- **[V] AzuraCast RAM**: at least 512 MB, preferably > 1 GB for DB + PHP; RAM does not scale linearly with station count (processes plateau). Same source.
- **[V] Liquidsoap memory** (2023 blog): default sample storage is 64-bit floats (8 bytes/sample). `pcm_s16` uses 4x less memory and is "probably enough for most applications". Multitrack mainly raises CPU. Multiple sources cost RAM. Tune with `runtime.gc.set` `space_overhead` (20 = less memory, 80 balanced, 140 less CPU). Source: https://liquidsoap.info/blog/2023-07-09-memory-management . No measured per-station numbers in the post.
- **[V] Encoding**: cookbook recommends `%ffmpeg` encoders for CPU/memory efficiency; one decode feeding several outputs, each with its own encoder. Source: https://www.liquidsoap.info/doc-2.1.0/cookbook.html (search [S]).
- **[K] Budget for planning** (to be benchmarked on our own hardware): with the ~10%-core-per-destination figure, a 2-vCPU VPS sustains roughly 5–8 destinations at ≤50% load, before accounting for decoding and Stereo Tool-type DSP. Benchmark before publishing numbers.

### 2.5 Dynamic configuration and hot reload
- **[V] Liquidsoap controls**: telnet server (`settings.server.telnet := true`, default bind 127.0.0.1, **no authentication**); Unix socket option (`settings.server.socket := true`, `settings.server.socket.path`); harbor HTTP telnet emulation at `/telnet` and interactive-variable UI at `/interactive` (`server.harbor()`, `interactive.harbor()`); `interactive.persistent("vars.json")` persists variable values across restarts. Commands: `var.set name = value`, `var.get`, `var.list`, `request.push`, `request.metadata`, `request.trace`, `request.alive`, `request.on_air`, `uptime`, `version`, responses end with `END`. Source: https://www.liquidsoap.info/doc-dev/server.html (fetched).
- **[V] Security**: Liquidsoap explicitly does not implement auth; the docs recommend an external mechanism (SSH with restricted shell running `socat` against the Unix socket, or an HTTP reverse proxy with login). **Never expose telnet/harbor control to the internet.**
- **[V] Control from Node**: Radio France's pattern is a small HTTP control API in front of Liquidsoap (`/livesource` GET/POST). We should do the same: Node talks to the station's Liquidsoap over a Unix socket (inside the container via a mounted volume) or the internal network, using `var.set` for "switch to live", "set volume", "push request", and reads `request.on_air` / metrics for now-playing.
- **[K] Hot reload**: Liquidsoap does not reload scripts in place for most changes. Prefer: (a) the script reads all dynamic values from interactive variables / request queues / files, so the script itself is static; (b) config changes = render new per-station script, restart *that station's* container at a scheduled quiet moment, using a drain-then-restart procedure (switch to a `single()` safety loop first, then restart). This keeps safe restarts from causing dead air.

### 2.6 Scaling limits
- AzuraCast docs: no universal station count; limited by total resources; ports exposed for first 50 stations by default; no thresholds given for splitting servers. [V] https://www.azuracast.com/docs/getting-started/scaling/
- Radio France: 77 stations (multi-tenant in one ops domain). Source: rf-liquidsoap README.

---

## 3. Multi-tenancy, RBAC, identity and billing

### 3.1 Tenant model (recommended)
- Organization (tenant, billing unit) -> Stations (broadcast unit, owns mounts, media library, schedule, Liquidsoap container) -> Users (memberships with role per org and/or per station). A user can belong to several orgs.
- **[K]** Keep the Liquidsoap container per station; enforce per-org quotas at the control plane (max stations, max bitrate, max mounts, storage GB, listener cap) because Centova and AzuraCast both expose such limits.

### 3.2 Isolation (data, storage, CPU)
- **[V] Docker cgroups**: `--cpus` (hard cap), `--cpu-shares` (relative weight, default 1024), `--memory`. Docker creates a cgroup per container; cgroups v2 is default on modern distros; kernel-memory limits deprecated in v2. Unlimited containers can starve neighbours. Sources (third-party explanations, verify against docs.docker.com): https://notes.kodekloud.com/docs/Docker-Certified-Associate-Exam-Course/Docker-Engine-Security/Resource-Limits-CPU ; https://oneuptime.com/blog/post/2026-02-08-how-to-understand-docker-container-cgroups-in-depth/markdown
- **[K]** Per-station limits: `cpus: 0.5–1.0`, `mem_limit: 512m–1g`, `pids_limit`, read-only root FS, dropped capabilities, non-root user, no privileged mode; separate Docker networks per org.
- **[K]** Storage: per-org media root under a dedicated bind path or volume with a quota (XFS project quotas or per-org S3 prefix with size accounting in DB). Object storage (S3/R2/Wasabi) is recommended for media growth (AzuraCast scaling guide).

### 3.3 RBAC roles for radio
- **[V] AzuraCast permission model** (verified): roles hold permissions; scoped globally or per station. Global: Administer Permissions (required to manage roles), All Permissions (super-user across install), Manage Stations (administer any station). Station: All Permissions (super-user for one station), manage station broadcasting (skip track), manage station media (play now / queue; open Media Manager, but not delete), delete station media. API keys carry the creator's permissions. Streamer/DJ accounts exist for live presenters; browser-based Web DJ for live broadcast. No preset roles named on the docs page. Source: https://azuracast.com/docs/administration/roles-and-permissions/ (fetched)
- **[K] Proposed role set** (mapping to station functions): Org Owner (billing + all stations); Org Admin; Station Manager (all station settings, users, mounts); Program Director (playlists/rotations/clocks, schedule approval); Music Director (media library, metadata, rotation rules, music imports); Presenter/DJ (live input credentials, now-playing, own show slots only, no media deletion); Traffic/Producer (ads/jingles scheduling, commercial logs); Analyst/read-only (stats, listener reports). Granular permissions as `resource:action` strings (e.g. `station.broadcast.skip`, `station.media.queue`, `station.media.delete`, `station.schedule.write`, `station.stream.credentials.rotate`, `org.billing.read`), assigned to roles, scoped to org or station.

### 3.4 Audit logs
- **[K]** Append-only audit table: actor, org, station, action, target, before/after diff, IP, user agent, request id; include system actions (auto-fallback events, scheduler changes, Liquidsoap restarts). Retention policy per plan. Keep separate from the operational event log.

### 3.5 Identity: SSO/OIDC, 2FA, API keys
- **[S] Keycloak vs Authentik**: Keycloak has built-in Organizations (since 26.0 per one comparison), fine-grained admin permissions (26.2), org-scoped admin (26.7); mature and enterprise-oriented but heavier (Java). Authentik has an organizations model, flow stages, lighter to run. Both support RBAC but fine-grained, contextual authorization needs an extra component. Sources: https://guptadeepak.com/compare/keycloak-vs-authentik/ ; https://cerbos.dev/blog/authentik-vs-keycloak-selfhosted-idp-comparison (vendor-sponsored; treat as directional).
- **[K] Recommendation**: build auth on a standard OIDC library (e.g., `openid-client` in Node) and let the app own RBAC and tenancy. Offer OIDC SSO for enterprise orgs by federating to an external IdP; for the self-hosted installer, bundle either Authentik or Keycloak as optional, not required. Implement 2FA (TOTP + WebAuthn) in-app or via the IdP; enforce per-org "require 2FA".
- **[K] API keys**: prefix-tagged random tokens (e.g. `ond_live_...`), store only a hash, scoped to org/station with permissions, rotatable, last-used timestamp (AzuraCast ties API keys to user permissions, a reasonable simpler model).

### 3.6 White-label and reseller billing
- **[V] Centova Cast** (reseller model): Reseller Reference Manual (v3.x) covers the reseller area; admin sees all client accounts, optionally across multiple servers; clients get their own control panel; plans capped by listeners and bitrate; resellers can upgrade/downgrade/suspend plans and choose disk/bitrate/bandwidth; overselling enabled. Sources: https://centova.com/doc/cast/reseller_manual/reference_manual ; https://centova.com/en/cast/tour/host (search snippets [S]).
- **[K] Plan dimensions to meter**: stations, active mounts / outbound destinations (CPU-relevant), max bitrate, listener-hours or peak listeners, media storage GB, transcode minutes, number of seats/users, API calls. Bill on destinations x bitrate (CPU proxy) plus storage and listener-hours.
- **[K] White-label**: custom domain per org (CNAME + Caddy on-demand TLS with an `ask` endpoint that validates the domain against the DB), custom logo/theme, custom stream domain (Icecast `hostname` and `<mount>` URL mapping).

---

## 4. Node.js control plane, RabbitMQ and real-time UI

### 4.1 Why RabbitMQ vs BullMQ (findings from comparison sources [S])
- **BullMQ**: Node library on Redis; built-in retries with backoff (examples: 3 attempts, exponential backoff), delayed jobs, rate limiting, job dependencies; failed jobs land in a "failed" set you query rather than a separate DLX; low operational complexity if Redis already exists. Source: https://oneuptime.com/blog/post/2026-01-21-bullmq-vs-other-queues/markdown ; https://www.dragonflydb.io/faq/bullmq-vs-rabbitmq
- **RabbitMQ**: AMQP broker with exchanges/routing, native dead-lettering, quorum queues, priority support, clustering, language-agnostic consumers (useful if Liquidsoap sidecars or a Go/Python media worker join). Higher operational complexity than BullMQ.
- **[K] Verdict**: RabbitMQ is defensible for us because (a) multiple worker languages (ffmpeg/Python audio analysis, fingerprinting), (b) native DLX and quorum delivery limits, (c) separation of the control plane from Redis-backed state. Costs: one more stateful service to back up and monitor.

### 4.2 RabbitMQ dead-lettering and retries (verified)
- **[V]** A message is dead-lettered when: rejected/nacked with requeue=false; per-message TTL expires; queue length limit exceeded; quorum queue returns it more times than the delivery limit. Entire-queue expiry does not dead-letter its messages. Reasons: `rejected`, `expired`, `maxlen`, `delivery_limit`. Headers: `x-death` array (most recent first), `x-first-death-*`, `x-last-death-*`. Since 3.10, quorum queues support at-least-once dead-lettering. Source: https://www.rabbitmq.com/docs/4.1/dlx (fetched)
- **[V]** Delivery limit default is **20** per RabbitMQ nack docs (https://www.rabbitmq.com/nack.html). Amazon MQ docs say messages over the limit are dropped; open-source docs say "dead-lettered or discarded", so configure a DLX explicitly if you need poison messages preserved.
- **[S] RabbitMQ 4.3 (Apr 2026)**: two counters, acquired-count (every requeue) and delivery-count (failed attempts only); only delivery-count feeds poison handling. Source: https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release . Verify before relying on it.
- **[K] Retry pattern without a delay plugin**: a retry exchange per backoff tier (e.g. 5s/30s/5min queues with TTL and DLX back to the work queue), then a parking DLQ for manual replay. Priority queues: RabbitMQ supports priority (queue argument, 1–255 per one comparison [S]); not verified here, so confirm the cap on the priority-queues docs before design. Use separate queues per priority class (`media.high`, `media.bulk`) rather than many priority levels.

### 4.3 Job patterns for the platform
- **Media ingest**: upload -> `media.transcode` (ffmpeg to normalized format), `media.analyze` (loudness EBU R128 / LUFS, duration, silence detection, tags), `media.fingerprint` (chromaprint/AcoustID, dedupe), `media.thumbnail`. Each job idempotent, keyed by media id + version hash; results written to DB, not to the message.
- **Schedule generation**: `schedule.generate(station, horizon)`, deterministic and versioned; `schedule.publish` writes the rendered playlist/requests into the station's Liquidsoap control path; priority high for "now+1h" windows.
- **Reports**: `report.generate` (listener hours, play logs, royalties export), low priority, time-windowed, output to object storage.
- **Control commands** (skip, push request, switch live): direct sync API call to the station's control endpoint, not via the queue, so latency stays low. Queue only for retryable side effects.
- **Retries**: transient errors -> retry with exponential backoff and jitter; permanent errors (bad file) -> DLQ with reason and tenant id; never retry non-idempotent commands blindly.
- **Consumers**: prefetch 1–10, manual ack, quorum queues for durability, consumer timeouts set per job type.

### 4.4 Real-time UI
- **[S] SSE vs WebSockets** (consensus of several 2026 blogs; not benchmarks): SSE for one-way server->client (now playing, queue changes, status), with REST for actions; built-in reconnection with Last-Event-ID; simpler to scale stateless behind a proxy. WebSockets only if clients send frequent bidirectional messages (VU meters are server->client, so SSE suffices; but a live-DJ console may need WS). Note HTTP/1.1 connection-per-SSE limit: use HTTP/2 at the proxy. Sources: https://oneuptime.com/blog/post/2026-01-27-sse-vs-websockets/view ; https://blog.codercops.com/blog/server-sent-events-vs-websockets-2026
- **[K] VU meters / levels**: do not push raw audio levels through the app layer at high frequency. Compute at ~5–10 Hz from Liquidsoap (`liquidsoap_output_lufs_5s` or a dedicated peak/RMS gauge), fan out through a single Node process per org channel via Redis pub/sub or RabbitMQ fanout, and throttle per client.
- **[K] Scaling**: Node with a pub/sub backbone (Redis or RabbitMQ streams) so multiple API replicas can serve SSE clients.

---

## 5. Deployment, installer, TLS, backups, sizing

### 5.1 Reference installers
- **AzuraCast `docker.sh`** [V]: download `docker.sh` into a base dir (`/var/azuracast`), `./docker.sh install`; subcommands `install-docker`, `install-docker-compose` (for VPS with outdated Docker), `setup-release` (Stable vs Rolling); unattended: `yes '' | ./docker.sh install`. Then open the web installer to create the super-admin. Also documented: `letsencrypt-create` (per search snippet [S]), backup script produces `backup.tar.gz` in app root; restore is destructive (wipes DB/media volumes). Sources: https://azuracast.com/docs/getting-started/installation/docker (fetched); https://git.disroot.org/... (mirror forks, [S]).
- **Coolify** [S]: `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash`; root required; Ubuntu LTS only for the auto script; Snap Docker unsupported; ports 22/80/443 always, 8000 during setup, 6001/6002 for realtime; use provider firewall rather than UFW because Docker's iptables NAT bypasses UFW. Requirements: 2 vCPU, 2 GB RAM, 30 GB free disk (safer than the 10 GB figure quoted). Source: https://coolify.io/docs/start-with-self-hosted
- **[K] Pattern to copy**: idempotent installer with preflight checks (OS, arch, Docker >= version, Compose v2, ports free, RAM/disk thresholds, DNS/IP check for TLS), generated secrets stored in `.env` with 0600 perms, `install` / `update` / `backup` / `restore` / `doctor` / `uninstall` subcommands, versioned compose file with pinned image digests, health wait loop, and printed admin URL. Avoid `curl | sudo bash` for the *app* installer if possible; publish checksummed releases.

### 5.2 Compose layout (recommended)
- Services: `caddy` (TLS, public), `web` (Node API + SSE), `worker` (scalable replicas), `scheduler`, `postgres`, `rabbitmq` (quorum queues), `redis` (optional, cache/pubsub), `icecast` (public listener endpoint), `station-<id>` (one Liquidsoap container per station, created dynamically by the control plane via Docker API), `prometheus`, `grafana`, `loki` (optional), `minio` (optional S3-compatible).
- Networks: `edge` (caddy <-> web/icecast), `core` (web/worker <-> postgres/rabbit/redis), `station-net` (control plane <-> Liquidsoap control socket, internal only).

### 5.3 TLS
- **[V]** Caddy: automatic ACME (Let's Encrypt or ZeroSSL), HTTP->HTTPS redirect, auto-renewal; Caddyfile mounted, `/data` and `/config` persisted; publish 80/443; use Let's Encrypt staging to avoid rate limits while testing; DNS challenge requires a plugin build. Source: https://www.virtualizationhowto.com/2025/09/caddy-reverse-proxy-in-2025-the-simplest-docker-setup-for-your-home-lab/ and https://oneuptime.com/blog/post/2026-01-16-docker-caddy-automatic-https/view (search snippets [S]).
- **[K] Icecast over TLS**: Icecast 2.4 does not terminate TLS cleanly for all players; put Caddy in front for HTTPS listener URLs (`reverse_proxy icecast:8000` with `flush_interval -1` to avoid buffering a live stream; Icecast `hostname`/mount config must match the public host). Verify with real players (VLC, browsers' `<audio>`, mobile). Note that AzuraCast's built-in Let's Encrypt is in its own nginx, so it conflicts with an external Traefik/Caddy TLS terminator; pick one owner of certificates.
- **[K] Custom domains per org**: Caddy on-demand TLS with an `ask` endpoint validating the domain against the DB.

### 5.4 Backups
- **[S]** Dump DBs logically (`pg_dump -Fc`, optionally `--no-owner`) and stream into restic (`--stdin`); snapshot config/media volumes separately with tags; restic `forget` retention (e.g. 7 daily, 4 weekly, 6 monthly); S3-compatible targets (Backblaze B2, Wasabi, R2, MinIO). Schedule via systemd timer or sidecar. Test restores regularly. Sources: https://oneuptime.com/blog/post/2026-01-06-docker-volume-backup-restore/markdown ; https://www.centron.de/tutorials/encrypted-docker-volume-backups-restic
- **[V]** AzuraCast media guidance: if backups include media, you need free space equal to the media library; media can be excluded from backups and S3 used as primary storage. Source: https://www.azuracast.com/docs/getting-started/scaling/
- **[K] Our plan**: Postgres PITR via WAL archiving (pgBackRest or wal-g to S3) + nightly restic of config/secrets (encrypted) + media in S3 with versioning; RabbitMQ definitions export; Liquidsoap station scripts are generated, so they need no backup (regenerate from DB).

### 5.5 Upgrades, migrations, rollback
- **[K]** Pin image tags (or digests) in the compose file; `update` = pull new digests, run DB migrations in a one-off container with a pre-migration backup, then recreate services; rolling restart of station containers only at scheduled quiet windows (or use the safety loop to avoid dead air). Keep previous compose + image digest for rollback; DB migrations must be backward compatible for one version (expand/contract).
- **[K] Station containers** are versioned by the template version stored in DB; upgrade them station by station with a canary (one station first) and automatic rollback if `liquidsoap_source_is_playing` drops within N minutes.

### 5.6 VPS sizing (planning estimates, to be benchmarked)
- **[S] Coolify minimum**: 2 vCPU, 2 GB RAM, 30 GB disk (installer itself); add headroom for builds.
- **[V] AzuraCast**: RAM >= 512 MB, preferably > 1 GB for DB+PHP; keep sustained CPU <= 50% of capacity; ~0.1 core per Icecast/AutoDJ destination; ~2 GB images + >= 5 GB free for upgrades.
- **[K] Starting point**: control plane + Postgres + RabbitMQ + Caddy + Grafana stack: 4 vCPU / 8 GB / 80 GB SSD; each additional station container budgeted at ~0.5 vCPU / 512 MB–1 GB RAM with 1–3 destinations; ffmpeg transcode jobs need burst capacity (bounded worker concurrency). Benchmark before selling a plan.

### 5.7 Firewall and hardening
- **[S]** Use the VPS provider's firewall (Docker's iptables bypasses UFW). Expose only 22 (or a bastion), 80, 443 publicly. Icecast: expose only via Caddy or on the public listener port needed (commonly 8000 for direct access; restrict if using a proxy). Keep Liquidsoap telnet/harbor/metrics/control on internal networks only (Liquidsoap has no auth). RabbitMQ management UI and Grafana: VPN/Tailscale or auth-proxied. SSH: key only, fail2ban or equivalent.
- **[K]** Container hardening: non-root users, read-only root FS, `no-new-privileges`, dropped capabilities, resource limits, image pinning, scan with Trivy, secrets via Docker secrets or 0600 `.env`.

---

## 6. Gaps and what to verify next
- Hot-standby Liquidsoap across hosts: no authoritative source found; design it ourselves and test.
- `request.dynamic` failure/restart semantics: not documented in what was read; test empirically.
- AzuraCast internal supervisor (supervisord?) and port allocation internals: not confirmed from source code. Check the AzuraCast repository (`backend/`, `util/`) if needed.
- Liquidsoap Docker HEALTHCHECK and process-supervision examples: none found.
- Icecast 2.4 config reference (`fallback-mount`, `fallback-override`, `hostname`): read https://icecast.org/docs/icecast-2.4.1/config-file.html directly; not retrieved.
- RabbitMQ priority queue cap and default delivery-limit on the current quorum docs: confirm on rabbitmq.com docs pages.
- Benchmarks: per-station CPU/RAM for our chosen encoders (ffmpeg vs native mp3/aac) must be measured.

---

## 7. Recommendations for our architecture

1. **Engine model**: one Liquidsoap process per station, in its own container, generated from a versioned template. Each script is "always infallible": ordered inputs (live harbor/SRT inputs first, then playlist/requests), then a `single()` safety loop, wrapped in `mksafe()` at the output. Never let an output see a fallible source unless a gap is acceptable.
2. **Two-layer emergency audio**: Liquidsoap-level safety loop (primary) plus Icecast `fallback-mount` chain (secondary, covers engine crash/hang when Icecast is the public entry point). Keep formats identical across mounts.
3. **Health and failover**: external probe (outside the engine, fetches the public stream and checks decode + level) plus Liquidsoap Prometheus gauges (`is_playing`, `is_blank`, `unready_duration`). Auto-restart a station container only after N seconds of blank output and only during a safe window; alert humans on repeated restarts (restart-storm guard).
4. **Control plane**: Node talks to each Liquidsoap through a Unix socket or internal-only telnet/HTTP; no public exposure. Build a thin HTTP shim (Radio France `/livesource` pattern) so control semantics are typed and audited.
5. **Port allocation**: internal network for all Liquidsoap ports; public ports only through Caddy/Icecast. Allocate listener ports from a DB-backed pool (AzuraCast-style range), never hardcode per station.
6. **Isolation**: per-station cgroup limits (`cpus`, `mem_limit`, `pids_limit`), per-org network, per-org storage quota (DB-accounted), non-root containers, read-only root FS.
7. **Tenancy and RBAC**: org -> stations -> users with org and station-scoped roles. Granular `resource:action` permissions; ship presets (Org Owner, Station Manager, Program Director, Music Director, Presenter/DJ, Producer/Traffic, Analyst). Audit log for every mutation and every automatic system action.
8. **Identity**: OIDC login with an optional bundled IdP (Authentik for simplicity, or Keycloak if org features and enterprise federation matter); in-app 2FA (TOTP/WebAuthn) and per-org "require 2FA"; API keys hashed, scoped, rotatable.
9. **Billing model**: meter station count, active destinations x bitrate (CPU proxy), listener-hours, storage GB, transcode minutes. Expose plan caps like Centova (listeners, bitrate, disk).
10. **Queues**: RabbitMQ with quorum queues, DLX for poison messages, retry tiers via TTL queues, separate high/bulk queues. Idempotent jobs keyed by content hash. Control commands are synchronous API calls, not queued.
11. **Real time**: SSE for now-playing, queue, status and throttled level meters (through Redis or RabbitMQ fanout across API replicas); WebSocket only for the live DJ console if bidirectional latency demands it.
12. **Installer**: idempotent bash installer with preflight checks, `install|update|backup|restore|doctor|uninstall` subcommands, pinned image digests, generated secrets in a 0600 `.env`, Caddy for TLS (on-demand TLS for custom org domains), firewall guidance for the provider's firewall (not UFW alone), Let's Encrypt staging option.
13. **Backups**: Postgres PITR (WAL archive to S3) + restic for config and volumes + S3 media with versioning; scheduled restore drills. Station containers are regenerated, not backed up.
14. **Upgrades**: expand/contract DB migrations, canary station upgrade with automatic rollback on silence, quiet-window rollouts.
15. **Observability**: Prometheus + Grafana + Alertmanager from day one (Radio France stack as template), Loki for logs with per-station labels, per-org dashboards.
16. **Sizing**: start from a 4 vCPU / 8 GB control-plane VPS; budget ~0.5 vCPU and 512 MB–1 GB per station container, benchmark encoders before publishing plan limits.

---

## Source index
- Liquidsoap sources/fallibility: https://www.liquidsoap.info/doc-dev/sources.html
- Liquidsoap server/telnet/harbor: https://www.liquidsoap.info/doc-dev/server.html ; https://www.liquidsoap.info/doc-2.4.5/harbor
- Liquidsoap Prometheus: https://www.liquidsoap.info/doc-dev/prometheus.html ; https://www.liquidsoap.info/doc-2.2.5/prometheus.html
- Liquidsoap memory: https://liquidsoap.info/blog/2023-07-09-memory-management
- Radio France rf-liquidsoap: https://github.com/radiofrance/rf-liquidsoap/blob/master/README.md
- AzuraCast scaling: https://www.azuracast.com/docs/getting-started/scaling/
- AzuraCast roles: https://azuracast.com/docs/administration/roles-and-permissions/
- AzuraCast Docker install: https://azuracast.com/docs/getting-started/installation/docker
- AzuraCast ports: https://azuracast.com/docs/administration/advanced-features
- Icecast glossary: https://www.icecast.org/docs/icecast-2.4.1/glossary.html
- Icecast fallback threads: https://lists.xiph.org/pipermail/icecast/2015-November/013565.html ; https://lists.xiph.org/pipermail/icecast/2018-August/014277.html ; https://lists.xiph.org/pipermail/icecast/2017-May/013928.html
- LibreTime Icecast handover: https://git.congegni.net/Congegni/sintonia/src/commit/0766b91cde4bce4ad9a2d4d4d7706d646bb38a86/docs/manual/icecast-handover/index.md
- streammonitor: https://github.com/mdisabato/streammonitor
- Radio Mast: https://www.radiomast.io/docs/stream-monitoring/quickstart.html
- RabbitMQ DLX: https://www.rabbitmq.com/docs/4.1/dlx ; nack/delivery-limit: https://www.rabbitmq.com/nack.html ; 4.3 release: https://www.rabbitmq.com/blog/2026/04/23/rabbitmq-4.3-release
- BullMQ vs RabbitMQ: https://oneuptime.com/blog/post/2026-01-21-bullmq-vs-other-queues/markdown
- SSE vs WebSockets: https://oneuptime.com/blog/post/2026-01-27-sse-vs-websockets/view
- Keycloak vs Authentik: https://cerbos.dev/blog/authentik-vs-keycloak-selfhosted-idp-comparison
- Centova reseller: https://centova.com/doc/cast/reseller_manual/reference_manual
- Coolify install: https://coolify.io/docs/start-with-self-hosted
- Caddy: https://www.virtualizationhowto.com/2025/09/caddy-reverse-proxy-in-2025-the-simplest-docker-setup-for-your-home-lab/
- Docker cgroups: https://oneuptime.com/blog/post/2026-02-08-how-to-understand-docker-container-cgroups-in-depth/markdown
- Backups: https://oneuptime.com/blog/post/2026-01-06-docker-volume-backup-restore/markdown
