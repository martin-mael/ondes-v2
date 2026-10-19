# syntax=docker/dockerfile:1
# Production image for @ondes/api. Build from the repository root:
#   docker build -f deploy/docker/api.Dockerfile -t ondes-api .
# Node runs the TypeScript sources directly (type stripping); see docs/adr/0005-production-images.md.

ARG NODE_IMAGE=node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# pnpm comes from the root package.json "packageManager" field.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
# Filtered production install: only @ondes/api and the workspace packages it depends on.
# Workspace dependencies stay symlinks to packages/*, outside node_modules, because Node
# refuses to strip types from files under node_modules (so no `pnpm deploy`).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@ondes/api..." --store-dir /pnpm/store
# Drop the other apps and the tests.
RUN find apps -mindepth 1 -maxdepth 1 ! -name api -exec rm -rf {} + \
 && find apps packages -name '*.test.ts' -delete

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=root:root /app /app
USER node
WORKDIR /app/apps/api
CMD ["node", "src/main.ts"]
