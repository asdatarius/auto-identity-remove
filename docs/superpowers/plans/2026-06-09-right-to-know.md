# CCPA / GDPR Right-to-Know Requests Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Add a "show me what you have" right-to-know request flow (CCPA / GDPR routed by `person.country`) for email-capable brokers, plus state tracking and a `--know` / `--know-status` CLI surface.

Architecture: A new pure `lib/right-to-know.js` exports `buildKnowRequest({ person, broker, regime })` returning `{ subject, body }`, mirroring the GDPR/CCPA template structure already in `lib/email.js`. A new `lib/right-to-know-runner.js` orchestrates per-broker sending (reusing `lib/email.js` SMTP transport when configured, otherwise printing the template) and records `state.optOuts[name].knowRequestedAt` via a small new helper in `lib/config.js`. `watcher.js` dispatches two new modes: `--know` (send/print) and `--know-status` (list pending requests older than 45 days).

Tech Stack: Plain Node.js, CommonJS (`require` / `module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict` with the `Module._load` mock pattern and module-object monkey-patching already used by `test/email.test.js`. SMTP via the existing optional `nodemailer` dependency (lazy-required). No new npm dependencies.

New dependencies: NONE. (Reuses existing `nodemailer` optionalDependency and Node built-ins.)

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `lib/right-to-know.js` | Created | Pure `buildKnowRequest({ person, broker, regime })` -> `{ subject, body }`; `pickRegime(country)`; CCPA + GDPR body builders for right-to-KNOW (access/disclosure), not erasure. |
| `lib/config.js` | Modified | Add `recordKnowRequest(brokerName)` (writes `knowRequestedAt`, `saveState()`) and `getPendingKnowRequests(brokers, opts)` (lists know-requests older than N days); export both. |
| `lib/right-to-know-runner.js` | Created | `sendKnowRequests(brokers, cfg, opts)`: filter email brokers, route per person, send via SMTP (reusing the `nodemailer` transport pattern) or log `manual` template, record state. |
| `watcher.js` | Modified | Parse `--know` / `--know-status` flags; add two early-exit mode branches. |
| `test/right-to-know.test.js` | Created | Unit tests for the pure template builder (both regimes, regime routing). |
| `test/right-to-know-config.test.js` | Created | Temp-state round-trip for `recordKnowRequest` + `getPendingKnowRequests`. |
| `test/right-to-know-runner.test.js` | Created | Mocked send: SMTP branch (nodemailer mocked), manual branch (no smtp), state recorded. |

---

## Task 1: Pure `buildKnowRequest` template builder

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/right-to-know.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/right-to-know.test.js`

This is the pure core. No I/O, no requires of `config`/`logger`. It mirrors `lib/email.js` `_pickTemplate` / `_buildBodyGDPR` / `_buildBodyCCPA` but the wording requests DISCLOSURE / ACCESS ("show me what you have"), citing GDPR Article 15 (right of access) and CCPA right to know, rather than erasure (Article 17 / removal).

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/right-to-know.test.js` with the complete contents:

```js
/**
 * test/right-to-know.test.js
 *
 * Covers the PURE template builder in lib/right-to-know.js:
 *   - buildKnowRequest returns { subject, body }
 *   - regime routing by person.country (EU/GB -> GDPR, else CCPA)
 *   - explicit regime override wins over country
 *   - body cites the right legal basis (access/know, NOT erasure)
 *   - person fields are interpolated
 *
 * No I/O, no network, no state. Pure function only.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildKnowRequest, pickRegime } = require('../lib/right-to-know');

const US_PERSON = {
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'jane@example.com',
  phoneFormatted: '(512) 555-0000',
  country: 'US',
};

const EU_PERSON = {
  fullName: 'Max Mustermann',
  firstName: 'Max',
  lastName: 'Mustermann',
  city: 'Berlin',
  state: 'BE',
  zip: '10115',
  email: 'max@example.de',
  phoneFormatted: '+49 30 1234567',
  country: 'DE',
};

const BROKER = { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' };

test('pickRegime: EU country -> GDPR', () => {
  assert.equal(pickRegime('DE'), 'GDPR');
  assert.equal(pickRegime('gb'), 'GDPR');
});

test('pickRegime: US / non-EU / missing -> CCPA', () => {
  assert.equal(pickRegime('US'), 'CCPA');
  assert.equal(pickRegime('AU'), 'CCPA');
  assert.equal(pickRegime(undefined), 'CCPA');
});

test('buildKnowRequest: US person -> CCPA right-to-know wording', () => {
  const { subject, body } = buildKnowRequest({ person: US_PERSON, broker: BROKER });
  assert.match(subject, /Right to Know/i);
  assert.match(subject, /Jane Doe/);
  assert.match(body, /CCPA/);
  assert.match(body, /categories of personal information/i);
  // It must NOT be an erasure request.
  assert.doesNotMatch(body, /erasure|right to be forgotten/i);
  // person fields interpolated
  assert.match(body, /Jane Doe/);
  assert.match(body, /Austin, TX 73301/);
  assert.match(body, /jane@example\.com/);
});

test('buildKnowRequest: EU person -> GDPR Article 15 access wording', () => {
  const { subject, body } = buildKnowRequest({ person: EU_PERSON, broker: BROKER });
  assert.match(body, /GDPR/);
  assert.match(body, /Article 15/);
  assert.match(body, /right of access/i);
  assert.doesNotMatch(body, /Article 17|erasure/i);
  assert.match(body, /Max Mustermann/);
  assert.match(body, /Berlin, BE 10115/);
});

test('buildKnowRequest: explicit regime overrides country', () => {
  const { body } = buildKnowRequest({ person: US_PERSON, broker: BROKER, regime: 'GDPR' });
  assert.match(body, /Article 15/);
  assert.match(body, /GDPR/);
});

test('buildKnowRequest: subject includes broker-agnostic title and full name', () => {
  const { subject } = buildKnowRequest({ person: EU_PERSON, broker: BROKER });
  assert.match(subject, /Max Mustermann/);
  assert.match(subject, /Right to Know|Data Access/i);
});
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test test/right-to-know.test.js`. Expected failure: `Cannot find module '../lib/right-to-know'` (module does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/right-to-know.js` with the complete contents:

```js
/**
 * lib/right-to-know.js
 *
 * PURE right-to-know (data access / disclosure) request template builder.
 *
 * Public API:
 *   buildKnowRequest({ person, broker, regime }) -> { subject, body }
 *   pickRegime(country) -> 'GDPR' | 'CCPA'
 *
 * This requests DISCLOSURE of what data a broker holds (a "show me what you
 * have" request), NOT erasure. GDPR path cites Article 15 (right of access);
 * CCPA path cites the consumer right to know (categories + specific pieces of
 * personal information collected, sources, purposes, and third parties).
 *
 * Pure module: no I/O, no config/logger requires, deterministic output. The
 * regime routing mirrors lib/email.js (_pickTemplate) so behaviour is
 * consistent across the codebase.
 */

// EU member states + GB (UK GDPR). Mirrors EU_COUNTRIES in lib/email.js.
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'GB',
]);

