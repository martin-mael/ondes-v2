# Production images

- `api.Dockerfile`, `worker.Dockerfile`: see `docs/adr/0005-production-images.md`.
- **Web app: no image yet (TODO #84).** `pnpm --filter @ondes/web build` produces static files in
  `apps/web/dist`. The installer's Caddy serves them and reverse-proxies `/api` to the api, with
  response buffering off for `/api/v1/stations/*/events` (SSE) and a SPA fallback to `index.html`.
  See `docs/adr/0008-ui.md`.
