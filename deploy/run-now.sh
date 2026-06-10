#!/usr/bin/env bash
#
# run-now — manually trigger an opt-out run inside the already-running container.
#
#   docker exec auto-identity-remove run-now              # full run
#   docker exec auto-identity-remove run-now --dry-run    # no submissions
#   docker exec auto-identity-remove run-now --verify     # re-check listings
#
# Or click "Console" on the container in Portainer and type: run-now
#
# Drops to PUID:PGID when invoked as root (the default for docker exec) so files
# under /data keep the right ownership. The scheduler stays untouched; the
# state.json lock prevents this from colliding with a scheduled run in progress.
set -e
# docker exec inherits the image env, NOT the entrypoint's exports — and gosu
# preserves HOME. Without this, the seeded config's "~/.config/..." profileDir
# expands to /root/... and mkdir as PUID fails EACCES. Mirror entrypoint.sh.
export HOME="${AIDR_DATA:-/data}"
if [ "$(id -u)" = "0" ]; then
  exec gosu "${PUID:-1000}:${PGID:-1000}" node /app/watcher.js "$@"
else
  exec node /app/watcher.js "$@"
fi