/**
 * Decide the legal regime for a right-to-know request based on country code.
 * @param {string|undefined} country - ISO 3166-1 alpha-2 country code
 * @returns {'GDPR'|'CCPA'}
 */
function pickRegime(country) {
  if (country && EU_COUNTRIES.has(String(country).toUpperCase())) return 'GDPR';
  return 'CCPA';
}

/**
 * Build the GDPR Article 15 right-of-access body (EU + UK).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyGDPR(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am writing to exercise my right of access under Article 15 of the General',
    'Data Protection Regulation (GDPR). I request that you disclose to me, in a',
    'commonly used electronic format, all personal data you hold about me, along',
    'with: the purposes of processing; the categories of personal data concerned;',
    'the recipients or categories of recipients to whom the data has been or will',
    'be disclosed; the sources from which the data was obtained; and the envisaged',
    'retention period.',
    '',
    `Name: ${person.fullName}`,
    `Location: ${person.city}, ${person.state} ${person.zip}`,
    `Email: ${person.email}`,
    `Phone: ${person.phoneFormatted}`,
    '',
    'Please provide this information within one month of receipt of this request,',
    'as required under Article 12(3) GDPR. This is a request for access and',
    'disclosure only; it is not a request for deletion.',
    '',
    'Thank you,',
    `${person.fullName}`,
  ].join('\n');
}

/**
 * Build the CCPA right-to-know body (US + other non-EU).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyCCPA(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am exercising my right to know under the California Consumer Privacy Act',
    '(CCPA / CPRA) and applicable privacy laws. Please disclose to me the',
    'categories of personal information you have collected about me, the specific',
    'pieces of personal information you hold, the categories of sources from which',
    'it was collected, the business or commercial purpose for collecting it, and',
    'the categories of third parties with whom you have shared or sold it.',
    '',
    `Name: ${person.fullName}`,
    `Location: ${person.city}, ${person.state} ${person.zip}`,
    `Email: ${person.email}`,
    `Phone: ${person.phoneFormatted}`,
    '',
    'Please respond within 45 days as required under the CCPA. This is a request',
    'for disclosure of the information you hold; it is not a request for deletion.',
    '',
    'Thank you,',
    `${person.fullName}`,
  ].join('\n');
}

/**
 * Build a right-to-know request for one (person, broker) pair.
 *
 * @param {object} opts
 * @param {object} opts.person  - person record (fullName, city, state, zip, email, phoneFormatted, country)
 * @param {object} opts.broker  - broker definition (name; emailTo for email method)
 * @param {'GDPR'|'CCPA'} [opts.regime] - explicit override; default derived from person.country
 * @returns {{ subject: string, body: string }}
 */
function buildKnowRequest({ person, broker, regime } = {}) {
  const chosen = regime || pickRegime(person && person.country);
  const body = chosen === 'GDPR' ? _buildBodyGDPR(person) : _buildBodyCCPA(person);
  const subject = `Right to Know / Data Access Request - ${person.fullName}`;
  return { subject, body };
}

module.exports = {
  buildKnowRequest,
  pickRegime,
  // Internal exports for unit-testing
  _buildBodyGDPR,
  _buildBodyCCPA,
  EU_COUNTRIES,
};
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test test/right-to-know.test.js`. Expected: all tests pass (6 passing).

- [ ] Step 1.5: Commit. Commands:
```bash
rtk git add lib/right-to-know.js test/right-to-know.test.js
git commit -m "$(cat <<'EOF'
Add pure buildKnowRequest right-to-know template builder

