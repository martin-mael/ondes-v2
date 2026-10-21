# deploy

- `compose.dev.yml`: backing services for local development (this file documents it).
- `dev/`: configs and bootstrap scripts used by `compose.dev.yml`.
- Production compose, installer and Caddyfile come later (epic #2 and its sub-issues).

## Local development services

Requirements: Docker with Compose v2.24+ (Docker Desktop or OrbStack on macOS).

```sh
cp .env.example .env   # app-side settings (DATABASE_URL, S3_*, ...)
pnpm dev:up            # start all services and wait until they're healthy
pnpm dev:seed          # migrate, then create the demo org, station and user
pnpm dev:ps            # status of each service
pnpm dev:logs          # follow logs (add a service name: pnpm dev:logs icecast)
pnpm dev:down          # stop, keep the data
pnpm dev:reset         # stop and delete all volumes
```

The compose project is called `ondes-dev`, so containers and volumes are prefixed with it.

Every port is bound to **127.0.0.1 only**. Nothing is reachable from other machines on your network.

| Service | Image (pinned) | Host address | Hostname in the compose network | What for |
|---|---|---|---|---|
| `postgres` | `postgres:18.6-alpine` | `127.0.0.1:5432` | `postgres:5432` | Main database (`ondes`) and integration-test database (`ondes_test`) |
| `rabbitmq` | `rabbitmq:4.3.6-management-alpine` | `127.0.0.1:5672` (AMQP), `127.0.0.1:15672` ([management UI](http://127.0.0.1:15672)) | `rabbitmq:5672` | Job queues, vhost `ondes` |
| `garage` | `dxflrs/garage:v2.4.1` | `127.0.0.1:3900` (S3 API), `127.0.0.1:3903` (admin API) | `garage:3900` | S3-compatible object storage, bucket `ondes-dev` |
| `garage-init` | `node:24.22.0-alpine` | – | – | One-shot: assigns the Garage layout, imports the dev key, creates the bucket, then exits 0 |
| `icecast` | `libretime/icecast:2.5.0-alpine` | `127.0.0.1:8000` ([status page](http://127.0.0.1:8000/)) | `icecast:8000` | Streaming server |
| `liquidsoap` | `savonet/liquidsoap:v2.4.6` | **not published** | `liquidsoap:1234` (telnet) | Audio engine. Streams a test tone to [`/dev.mp3`](http://127.0.0.1:8000/dev.mp3) |
| `mailpit` | `axllent/mailpit:v1.31.4` | `127.0.0.1:1025` (SMTP), `127.0.0.1:8025` ([web UI](http://127.0.0.1:8025)) | `mailpit:1025` | Catches every email the api sends (verification, password reset, invitations). Nothing leaves your machine |

Every long-running service has a healthcheck. `pnpm dev:up` waits until they all pass (`up --wait`), then runs `garage-init` in the foreground, so it exits non-zero if anything failed. A plain `docker compose -f deploy/compose.dev.yml up -d` starts everything too, `garage-init` included. Don't add `--wait` to that one: Compose counts the one-shot container's exit as a failure.

### Liquidsoap
- `dev/liquidsoap/dev.liq` is a placeholder that proves the Liquidsoap → Icecast chain works. The real station scripts live in `engine/templates` (#12, #13), and spike #13 may change the pinned version.
- Its telnet control server (port 1234) is only reachable from other containers on the compose network. It is **never** published to the host (see `CLAUDE.md`). To poke at it by hand:
  ```sh
  docker compose -f deploy/compose.dev.yml exec liquidsoap bash -c \
    'exec 3<>/dev/tcp/127.0.0.1/1234; printf "help\nquit\n" >&3; cat <&3'
  ```

### S3 (Garage)
Garage only serves requests once its cluster layout is set, and it can't preset keys from config, so `garage-init` (`dev/garage/init.ts`) does it through the admin API. It's idempotent and runs on every `pnpm dev:up`.

Clients must use **path-style** addressing and region `garage`. Quick check with the AWS CLI:

```sh
AWS_ACCESS_KEY_ID=GK6f6e6465732d6465762d6b65 \
AWS_SECRET_ACCESS_KEY=fc0e6e6f0bb08c084598a6494af6fc8299054cfbcb7e11d28c2241aeb3b54ee8 \
AWS_DEFAULT_REGION=garage \
aws --endpoint-url http://127.0.0.1:3900 s3 ls s3://ondes-dev/
```

To change the key, both values must keep Garage's format: `GK` + 24 hex characters for the id, 64 hex characters for the secret.

### Email (Mailpit)
The api sends email over SMTP (`SMTP_URL`, `MAIL_FROM`). In development `SMTP_URL=smtp://127.0.0.1:1025` points at Mailpit, which accepts everything and delivers nothing: open [http://127.0.0.1:8025](http://127.0.0.1:8025) to read the messages and click their links. Mailpit keeps messages in memory, so a restart empties the inbox. Integration tests don't use it: they swap in an in-memory mailer.

### Postgres
- `dev/postgres/init/` runs once, when the `postgres-data` volume is created. It creates the `ondes_test` database. If you change `POSTGRES_TEST_DB` later, run `pnpm dev:reset` (or create the database by hand).
- Postgres 18 images store data under `/var/lib/postgresql/18/docker`, so the volume is mounted at `/var/lib/postgresql`.

## Environment variables

`.env.example` at the repo root lists them all with their dev values. Apps read the root `.env`. Compose doesn't read it by default (its project directory is `deploy/`), so every variable below has the same default in `compose.dev.yml`. To change a port or password for the containers too, export it in your shell or run `docker compose --env-file .env -f deploy/compose.dev.yml up -d --wait`.

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://ondes:ondes@127.0.0.1:5432/ondes` | api, worker, `dev:seed` |
| `TEST_DATABASE_URL` | `postgres://ondes:ondes@127.0.0.1:5432/ondes_test` | integration tests |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `ondes` / `ondes` / `ondes` | compose |
| `POSTGRES_TEST_DB` | `ondes_test` | compose (first start only) |
| `POSTGRES_PORT` | `5432` | compose (host port) |
| `RABBITMQ_URL` | `amqp://ondes:ondes@127.0.0.1:5672/ondes` | api, worker |
| `RABBITMQ_USER` / `RABBITMQ_PASSWORD` / `RABBITMQ_VHOST` | `ondes` / `ondes` / `ondes` | compose (first start only) |
| `RABBITMQ_PORT` / `RABBITMQ_MANAGEMENT_PORT` | `5672` / `15672` | compose (host ports) |
| `S3_ENDPOINT` | `http://127.0.0.1:3900` | api, worker (`@ondes/storage`) |
| `S3_REGION` | `garage` | api, worker |
| `S3_BUCKET` | `ondes-dev` | api, worker, `garage-init` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | see `.env.example` | api, worker, `garage-init` |
| `S3_FORCE_PATH_STYLE` | `true` | api, worker |
| `S3_PORT` / `GARAGE_ADMIN_PORT` | `3900` / `3903` | compose (host ports) |
| `GARAGE_ADMIN_TOKEN` / `GARAGE_RPC_SECRET` | see `.env.example` | compose (`garage`, `garage-init`) |
| `ICECAST_URL` | `http://127.0.0.1:8000` | api (listener stats, public stream URL) |
| `ICECAST_PORT` | `8000` | compose (host port) |
| `ICECAST_SOURCE_PASSWORD` | `ondes-dev-source` | compose (`icecast`, `liquidsoap`) |
| `ICECAST_RELAY_PASSWORD` | `ondes-dev-relay` | compose |
| `ICECAST_ADMIN_USER` / `ICECAST_ADMIN_PASSWORD` | `admin` / `ondes-dev-admin` | compose, api (Icecast admin API) |
| `ICECAST_CONFIG_PATH` | unset | api: write the generated Icecast config there (production; see `icecast/README.md`) |
| `ICECAST_PUBLIC_HOSTNAME` | `localhost` | api: Icecast `<hostname>` in the generated config |
| `ICECAST_STATS_INTERVAL_MS` / `ICECAST_SYNC_INTERVAL_MS` | `15000` / `30000` | api: listener stats poll, config re-check |
| `SMTP_URL` | `smtp://127.0.0.1:1025` | api (outgoing email; Mailpit in dev) |
| `MAIL_FROM` | `Ondes <no-reply@localhost>` | api |
| `MAILPIT_SMTP_PORT` / `MAILPIT_UI_PORT` | `1025` / `8025` | compose (host ports) |
| `API_PORT` | `3000` | api |
| `APP_URL` | `http://localhost:5173` | api (links in emails) |
| `AUTH_SECRET` | see `.env.example` | api (encrypts TOTP secrets; keep it stable) |
| `AUTH_COOKIE_SECURE` | `true` (`false` in `.env.example`) | api (`Secure` session cookie; off only for plain-http dev) |
| `AUTH_SESSION_TTL_DAYS` / `AUTH_RATE_LIMIT_MAX` | `30` / `10` | api |
| `API_TRUST_PROXY` | unset = `loopback,uniquelocal` | api (proxies trusted for X-Forwarded-For; `false` to disable, `true` or a CIDR list to override) |

"First start only" means the image applies the value when its volume is empty. Run `pnpm dev:reset` after changing it.

These are development values only. Production secrets are generated by the installer and never committed.

## Volumes

| Volume | Mounted at | Holds |
|---|---|---|
| `ondes-dev_postgres-data` | `/var/lib/postgresql` | Databases |
| `ondes-dev_rabbitmq-data` | `/var/lib/rabbitmq` | Queues, users, vhosts |
| `ondes-dev_garage-meta` | `/var/lib/garage/meta` | Garage metadata (layout, keys, buckets) |
| `ondes-dev_garage-data` | `/var/lib/garage/data` | Object data |

Icecast, Liquidsoap and Mailpit keep no state. `pnpm dev:reset` deletes all four volumes.
