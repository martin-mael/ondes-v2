#!/bin/sh
# Runs once, when the dev Postgres volume is first created.
# Creates a separate database for integration tests (`pnpm test:integration`), so they
# never wipe the data you use while developing.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE "${POSTGRES_TEST_DB}" OWNER "${POSTGRES_USER}";
SQL
