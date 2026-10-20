#!/bin/sh
# Checks every Liquidsoap template with `liquidsoap --check` inside the pinned engine image.
# The image tag is pinned by the control spike (#13); set LIQUIDSOAP_IMAGE until compose provides it.
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

: "${LIQUIDSOAP_IMAGE:?set LIQUIDSOAP_IMAGE to the pinned Liquidsoap image}"
for t in $templates; do
  echo "checking $t"
  docker run --rm -v "$PWD/engine:/engine:ro" "$LIQUIDSOAP_IMAGE" liquidsoap --check "/$t"
done
