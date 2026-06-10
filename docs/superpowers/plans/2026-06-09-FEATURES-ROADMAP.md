# auto-identity-remove - Feature Roadmap (2026-06-09)

> **STATUS: ALL 14 SHIPPED.** Every plan below was implemented TDD, merged to `main`, and is green in CI. The test suite grew from 645 to 1067 root + 70 dashboard tests, with zero new npm dependencies. This document is retained as the design record; the checkboxes inside each linked plan reflect the as-built implementation. The dependency chains landed as designed: right-to-know's `knowRequestedAt` feeds regulatory-escalation, monthly-report's Playwright `page.pdf` pattern is reused by complaints, and HIBP's breach count enriches the exposure score. The `aidr` CLI exposes each feature as a subcommand (see the README command table).

These 14 plans push the tool past "submits opt-outs and hopes" toward a product a non-technical person can trust and actually benefit from. They cluster into three goals: **close the loop** (prove removal happened and keep it gone), **lower the barrier to entry** (onboard without editing JSON or living in a terminal), and **add regulatory teeth** (know-requests and complaints when brokers ignore the law). Every plan is TDD, CommonJS, hermetic-tested, and adds **zero new npm dependencies** - everything rides on Node built-ins, the global `fetch`, the already-present Playwright, and the existing optional `nodemailer`.

Each plan is self-contained and executable by a fresh Sonnet instance task-by-task. Steps use `- [ ]` checkboxes; follow superpowers:subagent-driven-development or superpowers:executing-plans.

## The plans

| Feature | Plan | Tier | New deps | Depends on / coordinates with |
|---|---|---|---|---|
| Exposure Score + trend | [exposure-score](2026-06-09-exposure-score.md) | Medium | none | reads verify-loop + serp-scan history (exist); consumes hibp `breachCount` (defaults 0, ships standalone); adds a dashboard endpoint + card |
| HIBP breach integration | [hibp-breach-check](2026-06-09-hibp-breach-check.md) | Medium | none | feeds `breachCount` to exposure-score; pairs with freeze-guide |
| Credit/identity freeze checklist | [freeze-guide](2026-06-09-freeze-guide.md) | Medium | none | additive `state.freezes`; adds a dashboard card; pairs with hibp |
| Monthly PDF + email report | [monthly-report](2026-06-09-monthly-report.md) | Medium | none | reuses audit.js/diff.js/snapshot.js; **owns the Playwright `page.pdf` renderer** |
| First-run config wizard (GUI) | [dashboard-config-wizard](2026-06-09-dashboard-config-wizard.md) | Medium | none | frontend + 1 status endpoint; uses existing PUT /api/config |
| Masked-email relay (SimpleLogin) | [masked-email-relay](2026-06-09-masked-email-relay.md) | Medium (sec) | none | wires forms.js + email.js; additive `state.relayAliases` |
| Allowlist (keep me listed) | [broker-allowlist](2026-06-09-broker-allowlist.md) | Quick win | none | touches broker-runner + generic-runner + verify-loop + logger STATUS_BUCKET |
| One-command install + npx CLI | [cli-packaging-installer](2026-06-09-cli-packaging-installer.md) | Medium | none | adds `bin/aidr.js`; wraps setup/watcher/dashboard |
| CCPA/GDPR Right-to-Know | [right-to-know](2026-06-09-right-to-know.md) | Quick win | none | writes `state.optOuts[name].knowRequestedAt`; **precedes regulatory-escalation** |
| Regulator complaints when ignored | [regulatory-escalation](2026-06-09-regulatory-escalation.md) | Medium | none | reads `knowRequestedAt`; **reuses the report's `page.pdf` renderer** |
| Continuous SERP watch + alerts | [serp-watch-alerts](2026-06-09-serp-watch-alerts.md) | Quick win | none | extends serp-scan; fires notify.js |
| Live broker feeds (CA/VT registries) | [live-broker-feeds](2026-06-09-live-broker-feeds.md) | Ambitious | none | feeds generic-runner; dedups via serp-scan hostname logic |
| Encrypt config at rest | [encrypt-config-at-rest](2026-06-09-encrypt-config-at-rest.md) | Ambitious (sec) | none | touches config.js core + setup.js + dashboard env; migration path |
| i18n success/confirm detection | [i18n-success-detection](2026-06-09-i18n-success-detection.md) | Quick win | none | extends success.js + confirm.js; threads page lang via broker-runner |