Mirrors lib/email.js regime routing (GDPR Article 15 access / CCPA
right to know) but requests disclosure rather than erasure.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: State helpers `recordKnowRequest` + `getPendingKnowRequests`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/config.js` (add two functions before the `module.exports` block at lines 329-355; add two names to the exports object)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/right-to-know-config.test.js`

`recordKnowRequest(brokerName)` sets `state.optOuts[brokerName].knowRequestedAt` to now (ISO), preserving existing fields, then `saveState()` (respects dry-run / test state path). `getPendingKnowRequests(brokers, opts)` returns `[{ name, knowRequestedAt, daysAgo, expectedSender? }]` for entries whose `knowRequestedAt` is older than `opts.olderThanDays` (default 45), sorted oldest-first. Uses `setTestStatePath` for hermetic disk round-trip.

- [ ] Step 2.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/right-to-know-config.test.js` with the complete contents:

```js
/**
 * test/right-to-know-config.test.js
 *
 * Covers the right-to-know state helpers in lib/config.js:
 *   - recordKnowRequest writes knowRequestedAt and persists to a temp state file
 *   - getPendingKnowRequests lists requests older than N days, sorted oldest-first
 *   - recent requests (< threshold) are excluded
 *   - brokers without a knowRequestedAt are excluded
 *
 * Hermetic: uses setTestStatePath to redirect writes to a temp file. Restores
 * the live shared state object afterward.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');

function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-know-'));
  const statePath = path.join(dir, 'state.json');
  cfg.setTestStatePath(statePath);
  // Reset the in-memory state to an empty optOuts so the temp file is the
  // single source of truth for this test.
  const state = cfg.loadState();
  const saved = {};
  for (const k of Object.keys(state)) { saved[k] = state[k]; delete state[k]; }
  state.optOuts = {};
  try {
    return fn({ state, statePath });
  } finally {
    cfg.setDryRun(false);
    cfg.setTestStatePath(null);
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('recordKnowRequest: writes knowRequestedAt and persists to disk', () => {
  withTempState(({ statePath }) => {
    cfg.setDryRun(false);
    cfg.recordKnowRequest('Pipl');

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const entry = onDisk.optOuts.Pipl;
    assert.ok(entry, 'expected Pipl entry on disk');
    assert.ok(entry.knowRequestedAt, 'expected knowRequestedAt timestamp');
    const ageMs = Date.now() - new Date(entry.knowRequestedAt).getTime();
    assert.ok(ageMs >= 0 && ageMs < 5000, `timestamp should be ~now, age=${ageMs}ms`);
  });
});

test('recordKnowRequest: preserves existing fields on the entry', () => {
  withTempState(({ state }) => {
    cfg.setDryRun(false);
    state.optOuts.Pipl = { history: ['success'], totalRuns: 2 };
    cfg.recordKnowRequest('Pipl');
    assert.deepEqual(state.optOuts.Pipl.history, ['success']);
    assert.equal(state.optOuts.Pipl.totalRuns, 2);
    assert.ok(state.optOuts.Pipl.knowRequestedAt);
  });
});

test('getPendingKnowRequests: lists requests older than threshold, oldest first', () => {
  withTempState(({ state }) => {
    const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    state.optOuts = {
      Pipl:   { knowRequestedAt: daysAgo(60) },
      Spokeo: { knowRequestedAt: daysAgo(90) },
      Radaris:{ knowRequestedAt: daysAgo(10) }, // too recent
      Intelius:{ history: ['success'] },         // no know request
    };
    const brokers = [
      { name: 'Pipl', expectedSender: 'privacy@pipl.com' },
      { name: 'Spokeo' },
    ];
    const pending = cfg.getPendingKnowRequests(brokers, { olderThanDays: 45 });
    assert.equal(pending.length, 2, `expected 2 pending, got ${JSON.stringify(pending)}`);
    assert.equal(pending[0].name, 'Spokeo'); // oldest first (90d)
    assert.equal(pending[1].name, 'Pipl');   // 60d
    assert.ok(pending[1].daysAgo >= 59 && pending[1].daysAgo <= 61);
    assert.equal(pending[0].expectedSender, undefined);
    assert.equal(pending[1].expectedSender, 'privacy@pipl.com');
  });
});

test('getPendingKnowRequests: default threshold is 45 days', () => {
  withTempState(({ state }) => {
    const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    state.optOuts = {
      Old:   { knowRequestedAt: daysAgo(50) },
      Fresh: { knowRequestedAt: daysAgo(40) },
    };
    const pending = cfg.getPendingKnowRequests([]);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].name, 'Old');
  });
});
```

- [ ] Step 2.2: Run it, expect fail. Command: `node --test test/right-to-know-config.test.js`. Expected failure: `TypeError: cfg.recordKnowRequest is not a function` (helper not yet added).

- [ ] Step 2.3: Implement. In `/Users/stephen/scripts/auto-identity-remove/lib/config.js`, insert the two new functions immediately BEFORE the `module.exports = {` line (currently line 329). Use the existing `recordPendingConfirmation` (lines 171-182) as the structural model. Add the following block:

```js
// ── Right-to-know (data access / disclosure) request tracking ──────────────
// Records that a "show me what you have" disclosure request was sent to a
// broker. Stored as state.optOuts[name].knowRequestedAt (ISO timestamp).
// Independent of opt-out history so it does not interfere with the 90-day
// re-check window used by shouldSkip.
function recordKnowRequest(brokerName) {
  const prev = state.optOuts[brokerName] || {};
  state.optOuts[brokerName] = {
    ...prev,
    knowRequestedAt: new Date().toISOString(),
  };
  saveState();
}

// Returns [{ name, knowRequestedAt, daysAgo, expectedSender? }] for brokers
// whose right-to-know request is older than opts.olderThanDays (default 45),
// sorted oldest-first. Brokers without knowRequestedAt are excluded. When a
// matching broker definition is supplied, its expectedSender is attached.
function getPendingKnowRequests(brokers, opts = {}) {
  const olderThanDays = opts.olderThanDays != null ? opts.olderThanDays : 45;
  const brokerMap = new Map((brokers || []).map(b => [b.name, b]));
  const out = [];
  for (const [name, entry] of Object.entries(state.optOuts || {})) {
    if (!entry || !entry.knowRequestedAt) continue;
    const daysAgo = (Date.now() - new Date(entry.knowRequestedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo < olderThanDays) continue;
    out.push({
      name,
      knowRequestedAt: entry.knowRequestedAt,
      daysAgo,
      expectedSender: brokerMap.get(name)?.expectedSender,
    });
  }
  return out.sort((a, b) => a.knowRequestedAt.localeCompare(b.knowRequestedAt));
}
```

Then add the two names to the exports object. Locate the line `  stateKey,` (currently line 354, the last entry before the closing `};` at line 355) and replace it with:

```js
  stateKey,
  recordKnowRequest,
  getPendingKnowRequests,
```

- [ ] Step 2.4: Run, expect pass. Command: `node --test test/right-to-know-config.test.js`. Expected: all 4 tests pass.

- [ ] Step 2.5: Commit. Commands:
```bash
rtk git add lib/config.js test/right-to-know-config.test.js
git commit -m "$(cat <<'EOF'
Add recordKnowRequest + getPendingKnowRequests state helpers

Tracks knowRequestedAt per broker, independent of opt-out history;
lists requests older than 45 days for follow-up.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `sendKnowRequests` runner (SMTP reuse + manual fallback + state record)

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/right-to-know-runner.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/right-to-know-runner.test.js`

`sendKnowRequests(brokers, cfg, opts)` filters `b.method === 'email'`, resolves persons via `configMod.getPersonsFromConfig(cfg)` (same source the watcher uses), and per (broker, person): builds the request with `buildKnowRequest`, then EITHER sends via SMTP using the same lazy-`nodemailer` transport pattern as `lib/email.js` `_sendViaSMTP` (when `cfg.email.smtp` is set and not `opts.dryRun`) OR logs a `manual` entry with the template so the user can copy-paste. On a successful send (or in dry-run preview) it calls `configMod.recordKnowRequest(broker.name)` (skipped when `opts.dryRun` is true, because dry-run promises no persisted state). Returns `{ sent: [...names], manual: [...names], errors: [...{name,error}] }`.

The test mocks `nodemailer` via `Module._load`, and monkey-patches `logger.logResult` and `config.recordKnowRequest` / `config.getPersonsFromConfig` at the module-object level (the pattern used in `test/email.test.js`).

- [ ] Step 3.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/right-to-know-runner.test.js` with the complete contents:

```js
/**
 * test/right-to-know-runner.test.js
 *
 * Covers lib/right-to-know-runner.js sendKnowRequests:
 *   1. smtp configured -> nodemailer sends a know-request email; state recorded
 *   2. no smtp -> logged 'manual' with the template body; state recorded
 *   3. dry-run -> no send, no state write
 *   4. non-email brokers are filtered out
 *
 * Mocks: nodemailer (Module._load), logger.logResult, config helpers - all at
 * the module-object level so the runner's cached requires see the patched
 * versions at call time. No real email/network/disk.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');

const PERSON = {
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'jane@example.com',
  phoneFormatted: '(512) 555-0000',
  country: 'US',
};

const EMAIL_BROKER = { name: 'Pipl', method: 'email', emailTo: 'privacy@pipl.com' };
const WEB_BROKER = { name: 'WhitePages', method: 'search-form', optOutUrl: 'https://wp.com' };

const origLogResult = loggerMod.logResult;
const origRecordKnow = configMod.recordKnowRequest;
const origGetPersons = configMod.getPersonsFromConfig;

function patchDeps() {
  const logCalls = [];
  const recorded = [];
  loggerMod.logResult = (broker, status, detail) => logCalls.push({ broker, status, detail });
  configMod.recordKnowRequest = (name) => recorded.push(name);
  configMod.getPersonsFromConfig = (c) => (c.persons && c.persons.length ? c.persons : [c.person]);
  return { logCalls, recorded };
}

function restoreDeps() {
  loggerMod.logResult = origLogResult;
  configMod.recordKnowRequest = origRecordKnow;
  configMod.getPersonsFromConfig = origGetPersons;
}

const runner = require('../lib/right-to-know-runner');

test('no smtp -> logs manual with template body, records state', async () => {
  const { logCalls, recorded } = patchDeps();
  const cfg = { person: PERSON };

  const result = await runner.sendKnowRequests([EMAIL_BROKER, WEB_BROKER], cfg, {});

  restoreDeps();

  const manualLog = logCalls.find(l => l.broker === 'Pipl' && l.status === 'manual');
  assert.ok(manualLog, `expected manual log, got ${JSON.stringify(logCalls)}`);
  assert.match(manualLog.detail, /CCPA|Right to Know/i);
  assert.deepEqual(result.manual, ['Pipl']);
  assert.deepEqual(recorded, ['Pipl']);
  // Web broker filtered out entirely.
  assert.equal(logCalls.filter(l => l.broker === 'WhitePages').length, 0);
});

test('smtp configured -> nodemailer sends know request, records state', async () => {
  const { logCalls, recorded } = patchDeps();
  const nmCalls = [];
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'nodemailer') {
      return {
        createTransport: () => ({
          sendMail: async (opts) => { nmCalls.push(opts); return { messageId: 'mock' }; },
        }),
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/right-to-know-runner')];
  const freshRunner = require('../lib/right-to-know-runner');

  const smtpCfg = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };
  const cfg = { person: PERSON, email: { smtp: smtpCfg } };
  const result = await freshRunner.sendKnowRequests([EMAIL_BROKER], cfg, {});

  Module._load = origLoad;
  delete require.cache[require.resolve('../lib/right-to-know-runner')];
  require('../lib/right-to-know-runner');
  restoreDeps();

  assert.equal(nmCalls.length, 1, 'expected one sendMail call');
  assert.equal(nmCalls[0].to, 'privacy@pipl.com');
  assert.match(nmCalls[0].subject, /Right to Know/i);
  assert.match(nmCalls[0].text, /CCPA/);
  assert.deepEqual(result.sent, ['Pipl']);
  assert.deepEqual(recorded, ['Pipl']);
  assert.ok(logCalls.find(l => l.broker === 'Pipl' && l.status === 'success'));
});

test('dry-run -> no send, no state record, manual preview only', async () => {
  const { logCalls, recorded } = patchDeps();
  const smtpCfg = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };
  const cfg = { person: PERSON, email: { smtp: smtpCfg } };

  const result = await runner.sendKnowRequests([EMAIL_BROKER], cfg, { dryRun: true });

  restoreDeps();

  assert.deepEqual(recorded, [], 'dry-run must not record state');
  assert.deepEqual(result.sent, [], 'dry-run must not send');
  assert.ok(logCalls.find(l => l.broker === 'Pipl'), 'should still log a preview');
});

test('multi-person -> one request per (broker, person)', async () => {
  const { recorded } = patchDeps();
  const personB = { ...PERSON, fullName: 'John Roe', firstName: 'John', lastName: 'Roe' };
  const cfg = { persons: [PERSON, personB] };

  const result = await runner.sendKnowRequests([EMAIL_BROKER], cfg, {});

  restoreDeps();

  // Manual log per person, state recorded once per broker per person.
  assert.equal(result.manual.length, 2, `expected 2 manual entries, got ${JSON.stringify(result.manual)}`);
  assert.equal(recorded.length, 2);
});
```

- [ ] Step 3.2: Run it, expect fail. Command: `node --test test/right-to-know-runner.test.js`. Expected failure: `Cannot find module '../lib/right-to-know-runner'`.

- [ ] Step 3.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/right-to-know-runner.js` with the complete contents:

```js
/**
 * lib/right-to-know-runner.js
 *
 * Orchestrates right-to-know (data access / disclosure) requests for
 * email-capable brokers.
 *
 * Public API:
 *   sendKnowRequests(brokers, cfg, opts) -> { sent, manual, errors }
 *
 * Routing mirrors lib/email.js:
 *   cfg.email.smtp set (and not dry-run) -> nodemailer (lazy-required)
 *   no smtp -> logResult(..., 'manual', <template>) so the user can copy-paste
 *
 * On a real send (or a manual print) the broker is recorded via
 * configMod.recordKnowRequest. In dry-run nothing is sent and no state is
 * written (dry-run promises no persisted state), but a preview is still logged.
 */

