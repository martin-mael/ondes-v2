#!/bin/sh
# Island splice test (see README.md): seam detector unit tests, type check, then the
# Liquidsoap splice matrix. Needs docker and ffmpeg on the host. Extra arguments go to run.ts,
# e.g. `sh engine/tests/splice/run.sh --quick`.
set -eu

pnpm exec vitest run --config engine/tests/splice/vitest.config.ts
pnpm exec tsc -p engine/tests/splice
node engine/tests/splice/run.ts "$@"
