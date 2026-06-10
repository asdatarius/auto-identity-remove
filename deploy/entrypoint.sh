#!/usr/bin/env bash
#
# entrypoint for auto-identity-remove (NAS / Portainer edition)
#
# Points config + state + logs at a single mounted /data volume, seeds them on
# first boot, then runs supercronic so the container fires the opt-out on a
# schedule by itself. When started as root it chowns /data to PUID:PGID and
# drops privileges (so a NAS bind-mount is writable and Chromium runs non-root).
#
set -euo pipefail

DATA_DIR="${AIDR_DATA:-/data}"
export AIDR_CONFIG="${AIDR_CONFIG:-$DATA_DIR/config.json}"
export AIDR_STATE="${AIDR_STATE:-$DATA_DIR/state.json}"
export AIDR_LOG_DIR="${AIDR_LOG_DIR:-$DATA_DIR/logs}"
export HEADLESS="${HEADLESS:-1}"
export HOME="$DATA_DIR"

CRON_SCHEDULE="${CRON_SCHEDULE:-0 9 1 * *}"
RUN_ON_START="${RUN_ON_START:-false}"
WATCHER_ARGS="${WATCHER_ARGS:-}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

mkdir -p "$DATA_DIR" "$AIDR_LOG_DIR" "$DATA_DIR/profile" 2>/dev/null || true

# Seed config from the example on first boot — the run will exit early until
# you fill it in, but this gives you a file to edit on the NAS volume.
if [ ! -f "$AIDR_CONFIG" ]; then
  echo "[entrypoint] no config at $AIDR_CONFIG — seeding from example."
  echo "[entrypoint] >>> EDIT $AIDR_CONFIG with your details before the scheduled run. <<<"
  cp /app/config.example.json "$AIDR_CONFIG" 2>/dev/null || true
fi
[ -f "$AIDR_STATE" ] || echo '{"optOuts":{}}' > "$AIDR_STATE" 2>/dev/null || true

# supercronic crontab — output is teed to the data volume and to stdout.
CRONTAB="/tmp/aidr.crontab"
echo "$CRON_SCHEDULE node /app/watcher.js $WATCHER_ARGS" > "$CRONTAB"

am_root() { [ "$(id -u)" = "0" ]; }

drop() {
  # Run "$@" as PUID:PGID when root, else as the current user.
  if am_root; then
    chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
    exec gosu "$PUID:$PGID" "$@"
  else
    exec "$@"
  fi
}

run_now() {
  if am_root; then
    chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
    gosu "$PUID:$PGID" node /app/watcher.js $WATCHER_ARGS || echo "[entrypoint] run exited $?"
  else
    node /app/watcher.js $WATCHER_ARGS || echo "[entrypoint] run exited $?"
  fi
}

# Ad-hoc command pass-through: `docker run ... IMAGE node watcher.js --dry-run`
# runs that command (as the dropped user) instead of the scheduler.
if [ "$#" -gt 0 ]; then
  echo "[entrypoint] running ad-hoc command: $*"
  drop "$@"
fi

if [ "$RUN_ON_START" = "true" ]; then
  echo "[entrypoint] RUN_ON_START=true → running once now (args: ${WATCHER_ARGS:-none})"
  run_now
fi

echo "[entrypoint] scheduling '$CRON_SCHEDULE'  TZ=${TZ:-UTC}  data=$DATA_DIR  uid=${PUID}:${PGID}"
drop supercronic "$CRONTAB"
