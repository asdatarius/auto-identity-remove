# Testing Plan — auto-identity-remove

**Date:** 2026-05-18
**Target:** 100% functional coverage of the production paths, maximally automated, runnable on every commit and on a nightly schedule.
**Current state:** 157 unit tests in `test/*.test.js`, all green, all pure (no real network, no real Playwright, no disk writes beyond fixtures).

This doc covers what to test, how to automate it, and the layers that need to exist to be confident in shipping behavior changes.

---

## Goals

| Goal | How we measure |
|------|----------------|
| No regression goes to `main` undetected | CI gate: every PR runs the full suite + the integration matrix |
| Every code path executes in CI | Branch coverage ≥ 90% via `c8` (built on `node --test`) |
| Heuristic strategies survive selector drift in the wild | Nightly job runs against synthetic + recorded HAR fixtures + a small live-broker canary set |
| Failures are diagnosable from CI output alone | Each test logs `broker name + strategy + assertion`; CI uploads `logs/`, screenshots on failure |
| Bugs that bit us once can't bite us twice | Every fix lands with a regression test referencing the issue/PR |

---

## Test layers

We test at five layers. Each layer answers a different question.

### Layer 1 — Unit tests (pure)

**What:** Module-internal logic with all I/O mocked. **Where:** `test/*.test.js` (current home; 157 tests today).

**Cover every:**
- `lib/logger.js` — bucket routing, summary wording, disclaimer, reset
- `lib/config.js` — recheck windows, `shouldSkip`, pending-confirm logic, dry-run state guard
- `lib/confirm.js` — regex positive + negative cases
- `lib/forms.js` — intl field map (province/postal/country fallbacks)
- `lib/scheduler.js` — per-platform command-string generation (no execution)
- `lib/notify.js` — per-platform dispatch, webhook payload shape
- `lib/email.js` — Mail.app branch vs SMTP branch, lazy `nodemailer` require, fallback to manual
- `lib/captcha.js` — CapSolver payload, error handling
- `lib/platform.js` — process.platform → 'macos'/'linux'/'windows'
- `lib/verifier.js` — three-classification logic (clear / still-listed / unverifiable)
- `lib/aliaser.js` (WP-A3) — provider abstraction, caching, fallback
- `lib/imap-confirmer.js` (WP-A2) — URL extraction, sender filtering
- `lib/ai-filler.js` (WP-A1) — plan parsing, malformed-JSON handling, cache
- `lib/concurrency.js` (WP-A5) — pool size, error propagation
- `lib/complaint-gen.js` (WP-B2) — template rendering
- `lib/dsar.js` (WP-C2) — per-state template selection
- `lib/encrypted-config.js` (WP-D3) — round-trip encrypt/decrypt
- `scripts/prune-dead.js` — aggregation correctness, idempotence
- `scripts/reverse-search.js` (WP-B4) — broker-hostname matching
- `scripts/dashboard.js` (WP-B3) — counts vs fixture logs

**Rules:**
- No network. Mock `fetch` / `imapflow.Client` / `node:child_process` at the boundary.
- No real `state.json` mutation on disk. Tests that touch state use `withCleanState(fn)` (see `test/pending-confirm.test.js`) or `setDryRun(true)`.
- Run time budget: full suite < 5 seconds.

### Layer 2 — Integration tests (Playwright + fixture HTML)

**What:** Run the real `generic-runner.js` and `lib/broker-runner.js` flows against captured HTML fixtures. **Where:** `test/integration/*.test.js` (new home; created by WP-D5).

**Mechanism:**
- One Playwright browser per test file, contexts per test (parallel safe).
- `page.setContent(htmlFixture)` loads the captured page.
- `processGenericUrl(page, ...)` runs end-to-end and we assert the returned status.

**Coverage matrix (initial fixtures — WP-D5):**

