# Roadmap: Phase 2+ Follow-up Items

**Date:** 2026-05-18
**Status:** Ready for implementation
**Audience:** Sonnet subagents — each Work Package (WP) is self-contained and can be implemented by an agent with no prior context.

---

## Context

`auto-identity-remove` is a Node.js + Playwright tool that automates data-broker opt-outs across 500+ sites. Phase 1 (WP1–WP6) shipped cross-platform support; Phase 1.5 (WP4 + WP7) shipped email-confirmation tracking and transparency wording. This roadmap covers everything proposed after HN feedback was triaged: 22 work packages, grouped by impact.

### Current architecture

| File | Role |
|------|------|
| `watcher.js` | Thin orchestrator: arg parsing + main loop |
| `lib/config.js` | Config + state (`recordSuccess`, `recordPendingConfirmation`, `shouldSkip`) |
| `lib/logger.js` | Bucketed results + `buildSummary` |
| `lib/forms.js` | Generic field filler with intl support |
| `lib/notify.js` | iMessage + webhook notifier (WP2) |
| `lib/scheduler.js` | Cross-platform job installer (WP1) |
| `lib/email.js` | Mail.app + SMTP (`nodemailer`) email opt-outs (WP2) |
| `lib/captcha.js` | CapSolver wrapper |
| `lib/verifier.js` | `--verify` read-only spot-check (WP5) |
| `lib/confirm.js` | Email-confirmation detection (WP4) |
| `lib/broker-runner.js` | `processBroker` per-broker flow |
| `lib/platform.js` | OS detection |
| `brokers.js` | ~31 explicit broker definitions (with `usOnly` / `verified` flags) |
| `generic-runner.js` | Heuristic runner for ~490 dataset URLs |
| `scripts/prune-dead.js` | Maintenance: trim permanently-dead hostnames |
| `setup.js` | Interactive setup |

Tests use Node's built-in `node:test`. 157/157 green. No external test deps.

**Security rule (codebase-wide):** Never shell out via `exec(string)`. Use `child_process.execFile(file, [...args])` with array arguments to avoid command injection. Any new WP that calls external binaries must follow this.

---

## Tier 1 — Effectiveness (closes the long tail)

These are the items that turn the project from "submits forms" into "actually completes opt-outs end-to-end."

### WP-A1 — AI fallback form-filling

**Problem:** The 4 generic strategies (Do Not Sell click, OneTrust/TrustArc, generic form, DSAR link) miss many sites. Each unique flow becomes a `manual` entry the user must handle. ~490 sites is too many for hand-mapped strategies.

**Files:** new `lib/ai-filler.js`, `generic-runner.js` (strategy 4 → 5), `config.example.json`, `README.md`

**Approach:**
1. New strategy 5 (after the existing 4 fail): extract simplified HTML of the page (forms + visible labels only, ~5 KB max) and send to Claude API (`claude-haiku-4-5` for cost) with a structured prompt: "Here is an opt-out page. Return JSON: `{ fields: [{selector, value: 'firstName'|'lastName'|'email'|...}], submitSelector }`. Use only the variable names listed: firstName, lastName, email, phone, city, state, zip, country."
2. Fill + submit per the returned plan. Log as `success` (with `ai-mapped` detail) or `pending_confirm` if applicable.
3. Gate behind `config.ai.apiKey` — opt-in. Without it, behavior unchanged.
4. Per-broker cache to `data/ai-mapped.json` so we only call the LLM once per host. Re-use the cached mapping on subsequent runs.
5. Cost guard: skip AI fallback if estimated tokens > 8K.

**Tests:** `test/ai-filler.test.js` — mock `fetch` to Claude API; assert plan-parsing handles malformed JSON, that cache deduplicates, that filler stops short of submit when fields can't be located on the page.

**Acceptance:** When AI is configured, a previously-`manual` test fixture (synthetic broker HTML) is filled + submitted. With AI not configured, behavior is identical to today.

**Conflict note:** Strategy registry in `generic-runner.js` — coordinate with WP-A4 (re-removal queue) which also touches result classification.

---

### WP-A2 — IMAP auto-click confirmation links