const configMod = require('./config');
const loggerMod = require('./logger');
const { buildKnowRequest } = require('./right-to-know');

/**
 * Send one know-request via SMTP using nodemailer (lazy-required).
 * Returns true on success, false on failure (failure is logged).
 *
 * @param {object} broker
 * @param {{ subject: string, body: string }} request
 * @param {object} smtpCfg
 * @returns {Promise<boolean>}
 */
async function _sendViaSMTP(broker, request, smtpCfg) {
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    loggerMod.logResult(broker.name, 'error', 'nodemailer not installed - run: npm install nodemailer');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: smtpCfg.host,
    port: smtpCfg.port || 587,
    secure: (smtpCfg.port || 587) === 465,
    auth: { user: smtpCfg.user, pass: smtpCfg.pass },
  });

  try {
    await transporter.sendMail({
      from: smtpCfg.from || smtpCfg.user,
      to: broker.emailTo,
      subject: request.subject,
      text: request.body,
    });
    loggerMod.logResult(broker.name, 'success', `Know request → ${broker.emailTo}`);
    return true;
  } catch (err) {
    loggerMod.logResult(broker.name, 'error', `SMTP failed: ${err.message.slice(0, 60)}`);
    return false;
  }
}

/**
 * Resolve persons from cfg. Reuses configMod.getPersonsFromConfig so the set
 * matches what watcher.js iterates over.
 * @param {object} cfg
 * @returns {object[]}
 */