| Fixture | Expected status | What it exercises |
|---|---|---|
| `do-not-sell-button.html` | `success` | Strategy 1 |
| `onetrust-modal.html` | `success` | Strategy 2 (OneTrust) |
| `trustarc-modal.html` | `success` | Strategy 2 (TrustArc) |
| `osano-modal.html` | `success` | Strategy 2 (Osano) |
| `generic-form-email-only.html` | `success` | Strategy 3 (email-only) |
| `generic-form-name-email.html` | `success` | Strategy 3 (name + email) |
| `dsar-link-page.html` | `manual` | Strategy 4 (DSAR fallback) |
| `confirmation-required.html` | `pending_confirm` | WP4 detection on submit response |
| `dead-404.html` (HTTP fixture server returns 404) | `dead` | WP3 classification |
| `dead-dns.html` (URL with non-resolving host) | `dead` | WP3 DNS failure |
| `intl-form-canadian.html` | `success` (province + postal filled) | WP6 intl fields |
| `captcha-recaptcha-v2.html` | success after mocked solve | WP1.5 captcha |

**HAR-based fixtures (per-broker regression):**
- Capture HAR for the top 10 explicit brokers in `test/integration/har/<broker>.har`.
- Playwright `context.routeFromHAR(harPath, { update: false })` replays them deterministically.
- Tests run quarterly via a refresh script that re-captures HARs and diffs.

**Rules:**
- Run on every PR.
- Run time budget: full integration suite < 60 seconds (with parallelism).
- One failing fixture blocks merge.

### Layer 3 — Mutation tests (Stryker)

**What:** Verify the test suite actually catches bugs. **Where:** `stryker.conf.json` + `.github/workflows/mutation.yml`.

**Why:** Coverage measures lines executed; mutation testing measures *assertions that fail when behavior changes*. A test that runs the code but asserts nothing useful has 100% coverage and 0% mutation kill.

**Targets:**
- `lib/confirm.js` — must achieve 100% mutation kill (small, critical)
- `lib/config.js` (skip logic, recheck windows) — ≥ 90%
- `lib/logger.js` (bucket routing) — ≥ 95%
- `lib/forms.js` (intl field aliases) — ≥ 85%
- Whole project: ≥ 75% baseline, fail PR if drops > 5 points

**Cadence:** nightly. PRs only on `lib/confirm.js`, `lib/config.js`, `lib/logger.js` (small, fast).

### Layer 4 — Live-broker canary

**What:** A tiny smoke run against a handful of well-behaved brokers, in `--verify` mode (read-only, never submits). **Where:** scheduled GitHub Action, weekly.

**Why:** Mock + fixture testing cannot catch broker-side selector drift. Selector drift is the #1 cause of production failures here.

