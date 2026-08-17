# Dockerfile - auto-identity-remove
#
# Based on the official Playwright image, which ships Chromium plus every system
# library it needs for both amd64 and arm64.
#
# IMPORTANT: the image tag below must match the `playwright` version pinned in
# package.json. The image contains exactly one Chromium build - the one its own
# Playwright release expects - so a mismatched client fails at launch with
# "Executable doesn't exist at /ms-playwright/chromium-<rev>/chrome-linux/chrome".
# test/docker-build-contract.test.js enforces the match; do not bump one without
# the other.
#
# Build:  docker build -t auto-identity-remove .
# Run:    docker run --rm --init \
#                    -v "$(pwd)/config.json:/app/config.json" \
#                    -v "$(pwd)/state.json:/app/state.json" \
#                    -v "$(pwd)/logs:/app/logs" \
#                    auto-identity-remove
#
# Tip: pass --dry-run to preview without submitting anything:
#   docker run --rm --init ... auto-identity-remove node watcher.js --dry-run
#
# Low-RAM hosts (Synology NAS, Raspberry Pi, small VPS): add
#   -e AIDR_LOW_MEMORY=1
# See docs/SYNOLOGY.md for measured numbers and the full NAS walkthrough.

FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package.json package-lock.json ./

# Install Node dependencies (Playwright browsers already in base image)
RUN npm ci --omit=dev

# Playwright browsers are bundled in the base image at /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Copy application source
COPY . .

# Run as non-root. The base image already ships `pwuser` (uid/gid 1001) with a
# home directory and the right access to /ms-playwright, so reuse it - creating
# another account at uid 1001 collides with it and aborts the build.
RUN chown -R pwuser:pwuser /app

USER pwuser

# Default command - override with e.g. `node watcher.js --dry-run`
CMD ["node", "watcher.js"]