**Problem:** WP4 detects "check your email to confirm" but the user still has to click the link. Many users never bother, so the opt-out remains incomplete.

**Files:** new `lib/imap-confirmer.js`, `watcher.js` (post-run hook), `config.example.json`

**Approach:**
1. After the main run, if any brokers landed in `pendingConfirm`, open an IMAP connection (use `imapflow` — small, modern, supports OAuth and app passwords).
2. Search the inbox for unread messages from the last 24h whose body contains a known confirmation phrase (re-use `lib/confirm.js` PATTERN).
3. Extract URLs from the email body. For each, run heuristics:
   - URL contains words like `confirm`, `verify`, `optout`, `removal`, `unsubscribe`
   - Sender domain matches a known broker domain
4. Open the link in a fresh Playwright page, wait for navigation, check if the resulting page indicates success (look for "confirmed", "thank you", etc.)
5. If success → `recordSuccess()`, clearing `pendingConfirmation`. Mark the email as read.
6. Optional safety: dry-run mode prints intended actions without clicking.

**Config additions:**
```json
"imap": {
  "host": "imap.gmail.com",
  "port": 993,
  "user": "you@example.com",
  "password": "app-password",
  "folder": "INBOX"
}
```

**Tests:** `test/imap-confirmer.test.js` — mock `imapflow` Client; assert URL extraction, sender filter, page-result classification. Use real broker email fixtures in `test/fixtures/confirm-emails/`.

**Acceptance:** A fixture confirmation email is parsed → URL is extracted → page-load result is classified correctly. Without IMAP config, post-run hook is a no-op.

**Conflict note:** Depends on WP4 (already landed). Re-uses `lib/confirm.js`.

---

### WP-A3 — Email-alias-per-broker

**Problem:** Submitting the same email to 500 brokers makes that address a leak signal. If broker X spams you, you can't tell which one sold it. Users (HN) explicitly suspect opt-out forms are email-confirmation harvesting.

**Files:** new `lib/aliaser.js`, `lib/broker-runner.js` (consume alias), `setup.js` (alias provider config), `config.example.json`

**Approach:**
1. Support three providers behind a uniform interface:
   - **SimpleLogin** — API token, generates per-broker `<broker>.<random>@yourdomain.com`
   - **AnonAddy / addy.io** — API token, similar
   - **Apple Hide My Email** — manual paste; user provides a CSV `broker,alias`
2. `getAliasFor(brokerName)`: returns a cached alias if seen before, else creates a new one via API. Cache lives in `data/aliases.json` (gitignored).
3. `lib/broker-runner.js` and `generic-runner.js` replace `person.email` with `getAliasFor(broker.name)` before form fill.
4. `state.json` records `aliasEmail` per broker. `--verify` includes the alias in reports.

**Config:**
```json
"alias": {
  "provider": "simplelogin",
  "apiKey": "sl_...",
  "domain": "yourdomain.com"
}
```

**Tests:** `test/aliaser.test.js` — mock provider APIs; assert caching, per-broker uniqueness, fallback to real email if provider unreachable + config opt-out.

**Acceptance:** With provider configured, every submission uses a unique alias. Without config, behavior unchanged.

**Conflict note:** Touches form-fill paths shared with WP-A1 (AI filler). Land before A1 so AI filler can use the aliased email automatically.

---

### WP-A4 — Re-removal queue

**Problem:** When `--verify` finds "still listed," nothing happens automatically. User has to manually re-run.

**Files:** `lib/verifier.js`, `lib/config.js` (state schema), `lib/broker-runner.js`, new `data/re-removal-queue.json` (gitignored)

**Approach:**
1. When `--verify` classifies a broker as `still_listed`, add `{ broker, addedAt, attempts }` to `data/re-removal-queue.json`.
2. On the next regular run, `watcher.js` processes the queue BEFORE the regular brokers list — these get priority.
3. Successful re-removals are removed from the queue. After 3 failed re-attempts, broker is moved to a "manual escalation" list (feeds WP-B2 CCPA generator).

**Tests:** `test/re-removal-queue.test.js` — fixture queue, simulate verify outcomes, assert queue mutations.