**Setup:**
- Dedicated canary GitHub Account with: a synthetic identity (`Test Canary` / fake address that has no real records), an alias email, an empty state file.
- Brokers: Spokeo, BeenVerified, Acxiom, LexisNexis, ZoomInfo. (Choose ones with stable opt-out flows.)
- Mode: `--verify` only (we don't want to flood real brokers with submissions).
- Failure → Slack alert + open a GitHub Issue with the broker name and the HTML diff vs the last captured HAR.

**Run time budget:** 5 min.

**Cadence:** weekly. Not on PR (cost + flake).

### Layer 5 — End-to-end dry-run

**What:** Run the full watcher in `--dry-run` mode in CI against all 521 brokers. **Where:** `.github/workflows/full-dry-run.yml`.

**Why:** Catches integration regressions — anything that crashes the orchestrator, deadlocks, or floods stdout. `--dry-run` is guaranteed safe (Phase 0 fix verified state.json byte-identical).

**Setup:**
- Use a checked-in `config.example.json`-derived test config in `test/fixtures/dry-run-config.json`.
- Run `node watcher.js --dry-run` with a 30-min timeout.
- Pass if exit code = 0 AND output contains expected summary lines (regex assertions).

**Cadence:** every PR + nightly. ~10–20 min.

---

## Test data

### `test/fixtures/`

| Path | Purpose |
|---|---|
| `brokers/*.html` | Synthetic HTML for each strategy class (WP-D5) |
| `har/<broker>.har` | Real captured network exchanges for replay (Layer 2) |
| `confirm-emails/*.eml` | Sample confirmation emails (WP-A2 / IMAP) |
| `state/*.json` | Various state shapes — fresh, pending, multi-profile, etc. |
| `logs/*.json` | Aggregated run logs (`prune-dead`, dashboard) |
| `ai-responses/*.json` | Captured Claude API responses for filler tests (WP-A1) |
| `dsar-emails/<state>.txt` | Expected email body per state (WP-C2) |

Add new fixtures whenever you fix a bug: capture the failing input as a fixture, write a test against it, fix the code.

### Test-only state isolation

Every test that touches `lib/config.js` state MUST go through `withCleanState(fn)` (see `test/pending-confirm.test.js` for the pattern). This:
1. Deletes any state entries matching the test broker name
2. Runs the test
3. Restores any previously-existing entry

This pattern is mandatory — without it, test order leaks state between tests and breaks reproducibility.

---

## CI workflows

### `.github/workflows/test.yml` — every PR + push

```
jobs:
  unit:
    runs-on: ubuntu-latest
    steps: [setup-node, npm ci, node --test test/*.test.js]
  unit-windows:
    runs-on: windows-latest  # WP1 platform branches
    steps: [setup-node, npm ci, node --test test/*.test.js]
  unit-macos:
    runs-on: macos-latest    # exercise launchd / Mail.app stubs
    steps: [setup-node, npm ci, node --test test/*.test.js]
  integration:
    runs-on: ubuntu-latest
    steps:
      - setup-node
      - npm ci
      - npx playwright install chromium
      - node --test test/integration/*.test.js
  dry-run:
    runs-on: ubuntu-latest
    steps:
      - setup-node
      - npm ci
      - npx playwright install --with-deps chromium
      - cp test/fixtures/dry-run-config.json config.json
      - timeout 30m node watcher.js --dry-run > dry-run.log 2>&1
      - grep "Submitted (form accepted)" dry-run.log
      - grep "Dead (stale URL)" dry-run.log
  lint:
    runs-on: ubuntu-latest
    steps: [setup-node, npm ci, npx eslint lib/ scripts/ watcher.js generic-runner.js]
  coverage:
    runs-on: ubuntu-latest
    steps:
      - setup-node
      - npm ci
      - npx c8 --reporter=text --reporter=lcov node --test test/*.test.js
      - upload coverage to Codecov
      - fail if total coverage < 90% (lines) / 85% (branches)
```

### `.github/workflows/nightly.yml`

```
schedule: cron 0 7 * * *
jobs:
  mutation:
    steps:
      - setup-node
      - npm ci
      - npx stryker run
      - fail if mutation score < 75%
  full-dry-run:
    steps:
      - setup-node
      - npm ci
      - npx playwright install --with-deps chromium
      - node watcher.js --dry-run  # full 521-broker pass
      - upload logs/
```

### `.github/workflows/canary.yml`

```
schedule: cron 0 12 * * 1   # Mondays noon UTC
jobs:
  verify-canary:
    steps:
      - setup-node
      - install canary config from secrets
      - node watcher.js --verify
      - parse logs/verify-*.json
      - if any broker → 'still listed' AND was previously verified clear → Slack + issue
```

### `.github/workflows/dependency-audit.yml`

```
schedule: cron 0 9 * * 1
jobs:
  audit:
    steps: [npm audit --audit-level=high, npm outdated]
```

---

## Pre-commit hooks

Optional but recommended. `.husky/pre-commit`:
1. `node --test test/*.test.js` (run only changed test files via filename glob if you want faster)
2. `npx eslint --fix` changed files
3. Forbid committing `config.json` / `state.json` / `logs/` (already gitignored — belt + braces)

---

## Quality bars (merge gates)

A PR can land only if:

- [ ] All Layer 1 unit tests pass (`node --test test/*.test.js`)
- [ ] All Layer 2 integration tests pass
- [ ] Layer 5 full-dry-run passes
- [ ] Line coverage ≥ 90%, branch coverage ≥ 85%
- [ ] No new `eslint` warnings
- [ ] If a `lib/*.js` file was modified: mutation score on that file ≥ 80%
- [ ] If a new feature WP: README updated, STATUS.md updated if brokers change, tests reference the WP id in describe block
- [ ] No new top-level dep without justification in PR description

---

## Failure-mode coverage matrix

Beyond happy paths, every component needs negative-path coverage. Map:

| Failure mode | Module(s) | Test |
|---|---|---|
| Playwright timeout | broker-runner, generic-runner | mock `page.goto` to throw; assert `error` status |
| Submit button absent | broker-runner, generic-runner | fixture without submit button; assert `success: form filled (no submit)` |
| Captcha unsolved | captcha + broker-runner | mock `detectAndSolveCaptcha` → false; assert `captcha_failed` |
| CapSolver API down | captcha | mock fetch → 500; assert graceful skip |
| Page disconnects mid-submit | broker-runner | mock locator to throw "frame detached"; assert `error`, no recordSuccess |
| Email-confirm regex over-matches | confirm.js | every negative case in `test/confirm-detection.test.js` |
| State.json corrupt JSON | config.js | write `{ invalid` → load → starts with empty optOuts, doesn't crash |
| State.json missing | config.js | delete → load → empty optOuts |
| Disk full on state save | config.js | mock `fs.writeFileSync` → ENOSPC; assert no crash, log to stderr |
| Network down (DNS) | generic-runner | classifyNavError positive cases |
| HTTP 4xx / 5xx | generic-runner | isDeadStatus tests |
| User Ctrl-C mid-run | watcher.js (WP-A6) | SIGINT handler test |
| Config encrypted but no passphrase | encrypted-config.js (WP-D3) | mock prompt → empty; assert exit 1 |
| Alias provider down | aliaser.js (WP-A3) | fetch → 503; assert fallback to real email + log warning |
| AI returns invalid JSON | ai-filler.js (WP-A1) | mock fetch → "not json"; assert strategy returns null (falls through) |
| IMAP auth fails | imap-confirmer.js (WP-A2) | mock connect → throw; assert post-run hook is a no-op |

This matrix is the source of truth for "we tested every failure." Each row maps to at least one assertion.

---

## What NOT to test

- Real network. Ever, except canary (Layer 4).
- Real CapSolver API calls.
- Real broker submissions.
- macOS-specific GUI integration (osascript / Mail.app actually sending) — mock at the `child_process` boundary.
- Library code we don't own (`playwright`, `nodemailer`, `imapflow` internals).

---

## Onboarding for new WPs

When a subagent writes a WP, their checklist:

1. **Read** `docs/plans/2026-05-18-testing-plan.md` (this file) and `docs/plans/2026-05-18-followup-items.md`.
2. **Write tests first** matching this doc's expected layer (Layer 1 unit by default; Layer 2 if the change is in `generic-runner.js` / `lib/broker-runner.js` flow).
3. **For every new module**, write at least: one happy-path test, one error-path test, one boundary test.
4. **For every fix**, add a regression test capturing the failing input as a fixture.
5. **For every new external integration** (HTTP / IMAP / SMTP / subprocess), mock at the boundary and add a failure-mode row to the matrix above.
6. **Run** `node --test test/*.test.js` and `npx c8 node --test test/*.test.js` locally before committing.
7. **Update** this doc if a new test layer is needed.

---

## Tooling additions (one-time setup)

```bash
npm i -D c8 @stryker-mutator/core @stryker-mutator/node-test-runner eslint actionlint-cli
```

`package.json` scripts:

```json
"scripts": {
  "test": "node --test test/*.test.js",
  "test:integration": "node --test test/integration/*.test.js",
  "test:coverage": "c8 --reporter=text --reporter=lcov node --test test/*.test.js",
  "test:mutation": "stryker run",
  "test:all": "npm test && npm run test:integration && npm run test:coverage",
  "lint": "eslint lib/ scripts/ watcher.js generic-runner.js setup.js",
  "ci": "npm run lint && npm run test:all"
}
```

`stryker.conf.json`:

```json
{
  "mutate": ["lib/**/*.js", "!lib/**/*.test.js"],
  "testRunner": "node-test",
  "coverageAnalysis": "perTest",
  "thresholds": { "high": 90, "low": 75, "break": 70 }
}
```

---

## Definition of "100% functional coverage"

We will not claim 100% line coverage — chasing the last 5% drives meaningless tests against `try { x } catch (_) {}` branches. Instead, we define functional coverage as:

> Every documented behavior in `README.md` and every public function in `lib/*.js` has at least one test asserting its contract, AND every failure mode in the matrix above has at least one test asserting the system degrades gracefully.

Concretely:

| Metric | Target |
|---|---|
| Line coverage (c8) | ≥ 90% |
| Branch coverage (c8) | ≥ 85% |
| Mutation score (Stryker) | ≥ 75% project-wide, 100% on `lib/confirm.js` |
| Public-function contracts tested | 100% |
| Failure-mode matrix rows covered | 100% |
| CI gate runs on every PR | Yes |
| Nightly mutation + full dry-run | Yes |
| Weekly live-broker canary | Yes |

This is what "robust + automated" means for this project. Anything beyond this is engineering theater.
