# 2026-05-19 — Stability + Features plan (10 work packages)

Plan for 10 stability/feature improvements identified after the HN follow-up
work shipped. Each WP is independently buildable by a Sonnet subagent in an
isolated worktree.

## Batching strategy

Merge conflicts are the main risk. Group by file overlap; run within-batch
in parallel, between-batch sequentially (merge batch N before dispatching N+1).

| Batch | WPs | Watcher.js? | Conflict risk |
|---|---|---|---|
| 1 | WP-S2, WP-S3, WP-S4, WP-S8 | none | very low |
| 2 | WP-S1, WP-S6, WP-S7 | one (WP-S1 top) | low |
| 3 | WP-S5, WP-S9, WP-S10 | all 3 | medium - merge sequentially |

---

## WP-S1: Atomic state.json writes + lock file

**Problem:** `fs.writeFileSync(STATE_PATH, ...)` mid-write on a kill leaves
corrupted JSON. Also, two watchers running concurrently (cron overlap, manual
+ scheduled) race on state.json.

**Approach:**
1. In `lib/config.js`, replace `saveState()` with atomic write: write to
   `state.json.tmp` then `fs.renameSync` to `state.json`. Keep one `.bak`
   of the previous version.
2. New `lib/lock.js`: `acquire()` creates `state.json.lock` containing PID +
   timestamp; throws if lock is held and lock-PID is still alive
   (`process.kill(pid, 0)`). `release()` removes the file.
3. `watcher.js` calls `acquire()` at start, `release()` in a `finally`.

**Files:** `lib/config.js`, `lib/lock.js` (new), `watcher.js` (top + finally), `test/lock.test.js` (new), `test/config.test.js` (extend).

**Tests:**
- Lock acquire on fresh dir succeeds; second acquire throws.
- Lock with dead PID is reclaimable.
- saveState writes to .tmp first; if .tmp write fails, original is unchanged.
- A `.bak` file appears after second successful write.

---

## WP-S2: Retry + backoff on transient errors

**Problem:** A 503 or `Timeout` from a broker today fails permanently for 90
days. Many of these are transient (CDN blip, broker overload).

**Approach:** `lib/retry.js` exports `withRetry(fn, {attempts: 3, baseMs: 500})`.
Exponential backoff: 500ms, 1000ms, 2000ms. Only retry on these errors:
`Timeout`, `net::ERR_*`, HTTP 502/503/504. Don't retry on selector failures
or CAPTCHA failures.

Wrap the `await page.goto(...)` calls in `broker-runner.js` and
`generic-runner.js` with `withRetry`.

**Files:** `lib/retry.js` (new), `lib/broker-runner.js`, `generic-runner.js`, `test/retry.test.js` (new).

**Tests:**
- Succeeds on first attempt: no delays, no retries.
- Fails twice then succeeds: 2 backoff delays, eventual return value.
- Fails all 3: throws original error.
- Non-retriable error (selector miss): no retries.

---

## WP-S3: Anti-bot stealth (random jitter)

**Problem:** Fixed `sleep(1500)` between actions makes the script obviously
robotic. Real users have variable timing.

**Approach:**
1. Replace fixed sleeps in `lib/forms.js` and `lib/broker-runner.js` with
   `jitterSleep(min, max)` from new `lib/timing.js`.
2. Random delay between brokers: 5-15s instead of 700ms.
3. Add `--turbo` flag to opt out of jitter for testing/dev (keeps current
   short delays).

**Files:** `lib/timing.js` (new), `lib/forms.js`, `lib/broker-runner.js`, `test/timing.test.js` (new).

**Tests:**
- `jitterSleep(100, 200)` resolves between 100-200ms.
- `jitterSleep` honors `TURBO=1` env to skip waits in tests.

---

## WP-S4: GitHub Actions CI

**Problem:** Nothing enforces green tests on PR. Could merge broken code.

**Approach:** `.github/workflows/test.yml` runs `node --test` on push and PR
against Node 18, 20, 22.

**Files:** `.github/workflows/test.yml` (new), `README.md` badge.

**Tests:** N/A (the workflow is the test).

**Verification:** Trigger the workflow once after merging to confirm green.

---

## WP-S5: Filter flags (--only / --skip / --retry-failed / --list)

**Problem:** A full run takes 30+ minutes. Devs/users can't easily test or
re-run a single broker.

**Approach:** Four new CLI flags in `watcher.js`:
- `--only <name1,name2>` — only run these brokers.
- `--skip <name1,name2>` — skip these.
- `--retry-failed` — read last log, only re-run brokers that had `error`,
  `captcha_failed`, or `pending_confirm`.
- `--list` — print all brokers with status from state.json, then exit.

Filter is applied to the explicit + generic broker list before processing.

**Files:** `watcher.js`, `lib/filter.js` (new helper), `test/filter.test.js` (new).

**Tests:**
- `--only Spokeo,Radaris` returns only those two from a fixture broker list.
- `--skip` removes named brokers, keeps the rest.
- `--retry-failed` parses a fixture log and selects only error/pending.
- `--list` outputs broker names + status without launching browser.