**Acceptance:** Verify → still-listed → queue grows. Next run → priority pass on queued brokers. After 3 attempts → manual list.

**Conflict note:** Touches state schema. Coordinate with WP-A3 (alias schema).

---

### WP-A5 — Parallel broker execution

**Problem:** Sequential execution makes a full 500-broker run take 1.5–2 hours. Most of that is waiting on `await page.goto(...)`.

**Files:** `watcher.js`, `generic-runner.js`, new `lib/concurrency.js`

**Approach:**
1. Add `--parallel N` flag (default: 1 for safety). 4–8 is the sweet spot.
2. New `lib/concurrency.js`: simple `pool(items, n, fn)` async-pool helper.
3. Each worker holds its own Playwright `context` (NOT a shared page — pages aren't thread-safe in Playwright).
4. Logger writes are protected by a mutex (just a serial `await queue` since JS is single-threaded — only need to interleave console output cleanly).
5. CapSolver has its own concurrency limits — gate captcha-likely brokers to N=2 max.

**Tests:** `test/concurrency.test.js` — pool correctness, error propagation, ordering of results.

**Acceptance:** `--parallel 8` completes a 500-broker run in <30 min (was ~2hr). Output remains readable. No data corruption (verify state.json byte-equality with sequential runs on a fixed broker subset).

**Conflict note:** Requires `lib/broker-runner.js` configuration to be per-call rather than module-level. Currently it's per-call via `configure()` — but `opts` is shared module-level. Refactor to pass `opts` as an argument so parallel workers don't clobber each other.

---

### WP-A6 — Resume / checkpoint

**Problem:** If the run crashes mid-pass (network glitch, OOM, Ctrl-C), state.json is only updated per-broker on success. Recovery means starting over.

**Files:** `lib/config.js`, `watcher.js`

**Approach:**
1. `state.json` gains a `currentRun: { startedAt, completedBrokers: [...] }` field.
2. On startup, if `currentRun` exists and is recent (< 12h), prompt: "Resume previous run? (Y/n)". On yes, skip completed brokers.
3. On clean completion, clear `currentRun`.
4. Save `state.json` after every broker, not just on success (already mostly true via `recordSuccess`/`recordPendingConfirmation`; add a `markAttempted(name)` for failures too).

**Tests:** `test/resume.test.js` — write a partial state.json, assert resume logic skips correctly.

**Acceptance:** Kill watcher mid-run → re-run → previously completed brokers are skipped.

---

## Tier 2 — Trust & evidence

### WP-B1 — Screenshot + timestamp proof

**Problem:** Brokers ignore opt-outs; without evidence the user can't escalate.

**Files:** `lib/broker-runner.js`, `generic-runner.js`, `lib/logger.js`, `.gitignore`

**Approach:**
1. After each submit, take `page.screenshot({ path: 'logs/proof/<date>/<broker>.png' })`.
2. Save the response page HTML to `logs/proof/<date>/<broker>.html`.
3. Each `logs/proof/<date>/manifest.json` lists `{ broker, screenshot, html, submittedAt, sha256 }` — the evidence package.
4. `--no-proof` flag to disable for disk-constrained users.

**Tests:** `test/proof.test.js` — mock `page.screenshot` and `fs.writeFile`; assert manifest schema and SHA-256 stability.

**Acceptance:** `ls logs/proof/2026-05-18/` shows one PNG + one HTML per submission. Manifest validates.

---

### WP-B2 — CCPA / state-AG complaint generator

**Problem:** Brokers routinely ignore opt-outs (HN: Uline anecdote). No escalation path.

**Files:** new `lib/complaint-gen.js`, `scripts/complain.js`, new `data/complaint-templates/` directory

**Approach:**
1. Template per regulator: CA AG (CCPA), TX OAG, OR DOJ, VT AG, FTC.
2. `node scripts/complain.js --broker Spokeo` generates a pre-filled complaint with:
   - Your info (from config.json)
   - Opt-out submission date(s) from `state.json`
   - Re-removal-queue history (WP-A4)
   - Screenshot proof references (WP-B1)
   - Pre-filled regulator form URL
3. Output: PDF (use `pdfkit`) + plain-text complaint body for paste.

**Tests:** `test/complaint-gen.test.js` — template rendering, variable substitution, output format.

**Acceptance:** Given a broker with ≥3 failed re-removals (WP-A4 escalation), generate a complaint draft. User opens the regulator portal, pastes the body, submits.

---

### WP-B3 — HTML dashboard

**Problem:** Logs are JSON. Hard to see the picture across runs.

**Files:** new `scripts/dashboard.js`, new `templates/dashboard.html` (vanilla JS + Chart.js CDN)

**Approach:**
1. Reads all `logs/run-*.json` + current `state.json`.
2. Writes `dashboard.html` with:
   - Total brokers, submitted (last 90d), still-listed (last verify), pending email confirms
   - Timeline chart of exposure
   - Per-broker last-action date
   - Action items (queue + manual list)
3. Single-file HTML, openable locally. No server needed.

**Tests:** `test/dashboard.test.js` — fixture logs, assert HTML contains expected counts.

**Acceptance:** `node scripts/dashboard.js && open dashboard.html` shows current state.

---

### WP-B4 — Reverse search

**Problem:** The signal that actually matters: when someone Googles you, what shows up?

**Files:** new `scripts/reverse-search.js`, new `lib/serp.js`

**Approach:**
1. Use [SerpAPI](https://serpapi.com) or [Brave Search API](https://brave.com/search/api/) (Brave is cheaper / privacy-friendly).
2. Query `"FirstName LastName" "City"` and `"FirstName LastName" "phone-prefix"`.
3. For each top-10 result, check the hostname against `data/markup-parsed.json` — if it's a known broker, flag as "still indexed."
4. Output: list of "still findable on Google" with the broker name. Feed into re-removal queue (WP-A4) for brokers we have opt-out flows for.

**Tests:** `test/serp.test.js` — mock API response, assert classification and queue feed.

**Acceptance:** `node scripts/reverse-search.js` produces a list. Each indexed broker we can opt out of is added to the queue.

---

## Tier 3 — Reach

### WP-C1 — More broker datasets

**Files:** `data/vermont-brokers.json`, `data/ca-drop-brokers.json`, `data/prc-brokers.json`, `generic-runner.js` (loader)

**Approach:** Vermont publishes its data broker registry under 9 V.S.A. § 2446. California DROP launches Aug 1 2026. Both are official, machine-readable lists. Privacy Rights Clearinghouse maintains a hand-curated list.

For each source: a tiny scraper script in `scripts/refresh-datasets.js` that fetches → dedupes → writes to the appropriate JSON. Run quarterly.

**Tests:** schema validation on each JSON file.

**Acceptance:** Three new dataset files; generic-runner picks them up automatically.

---

### WP-C2 — State-specific DSAR templates

**Files:** new `lib/dsar.js`, new `data/dsar-templates/<state>.md`

**Approach:** TX, OR, CT, VA, UT have different rights wording. Currently `sendEmailOptOuts` uses one CCPA-flavored body. Switch to per-state template selected by `config.person.state`. Fall back to CCPA for unmapped states (it's the most expansive).

**Tests:** `test/dsar.test.js` — assert each state's body contains its specific statute citation.

**Acceptance:** Email opt-outs cite the correct state law.

---

### WP-C3 — Family / multi-profile mode

**Problem:** Most users want to remove themselves + spouse + kids + aging parents. Currently requires 4 separate clones.

**Files:** `setup.js`, `lib/config.js`, `watcher.js`, `config.example.json`

**Approach:**
1. `config.json` schema: `profiles: [{ id, person, aliasOverrides? }, ...]`. Old single-`person` config auto-migrated as one profile.
2. `state.json` keyed by `{ profile, broker }`.
3. Run loop: for each profile, run all brokers. (Or `--profile <id>` for one.)
4. Summary groups by profile.

**Tests:** `test/multi-profile.test.js` — fixture config with 2 profiles, assert state isolation.

**Acceptance:** One config covers a household. Each member's state is tracked independently.

**Conflict note:** Touches state schema heavily — must land before WP-A4 (queue) and WP-A6 (resume) if both want per-profile awareness, OR retrofit them after.

---

### WP-C4 — Phone-alias support

**Files:** `lib/aliaser.js` (extend), `config.example.json`

**Approach:** Like WP-A3 but for phone numbers. Providers: Google Voice (manual), MySudo (API), Burner (API). Optional. Many brokers don't accept VoIP — flag those in `brokers.js` with `acceptsVoIP: false`.

**Tests:** in `test/aliaser.test.js`.

**Acceptance:** Phone alias used when available, real number when not.

---

## Tier 4 — Portability & adoption

### WP-D1 — Apprise integration

**Problem:** `lib/notify.js` supports iMessage + one webhook. Users want Telegram, Pushover, Matrix, Gotify, etc.

**Files:** `lib/notify.js`, `package.json`, `setup.js`, `README.md`

**Approach:** Apprise is a Python project. Easiest path: shell out to the `apprise` CLI if installed (`brew install apprise` / `pip install apprise`), via `child_process.execFile('apprise', [...args])` (array form — no shell). Otherwise stick with current webhook. Config: `notify.appriseUrls: ["tgram://...", "pover://..."]`.

**Tests:** mock `child_process.execFile`, assert correct argv.

**Acceptance:** A configured Telegram bot receives the summary when Apprise is installed.

---

### WP-D2 — GitHub Action workflow

**Files:** new `.github/workflows/monthly-optout.yml`, new `docs/github-action-setup.md`

**Approach:** Use `actions/setup-node@v4` + `npx playwright install --with-deps chromium`. Secrets: `CONFIG_JSON`, `CAPSOLVER_KEY`, `STATE_JSON` (mutated via API). Schedule: `cron: '0 9 1 * *'`. Reports back via Slack/webhook.

State persistence problem: GH Actions has no durable disk. Solutions:
- Store state.json as a GitHub Actions repository secret, updated via API at end of run.
- Or commit it back to a `private-state` branch (sketchy — leaks history).
- Or external storage (S3/R2) — recommended.

**Tests:** lint the workflow with `actionlint`; no functional tests possible.

**Acceptance:** A scheduled workflow runs successfully, posts results to Slack, state is preserved across runs.

---

### WP-D3 — Encrypted config

**Problem:** `config.json` has plaintext PII on disk.

**Files:** new `lib/encrypted-config.js`, `setup.js`, `package.json` (add `age-encryption`)

**Approach:**
1. `setup.js` asks: "Encrypt config with passphrase? (Y/n)".
2. If yes, `config.json` is written as `config.json.age`. On load, prompt for passphrase once per run (or use `keytar` for OS keychain).
3. State.json is similarly encryptable but a bigger pain (writes are frequent). Optional.

**Tests:** `test/encrypted-config.test.js` — round-trip encrypt/decrypt.

**Acceptance:** With encryption enabled, no plaintext PII on disk between runs. Keychain lookup works on macOS / Linux (libsecret) / Windows.

---

### WP-D4 — `--single <broker>` flag

**Problem:** When debugging, you don't want to run all 500.

**Files:** `watcher.js`

**Approach:** Trivial. `--single Spokeo` filters the broker list to one match.

**Tests:** `test/single-flag.test.js`.

**Acceptance:** `node watcher.js --single Spokeo` runs only Spokeo.

---

### WP-D5 — Synthetic broker fixtures

**Problem:** All current tests mock at the API boundary. We have no regression coverage for the actual heuristic strategies against real-shaped HTML.

**Files:** new `test/fixtures/brokers/*.html`, new `test/generic-strategies.test.js`

**Approach:**
1. Capture a sanitized HTML snapshot of each strategy class:
   - `do-not-sell-button.html`
   - `onetrust-modal.html`
   - `trustarc-modal.html`
   - `generic-form-email-only.html`
   - `generic-form-name-email.html`
   - `dsar-link-page.html`
   - `404-page.html`
   - `confirmation-required.html`
2. Use Playwright's `page.setContent(html)` to load each fixture.
3. Assert `processGenericUrl` returns the expected status for each.

**Tests:** This IS the test suite — regression coverage for the heuristic core.

**Acceptance:** 8 fixtures, 8 tests, all green. Changes to generic-runner.js cannot break a strategy class silently.

---

### WP-D6 — Docker / docker-compose

**Files:** new `Dockerfile`, new `docker-compose.yml`, `README.md`

**Approach:** Base image `mcr.microsoft.com/playwright:v1.50.0-jammy` (Playwright preinstalled). Mount `./config.json` + `./state.json` + `./logs/` as volumes. CMD `node watcher.js`.

```yaml
services:
  optout:
    build: .
    volumes:
      - ./config.json:/app/config.json:ro
      - ./state.json:/app/state.json
      - ./logs:/app/logs
```

**Tests:** `docker build .` runs in CI.

**Acceptance:** `docker compose run --rm optout --dry-run` works.

---

### WP-D7 — CapSolver browser extension doc

**Files:** `README.md` (Manual / Hybrid mode section)

**Approach:** No code. Document that users who want to watch + intervene can install the CapSolver browser extension (it auto-solves captchas in any visible Chromium tab) and run watcher with `--headed`.

**Acceptance:** Section in README under "Advanced usage."

---

### WP-D8 — California DROP enrollment helper

**Files:** new `scripts/enroll-drop.js`, `README.md`

**Approach:** Walk the user through California's DROP registration once it's live (Aug 1 2026). DROP is a single point of registration that all CA-registered brokers must honor — it's the single most valuable opt-out a CA resident can do. Auto-fill the DROP form via Playwright using `config.person`.

**Tests:** Once DROP is live, replay against a recorded HAR.

**Acceptance:** `node scripts/enroll-drop.js` walks the user through registration and records success in state.json under broker name `California DROP`.

---

## Execution Plan

Dependencies form four small DAGs:

```
Group α (independent — can run in parallel)
  WP-D4  --single flag
  WP-D5  fixtures + heuristic regression tests
  WP-D6  Docker
  WP-D7  CapSolver ext doc

Group β (state-schema touches — serialize)
  WP-A6 → WP-A4 → WP-C3
  (resume/checkpoint → re-removal queue → multi-profile)

Group γ (independent of β)
  WP-A3 (alias)  → WP-C4 (phone alias)
  WP-A1 (AI fill) — depends on WP-A3 for alias-aware fills
  WP-A2 (IMAP)   — depends on WP4 (landed)
  WP-A5 (parallel) — needs broker-runner opts arg refactor

Group δ (trust / evidence — additive)
  WP-B1 (proof) → WP-B2 (complaint gen)
  WP-B3 (dashboard) — independent
  WP-B4 (reverse search) → feeds WP-A4

Group ε (datasets / regulatory — independent)
  WP-C1 (datasets), WP-C2 (DSAR), WP-D2 (GH Action), WP-D3 (encrypted), WP-D1 (Apprise), WP-D8 (DROP)
```

**Dispatch guidance:**
1. Kick off Group α in parallel (4 subagents). Land each independently.
2. Land WP-D5 first — gives all subsequent WPs regression coverage to test against.
3. Group β must serialize. Resume → queue → multi-profile, each rebases on previous.
4. Group γ: WP-A3 first, then A1 / A2 / A5 in parallel.
5. Group δ + ε: any order, parallel-safe.

**Per-WP rules (reaffirm Phase 1 discipline):**
- TDD: write tests first.
- No file > 300 lines.
- No new top-level dependencies without justification (`nodemailer` for WP2 set the bar — must be lazy-required and gated by config).
- All external-binary calls use `child_process.execFile(name, [...args])`, never `exec(string)`.
- Each WP commits with `feat:`/`fix:` referencing the WP id.
- Each WP updates `README.md` for any user-facing change.
- Each WP runs `node --test test/*.test.js` before commit. 100% green required.

## Out of scope (still / again)

- Data-poisoning / fake-record injection
- Bundling a paid proxy email service (we integrate; we don't host)
- Guaranteeing deletion (legally impossible)
- Per-broker bespoke flows for all 500 generic sites — the heuristic + AI fallback is the line we'll draw