function _getPersons(cfg) {
  try {
    return configMod.getPersonsFromConfig(cfg);
  } catch (_) {
    return [];
  }
}

/**
 * Send right-to-know requests for all email-method brokers.
 *
 * @param {object[]} brokers - full broker list (filtered internally)
 * @param {object}   cfg      - full config (cfg.person/cfg.persons, cfg.email.smtp)
 * @param {object}   [opts]
 * @param {boolean}  [opts.dryRun] - when true, print previews but do not send or record
 * @returns {Promise<{ sent: string[], manual: string[], errors: {name:string,error:string}[] }>}
 */
async function sendKnowRequests(brokers, cfg, opts = {}) {
  const dryRun = !!opts.dryRun;
  const persons = _getPersons(cfg);
  const smtpCfg = cfg && cfg.email && cfg.email.smtp;
  const emailBrokers = brokers.filter(b => b.method === 'email');

  const sent = [];
  const manual = [];
  const errors = [];

  for (const broker of emailBrokers) {
    for (const person of persons) {
      const request = buildKnowRequest({ person, broker });

      if (dryRun) {
        loggerMod.logResult(
          broker.name,
          'skipped',
          `[preview] Right-to-know → ${broker.emailTo} (${request.subject})`
        );
        continue;
      }

      if (smtpCfg) {
        const ok = await _sendViaSMTP(broker, request, smtpCfg);
        if (ok) {
          configMod.recordKnowRequest(broker.name);
          sent.push(broker.name);
        } else {
          errors.push({ name: broker.name, error: 'send failed' });
        }
      } else {
        loggerMod.logResult(
          broker.name,
          'manual',
          `Right-to-know → ${broker.emailTo} - ${request.subject}\n${request.body}`
        );
        configMod.recordKnowRequest(broker.name);
        manual.push(broker.name);
      }
    }
  }

  return { sent, manual, errors };
}

