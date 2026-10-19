# Open-source radio landscape: research report

> Saved by the orchestrator from the Haiku agent's returned report. Several primary doc pages returned 404s, so items marked UNVERIFIED need confirming. Rivendell, Airtime history, Mixxx, Owncast, Ampache, RadioDJ, Radio Cult, OpenBroadcaster, ODR and Pi-Radio were only researched from search snippets.

## 1. Comparison table

| Project | License | Core stack | Model | Notes |
|---|---|---|---|---|
| AzuraCast | Apache 2.0 per a 2020 post (https://github.com/AzuraCast/AzuraCast/issues/3061). Check the current LICENSE file. | PHP web app, Liquidsoap AutoDJ, Icecast-KH, NGINX, MariaDB, Redis, Centrifugo (now-playing feed), Docker Compose | Multi-station, one install | Liquidsoap runs the always-on AutoDJ and Icecast-KH is the frontend (https://azuracast.com/docs) |
| LibreTime | AGPL-3.0 (https://github.com/LibreTime/libretime) | Airtime fork; Python playout (pypo), libretime-analyzer, Liquidsoap, RabbitMQ, HLS + Icecast outputs | Show-based calendar (month/week/day) | Playout pre-downloads media up to 24h ahead and runs level and silence checks |
| Rivendell | GPL | Linux pro automation: RDCatch, RDLogManager, RDAirPlay, RDLogEdit, RDLibrary, RDAdmin | Log-based (program logs built from templates), multi-workstation | Scales from one workstation to clustered servers. Created by Salem Radio Labs around 2006. https://github.com/WMFO/rivendell |
| Liquidsoap | GPL-2.0 (OCaml) | Stream-processing language and engine | Scripting | 2.4.x is the supported branch and 2.5.x is in development (https://github.com/savonet/liquidsoap) |

## 2. AzuraCast (deep dive)

### Architecture
- A single Docker image/container named "azuracast" bundles PHP, Liquidsoap, Icecast, NGINX, supervisor, MariaDB and Redis.
- The updater is `docker.sh`, with these commands: `install`, `update`, `update-self`, `rollback <version>`, `backup [path]`, `restore [path]`, `up`, `down`, `restart`, `cli`, `bash`, `db`, `change-ports`, `uninstall`. It uses Podman when it detects it. Let's Encrypt is managed in the web UI.

### Playlists (https://azuracast.com/docs/en/user-guide/playlists)
- Types, with default priorities (unscheduled / scheduled):
  - General Rotation: 0
  - Once Per X Minutes: 2 / 3
  - Once Per X Songs: 4 / 5
  - Once Per X Hour: 6 / 7
  - Advanced: hand-written Liquidsoap rules
- Any playlist type can be scheduled to time blocks or date ranges. Song requests get top priority by default.
- Custom priority (added Sept 2024): the highest-priority eligible playlist always wins. Weighted rotation uses Liquidsoap `rotate`. Fallible sources are protected with `mksafe` or a fallback stream.

### Known issues (GitHub issues sorted by reactions)
- #2631 "Playlist Not Playing at Scheduled Time Super-Issue" is the most-discussed bug (83 comments).
- Other popular threads:
  - #4460 Roadmap to 1.0
  - #4132 PWA/mobile app
  - #1285 Songs repeating too often
  - #686 Schedule when DJs can connect
  - #753 Mark as jingle
  - #6965 Jingle trimming
- Licensing controversy: in 2020 the project planned to dual-license under AGPL-3 plus a paid reseller license, with a CLA (#3061, #3301).

## 3. LibreTime / Airtime
- LibreTime is a community fork of Airtime under AGPL-3.0. It has about 135 open issues.
- Its components are a scheduler/backend, playout (pypo), an analyzer, and Liquidsoap feeding Icecast and HLS, with RabbitMQ between them.
- The data model is show-based: shows contain playlists, playlists can be nested, and items are scheduled by date and time.

## 4. Rivendell (the "pro" reference)
- Rivendell is log-centric:
  - RDLogManager builds program logs from templates and imports traffic and music schedules.
  - RDAirPlay is the on-air app.
  - RDCatch is the timed recorder and event scheduler.
  - RDLibrary holds the cart-based audio library.
- What makes it "pro": hard-timed logs, the cart model, voice tracking, multi-workstation clustering, and real FM deployments.

## 5. Liquidsoap 2.x
- New in 2.4.0:
  - `cron.add("0 * * * *", ...)`
  - TLS client certificate validation
  - LUFS loudness correction unified with ReplayGain via `normalize_track_gain`
  - A new external decoder API
- Breaking changes in 2.4.0:
  - Callbacks became methods (`s.on_metadata(...)`) and need the `synchronous` flag.
  - The `insert_metadata` operator became a method.
  - `start_next` autocue behavior changed.
- 2.4.4: `input.harbor` returns 403 when a mountpoint is already taken. 2.4.5: fixed a harbor HTTP handler removal bug.
- UNVERIFIED (doc pages 404'd): HLS output details, `request.dynamic` / `request.queue` / `annotate:`, the telnet/socket server, `server.register` interactive variables, and the HTTP API. Confirm these against https://www.liquidsoap.info/doc.

## 6. Other projects (2024–2026)
- michochieng/web-radio (2025): Docker, Caddy, Icecast2, and Liquidsoap with silence detection and fallback. Small and stale.

## 7. Architecture lessons

### What to copy
- A single-command installer and updater with backup, restore and rollback built in.
- Playlist type taxonomy with default priorities, time-block scheduling, and an "Advanced" raw Liquidsoap escape hatch.
- Priority-based selection with an infallible fallback (`mksafe`).
- LibreTime's split into scheduler, playout worker and analyzer, connected by a message queue. This maps directly onto our RabbitMQ design.
- Pre-downloading and validating media ahead of playout.
- Using Liquidsoap's `cron.add` for scheduled actions.

### What to avoid
- Putting many services in one container under supervisor in a multi-tenant product.
- Schedule-boundary bugs like AzuraCast #2631. Resolve the schedule in one well-tested place with explicit time zones.
- Licensing ambiguity and CLAs.
- Calendar models that only know about shows and can't express log-level timing. A Rivendell-style log is more precise.

## 8. Liquidsoap integration patterns
- **A (AzuraCast):** the app generates a Liquidsoap config per station. Liquidsoap pulls the next track from the app through a request/annotate source.
- **B (LibreTime):** a playout daemon downloads files and drives Liquidsoap over its control interface. RabbitMQ carries schedule updates.
- **C (recommended to evaluate):** one Liquidsoap instance per station. The app pushes upcoming items through `request.queue` / `request.dynamic` (annotate URIs) over the socket server or HTTP, and uses interactive variables for skip, volume and mode.
- Live DJs connect through `input.harbor`. Now-playing comes from `on_metadata`; AzuraCast publishes it via Centrifugo.
- Keep Liquidsoap as pure playout. Scheduling and tenancy belong in Node.js.

## Sources
- https://azuracast.com/docs · https://azuracast.com/docs/en/user-guide/playlists · https://github.com/AzuraCast/AzuraCast
- https://github.com/AzuraCast/AzuraCast/issues/3061 · /3301 · https://github.com/AzuraCast/AzuraCast/issues?q=is%3Aissue+sort%3Areactions-%2B1-desc
- https://github.com/LibreTime/libretime · https://github.com/WMFO/rivendell
- https://www.liquidsoap.info/blog/2025-08-11-liquidsoap-2.4.0 · https://ocaml.org/p/liquidsoap/2.4.5/CHANGES.html · https://github.com/savonet/liquidsoap
