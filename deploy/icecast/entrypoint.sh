#!/bin/sh
# Icecast on the config the api generates (apps/api/src/modules/engine/icecast).
#
# The api writes icecast.xml for every station into a volume shared with this container
# (ICECAST_CONFIG_SOURCE, default /config/icecast.xml), without secrets: the passwords are
# placeholders (`env:ICECAST_SOURCE_PASSWORD`, ...). This script
#   1. waits for that file, fills in the passwords from this container's environment and
#      starts Icecast on the result (/etc/icecast.xml, readable by Icecast's user only);
#   2. checks the source file every ICECAST_CONFIG_POLL_SECONDS (default 2) and, when it
#      changed, renders it again and sends Icecast a SIGHUP. Icecast 2.5 re-reads its config
#      in place: listeners and sources stay connected; a file it can't parse is ignored and
#      the previous config stays active. See deploy/icecast/README.md.
#   3. probes Icecast every ICECAST_WATCHDOG_SECONDS (default 10) and kills it after three
#      failed probes in a row, so the container exits and its restart policy brings it back.
#      Icecast 2.5.0 can deadlock on a reload (after an /admin/listclients request): without
#      this the container stays up, serving nothing.
#
# For libretime/icecast:2.5.0-alpine (busybox sh, awk, md5sum). Run it as the entrypoint:
#   entrypoint: [sh, /ondes/entrypoint.sh]
set -eu

SRC=${ICECAST_CONFIG_SOURCE:-/config/icecast.xml}
LIVE=${ICECAST_CONFIG_LIVE:-/etc/icecast.xml}
POLL=${ICECAST_CONFIG_POLL_SECONDS:-2}
WATCHDOG=${ICECAST_WATCHDOG_SECONDS:-10}
# The port of the generated config's listen socket.
PORT=${ICECAST_PORT:-8000}

log() { echo "[ondes-icecast] $*" >&2; }

for var in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    log "$var is not set"
    exit 1
  fi
done
export ICECAST_ADMIN_USERNAME="${ICECAST_ADMIN_USERNAME:-admin}"
# Relays are not used; a random password keeps the relay login closed.
export ICECAST_RELAY_PASSWORD="${ICECAST_RELAY_PASSWORD:-$(head -c 24 /dev/urandom | md5sum | cut -c1-32)}"
export ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD

# Replaces each `env:NAME` placeholder with the XML-escaped value of $NAME. Plain string
# operations: a password can hold any character (`|`, `&`, `\`, quotes) without being
# interpreted as sed or awk syntax.
render() {
  tmp="${TMPDIR:-/tmp}/icecast.xml.new"
  awk '
    function esc(s) {
      gsub(/&/, "\\&amp;", s); gsub(/</, "\\&lt;", s); gsub(/>/, "\\&gt;", s)
      gsub(/"/, "\\&quot;", s); gsub(/\047/, "\\&apos;", s)
      return s
    }
    BEGIN {
      n = split("ICECAST_SOURCE_PASSWORD ICECAST_RELAY_PASSWORD ICECAST_ADMIN_USERNAME ICECAST_ADMIN_PASSWORD", names, " ")
    }
    {
      line = $0
      for (i = 1; i <= n; i++) {
        key = "env:" names[i]
        value = esc(ENVIRON[names[i]])
        out = ""
        while ((at = index(line, key)) > 0) {
          out = out substr(line, 1, at - 1) value
          line = substr(line, at + length(key))
        }
        line = out line
      }
      print line
    }
  ' "$SRC" >"$tmp"
  chmod 600 "$tmp"
  # In place (not mv): /etc is not writable by the icecast user, the file itself is.
  cat "$tmp" >"$LIVE"
  chmod 600 "$LIVE"
  rm -f "$tmp"
}

sum() { md5sum "$SRC" 2>/dev/null | cut -d' ' -f1; }

waited=0
while [ ! -s "$SRC" ]; do
  [ "$waited" -eq 0 ] && log "waiting for $SRC (written by the api)"
  waited=1
  sleep 1
done

render
current=$(sum)
log "starting Icecast on $SRC ($current)"
icecast -c "$LIVE" &
pid=$!

trap 'kill -TERM "$pid" 2>/dev/null' TERM INT

elapsed=0
failures=0
while kill -0 "$pid" 2>/dev/null; do
  sleep "$POLL" &
  wait $! || true
  next=$(sum)
  if [ -n "$next" ] && [ "$next" != "$current" ]; then
    render
    current=$next
    log "config changed ($current), reloading Icecast"
    kill -HUP "$pid" 2>/dev/null || true
  fi

  elapsed=$((elapsed + POLL))
  if [ "$elapsed" -ge "$WATCHDOG" ]; then
    elapsed=0
    if wget -q -T 3 -O /dev/null "http://127.0.0.1:$PORT/status-json.xsl" 2>/dev/null; then
      failures=0
    else
      failures=$((failures + 1))
      log "Icecast did not answer ($failures/3)"
      if [ "$failures" -ge 3 ]; then
        log "Icecast is stuck, killing it"
        kill -KILL "$pid" 2>/dev/null || true
        wait "$pid" || true
        exit 1
      fi
    fi
  fi
done

wait "$pid"
