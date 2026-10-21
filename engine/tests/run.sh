#!/bin/sh
# Checks the Liquidsoap templates with `liquidsoap --check` inside the pinned engine image.
# Defaults to the Liquidsoap image pinned in deploy/compose.dev.yml (#13); override with LIQUIDSOAP_IMAGE.
#
# The station template (#27) is not runnable by itself: it is rendered from station settings
# by apps/api/src/modules/engine/config, so every settings combination in
# engine/tests/template/combos.ts is rendered and checked. Any other template in
# engine/templates is checked as is. Needs docker and node (with `pnpm install` done).
set -eu

# The island splice matrix (#12) is separate: `pnpm test:engine:splice` (needs ffmpeg).
# The station template's runtime test is `pnpm test:engine:template` (needs ffmpeg).

LIQUIDSOAP_IMAGE=${LIQUIDSOAP_IMAGE:-$(sed -n 's/^ *image: *\(savonet\/liquidsoap:[^ ]*\).*/\1/p' deploy/compose.dev.yml | head -n 1)}
: "${LIQUIDSOAP_IMAGE:?no savonet/liquidsoap image in deploy/compose.dev.yml; set LIQUIDSOAP_IMAGE}"

work=engine/tests/template/.work/check
rm -rf "$work"
mkdir -p "$work"
node engine/tests/template/combos.ts "$work"

# Plain templates (no settings markers) are checked directly.
for t in $(find engine/templates -name '*.liq' | sort); do
  if ! grep -q '^# @ondes:config$' "$t"; then
    cp "$t" "$work/template-$(basename "$t")"
  fi
done

# One container for every script: `liquidsoap --check` takes one script per run.
docker run --rm -v "$PWD/$work:/check:ro" --entrypoint sh "$LIQUIDSOAP_IMAGE" -c '
  status=0
  for f in /check/*.liq; do
    if out=$(liquidsoap --check "$f" 2>&1); then
      echo "ok   $(basename "$f")"
      # Warnings are treated as errors: they usually mean a renamed or unused setting.
      if printf "%s" "$out" | grep -q "Warning"; then echo "$out"; status=1; fi
    else
      echo "FAIL $(basename "$f")"; echo "$out"; status=1
    fi
  done
  exit $status
'
