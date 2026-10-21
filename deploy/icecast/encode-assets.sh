#!/bin/sh
# Encodes a station's fallback loop and intro for Icecast (see encode-assets.liq for the
# variables). Creates the per-station folders, runs Liquidsoap, makes the files readable by
# Icecast. Example, from the host:
#
#   docker run --rm --user root \
#     -e JOBS="vandale/mp3:mp3:fallback vandale/aac:aac:fallback" \
#     -e FALLBACK_INPUT=/in/emergency.flac \
#     -v /srv/ondes/emergency.flac:/in/emergency.flac:ro \
#     -v stream-assets:/assets \
#     -v ./deploy/icecast:/ondes:ro \
#     --entrypoint sh savonet/liquidsoap:v2.4.6 /ondes/encode-assets.sh
set -eu
OUT=${OUT:-/assets}
for job in ${JOBS:-}; do
  mount=${job%%:*}
  mkdir -p "$OUT/$(dirname "$mount")"
done
liquidsoap "$(dirname "$0")/encode-assets.liq"
chmod -R a+rX "$OUT"
