# syntax=docker/dockerfile:1
#
# Deployment image for auto-identity-remove — NAS / Portainer edition.
#
# Differences vs the upstream Dockerfile:
#   - adds supercronic so the container schedules the monthly run itself
#     (no host cron / no docker socket needed)
#   - adds gosu so a NAS bind-mount can be owned by an arbitrary PUID/PGID
#   - an entrypoint that points config/state/logs at a single /data volume,
#     which sidesteps the single-file-bind-mount EBUSY bug in state saving
#
# Build (multi-arch) from the REPO ROOT:
#   docker buildx build -f deploy/Dockerfile \
#     --platform linux/amd64,linux/arm64 \
#     -t YOURNAME/auto-identity-remove:latest --push .
#
# NOTE: this tag MUST match the playwright version in package-lock.json (1.60.0).
# A mismatch means the bundled Chromium build path won't exist and launch fails.
FROM mcr.microsoft.com/playwright:v1.60.0-noble

# gosu = privilege drop for NAS uid mapping; tzdata = honour the TZ env var
# tini = PID-1 init (reaps zombies + clean signals; also avoids supercronic's
# own PID-1 reaper, which fails to fork-exec in this base image)
# gosu = privilege drop for NAS uid mapping; tzdata = honour the TZ env var
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini gosu tzdata ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency manifests first for layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# --- supercronic: container-native cron, runs fine as non-root, logs to stdout
ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.34
ARG SUPERCRONIC_SHA256_AMD64=a51b340a83c5bd035742f0d7191555f9663876405e494dbf824537d64f3e39c6
ARG SUPERCRONIC_SHA256_ARM64=c9aefa42729ac2bf722ae2abb1cc1f25dfd153d21ecd6de12976463276be0578
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) SC_SHA="$SUPERCRONIC_SHA256_AMD64" ;; \
      arm64) SC_SHA="$SUPERCRONIC_SHA256_ARM64" ;; \
      *) echo "unsupported TARGETARCH=$TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}"; \
    echo "${SC_SHA}  /usr/local/bin/supercronic" | sha256sum -c -; \
    chmod +x /usr/local/bin/supercronic

# App source (config.js/watcher.js honour AIDR_* path env vars)
COPY . .
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY deploy/run-now.sh    /usr/local/bin/run-now
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/run-now

# AIDR_* paths are set as image ENV (not just derived in the entrypoint) so that
# `docker exec` / Portainer Console / `run-now` inherit them too.
ENV AIDR_DATA=/data \
    AIDR_CONFIG=/data/config.json \
    AIDR_STATE=/data/state.json \
    AIDR_LOG_DIR=/data/logs \
    HEADLESS=1 \
    CRON_SCHEDULE="0 9 1 * *" \
    RUN_ON_START=false \
    PUID=1000 \
    PGID=1000

VOLUME ["/data"]

# tini is PID 1; entrypoint runs as root only long enough to chown /data,
# then drops to PUID:PGID. Pass a command to run it ad-hoc instead of the
# scheduler, e.g.  docker run ... IMAGE node watcher.js --dry-run
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
