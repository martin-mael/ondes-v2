#!/bin/sh
# Checks every Liquidsoap template with `liquidsoap --check` inside the pinned engine image.
# Defaults to the Liquidsoap image pinned in deploy/compose.dev.yml (#13); override with LIQUIDSOAP_IMAGE.
set -eu

# Island splice test (#12): seam detector + A body → island → B body through Liquidsoap.
# SPLICE_ARGS=--quick runs the FLAC cases only.
# shellcheck disable=SC2086
sh engine/tests/splice/run.sh ${SPLICE_ARGS:-}

templates=$(find engine/templates -name '*.liq' 2>/dev/null)
if [ -z "$templates" ]; then
  echo "test:engine: no Liquidsoap templates yet, skipping"
  exit 0
fi

LIQUIDSOAP_IMAGE=${LIQUIDSOAP_IMAGE:-$(sed -n 's/^ *image: *\(savonet\/liquidsoap:[^ ]*\).*/\1/p' deploy/compose.dev.yml | head -n 1)}
: "${LIQUIDSOAP_IMAGE:?no savonet/liquidsoap image in deploy/compose.dev.yml; set LIQUIDSOAP_IMAGE}"
for t in $templates; do
  echo "checking $t"
  docker run --rm -v "$PWD/engine:/engine:ro" "$LIQUIDSOAP_IMAGE" liquidsoap --check "/$t"
done