## Recommended build order

**Phase A - make the existing work legible and high-impact (the three highest-leverage):**
1. **exposure-score** - turns everything already collected (verify-loop, serp-scan, state history) into one number with a trend. Ship it with `breachCount = 0`; it is the single biggest "I can see it working" win.
2. **hibp-breach-check** then **freeze-guide** - the highest real-world protection, and hibp's `breachCount` immediately enriches the exposure score; a high-severity breach routes the user into the freeze checklist.
3. **dashboard-config-wizard** - unlocks non-technical users (no more hand-editing `config.json`). Pairs naturally with the next item.

**Phase B - reach + retention:**
4. **cli-packaging-installer** (one-command install / `npx aidr`) and **monthly-report** (the report makes it feel like a service). Build the report first because it introduces the shared Playwright `page.pdf` renderer.
5. **serp-watch-alerts** and **i18n-success-detection** - cheap, contained quality-of-life and global-reach wins.

**Phase C - teeth + freshness:**
6. **right-to-know** (writes the `knowRequestedAt` timestamp) then **regulatory-escalation** (consumes it; reuses the report's PDF renderer). Order matters.
7. **live-broker-feeds** - replaces the stale Jan-2023 Markup dataset with the official CA SB-362 + Vermont registries so coverage stops rotting.

**Phase D - hardening (do last, or whenever a security pass is warranted):**
8. **masked-email-relay** and **encrypt-config-at-rest** - both security-sensitive; see the risk note below.

**broker-allowlist** can drop in any time; sequence it alongside another broker-runner/verify-loop change to coordinate edits to those files.

## Shared infrastructure (build once, reuse)

- **Playwright `page.pdf` renderer.** monthly-report introduces `renderReportPdf({ html, outPath, context })` (inject the browser context; tests use a fake context, no real browser). regulatory-escalation reuses the identical pattern. Implement it once in `lib/report.js` and have complaints import or mirror it - do not fork two renderers.
- **State-schema additions are all additive.** New keys (`state.freezes`, `state.relayAliases`, `state.optOuts[name].knowRequestedAt`, the exposure snapshot file, allowlist status) never disturb `optOuts`. Always go through the existing atomic write in `lib/config.js` (write tmp -> rename -> copy bak) and the `saveState()` path.
- **Dashboard edits.** exposure-score, freeze-guide, dashboard-config-wizard, and broker-allowlist each add endpoints + UI. Keep every DOM insertion routed through the existing `esc()`/`safeUrl()`, preserve the masked-secret + CSRF + auth conventions in `dashboard/server.js`, and follow `dashboard/server.test.js`'s hermetic temp-config pattern for new endpoint tests.
- **New data files must be gitignored** (exposure-history.json, logs/reports, logs/complaints, feeds-brokers.json) - mirror how state.json/serp-history.json are already ignored, to avoid leaking PII (same class as the earlier state.json.bak near-miss).

## Security risk callout

Three plans handle secrets or attacker-influenced input and deserve a careful review before merge:

- **encrypt-config-at-rest** touches the core `loadConfig` path and a migration that can shred the plaintext config. Its tests must cover wrong-passphrase rejection, GCM tamper-detection (flip a byte -> throws), and round-trip fidelity, and the dashboard must still read config when `AIDR_PASSPHRASE` is set in its env. A bug here can lock the user out of their own config.
- **masked-email-relay** sends the user's identity to a third-party alias provider (SimpleLogin) and caches aliases in state. Validate the API responses and fail back to `person.email` cleanly; never log the API key.
- **hibp-breach-check** adds an API key to config (covered by the existing secret-masking once the key path is added to the dashboard's mask list) and must rate-limit (HIBP requires ~1.5s between calls) without hammering on errors.

All three are net-additive and behind explicit flags/config, so they cannot regress the default path - but they are the ones to put through `/security-review` or a focused adversarial pass when implemented.