module.exports = {
  sendKnowRequests,
  _sendViaSMTP,
  _getPersons,
};
```

- [ ] Step 3.4: Run, expect pass. Command: `node --test test/right-to-know-runner.test.js`. Expected: all 4 tests pass.

- [ ] Step 3.5: Commit. Commands:
```bash
rtk git add lib/right-to-know-runner.js test/right-to-know-runner.test.js
git commit -m "$(cat <<'EOF'
Add sendKnowRequests runner (SMTP reuse + manual fallback)

Sends right-to-know requests for email brokers via nodemailer when
SMTP is configured, otherwise logs the template for manual send;
records knowRequestedAt unless dry-run.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `--know` and `--know-status` CLI modes into `watcher.js`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js`
  - Add `KNOW` / `KNOW_STATUS` flag parsing near the other boolean flags (after line 44).
  - Add a `--know-status` early-exit branch alongside the existing `--list` / `--pending` branches (after the `--pending` block ends at line 92, before the `--confirm-emails` block at line 94). `--know-status` needs no browser, so it lives with the print-and-exit modes.
  - Add a `--know` early-exit branch inside the main (non-doctor, non-confirm-emails) section, after `setDryRun(DRY_RUN)` (line 176) and after `--install-scheduler` (line 189) but before `const config = loadConfig();` at line 191 - actually it must run after config load, so place it right after `const persons = getPersonsFromConfig(config);` (line 196). It sends and exits; no Playwright launch needed because email brokers do not use the browser.
- Test: none new (watcher.js is the thin orchestrator; logic is covered by the lib tests above and the full-suite run in Task 5). This task is verified by manual smoke commands plus the existing suite staying green.

Note on placement: `--know-status` is pure print (uses `loadState` + `getPendingKnowRequests`), so it belongs with `--list`/`--pending`. `--know` performs sends and must run after `loadConfig()`; it does NOT need a lock as aggressively as `main()`, but to stay consistent with `--confirm-emails` (which also calls `recordSuccess`->`saveState`) we acquire the same `STATE_PATH + '.lock'`.

- [ ] Step 4.1: Add flag parsing. In `/Users/stephen/scripts/auto-identity-remove/watcher.js`, find the block at lines 41-44:

```js
const PENDING_MODE    = process.argv.includes('--pending');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
```

Replace it with:

```js
const PENDING_MODE    = process.argv.includes('--pending');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
const KNOW_MODE       = process.argv.includes('--know');
const KNOW_STATUS     = process.argv.includes('--know-status');
```

- [ ] Step 4.2: Add the `--know-status` print-and-exit branch. In `watcher.js`, find the end of the `--pending` block (lines 89-92), whose exact text is:

```js
    console.log(`\n${pending.length} broker(s) awaiting confirmation. Check your inbox for opt-out confirmation emails.\n`);
  }
  process.exit(0);
}
```

Replace that exact block with:

```js
    console.log(`\n${pending.length} broker(s) awaiting confirmation. Check your inbox for opt-out confirmation emails.\n`);
  }
  process.exit(0);
}

