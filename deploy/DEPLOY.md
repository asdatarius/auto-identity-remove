# Deploying auto-identity-remove on a NAS (Docker Hub + Portainer)

This folder packages the tool for a headless NAS: a multi-arch image you push to
your own Docker Hub, and a Portainer stack that runs the opt-out **monthly by
itself** (no host cron, no Docker socket).

## What this edition changes vs upstream

| Concern | Upstream | Here |
|---|---|---|
| State persistence | mounts `state.json` as a **single file** → atomic save fails with `EBUSY` in Docker, so opt-out history never persists | everything lives under one mounted **directory** `/data`, where saves work |
| Scheduling | host scheduler (launchd/systemd/cron) runs it monthly | `supercronic` inside the container fires it on `CRON_SCHEDULE` |
| NAS file permissions | runs as fixed uid 1001 | `PUID`/`PGID` env, ownership fixed at startup via `gosu` |
| Notifications | iMessage (macOS) | webhook (ntfy/Slack/Discord) — set in `config.json` |

Two tiny, backward-compatible source patches make this work: `lib/config.js` and
`watcher.js` now read `AIDR_CONFIG` / `AIDR_STATE` / `AIDR_LOG_DIR` env vars
(defaults unchanged for native use).

---

## 1. Build & push the image

From the **repo root** (not this folder):

```bash
# one-time: a buildx builder that can do multi-arch
docker buildx create --name aidr --use 2>/dev/null || docker buildx use aidr

docker login   # your Docker Hub account

docker buildx build -f deploy/Dockerfile \
  --platform linux/amd64,linux/arm64 \
  -t asdatarius/auto-identity-remove:latest \
  -t asdatarius/auto-identity-remove:1.0.0 \
  --push .
```

`--push` is required for multi-arch (the manifest can't live in the local
daemon). The image is tagged under your `asdatarius` namespace.

---

## 2. Prepare the NAS volume

Pick a folder on the NAS, e.g. `/volume1/docker/auto-identity-remove`, and drop
your config in it:

```bash
cp deploy/config.sample.json /volume1/docker/auto-identity-remove/config.json
# then edit it with your real name/state/email + webhook
```

Note the folder's owner uid/gid (`ls -n`) — you'll put those in `PUID`/`PGID`.
On Synology a share is often `1026:100`; plain Linux is often `1000:1000`.

---

## 3. Deploy the Portainer stack

Portainer → **Stacks → Add stack → Web editor**, paste `deploy/docker-compose.yml`,
edit the three marked spots (`TZ`, `PUID`/`PGID`, volume path — the image is
already set to `asdatarius/auto-identity-remove:latest`), and deploy.

The container starts, idles, and runs `watcher.js` on the schedule. Watch
**Logs** in Portainer to confirm `[entrypoint] scheduling '0 9 1 * *' ...`.

---

## 4. First run — do a dry run before the real one

Before trusting the monthly job, run once with no submissions to confirm config
+ networking + headless Chromium work. Easiest is a throwaway container
(doesn't touch the schedule):

```bash
docker run --rm \
  -v /volume1/docker/auto-identity-remove:/data \
  -e RUN_ON_START=true -e WATCHER_ARGS="--dry-run" \
  asdatarius/auto-identity-remove:latest
```

Or from Portainer, set `RUN_ON_START: "true"` and `WATCHER_ARGS: "--dry-run"`
temporarily, redeploy, read the logs, then revert.

A real immediate run is the same with `WATCHER_ARGS` empty (or `--no-capsolver`
if you don't use CapSolver and don't want CAPTCHA sites attempted).

---

## Configuration reference (compose env)

| Var | Default | Meaning |
|---|---|---|
| `TZ` | `UTC` | Timezone the cron schedule fires in |
| `CRON_SCHEDULE` | `0 9 1 * *` | Standard 5-field cron. Monthly, 1st @ 09:00 |
| `RUN_ON_START` | `false` | `true` = also run once immediately on (re)deploy |
| `WATCHER_ARGS` | _(empty)_ | Extra flags for `watcher.js` (`--dry-run`, `--no-capsolver`, `--verify`, `--only spokeo`, …) |
| `HEADLESS` | `1` | Keep `1` on a NAS (no display) |
| `PUID` / `PGID` | `1000` | uid/gid that owns the `/data` volume |

Files that appear under your NAS volume after a run:
`config.json` (yours), `state.json` (opt-out history — **keep this**),
`logs/run-YYYY-MM-DD.json`, `profile/` (browser session).

---

## Updating later

```bash
docker buildx build -f deploy/Dockerfile --platform linux/amd64,linux/arm64 \
  -t asdatarius/auto-identity-remove:latest --push .
```

Then in Portainer: the stack → **Pull and redeploy** (or **Recreate** with
"re-pull image"). `state.json` survives because it lives on the volume.

---

## Notes & caveats

- **Image size** ~2 GB (the Playwright base ships Chromium for both arches). Fine
  for a NAS; the monthly run is short.
- **"Submitted" ≠ "deleted"** — see the upstream README. Use `WATCHER_ARGS=--verify`
  occasionally to spot-check.
- **Don't expose this container to the internet.** It holds personal data in
  `/data/config.json` and does outbound-only work; it needs no inbound ports.
- **`--pollute` (noise mode) is off** unless you add it to `WATCHER_ARGS`; it may
  violate broker ToS (upstream warns about this).