---

## WP-S6: Doctor command

**Problem:** When setup fails, the user sees a cryptic error. No way to
self-diagnose.

**Approach:** `node watcher.js doctor` (or `--doctor` flag) runs checks:
1. `config.json` exists and has required fields.
2. Playwright installed and Chromium downloaded.
3. SMTP host reachable (if configured).
4. CapSolver API key valid (HEAD request to API).
5. Network reachable for broker hosts (HEAD request to top 5).
6. `state.json` is parseable.
7. Webhook URL responds 2xx (if configured).

Output: green checkmarks for pass, red X with remediation hint for fail.

**Files:** `lib/doctor.js` (new), `watcher.js` (dispatch), `test/doctor.test.js` (new).

**Tests:**
- Each check function returns `{ok: true/false, hint: string}`.
- Mock `fs.existsSync` / `https.request` for offline tests.

---

## WP-S7: Selector drift detection

**Problem:** When a broker silently changes their DOM, the selector misses
and we never know — we just log `error` and move on.

**Approach:** Track per-broker rolling success rate in `state.json`:
```json
"Spokeo": { "history": ["success", "success", "error", "error", "error"], ... }
```
After each run, if last 3 attempts are non-success, promote the broker's
confidence to `drifted` in a new `lib/drift.js` report.

End-of-run summary includes:
```
🚨 Drift detected — these brokers have failed 3+ times:
   • Spokeo (last success: 2026-02-14)
   • MyLife (last success: 2026-03-02)
```

**Files:** `lib/drift.js` (new), `lib/config.js` (history tracking), `lib/logger.js` (summary section), `test/drift.test.js` (new).

**Tests:**
- History trimmed to last 5 attempts.
- Drift flagged when 3 consecutive non-success.
- Drift cleared after a success.

---

## WP-S8: GDPR email templates + CalPrivacy DROP entry

**Problem:** Current email is CCPA-flavored. EU users need GDPR Article 17
wording. Also, California users should know about the DROP platform.

**Approach:**
1. In `lib/email.js`, detect `person.country` — use GDPR template when EU
   countries (DE, FR, ES, IT, NL, etc.) or GB.
2. GDPR template cites Article 17, mentions data portability, 30-day SLA.
3. CCPA template (existing) stays default for US/other.
4. Add a manual broker entry for CalPrivacy DROP
   (`https://cppa.ca.gov/data_broker_registry/`) with notes explaining
   single-submission coverage.

**Files:** `lib/email.js` (template routing), `brokers.js` (DROP entry), `test/email.test.js` (extend).

**Tests:**
- GDPR template emitted for `country: 'DE'`.
- CCPA template emitted for `country: 'US'`.
- Both templates include Name/Address/Email/Phone fields.
- DROP entry present in brokers.js with `method: 'manual'`.

---

## WP-S9: Result diffing + markdown audit report

**Problem:** No way to see "what changed since last run" — did new exposures
appear? Did anything regress? Also, no formal proof-of-request artifact.

**Approach:**
1. `lib/diff.js`: compare current `results` to previous `logs/run-*.json`.
   Output: "Since last run: +3 new exposures, +5 newly removed, 2 regressed."
2. `lib/audit.js`: render a markdown audit report per run: timestamp, broker
   name, status, submission detail. Saved to `logs/audit-YYYY-MM-DD.md`.
   Suitable as legal evidence of opt-out request.

**Files:** `lib/diff.js` (new), `lib/audit.js` (new), `watcher.js`, `test/diff.test.js` (new), `test/audit.test.js` (new).

**Tests:**
- diff: fixture previous + current → known counts.
- diff: missing previous → all current treated as new.
- audit: rendered markdown contains all broker outcomes.

---

## WP-S10: Per-broker timeout + webhook rich payload

**Problem:** Hard-coded 15s timeout fails fast for slow brokers (Radaris
sometimes takes 30s) and wastes time on fast ones. Webhook only sends summary
text, not structured data.

**Approach:**
1. `brokers.js` entries can specify `timeoutMs: 30000`. Default 15000.
2. `lib/broker-runner.js` uses `broker.timeoutMs || 15000` in `page.goto`.
3. `lib/notify.js` `sendWebhook` accepts structured payload:
   ```json
   {"summary": "...", "results": {"succeeded": [...], "errors": [...]}, "timestamp": "..."}
   ```

**Files:** `lib/broker-runner.js`, `brokers.js`, `lib/notify.js`, `test/broker-runner-timeout.test.js` (new), `test/notify.test.js` (extend).

**Tests:**
- Broker with `timeoutMs: 30000` uses that value.
- Default timeout still 15000.
- Webhook payload includes `results` and `timestamp` keys.

---

## Final acceptance

- [ ] All 10 WPs merged to main, pushed to GH
- [ ] Test suite >= 229 + ~40 new tests, all green
- [ ] `node watcher.js doctor` runs without errors
- [ ] `node watcher.js --only Radaris --dry-run` runs a single broker
- [ ] CI badge green on README