// ── --know-status: print right-to-know requests older than 45 days, then exit ─
if (KNOW_STATUS) {
  const brokers = require('./brokers');
  const { getPendingKnowRequests } = require('./lib/config');
  const pending = getPendingKnowRequests(brokers, { olderThanDays: 45 });
  if (pending.length === 0) {
    console.log('\nNo right-to-know requests are older than 45 days awaiting a response.\n');
  } else {
    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n' + pad('Broker', 40) + pad('Requested', 14) + 'Days ago');
    console.log('-'.repeat(70));
    for (const p of pending) {
      const when = p.knowRequestedAt.slice(0, 10);
      console.log(pad(p.name, 40) + pad(when, 14) + Math.round(p.daysAgo));
    }
    console.log(`\n${pending.length} right-to-know request(s) past 45 days. Follow up with the broker if no disclosure arrived.\n`);
  }
  process.exit(0);
}
```

- [ ] Step 4.3: Add the `--know` send-and-exit branch. In `watcher.js`, find the lines 191-197 (config load + configure):

```js
const config = loadConfig();
const { notify } = config;
const profileDir = (config.profileDir || '~/.config/auto-identity-remove')
  .replace(/^~(?=\/|$)/, os.homedir());
const state = loadState();
const persons = getPersonsFromConfig(config);
brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: persons[0], capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length });
```

Replace it with (inserting the `--know` branch right after `persons` is resolved):

```js
const config = loadConfig();
const { notify } = config;
const profileDir = (config.profileDir || '~/.config/auto-identity-remove')
  .replace(/^~(?=\/|$)/, os.homedir());
const state = loadState();
const persons = getPersonsFromConfig(config);

// ── --know: fire right-to-know (data access) requests to email brokers, exit ──
// No browser needed - email-method brokers only. Acquires the state lock since
// recordKnowRequest -> saveState writes state.json.
if (KNOW_MODE) {
  const brokers = require('./brokers');
  const { sendKnowRequests } = require('./lib/right-to-know-runner');
  const { getPendingKnowRequests } = require('./lib/config');
  const KNOW_LOCK_PATH = STATE_PATH + '.lock';
  try {
    lock.acquire(KNOW_LOCK_PATH);
  } catch (err) {
    const pidMatch = err.message.match(/pid (\d+)/);
    console.error(`Another instance is running, pid=${pidMatch ? pidMatch[1] : '?'}. Exiting.`);
    process.exit(1);
  }

  (async () => {
    console.log('\n🔎 Right-to-know - requesting disclosure of held data from email brokers');
    if (DRY_RUN) console.log('🧪 DRY RUN - previews only, nothing sent, no state saved.');
    const emailBrokerCount = brokers.filter(b => b.method === 'email').length;
    console.log(`📋 ${emailBrokerCount} email broker(s) × ${persons.length} person(s)\n`);

    const result = await sendKnowRequests(brokers, config, { dryRun: DRY_RUN });

    console.log('\n' + '='.repeat(54));
    console.log('Right-to-know results - ' + new Date().toLocaleString());
    console.log('='.repeat(54));
    console.log(`  sent (SMTP) : ${result.sent.length}`);
    console.log(`  manual      : ${result.manual.length}`);
    console.log(`  errors      : ${result.errors.length}`);
    for (const e of result.errors) console.log(`    - ${e.name}: ${e.error}`);
    const pending = getPendingKnowRequests(brokers, { olderThanDays: 45 });
    console.log(`\n  ${pending.length} prior request(s) now past 45 days (run --know-status for detail).`);
    console.log('='.repeat(54) + '\n');
  })().then(() => {
    lock.release(STATE_PATH + '.lock');
    process.exit(0);
  }).catch(err => {
    lock.release(STATE_PATH + '.lock');
    console.error('know error:', err.message);
    process.exit(1);
  });
} else {

brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: persons[0], capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length });
```

Because this opens a new `else {` block, close it at the end of `main()`'s definition area. Find the line `main().catch(err => {` (currently line 503). The `--know` branch must NOT fall through to `main()`. Locate the existing end-of-file structure (lines 503-511):

```js
main().catch(err => {
  console.error('\nFatal:', err.message);
  sendText(`❌ Privacy Watcher crashed: ${err.message.slice(0, 100)}`, notify);
  process.exit(1);
});

} // end else (not DOCTOR mode)

} // end else (not --confirm-emails mode)
```

Replace it with:

```js
main().catch(err => {
  console.error('\nFatal:', err.message);
  sendText(`❌ Privacy Watcher crashed: ${err.message.slice(0, 100)}`, notify);
  process.exit(1);
});

} // end else (not --know mode)

} // end else (not DOCTOR mode)

} // end else (not --confirm-emails mode)
```

- [ ] Step 4.4: Verify the file still parses and the modes behave. Run these hermetic smoke checks (no network: email brokers with no SMTP only print; we do NOT pass `--know` here to avoid touching real config). Commands:
```bash
node -c watcher.js && echo "SYNTAX_OK"
node watcher.js --know-status
```
Expected: `SYNTAX_OK` printed (syntax valid), and `--know-status` prints either the "No right-to-know requests are older than 45 days" line or a table - exit 0, no crash. (It reads the live `state.json` fixture which has no `knowRequestedAt`, so the empty-state message is expected.)

- [ ] Step 4.5: Commit. Commands:
```bash
rtk git add watcher.js
git commit -m "$(cat <<'EOF'
Wire --know and --know-status CLI modes into watcher

