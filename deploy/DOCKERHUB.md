# auto-identity-remove (NAS / Portainer edition)

Automated **data-broker opt-out runner** — removes your (and your family's) personal
info from 500+ people-search and data-broker sites on a monthly schedule, headless.
This image is a **container-ready build** of
[stephenlthorn/auto-identity-remove](https://github.com/stephenlthorn/auto-identity-remove),
packaged to "just work" on a NAS via Portainer. Source for this build:
[asdatarius/auto-identity-remove](https://github.com/asdatarius/auto-identity-remove).

**Multi-arch:** `linux/amd64` + `linux/arm64`.

## What this build adds over upstream
- Self-schedules the monthly run inside the container (no host cron, no Docker socket)
- All config/state/logs live on **one `/data` volume** (fixes the broken single-file mount)
- `PUID`/`PGID` for NAS file permissions
- Webhook / Telegram notifications (headless-friendly; iMessage is macOS-only)
- A `run-now` helper for on-demand runs
- Tracks upstream weekly (auto-sync PRs), so new upstream features land here too

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
   [`deploy/config.sample.json`](https://github.com/asdatarius/auto-identity-remove/blob/main/deploy/config.sample.json)).
   Use a `persons` array for the whole family.
2. Deploy the stack. The container idles and runs the opt-out on `CRON_SCHEDULE`.
3. **Test first:** `docker exec auto-identity-remove run-now --dry-run`

## Run it manually
```bash
docker exec auto-identity-remove run-now                # full run
docker exec auto-identity-remove run-now --dry-run      # fill forms, submit nothing
docker exec auto-identity-remove run-now --verify       # re-check past opt-outs
docker exec auto-identity-remove run-now --score        # exposure score + trend
docker exec auto-identity-remove run-now --breach-check # HIBP breach check (needs hibp.apiKey)
docker exec auto-identity-remove run-now --serp-watch   # alert on NEW search-result domains
```
Or click **Console** on the container in Portainer and type `run-now`.

## The `/data` volume
Holds everything that must persist (mount one folder):

| File | Purpose |
|------|---------|
| `config.json` | your details (you provide this) |
| `state.json`  | opt-out history — **keep it**; stops re-submitting every run |
| `logs/`       | per-run JSON logs (+ `--snapshot` screenshots) |
| `profile/`    | browser session |
| `serp-history.json` | search-result scan history (`--serp-scan` / `--serp-watch`) |

## Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `TZ` | `UTC` | Timezone the schedule fires in |
| `CRON_SCHEDULE` | `0 9 1 * *` | 5-field cron (monthly, 1st @ 09:00) |
| `RUN_ON_START` | `false` | `true` = run once immediately on (re)deploy |
| `WATCHER_ARGS` | _(empty)_ | Extra flags (`--dry-run`, `--verify`, `--no-capsolver`, `--only X`) |
| `HEADLESS` | `1` | Keep `1` on a NAS |
| `PUID` / `PGID` | `1000` | uid/gid that owns `/data` |
| `AIDR_PASSPHRASE` | _(empty)_ | Optional: decrypts an at-rest-encrypted `config.json.enc` (see upstream `--encrypt-config`) |

## Notifications (set in `config.json`)
- **Discord:** webhook URL **with `/slack` appended**
- **Telegram:** `notify.telegram = { botToken, chatId }`
- **ntfy:** `https://ntfy.sh/<your-topic>` — invent a long random topic; anyone who knows it can read it

## Optional features (config blocks, all default-off)
- **Masked-email relay** (`relay`): submit opt-outs with per-person SimpleLogin aliases so brokers never get your real address
- **Broker allowlist** (`allowlist`): skip brokers you intentionally keep
- **At-rest config encryption**: `--encrypt-config` + `AIDR_PASSPHRASE` env
- **Breach check** (`hibp.apiKey`): cross-reference Have-I-Been-Pwned breaches

## Tags
- `latest` — current build
- `1.0.x` — pinned versions (1.0.6+: upstream relay/allowlist/encryption/HIBP/score features)
- `sha-<commit>` — exact source commit

## Notes
- **"Submitted" ≠ "deleted."** Use `run-now --verify` to spot-check.
- Don't expose this container to the internet — it's outbound-only and holds PII in `/data`.
- Image is ~2 GB (bundled Chromium). The monthly run itself is short.
- License: MIT. Built on [stephenlthorn/auto-identity-remove](https://github.com/stephenlthorn/auto-identity-remove).
