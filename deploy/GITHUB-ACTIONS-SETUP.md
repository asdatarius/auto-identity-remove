# GitHub fork + Actions — build images in the cloud & track upstream

This sets up your **own fork** of `auto-identity-remove` on GitHub so that:

- **GitHub Actions builds the multi-arch image** (`deploy/Dockerfile`) and pushes it
  to Docker Hub automatically — on every push to `main`, a manual button, and weekly.
  No more building on your Mac.
- A **weekly upstream-sync** opens a PR when `stephenlthorn/auto-identity-remove`
  gets new commits. You review/merge it → that triggers a fresh build.

Your namespace: **`asdatarius`**. Your fork will be **`asdatarius/auto-identity-remove`**.

The two workflow files already exist in this repo:
- `.github/workflows/deploy-image.yml` — build & push
- `.github/workflows/upstream-sync.yml` — weekly upstream PR

---

## What's a "patch" here (why this needs care)

Your image is **upstream + your changes**. The changes live in normal source files:

| File | Change |
|------|--------|
| `lib/config.js`, `generic-runner.js`, `lib/doctor.js`, `watcher.js` | honour `AIDR_CONFIG` / `AIDR_STATE` / `AIDR_LOG_DIR` env paths |
| `watcher.js` | email opt-out moved outside the per-person loop (no N× duplicate emails) |
| `lib/notify.js` | native Telegram support |
| `deploy/` | the whole NAS/Portainer overlay (Dockerfile, entrypoint, compose, docs) |
| `.github/workflows/deploy-image.yml`, `upstream-sync.yml` | this CI |

"Syncing upstream" = **merging upstream's new commits into your patched `main`**. If
upstream edits the same lines you patched, the sync PR will show conflicts to resolve
(rare — the patches are deliberately small).

---

## One-time setup

### Step 1 — Fork on GitHub
Open <https://github.com/stephenlthorn/auto-identity-remove> → click **Fork** →
owner **asdatarius** → **Create fork**. You now have
`https://github.com/asdatarius/auto-identity-remove`.

### Step 2 — Create a Docker Hub access token
hub.docker.com → your avatar → **Account Settings → Personal access tokens** →
**Generate new token**. Name it `github-actions`, permissions **Read & Write**.
**Copy the token now** (shown once).

### Step 3 — Add the secrets to your fork
Fork → **Settings → Secrets and variables → Actions → New repository secret**. Add two:

| Name | Value |
|------|-------|
| `DOCKERHUB_USERNAME` | `asdatarius` |
| `DOCKERHUB_TOKEN` | the token from Step 2 |

> The build tags the image as `${DOCKERHUB_USERNAME}/auto-identity-remove`, so this
> secret must exist **before** the first build.

### Step 4 — Set workflow permissions (needed for the sync PR)
Fork → **Settings → Actions → General → Workflow permissions**:
- ✅ **Read and write permissions**
- ✅ **Allow GitHub Actions to create and approve pull requests**

Click **Save**.

### Step 5 — Enable Actions on the fork
Forks have Actions disabled by default. Fork → **Actions** tab →
**"I understand my workflows, go ahead and enable them"**.

### Step 6 — Push your patched code to the fork
On your Mac, in the local clone (currently `origin` = upstream). Repoint `origin` to
your fork and push everything:

```bash
cd /Users/e.prokopiev/Projects/auto-identity-remove/repo

git remote rename origin upstream
git remote add origin https://github.com/asdatarius/auto-identity-remove.git

git add -A
git commit -m "NAS/Portainer edition: AIDR_* path env, email dedup, Telegram notify, deploy/ overlay + CI"

git push -u origin main
```

> **If the push is rejected (non-fast-forward):** your fork's `main` advanced past your
> local copy. Reconcile once, then push:
> ```bash
> git pull --no-rebase origin main   # resolve any conflicts, then:
> git push origin main
> ```

The push triggers **build-and-push**. Go to the **Actions** tab and watch it. When green,
`asdatarius/auto-identity-remove:latest` on Docker Hub is now built by CI.

---

## Day-to-day: how updates flow

```
upstream gets commits
        │
        ▼  (weekly, or Actions → upstream-sync → Run workflow)
 upstream-sync opens a PR  ──►  you review the diff
        │                         (resolve conflicts if any)
        ▼
   you MERGE the PR
        │
        ▼  (push to main triggers it)
 build-and-push builds + pushes :latest
        │
        ▼  (you choose when)
 Portainer: re-pull image + recreate  ──►  NAS runs the new version
```

**Deploy stays manual on purpose** — this tool submits your family's real data, so you
glance at the upstream diff before letting new code run. Don't wire Watchtower to
auto-pull `:latest` unattended.

### Triggering things manually
- **Build now:** Actions → **build-and-push** → **Run workflow**.
- **Check upstream now:** Actions → **upstream-sync** → **Run workflow**.

### Resolving a sync PR with conflicts
The PR body tells you if conflicts exist. If so:
```bash
cd .../repo
git fetch origin
git checkout upstream-sync
# open the conflicted files (look for <<<<<<< markers), keep BOTH your patch
# and upstream's change as appropriate, then:
git add -A
git commit
git push origin upstream-sync
```
The PR updates; merge it when clean.

### Updating the NAS after a new image
Portainer → your stack → **Update the stack** → tick **Re-pull image and redeploy**
(or SSH: `docker pull asdatarius/auto-identity-remove:latest` then recreate).
`config.json` and `state.json` survive — they're on the `/data` volume.

---

## Image tags produced by CI

| Tag | When |
|-----|------|
| `latest` | every build |
| `sha-<gitsha>` | every build (pin to an exact commit if you want) |
| `YYYYMMDD` | the weekly scheduled rebuild |

Your Portainer compose uses `:latest`. To pin a known-good version instead, set the
compose `image:` to a `sha-...` or date tag.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| First build fails: `invalid reference format` / empty image name | `DOCKERHUB_USERNAME` secret missing (Step 3) |
| Build fails on `docker login` | `DOCKERHUB_TOKEN` wrong/expired, or not Read+Write — regenerate (Step 2) |
| `upstream-sync` can't open a PR | Step 4 toggle "Allow Actions to create PRs" is off |
| No workflows run at all | Actions not enabled on the fork (Step 5) |
| Weekly jobs silently stopped | GitHub **pauses scheduled workflows after ~60 days of repo inactivity**. Any manual run or commit re-arms them |
| `run-now: command not found` on NAS | You're on an old image — re-pull (see "Updating the NAS") |

---

## Optional: shrink the fork later
If the maintainer accepts your path/email/Telegram patches upstream, your fork reduces
to just the `deploy/` overlay + CI — fewer merge conflicts. Ask Claude to prepare that
upstream PR when you're ready.
