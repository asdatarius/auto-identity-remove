# 2026-05-19 — HN follow-up implementation plan

Plan for the 8 unimplemented suggestions from the HN thread
(https://news.ycombinator.com/item?id=48178184). Each work package is
independently buildable by a Sonnet subagent in an isolated worktree.

## Workflow

1. Each WP is built in its own git worktree to avoid merge conflicts.
2. Each WP must add tests; full suite must stay 100% green.
3. After agent completes, merge worktree branch into `main`, push to GH.
4. After all merges, run a final end-to-end dry-run smoke test.

## Conflict map

| WP | Primary files | Test files | Conflict risk |
|---|---|---|---|
| WP1 | lib/scheduler.js, scripts/install-cron.sh | test/scheduler.test.js | low |
| WP2 | lib/notify.js, watcher.js, package.json | test/notify.test.js | medium (watcher.js) |
| WP3 | lib/logger.js, watcher.js | test/logger.test.js | medium (logger.js, watcher.js) |
| WP4 | lib/broker-runner.js, watcher.js | test/broker-runner-preview.test.js | medium (watcher.js) |
| WP5 | generic-runner.js, lib/logger.js | test/generic-runner-audit.test.js | medium (logger.js) |
| WP6 | lib/forms.js, lib/config.js | test/forms-intl-postal.test.js | low |
| WP7 | docs/PRIVACY.md (new) | n/a | none (doc only) |
| WP8 | watcher.js, lib/broker-runner.js, lib/noise.js (new) | test/noise.test.js | medium (broker-runner, watcher) |

Batching to minimize conflicts:
- **Batch 1** (parallel): WP1, WP6, WP7 — all independent files
- **Batch 2** (parallel): WP2, WP3 — touch watcher.js but different lines
- **Batch 3** (parallel): WP4, WP5 — touch logger.js separately
- **Batch 4** (sequential): WP8 — touches watcher.js + broker-runner.js heavily

---

## WP1 — Linux systemd + Windows Task Scheduler support

**Problem:** Scheduler today only writes a macOS launchd plist. Linux users
(`ramon156`) and Windows users (`jeroenhd`) can't auto-run on a schedule.

**Approach:** `lib/scheduler.js` already has a stub `installSystemd()` —
verify it works and add `installWindowsTask()` using `schtasks /Create`.
Wire `--install-scheduler` flag in `watcher.js` to detect platform and call
the right installer.

**Files:**
- `lib/scheduler.js` — add `installWindowsTask({hour, minute})` and
  verify `installSystemd()` returns a working `.service` + `.timer`.
- `watcher.js` — detect `--install-scheduler` flag; route by platform.

**Tests:**
- `test/scheduler.test.js` — assert systemd unit file content matches expected
  format (`OnCalendar=*-*-01 03:00:00`, `Type=oneshot`).
- New: assert `schtasks` command string is built correctly with proper
  escaping for paths-with-spaces.
- Cross-platform: mock `process.platform`, verify correct installer called.

**Acceptance:** `node watcher.js --install-scheduler` works on macOS, Linux,
and Windows (verified via mocked platform).

---

## WP2 — Docker / cross-platform notifications

**Problem:** `LatencyKills` and `IgorPartola` flagged that `macNotify()` and
iMessage calls block non-Mac usage. Goal: tool should run inside Docker /
on a headless Linux server with no Mac dependencies.

**Approach:**
1. Audit `lib/notify.js` — make all Mac-specific functions (`sendText` via
   iMessage, `desktopNotify` via osascript) no-op gracefully on non-Mac
   with a debug log instead of crashing.
2. Add webhook notification path (Slack/Discord/ntfy) via simple POST.
3. Add `Dockerfile` for headless usage with Playwright Chromium pre-installed.

**Files:**
- `lib/notify.js` — guard `sendText`/`desktopNotify` with `isMac` check;
  add `sendWebhook(url, message)` using built-in `https`.
- `Dockerfile` (new) — based on `mcr.microsoft.com/playwright:focal`.
- `README.md` — Docker run command, webhook config example.

**Tests:**
- `test/notify.test.js` — assert `sendText` is no-op on non-mac (no crash,
  returns false); assert `sendWebhook` POSTs correct JSON shape.
- Mock `https.request` for webhook tests.

**Acceptance:** `docker build . && docker run` completes a dry-run; webhook
fires on `notify.webhook` config; no exit-1 on Linux.

---

## WP3 — Post-run "what to watch for in your inbox" checklist

**Problem:** `lolpython` asked for a human-readable list of which sender
emails to expect after the run, instead of just a `pending_confirm` status
code.

**Approach:** In `buildSummary()`, when `results.pendingConfirm.length > 0`,
emit a "📧 Action needed — watch your inbox" section listing broker name +
expected sender domain (derived from `broker.optOutUrl` hostname).

**Files:**
- `lib/logger.js` — extend `buildSummary()` with the new section.
- `watcher.js` — no change needed if section comes from `buildSummary`.

**Tests:**
- `test/logger.test.js` — add test: when `results.pendingConfirm` has 2
  entries, summary includes section header "📧 Watch your inbox" and one
  bullet per broker with sender domain.

**Acceptance:** After a run with 2 pending confirms, terminal output
includes:
```
📧 Watch your inbox — confirm removal:
   • Radaris (sender: radaris.com)
   • InfoTracer (sender: infotracer.com)
```

---

## WP4 — Detailed dry-run preview (fields → broker)

**Problem:** `Waffle2180` wants dry-run mode to print which fields would be
submitted to which broker before any network call, as a safety review step.

**Approach:** In `processBroker`, after `fillForm()` populates the page,
collect the resolved values (`name=foo → "Jane"`, etc.) and log them when
`opts.dryRun === true` and `opts.verbosePreview === true` (new flag
`--preview`).

**Files:**
- `lib/broker-runner.js` — extract resolved field values from `page` using
  `page.evaluate(() => [...document.querySelectorAll('input,select,textarea')].map(el => ({name:el.name||el.id, value:el.value})))`.
- `watcher.js` — accept `--preview` CLI flag; pass to `configure()`.

**Tests:**
- `test/broker-runner-preview.test.js` (new) — stub page with `evaluate`
  returning fixture field list; assert `logResult` is called with detail
  containing field-value pairs when `preview: true`.

**Acceptance:** `node watcher.js --dry-run --preview` prints e.g.
```
[Radaris] preview — input[name=first]="Jane" input[email]="jane@example.com" → POST https://radaris.com/optout
```

---

## WP5 — Generic runner success/failure audit

**Problem:** No way to know which of the ~500 generic sites are actually
succeeding vs. silently failing. Author's own open question.

**Approach:** Track per-site outcome with a confidence label:
- `submitted` — found form + clicked submit (no error)
- `no_form_found` — page loaded but no recognizable form
- `error` — exception during processing
- `dry-run-skipped` — submit deferred

Aggregate stats and emit a section in summary:
```
Generic runner: 487 attempted | 312 submitted | 142 no_form_found | 33 error
```

**Files:**
- `generic-runner.js` — return per-site outcome objects from `runGenericBrokers`.
- `lib/logger.js` — add `genericStats` to `results`, render in summary.

**Tests:**
- `test/generic-runner-audit.test.js` (new) — stub 4 brokers with different
  outcomes; assert returned counts match.

**Acceptance:** Summary includes generic stats; logs/json contains per-site
breakdown for debugging.

---

## WP6 — Non-US address handling improvements

**Problem:** `pards` (CA) and `7777777phil` flagged that non-numeric postal
codes and non-US address formats may break automation on global brokers.

**Approach:**
1. Validate `applyRegionAliases` handles CA `K1A 0A6`, GB `SW1A 1AA`,
   AU `2000` postal codes without dropping characters.
2. Add `country`-aware phone formatting in `lib/config.js` —
   currently `phoneFormatted` is assumed pre-formatted, but should be
   sanitized for non-US (strip US-style parens/dashes if country !== 'US').
3. Add postal-code validation regex per country in `lib/forms.js` —
   if `country === 'CA'`, allow alphanumeric+space; default US allows digits.

**Files:**
- `lib/forms.js` — extend `applyRegionAliases` for AU/NZ/IE postcode names.
- `lib/config.js` — country-aware phone normalization helper.

**Tests:**
- `test/forms-intl-postal.test.js` (new) — feed `K1A 0A6` through a form
  with `input[name="postcode"]`; verify space + alphanumeric preserved.

**Acceptance:** A CA user with `K1A 0A6` zip has the postal code submitted
verbatim, not normalized to digits-only.

---

## WP7 — Privacy threat model doc

**Problem:** `exiguus` and `ur-whale` flagged that the tool's data-flow is
unclear — what leaves the machine, what CapSolver sees, what trust assumptions.

**Approach:** Write `docs/PRIVACY.md` covering:
1. **Data inputs** — name, address, email, phone (from `config.json`).
2. **Data destinations** — broker opt-out forms (HTTPS to broker hostnames
   only), CapSolver API (only the CAPTCHA image bytes — NOT your PII),
   optional SMTP server (your configured server), optional webhook.
3. **Data NOT sent** — no telemetry, no central server, no analytics. The
   tool has no phone-home.
4. **Trust assumptions** — broker honors GDPR/CCPA, CapSolver doesn't log
   images, your local config.json is gitignored.
5. **Threat model** — adversary scenarios: (a) malicious broker captures
   submitted data → already public; (b) CapSolver compromised → only
   CAPTCHA bytes leak; (c) repo compromise → no PII in repo.

**Files:**
- `docs/PRIVACY.md` (new).
- `README.md` — link prominently in opening paragraph.

**Tests:** N/A (doc-only).

**Acceptance:** PRIVACY.md exists with all 5 sections, README links to it.

---

## WP8 — Noise / data-pollution mode

**Problem:** `himata4113` suggested submitting bogus entries alongside
opt-outs to flood broker databases, making search results useless.

**Approach (NEW FEATURE, OFF BY DEFAULT):**
1. `--pollute N` CLI flag — generates N realistic fake records using
   `lib/noise.js` and submits them to brokers that accept arbitrary input.
2. Each fake record uses real city/state/zip from a fixture list (NOT the
   user's) and a randomly generated name/email/phone.
3. Only applies to brokers explicitly tagged `acceptsBogus: true` —
   to avoid wasting submissions on brokers that gate by SSN/DOB.

**Files:**
- `lib/noise.js` (new) — `generateBogusPerson()` returns fake person object;
  fixture list of 50 US cities w/ valid zip/area-code combos.
- `watcher.js` — handle `--pollute N` flag.
- `lib/broker-runner.js` — `processBrokerWithPerson(context, broker, person)`
  variant so we can pass bogus person instead of real.

**Tests:**
- `test/noise.test.js` (new) — `generateBogusPerson()` returns valid shape,
  zip matches state, area code matches state.

**Acceptance:** `node watcher.js --pollute 10` submits 10 bogus records to
each `acceptsBogus` broker. Default behavior (no flag) unchanged.

**Note:** Noise mode is ethically gray — README must warn about ToS
violations. Off by default. Documented as "advanced / experimental".

---

## Final acceptance criteria

- [ ] All 8 WPs merged to `main`
- [ ] Full test suite passes (163+ tests)
- [ ] `node watcher.js --dry-run` runs end-to-end without errors
- [ ] All commits pushed to GitHub
- [ ] README updated with new flags/Docker section
- [ ] PRIVACY.md linked from README