--know fires right-to-know requests to email brokers (SMTP or manual
print) under the state lock; --know-status lists requests past 45 days.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Full-suite verification

Files:
- Test: runs the entire root suite plus the dashboard suite. No code changes.

The dashboard was not touched, but its suite is part of the project test contract (`.github/workflows/test.yml`), so we confirm both green to mirror CI exactly.

- [ ] Step 5.1: Run the root suite exactly as CI does. Command:
```bash
node --test test/*.test.js dashboard/validate.test.js
```
Expected: all tests pass, including the three new files (`test/right-to-know.test.js`, `test/right-to-know-config.test.js`, `test/right-to-know-runner.test.js`). Look for `# fail 0` in the TAP summary.

- [ ] Step 5.2: Run the dashboard suite (unchanged, must stay green). Commands:
```bash
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```
Expected: `# fail 0`. (No dashboard files were modified; this is a regression guard.)

- [ ] Step 5.3: Confirm `npm test` (root script) passes end to end. Command:
```bash
cd /Users/stephen/scripts/auto-identity-remove && npm test
```
Expected: the `node --test test/*.test.js dashboard/validate.test.js` script exits 0 with `# fail 0`.

- [ ] Step 5.4: Commit (only if any incidental fixes were needed; otherwise skip). If Step 5.1-5.3 surfaced and required a fix, stage and commit it:
```bash
rtk git add -A
git commit -m "$(cat <<'EOF'
Fix test regressions surfaced by full suite for right-to-know feature

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```
If no changes were needed, do not create an empty commit - proceed.

---

## Self-review

Spec coverage:
- Pure `buildKnowRequest({ person, broker, regime })` returning `{ subject, body }`, unit-tested for both regimes and routing - Task 1. Templated in the same line-array style as `lib/email.js` `_buildBodyGDPR` / `_buildBodyCCPA`, and reuses the identical `EU_COUNTRIES` set so regime routing matches `_pickTemplate`.
- Right-to-know wording requests DISCLOSURE/ACCESS (GDPR Article 15, CCPA right to know) and explicitly is NOT erasure - asserted via `assert.doesNotMatch(.../erasure|Article 17/)` so it cannot silently drift into the opt-out template.
- `--know` CLI mode: for email-capable brokers, sends via existing SMTP transport (lazy `nodemailer`, same `createTransport` shape as `lib/email.js` `_sendViaSMTP`) or prints the template when SMTP is off, and records `state.optOuts[name].knowRequestedAt` - Tasks 3 + 4.
- `--know-status` lists pending know-requests older than 45 days - Task 2 (`getPendingKnowRequests`, default 45) + Task 4 branch.
- Regime routing by `person.country` reusing the GDPR-vs-CCPA logic - `pickRegime` mirrors `lib/email.js` `EU_COUNTRIES` exactly.
- Naming does not clash with RTK (rust-token-killer): files are `lib/right-to-know.js`, `lib/right-to-know-runner.js`, `test/right-to-know*.test.js`. No symbol or filename uses the token `rtk`.
- Tests required: pure template builder for both regimes (Task 1), temp-state record round-trip via `setTestStatePath` (Task 2), mocked email send via `Module._load` (Task 3). All hermetic - no real network/spawn; state writes go to `os.tmpdir()` temp files or injected/monkey-patched deps; no writes to the real `config.json` (the `--know` smoke test in Step 4.4 uses only `--know-status`, which reads the existing fixture and writes nothing).

Signature consistency with the real repo (verified against the read files):
- `lib/config.js` exports object (lines 329-355) is extended with `recordKnowRequest` and `getPendingKnowRequests`; new functions use the existing `state`, `saveState`, `setTestStatePath`, `setDryRun` machinery exactly as `recordPendingConfirmation` / `getPendingConfirmations` do.
- `sendKnowRequests` reuses `configMod.getPersonsFromConfig(cfg)` (real export, lines 278-289) - same person source as `watcher.js` line 196.
- SMTP path matches `lib/email.js` `_sendViaSMTP` (lines 115-146): lazy `require('nodemailer')`, `createTransport({ host, port||587, secure: port===465, auth })`, `sendMail({ from, to, subject, text })`, then `logResult('success', ...)`.
- `logResult(broker, status, detail)` statuses used (`'manual'`, `'success'`, `'error'`, `'skipped'`) are all present in `STATUS_BUCKET` (lib/logger.js) so they bucket correctly.
- `watcher.js` integration follows the existing flag-parse-then-early-exit ladder (`--list` lines 57-71, `--pending` lines 74-92, `--confirm-emails` lines 95-156) and the `STATE_PATH + '.lock'` acquire/release pattern from `--confirm-emails` (lines 113-120, 149-153).
- Test style matches `test/email.test.js` (top-level fixtures, `patchDeps`/`restoreDeps`, `Module._load` nodemailer mock, cache-bust + re-require) and `test/config.test.js` (save/restore of the shared mutable `state`).

No placeholders: every test and implementation block above is complete, runnable code. No "TBD", no "add error handling", no "similar to above". No em dashes in authored prose (hyphens only); the GDPR/CCPA template strings intentionally contain no em dashes either.

New npm dependencies: none. Uses the already-present optional `nodemailer` and Node built-ins (`fs`, `os`, `path`, `node:test`, `node:assert/strict`).
