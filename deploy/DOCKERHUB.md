# auto-identity-remove (NAS / Portainer edition)

Automated **data-broker opt-out runner** — removes your (and your family's) personal
info from 500+ people-search and data-broker sites on a monthly schedule, headless.
This image is a **container-ready build** of
[stephenlthorn/auto-identity-remove](https://github.com/stephenlthorn/auto-identity-remove),
packaged to "just work" on a NAS via Portainer.

**Multi-arch:** `linux/amd64` + `linux/arm64`.

## What this build adds over upstream
- Self-schedules the monthly run inside the container (no host cron, no Docker socket)
- All config/state/logs live on **one `/data` volume** (fixes the broken single-file mount)
- `PUID`/`PGID` for NAS file permissions
- Webhook / Telegram notifications (headless-friendly; iMessage is macOS-only)
- A `run-now` helper for on-demand runs

## Quick start (Portainer stack)

```yaml
services:
  auto-identity-remove:
    image: asdatarius/auto-identity-remove:latest
    container_name: auto-identity-remove
    restart: unless-stopped
    environment:
      TZ: "Europe/Amsterdam"        # your timezone (cron fires in this TZ)
      CRON_SCHEDULE: "0 9 1 * *"    # 09:00 on the 1st of each month
      RUN_ON_START: "false"         # "true" = also run once on (re)deploy
      PUID: "1000"                  # uid that owns the volume path below
      PGID: "1000"                  # gid that owns the volume path below
    volumes:
      - /volume1/docker/auto-identity-remove:/data
```

1. Create the host folder and drop your **`config.json`** in it (template:
   [`deploy/config.sample.json`](https://github.com/stephenlthorn/auto-identity-remove)).
   Use a `persons` array for the whole family.
2. Deploy the stack. The container idles and runs the opt-out on `CRON_SCHEDULE`.
3. **Test first:** `docker exec auto-identity-remove run-now --dry-run`

## Run it manually
```bash
docker exec auto-identity-remove run-now            # full run
docker exec auto-identity-remove run-now --dry-run  # fill forms, submit nothing
docker exec auto-identity-remove run-now --verify   # re-check past opt-outs
```
Or click **Console** on the container in Portainer and type `run-now`.

## The `/data` volume
Holds everything that must persist (mount one folder):

| File | Purpose |
|------|---------|
| `config.json` | your details (you provide this) |
| `state.json`  | opt-out history — **keep it**; stops re-submitting every run |
| `logs/`       | per-run JSON logs |
| `profile/`    | browser session |

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `TZ` | `UTC` | Timezone the schedule fires in |
| `CRON_SCHEDULE` | `0 9 1 * *` | 5-field cron (monthly, 1st @ 09:00) |
| `RUN_ON_START` | `false` | `true` = run once immediately on (re)deploy |
| `WATCHER_ARGS` | _(empty)_ | Extra flags (`--dry-run`, `--verify`, `--no-capsolver`, `--only X`) |
| `HEADLESS` | `1` | Keep `1` on a NAS |
| `PUID` / `PGID` | `1000` | uid/gid that owns `/data` |

## Notifications (set in `config.json`)
- **Discord:** webhook URL **with `/slack` appended**
- **Telegram:** `notify.telegram = { botToken, chatId }`
- **ntfy:** `https://ntfy.sh/<your-topic>` (free)

## Tags
- `latest` — current build
- `1.0.x` — pinned versions
- `sha-<commit>` — exact source commit

## Notes
- **"Submitted" ≠ "deleted."** Use `run-now --verify` to spot-check.
- Don't expose this container to the internet — it's outbound-only and holds PII in `/data`.
- Image is ~2 GB (bundled Chromium). The monthly run itself is short.
- License: MIT. Built on [stephenlthorn/auto-identity-remove](https://github.com/stephenlthorn/auto-identity-remove).
