# Broker Allowlist (Keep Me Listed Here) Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Let users mark brokers they WANT to stay listed on (`config.allowlist: string[]`, case-insensitive) so the tool never opts out for them, verification never flags them as still-listed, and they can edit the list from the CLI (`--allow`/`--unallow`) or the dashboard config UI.

Architecture: A single pure predicate `isAllowlisted(name, config)` is added to `lib/filter.js` and becomes the one source of truth. The two run loops (`lib/broker-runner.js` `processBrokerWithPerson`, `generic-runner.js` `processGenericUrl`) consult it near their existing skip guards and short-circuit with a new `allowlisted` status; `lib/logger.js` learns that status; `lib/verify-loop.js` skips allowlisted brokers (so they never count as `still_listed`); `watcher.js` gains `--allow <name>` / `--unallow <name>` subcommands that atomically edit `config.json`; the dashboard config form surfaces the list as a comma field.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict`, run with `node --test`. Browser automation is Playwright (stubbed in tests). No new npm dependencies.

---

## File map

| File | Created / Modified | Responsibility |
|---|---|---|
| `lib/filter.js` | Modified | Add pure `isAllowlisted(name, config)` predicate (case-insensitive, trimmed); export it. |
| `lib/logger.js` | Modified | Add `allowlisted` status → `skipped` bucket in `STATUS_BUCKET` and an icon in `ICONS`. |
| `lib/broker-runner.js` | Modified | In `processBrokerWithPerson`, skip allowlisted brokers (log `allowlisted`, never fill/submit/record) and accept the active config via `configure`. |
| `generic-runner.js` | Modified | In `processGenericUrl`, return `{ status: 'allowlisted' }` for allowlisted hosts before any navigation; map `allowlisted` outcome in `classifyOutcome`. |
| `lib/verify-loop.js` | Modified | Skip allowlisted (broker, person) pairs so they are never re-searched or counted as `still_listed`. |
| `lib/allowlist-edit.js` | Created | Pure helpers `addToAllowlist` / `removeFromAllowlist` operating on a config object (no disk I/O), reused by the CLI and dashboard. |
| `watcher.js` | Modified | Parse `--allow <name>` / `--unallow <name>` as early-exit subcommands that atomically rewrite `config.json`; pass `config` into `brokerRunner.configure`; skip generic-runner allowlist handling needs config. |
| `dashboard/public/index.html` | Modified | Add an "Allowlist (keep listed, comma)" input to the config form. |
| `dashboard/public/app.js` | Modified | Load/save the `allowlist` field as a comma-joined string (like `person.aliases`). |
| `test/allowlist.test.js` | Created | Unit tests for `isAllowlisted`, `addToAllowlist`, `removeFromAllowlist`. |
| `test/allowlist-broker-runner.test.js` | Created | `Module._load` test: an allowlisted broker logs `allowlisted` and never calls `fillForm`/`recordSuccess`. |
| `test/allowlist-generic-runner.test.js` | Created | Generic runner returns `allowlisted` (no navigation) for allowlisted hosts. |
| `test/allowlist-verify-loop.test.js` | Created | `runVerify` skips allowlisted brokers (not in `still_listed`). |

---

## Task 1: Pure `isAllowlisted` predicate in lib/filter.js

Files:
- Modify: `lib/filter.js` (add function before the final `module.exports` at lines 99; extend the exports object)
- Test: `test/allowlist.test.js` (Create)

- [ ] Step 1.1: Write the failing test. Create `test/allowlist.test.js` with ONLY the `isAllowlisted` block for now (the `allowlist-edit` blocks are added in Task 6):

```js
/**
 * test/allowlist.test.js
 *
 * Pure-helper coverage for the broker allowlist feature:
 *   - isAllowlisted(name, config)  - case-insensitive, trimmed membership test
 *   - addToAllowlist / removeFromAllowlist - immutable config edits (Task 6)
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isAllowlisted } = require('../lib/filter');

test('isAllowlisted: returns false when config has no allowlist', () => {
  assert.equal(isAllowlisted('Spokeo', {}), false);
  assert.equal(isAllowlisted('Spokeo', { allowlist: [] }), false);
});

test('isAllowlisted: exact match returns true', () => {
  assert.equal(isAllowlisted('Spokeo', { allowlist: ['Spokeo'] }), true);
});

test('isAllowlisted: match is case-insensitive', () => {
  assert.equal(isAllowlisted('Spokeo', { allowlist: ['spokeo'] }), true);
  assert.equal(isAllowlisted('SPOKEO', { allowlist: ['Spokeo'] }), true);
});

test('isAllowlisted: surrounding whitespace in the list is ignored', () => {
  assert.equal(isAllowlisted('BeenVerified', { allowlist: ['  BeenVerified  '] }), true);
});

test('isAllowlisted: non-member returns false', () => {
  assert.equal(isAllowlisted('Radaris', { allowlist: ['Spokeo', 'BeenVerified'] }), false);
});

test('isAllowlisted: tolerates missing/blank name and non-array allowlist', () => {
  assert.equal(isAllowlisted('', { allowlist: ['Spokeo'] }), false);
  assert.equal(isAllowlisted(undefined, { allowlist: ['Spokeo'] }), false);
  assert.equal(isAllowlisted('Spokeo', null), false);
  assert.equal(isAllowlisted('Spokeo', { allowlist: 'Spokeo' }), false);
});
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test test/allowlist.test.js`. Expected failure: `TypeError: isAllowlisted is not a function` (the export does not exist yet).

- [ ] Step 1.3: Implement. In `lib/filter.js`, insert this function immediately before the `module.exports` line (currently line 99):

```js
/**
 * Case-insensitive, whitespace-tolerant membership test for the broker allowlist.
 *
 * A broker on the allowlist is one the user explicitly wants to STAY listed on,
 * so the run loops skip it and verification never flags it as still-listed.
 *
 * @param {string} name    Broker name (e.g. broker.name).
 * @param {{ allowlist?: string[] }} [config]  Parsed config object.
 * @returns {boolean}
 */
function isAllowlisted(name, config) {
  if (!name || !config || !Array.isArray(config.allowlist)) return false;
  const target = String(name).trim().toLowerCase();
  if (!target) return false;
  return config.allowlist.some(entry => String(entry).trim().toLowerCase() === target);
}
```

  Then update the export at the end of the file from:

```js
module.exports = { parseList, applyFilter, loadLastLog, extractFailedBrokers };
```

  to:

```js
module.exports = { parseList, applyFilter, loadLastLog, extractFailedBrokers, isAllowlisted };
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test test/allowlist.test.js`. Expect all `isAllowlisted` tests passing (the `allowlist-edit` ones do not exist yet).

- [ ] Step 1.5: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add lib/filter.js test/allowlist.test.js
rtk git commit -m "Add isAllowlisted predicate to lib/filter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: New `allowlisted` status in lib/logger.js

Files:
- Modify: `lib/logger.js` (`ICONS` line 22, `STATUS_BUCKET` lines 24-35)
- Test: `test/allowlist-logger.test.js` (Create)

- [ ] Step 2.1: Write the failing test. Create `test/allowlist-logger.test.js`:

```js
/**
 * test/allowlist-logger.test.js
 *
 * Verifies the logger learns the new 'allowlisted' status and routes it to the
 * 'skipped' bucket (allowlisted brokers are intentionally not acted on, so they
 * belong with skips, not errors).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { STATUS_BUCKET, ICONS, logResult, resetResults, results } = require('../lib/logger');

test('STATUS_BUCKET maps allowlisted -> skipped', () => {
  assert.equal(STATUS_BUCKET.allowlisted, 'skipped');
});

test('ICONS has an entry for allowlisted', () => {
  assert.ok(ICONS.allowlisted, 'expected an icon for the allowlisted status');
});

test('logResult routes an allowlisted entry into results.skipped', () => {
  resetResults();
  logResult('Spokeo', 'allowlisted', 'on allowlist - keeping listing');
  const entry = results.skipped.find(e => e.broker === 'Spokeo');
  assert.ok(entry, 'allowlisted entry should land in the skipped bucket');
  assert.equal(entry.status, 'allowlisted');
});
```

- [ ] Step 2.2: Run it, expect fail. Command: `node --test test/allowlist-logger.test.js`. Expected failure: `STATUS_BUCKET.allowlisted` is `undefined`, so `assert.equal(STATUS_BUCKET.allowlisted, 'skipped')` fails with `undefined !== 'skipped'`.

- [ ] Step 2.3: Implement. In `lib/logger.js`, change the `ICONS` constant (line 22) from:

```js
const ICONS = { success: '✅', skipped: '⏭ ', notFound: '🔍', captcha_failed: '⚠️ ', manual: '📋', error: '❌', dead: '💀', pending_confirm: '📧', preview: '👀', unverified: '❓' };
```

  to (add the `allowlisted` icon):

```js
const ICONS = { success: '✅', skipped: '⏭ ', notFound: '🔍', captcha_failed: '⚠️ ', manual: '📋', error: '❌', dead: '💀', pending_confirm: '📧', preview: '👀', unverified: '❓', allowlisted: '📌' };
```

  Then change the `STATUS_BUCKET` map (lines 24-35) from:

```js
const STATUS_BUCKET = {
  success:         'succeeded',
  skipped:         'skipped',
  notFound:        'notFound',
  captcha_failed:  'captchaFailed',
  manual:          'manual',
  error:           'errors',
  dead:            'dead',
  pending_confirm: 'pendingConfirm',
  preview:         'skipped',
  unverified:      'errors',
};
```

  to (add the `allowlisted` row):

```js
const STATUS_BUCKET = {
  success:         'succeeded',
  skipped:         'skipped',
  notFound:        'notFound',
  captcha_failed:  'captchaFailed',
  manual:          'manual',
  error:           'errors',
  dead:            'dead',
  pending_confirm: 'pendingConfirm',
  preview:         'skipped',
  unverified:      'errors',
  allowlisted:     'skipped',
};
```

- [ ] Step 2.4: Run, expect pass. Command: `node --test test/allowlist-logger.test.js`. Expect 3 passing tests.

- [ ] Step 2.5: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add lib/logger.js test/allowlist-logger.test.js
rtk git commit -m "Add allowlisted status to logger (routes to skipped bucket)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: broker-runner skips allowlisted brokers

`processBrokerWithPerson` must short-circuit allowlisted brokers BEFORE the search/fill/submit path, logging `allowlisted` and never calling `fillForm` or `recordSuccess`. The active config reaches the module through `configure({ config })` (a new injected opt), keeping the no-circular-require / DI pattern the module already uses.

Files:
- Modify: `lib/broker-runner.js` (opts default line 23; skip guards lines 42-62)
- Test: `test/allowlist-broker-runner.test.js` (Create)

- [ ] Step 3.1: Write the failing test. Create `test/allowlist-broker-runner.test.js` using the established `Module._load` interception pattern (mirrors `test/broker-runner-buckets.test.js`):

```js
/**
 * test/allowlist-broker-runner.test.js
 *
 * Verifies processBrokerWithPerson short-circuits an allowlisted broker:
 *   - logResult is called with status 'allowlisted'
 *   - fillForm is NEVER called (no form interaction)
 *   - recordSuccess is NEVER called (no 90-day cooldown started)
 *
 * A non-allowlisted broker must still proceed to fillForm + recordSuccess,
 * proving the guard is scoped to the allowlist and not a blanket skip.
 *
 * Uses the Module._load interception pattern from the other broker-runner tests.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const recorded = { success: [] };
const calls = { fillForm: 0 };

const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: () => null,
  isPendingConfirmation: () => false,
  recordSuccess: (name, detail) => recorded.success.push({ name, detail }),
  recordPendingConfirmation: () => {},
  recordFailure: () => {},
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: () => {},
  stateKey: (brokerName) => brokerName,
};

const filterMock = {
  isAllowlisted: (name, config) =>
    !!(config && Array.isArray(config.allowlist) &&
       config.allowlist.some(e => String(e).trim().toLowerCase() === String(name).trim().toLowerCase())),
};

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './filter') return filterMock;
  if (request === './logger') return {
    logResult: (name, status, detail) => logged.push({ name, status, detail }),
    STATUS_BUCKET: {},
  };
  if (request === './forms') return {
    fillForm: async () => { calls.fillForm++; },
    findListingUrl: async () => 'https://example.com/listing/123',
  };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false, snippet: '' }) };
  if (request === './success') return { classifyPostSubmit: () => ({ outcome: 'success', snippet: 'Removed.' }) };
  if (request === './retry') return { withRetry: fn => fn() };
  if (request === './timing') return { jitterSleep: async () => {} };
  if (request === './snapshot') return { captureSubmitSnapshot: async () => null };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
Module._load = originalLoad;

function clearAll() {
  logged.length = 0;
  recorded.success.length = 0;
  calls.fillForm = 0;
}

const PERSON = { firstName: 'Test', lastName: 'User', email: 'test@example.com', country: 'US' };

function makeContext() {
  return {
    newPage: async () => ({
      goto: async () => {},
      locator: () => ({ first: () => ({ fill: async () => {}, count: async () => 1, isVisible: async () => true, click: async () => {} }) }),
      evaluate: async () => 'page body text',
      close: async () => {},
    }),
  };
}

const SEARCH_BROKER = {
  name: 'AllowedBroker',
  method: 'search-form',
  searchUrl: 'https://example.com/search',
  optOutUrl: 'https://example.com/optout',
  submitSelector: 'button[type="submit"]',
  formFields: { 'input[name="x"]': 'y' },
};

test('allowlisted broker: logResult called with status allowlisted', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null, config: { allowlist: ['AllowedBroker'] } });

  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  const entry = logged.find(l => l.name === SEARCH_BROKER.name);
  assert.ok(entry, 'logResult should have been called');
  assert.equal(entry.status, 'allowlisted', `expected "allowlisted" but got "${entry.status}"`);
});

test('allowlisted broker: fillForm is NEVER called', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null, config: { allowlist: ['AllowedBroker'] } });

  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(calls.fillForm, 0, 'fillForm must NOT be called for an allowlisted broker');
});

test('allowlisted broker: recordSuccess is NEVER called', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null, config: { allowlist: ['AllowedBroker'] } });

  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(recorded.success.length, 0, 'recordSuccess must NOT be called for an allowlisted broker');
});

test('non-allowlisted broker still proceeds to fillForm + recordSuccess', async () => {
  clearAll();
  configure({ dryRun: false, person: PERSON, capsolver: null, config: { allowlist: ['SomeOtherBroker'] } });

  await processBrokerWithPerson(makeContext(), SEARCH_BROKER, PERSON);

  assert.equal(calls.fillForm, 1, 'fillForm should run for a non-allowlisted broker');
  assert.equal(recorded.success.length, 1, 'recordSuccess should run for a non-allowlisted broker');
  const entry = logged.find(l => l.name === SEARCH_BROKER.name);
  assert.equal(entry.status, 'success');
});
```

- [ ] Step 3.2: Run it, expect fail. Command: `node --test test/allowlist-broker-runner.test.js`. Expected failure: the first test fails because no allowlist guard exists yet - the broker proceeds to the success path, so `entry.status` is `'success'`, not `'allowlisted'` (`'success' !== 'allowlisted'`).

- [ ] Step 3.3: Implement. In `lib/broker-runner.js` make three edits.

  (a) Add the `isAllowlisted` require alongside the existing requires. Change line 15 from:

```js
const { fillForm, findListingUrl } = require('./forms');
```

  to:

```js
const { fillForm, findListingUrl } = require('./forms');
const { isAllowlisted } = require('./filter');
```

  (b) Add `config` to the injectable opts default. Change line 23 from:

```js
let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false, snapshot: false, personCount: 1 };
```

  to:

```js
let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false, snapshot: false, personCount: 1, config: null };
```

  (c) Add the allowlist guard at the very top of the skip block, immediately after `const skip = shouldSkip(key);` handling and before the US-only gate. Change the block (lines 50-62) from:

```js
  // Centralized skip logic — handles both regular re-check window AND
  // WP4 pending-confirmation 14-day retry window.
  const skip = shouldSkip(key);
  if (skip) {
    logResult(broker.name, 'skipped', skip.reason);
    return;
  }

  // Skip US-only brokers for non-US users (these sites hold no non-US records)
  if (broker.usOnly && (person?.country || 'US') !== 'US') {
    logResult(broker.name, 'skipped', 'US-only broker — skipped for non-US user');
    return;
  }
```

  to (insert the allowlist guard first so an allowlisted broker is never even checkpoint/skip-evaluated for action):

```js
  // Allowlist: the user explicitly wants to STAY listed on this broker, so never
  // submit an opt-out. Logged as 'allowlisted' (routed to the skipped bucket).
  if (isAllowlisted(broker.name, opts.config)) {
    logResult(broker.name, 'allowlisted', 'on allowlist - keeping listing, no opt-out submitted');
    return;
  }

  // Centralized skip logic — handles both regular re-check window AND
  // WP4 pending-confirmation 14-day retry window.
  const skip = shouldSkip(key);
  if (skip) {
    logResult(broker.name, 'skipped', skip.reason);
    return;
  }

  // Skip US-only brokers for non-US users (these sites hold no non-US records)
  if (broker.usOnly && (person?.country || 'US') !== 'US') {
    logResult(broker.name, 'skipped', 'US-only broker — skipped for non-US user');
    return;
  }
```

- [ ] Step 3.4: Run, expect pass. Command: `node --test test/allowlist-broker-runner.test.js`. Expect 4 passing tests.

- [ ] Step 3.5: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add lib/broker-runner.js test/allowlist-broker-runner.test.js
rtk git commit -m "Skip allowlisted brokers in broker-runner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: generic-runner skips allowlisted hosts

`processGenericUrl` runs the ~500 generic brokers. It must return `{ status: 'allowlisted' }` before any navigation when the host is allowlisted, and `classifyOutcome` must map that to a stats bucket. The active config is read via the module's existing lazy `getConfig()`, so no signature change is needed.

Files:
- Modify: `generic-runner.js` (require block lines 31-33; `processGenericUrl` start line 285; `classifyOutcome` lines 429-446)
- Test: `test/allowlist-generic-runner.test.js` (Create)

- [ ] Step 4.1: Write the failing test. Create `test/allowlist-generic-runner.test.js`. It calls `processGenericUrl` indirectly through `runGenericBrokers` with an injected broker list and an injected process function is NOT used here - instead we drive the real `processGenericUrl` via a page stub that throws if navigation is attempted, proving the allowlist short-circuits before `page.goto`:

```js
/**
 * test/allowlist-generic-runner.test.js
 *
 * Verifies the generic runner short-circuits an allowlisted host:
 *   - the broker is logged with status 'allowlisted'
 *   - page.goto is NEVER called (no network request for an allowlisted host)
 *
 * We inject a real config via the module's config cache by pointing CONFIG at a
 * temp file is overkill; instead we use runGenericBrokers' injectedProcessFn to
 * exercise the allowlist branch deterministically without touching disk.
 *
 * Strategy: require generic-runner, then call processGenericUrl through the
 * exported runner with injectedBrokers. To make the allowlist visible to the
 * module we monkeypatch its getConfig via the lib/filter mock seam: the runner
 * reads the allowlist through isAllowlisted(broker.name, getConfig()), so we
 * stub require('./lib/filter') with Module._load before requiring the runner.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

// Allowlist seam: the runner will call isAllowlisted(name, config). We force the
// config the runner sees and assert the predicate is consulted before navigation.
const ALLOWLIST = ['AllowedGeneric'];

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('generic-runner')) return originalLoad(request, parent, isMain);
  if (request === './lib/filter') return {
    isAllowlisted: (name) =>
      ALLOWLIST.some(e => String(e).trim().toLowerCase() === String(name).trim().toLowerCase()),
  };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const genericRunnerPath = require.resolve('../generic-runner');
delete require.cache[genericRunnerPath];
const { runGenericBrokers, classifyOutcome } = require('../generic-runner');
Module._load = originalLoad;

test('classifyOutcome maps allowlisted -> allowlisted bucket', () => {
  assert.equal(classifyOutcome('allowlisted', 'on allowlist'), 'allowlisted');
});

test('generic runner: allowlisted host is logged allowlisted and never navigated', async () => {
  const logged = [];
  const logResult = (name, status, detail) => logged.push({ name, status, detail });
  const recordSuccess = () => { throw new Error('recordSuccess must not be called for an allowlisted host'); };

  // A page whose goto throws - proves the allowlist branch returns before navigation.
  const page = {
    goto: async () => { throw new Error('navigation must not happen for an allowlisted host'); },
    waitForTimeout: async () => {},
    isClosed: () => false,
    close: async () => {},
  };
  const context = {
    newPage: async () => page,
    pages: () => [page],
  };

  const state = { optOuts: {} };
  const injectedBrokers = [{ name: 'AllowedGeneric', url: 'https://allowed-generic.example.com/optout', source: 'markup' }];

  const out = await runGenericBrokers(context, new Set(), state, logResult, recordSuccess, { injectedBrokers });

  const entry = logged.find(l => l.name === 'AllowedGeneric');
  assert.ok(entry, 'the allowlisted broker should still be logged');
  assert.equal(entry.status, 'allowlisted');
  assert.equal(out.genericStats.attempted, 1);
});
```

- [ ] Step 4.2: Run it, expect fail. Command: `node --test test/allowlist-generic-runner.test.js`. Expected failure: the first test fails on `classifyOutcome('allowlisted', ...)` returning `'error'` (the default branch) instead of `'allowlisted'`; the second fails because `page.goto` throws (no allowlist short-circuit), so the entry status is `'error'`.

- [ ] Step 4.3: Implement. In `generic-runner.js` make three edits.

  (a) Add the `isAllowlisted` require. Change the require block (lines 31-33) from:

```js
const { detectConfirmationRequired } = require('./lib/confirm');
const { CONFIRM_RECHECK_DAYS } = require('./lib/config');
const { withRetry } = require('./lib/retry');
```

  to:

```js
const { detectConfirmationRequired } = require('./lib/confirm');
const { CONFIRM_RECHECK_DAYS } = require('./lib/config');
const { withRetry } = require('./lib/retry');
const { isAllowlisted } = require('./lib/filter');
```

  (b) Add the allowlist short-circuit at the very top of `processGenericUrl`, before the pending/recheck logic. Change the function head (lines 285-289) from:

```js
async function processGenericUrl(page, broker, state, dryRun = false, injectedDeadSet) {
  // WP4: if the entry is in pending-confirmation state, use the shorter 14-day
  // re-check window so the user has a chance to click the confirmation link.
  const entry = state.optOuts[broker.name];
```

  to (note: tests stub `getConfig` by stubbing `isAllowlisted`, so pass `getConfig()` defensively wrapped in a try so a missing config.json in pure-helper tests never throws here):

```js
async function processGenericUrl(page, broker, state, dryRun = false, injectedDeadSet) {
  // Allowlist: the user explicitly wants to stay listed on this host, so never
  // navigate or submit. Returned before any network request.
  let allowCfg = null;
  try { allowCfg = getConfig(); } catch (_) { allowCfg = null; }
  if (isAllowlisted(broker.name, allowCfg)) {
    return { status: 'allowlisted', detail: 'on allowlist - keeping listing, no opt-out submitted' };
  }

  // WP4: if the entry is in pending-confirmation state, use the shorter 14-day
  // re-check window so the user has a chance to click the confirmation link.
  const entry = state.optOuts[broker.name];
```

  (c) Map the new outcome in `classifyOutcome`. Change the switch (lines 429-446) from:

```js
function classifyOutcome(status, detail) {
  switch (status) {
    case 'success':
    case 'pending_confirm':
      return 'submitted';
    case 'manual':
    case 'dead':
      return 'no_form_found';
    case 'error':
      return 'error';
    case 'skipped':
      // Distinguish dry-run skips from recently-visited skips via detail text
      if (detail && detail.includes('dry-run')) return 'dry-run-skipped';
      return 'skipped-recent';
    default:
      return 'error';
  }
}
```

  to (add the `allowlisted` case):

```js
function classifyOutcome(status, detail) {
  switch (status) {
    case 'success':
    case 'pending_confirm':
      return 'submitted';
    case 'manual':
    case 'dead':
      return 'no_form_found';
    case 'error':
      return 'error';
    case 'allowlisted':
      return 'allowlisted';
    case 'skipped':
      // Distinguish dry-run skips from recently-visited skips via detail text
      if (detail && detail.includes('dry-run')) return 'dry-run-skipped';
      return 'skipped-recent';
    default:
      return 'error';
  }
}
```

  Because the test asserts on `genericStats.attempted` (incremented for every broker regardless of bucket) and the `allowlisted` bucket is dynamically created by the existing `stats[bucket] = (stats[bucket] || 0) + 1` line, no change to the `runGenericBrokers` stats accumulator or its returned `genericStats` shape is required. The `allowlisted` status is not `'success'`, `'pending_confirm'`, `'error'`, or `'dead'`, so none of the `recordSuccess`/`recordPendingConfirmation`/`recordFailure` branches fire for it - exactly the intended behavior.

- [ ] Step 4.4: Run, expect pass. Command: `node --test test/allowlist-generic-runner.test.js`. Expect 2 passing tests.

- [ ] Step 4.5: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add generic-runner.js test/allowlist-generic-runner.test.js
rtk git commit -m "Skip allowlisted hosts in generic-runner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: verify-loop skips allowlisted brokers

`runVerify` must not re-search an allowlisted broker and must never count it as `still_listed`. The allowlist comes from the config, so `runVerify` gains an optional `opts.config` (defaulting to `null`, preserving existing callers' behavior). Allowlisted pairs are pushed to `skipped` with a clear reason.

Files:
- Modify: `lib/verify-loop.js` (require line 34; `runVerify` opts destructure line 51; per-broker loop start ~line 69)
- Test: `test/allowlist-verify-loop.test.js` (Create)

- [ ] Step 5.1: Write the failing test. Create `test/allowlist-verify-loop.test.js`:

```js
/**
 * test/allowlist-verify-loop.test.js
 *
 * Verifies runVerify skips allowlisted brokers entirely:
 *   - an allowlisted broker is NOT re-searched (findUrl is never called for it)
 *   - it is NOT placed in still_listed (even though, un-allowlisted, it would be)
 *   - it appears in skipped with an allowlist reason
 *
 * A non-allowlisted broker with the same state is still searched and classified,
 * proving the guard is scoped to the allowlist.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runVerify } = require('../lib/verify-loop');

const PERSON = { firstName: 'Test', lastName: 'User' };

// 30 days ago - past the 7-day VERIFY_AFTER_DAYS gate.
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 86400000).toISOString();

function makeBroker(name) {
  return {
    name,
    method: 'search-form',
    searchUrl: `https://example.com/${name}/search`,
    listingPattern: /found/i,
  };
}

function makeContext() {
  return { newPage: async () => ({ close: async () => {} }) };
}

test('runVerify: allowlisted broker is skipped, not searched, not still_listed', async () => {
  const searched = [];
  // findUrl returns a non-null URL => would normally classify as still_listed.
  const findUrl = async (_page, broker) => { searched.push(broker.name); return 'https://example.com/listing'; };

  const state = {
    optOuts: {
      AllowedBroker: { lastSuccess: THIRTY_DAYS_AGO },
      NormalBroker: { lastSuccess: THIRTY_DAYS_AGO },
    },
  };

  const brokers = [makeBroker('AllowedBroker'), makeBroker('NormalBroker')];

  const result = await runVerify(makeContext(), brokers, [PERSON], {
    state,
    findUrl,
    config: { allowlist: ['AllowedBroker'] },
  });

  assert.ok(!searched.includes('AllowedBroker'), 'findUrl must NOT run for an allowlisted broker');
  assert.ok(searched.includes('NormalBroker'), 'findUrl SHOULD run for a non-allowlisted broker');

  assert.ok(
    !result.still_listed.some(e => e.broker === 'AllowedBroker'),
    'allowlisted broker must never be counted as still_listed'
  );
  assert.ok(
    result.still_listed.some(e => e.broker === 'NormalBroker'),
    'non-allowlisted broker with a found listing should be still_listed'
  );

  const skip = result.skipped.find(e => e.broker === 'AllowedBroker');
  assert.ok(skip, 'allowlisted broker should be in skipped');
  assert.match(skip.reason, /allowlist/i);
});

test('runVerify: no config (default) preserves existing behavior', async () => {
  const findUrl = async () => null; // listing absent => verified_clear
  const state = { optOuts: { NormalBroker: { lastSuccess: THIRTY_DAYS_AGO } } };
  const brokers = [makeBroker('NormalBroker')];

  const result = await runVerify(makeContext(), brokers, [PERSON], { state, findUrl });

  assert.ok(result.verified_clear.some(e => e.broker === 'NormalBroker'));
});
```

- [ ] Step 5.2: Run it, expect fail. Command: `node --test test/allowlist-verify-loop.test.js`. Expected failure: the first test fails because, with no allowlist guard, `AllowedBroker` is searched (`findUrl` returns a URL) and lands in `still_listed` - so `searched.includes('AllowedBroker')` is true and the `still_listed` assertion fails.

- [ ] Step 5.3: Implement. In `lib/verify-loop.js` make three edits.

  (a) Add the `isAllowlisted` require. Change line 34 from:

```js
const { stateKey } = require('./config');
```

  to:

```js
const { stateKey } = require('./config');
const { isAllowlisted } = require('./filter');
```

  (b) Destructure `config` from opts. Change line 51 from:

```js
  const { state, findUrl: injectedFindUrl } = opts;
```

  to:

```js
  const { state, findUrl: injectedFindUrl, config = null } = opts;
```

  (c) Add the allowlist guard as the first check inside the broker loop, before Gate 1. The guard is per-broker (not per-person) because the allowlist is broker-scoped; we push a single `skipped` entry per broker and `break` out of the person loop. Change the loop head (lines 69-78) from:

```js
  for (const broker of brokers) {
    for (const person of persons) {
      const key    = stateKey(broker.name, person, persons.length);
      const record = state.optOuts[key];

      // ── Gate 1: must have a recorded lastSuccess ──────────────────────────
      if (!record || !record.lastSuccess) {
        skipped.push({ broker: broker.name, person, reason: 'no recorded opt-out submission' });
        continue;
      }
```

  to:

```js
  for (const broker of brokers) {
    // ── Gate 0: allowlisted brokers are never verified (the user wants to stay
    // listed, so a found listing is not a failure). Recorded once per broker. ─
    if (isAllowlisted(broker.name, config)) {
      skipped.push({ broker: broker.name, reason: 'on allowlist - keeping listing, verification skipped' });
      continue;
    }

    for (const person of persons) {
      const key    = stateKey(broker.name, person, persons.length);
      const record = state.optOuts[key];

      // ── Gate 1: must have a recorded lastSuccess ──────────────────────────
      if (!record || !record.lastSuccess) {
        skipped.push({ broker: broker.name, person, reason: 'no recorded opt-out submission' });
        continue;
      }
```

- [ ] Step 5.4: Run, expect pass. Command: `node --test test/allowlist-verify-loop.test.js`. Expect 2 passing tests.

- [ ] Step 5.5: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add lib/verify-loop.js test/allowlist-verify-loop.test.js
rtk git commit -m "Skip allowlisted brokers in verify-loop

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Pure allowlist-edit helpers (CLI + dashboard share these)

`--allow`/`--unallow` and the dashboard both need to add/remove a broker name from `config.allowlist` immutably and case-insensitively (no duplicates, preserve original casing of the first occurrence). Keep this pure (no disk I/O) so it is hermetically testable; the CLI wraps it with an atomic file write in Task 7.

Files:
- Create: `lib/allowlist-edit.js`
- Test: extend `test/allowlist.test.js` (created in Task 1) with the edit blocks

- [ ] Step 6.1: Write the failing test. Append the following blocks to `test/allowlist.test.js` (after the existing `isAllowlisted` tests). Also add the `require` at the top of that file:

  At the top of `test/allowlist.test.js`, change:

```js
const { isAllowlisted } = require('../lib/filter');
```

  to:

```js
const { isAllowlisted } = require('../lib/filter');
const { addToAllowlist, removeFromAllowlist } = require('../lib/allowlist-edit');
```

  Then append these tests at the end of the file:

```js
test('addToAllowlist: adds a name to an absent allowlist', () => {
  const out = addToAllowlist({ person: {} }, 'Spokeo');
  assert.deepEqual(out.allowlist, ['Spokeo']);
  assert.deepEqual(out.person, {}, 'other config keys are preserved');
});

test('addToAllowlist: does not mutate the input config', () => {
  const input = { allowlist: ['BeenVerified'] };
  const out = addToAllowlist(input, 'Spokeo');
  assert.deepEqual(input.allowlist, ['BeenVerified'], 'input must be untouched');
  assert.deepEqual(out.allowlist, ['BeenVerified', 'Spokeo']);
});

test('addToAllowlist: is idempotent and case-insensitive (no duplicates)', () => {
  const out = addToAllowlist({ allowlist: ['Spokeo'] }, 'spokeo');
  assert.deepEqual(out.allowlist, ['Spokeo'], 'existing entry casing is preserved, no duplicate added');
});

test('addToAllowlist: trims the incoming name', () => {
  const out = addToAllowlist({ allowlist: [] }, '  Radaris  ');
  assert.deepEqual(out.allowlist, ['Radaris']);
});

test('addToAllowlist: throws on empty name', () => {
  assert.throws(() => addToAllowlist({ allowlist: [] }, '   '), /name/i);
});

test('removeFromAllowlist: removes case-insensitively', () => {
  const out = removeFromAllowlist({ allowlist: ['Spokeo', 'BeenVerified'] }, 'spokeo');
  assert.deepEqual(out.allowlist, ['BeenVerified']);
});

test('removeFromAllowlist: no-op when name absent or list missing', () => {
  assert.deepEqual(removeFromAllowlist({ allowlist: ['Spokeo'] }, 'Radaris').allowlist, ['Spokeo']);
  assert.deepEqual(removeFromAllowlist({ person: {} }, 'Radaris').allowlist, []);
});

test('removeFromAllowlist: does not mutate the input config', () => {
  const input = { allowlist: ['Spokeo'] };
  const out = removeFromAllowlist(input, 'Spokeo');
  assert.deepEqual(input.allowlist, ['Spokeo'], 'input must be untouched');
  assert.deepEqual(out.allowlist, []);
});
```

- [ ] Step 6.2: Run it, expect fail. Command: `node --test test/allowlist.test.js`. Expected failure: `Cannot find module '../lib/allowlist-edit'` (the file does not exist yet).

- [ ] Step 6.3: Implement. Create `lib/allowlist-edit.js`:

```js
/**
 * lib/allowlist-edit.js
 *
 * Pure (no disk I/O) immutable edits to a config object's `allowlist` array.
 * Shared by the CLI (--allow / --unallow in watcher.js) and the dashboard.
 *
 * The allowlist is a list of broker names the user wants to STAY listed on.
 * Matching is case-insensitive; the original casing of an existing entry is
 * preserved so the stored config stays readable.
 */

'use strict';

/**
 * Return a new config object with `name` present in `config.allowlist`.
 * Idempotent and case-insensitive (no duplicate is added).
 *
 * @param {object} config  Parsed config object (not mutated).
 * @param {string} name    Broker name to allowlist.
 * @returns {object}       New config with the updated allowlist.
 */
function addToAllowlist(config, name) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) throw new Error('allowlist name must be a non-empty string');
  const existing = Array.isArray(config && config.allowlist) ? config.allowlist : [];
  const already = existing.some(e => String(e).trim().toLowerCase() === trimmed.toLowerCase());
  const allowlist = already ? [...existing] : [...existing, trimmed];
  return { ...(config || {}), allowlist };
}

/**
 * Return a new config object with `name` removed from `config.allowlist`
 * (case-insensitive). No-op when the name is absent or the list is missing.
 *
 * @param {object} config  Parsed config object (not mutated).
 * @param {string} name    Broker name to remove.
 * @returns {object}       New config with the updated allowlist.
 */
function removeFromAllowlist(config, name) {
  const trimmed = String(name == null ? '' : name).trim().toLowerCase();
  const existing = Array.isArray(config && config.allowlist) ? config.allowlist : [];
  const allowlist = existing.filter(e => String(e).trim().toLowerCase() !== trimmed);
  return { ...(config || {}), allowlist };
}

module.exports = { addToAllowlist, removeFromAllowlist };
```

- [ ] Step 6.4: Run, expect pass. Command: `node --test test/allowlist.test.js`. Expect all `isAllowlisted` AND all `addToAllowlist`/`removeFromAllowlist` tests passing.

- [ ] Step 6.5: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add lib/allowlist-edit.js test/allowlist.test.js
rtk git commit -m "Add pure allowlist-edit helpers (add/remove)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: CLI subcommands `--allow <name>` / `--unallow <name>` in watcher.js

These are early-exit subcommands (like `--list`/`--pending`): parse the value, read `config.json`, apply the pure edit, atomically write `config.json`, print the new allowlist, and `process.exit(0)`. They run BEFORE any browser launch. Also wire the active `config` into `brokerRunner.configure(...)` so the run loop's allowlist guard (Task 3) sees it.

Because the file-writing path touches the real `config.json`, it is NOT unit-tested here (hermeticity rule); the atomic-write logic is the same `tmp -> rename` strategy already used by `lib/config.js` `saveState`. The pure edit it wraps is fully covered by Task 6. We add a focused test that the parsing/wiring helper picks the value argument correctly.

Files:
- Modify: `watcher.js` (flag parsing block after line 44; new early-exit block after the `--pending` block ~line 92; `brokerRunner.configure` calls at lines 197 and 371)
- Test: `test/allowlist-cli-args.test.js` (Create)

- [ ] Step 7.1: Write the failing test. Create `test/allowlist-cli-args.test.js`. It tests a small pure exported helper `parseAllowlistArgs(argv)` that watcher.js will use, so the argv parsing is covered without spawning a process or touching disk:

```js
/**
 * test/allowlist-cli-args.test.js
 *
 * Covers the pure argv parsing for the --allow / --unallow subcommands.
 * The disk-writing wrapper in watcher.js is intentionally not unit-tested
 * (it touches the real config.json); the pure edit it calls is covered by
 * test/allowlist.test.js, and the atomic write mirrors lib/config.js saveState.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseAllowlistArgs } = require('../lib/allowlist-edit');

test('parseAllowlistArgs: detects --allow with its value', () => {
  const r = parseAllowlistArgs(['node', 'watcher.js', '--allow', 'Spokeo']);
  assert.deepEqual(r, { action: 'allow', name: 'Spokeo' });
});

test('parseAllowlistArgs: detects --unallow with its value', () => {
  const r = parseAllowlistArgs(['node', 'watcher.js', '--unallow', 'BeenVerified']);
  assert.deepEqual(r, { action: 'unallow', name: 'BeenVerified' });
});

test('parseAllowlistArgs: returns null when neither flag present', () => {
  assert.equal(parseAllowlistArgs(['node', 'watcher.js', '--list']), null);
});

test('parseAllowlistArgs: returns an error marker when value missing', () => {
  assert.deepEqual(
    parseAllowlistArgs(['node', 'watcher.js', '--allow']),
    { action: 'allow', name: null, error: 'missing broker name' }
  );
});

test('parseAllowlistArgs: rejects a flag-looking value (e.g. --allow --serp-scan)', () => {
  assert.deepEqual(
    parseAllowlistArgs(['node', 'watcher.js', '--allow', '--serp-scan']),
    { action: 'allow', name: null, error: 'missing broker name' }
  );
});
```

- [ ] Step 7.2: Run it, expect fail. Command: `node --test test/allowlist-cli-args.test.js`. Expected failure: `parseAllowlistArgs is not a function` (not yet exported from `lib/allowlist-edit`).

- [ ] Step 7.3: Implement. Two parts.

  (a) Add `parseAllowlistArgs` to `lib/allowlist-edit.js`. Insert this function before the `module.exports` line:

```js
/**
 * Parse --allow <name> / --unallow <name> out of an argv array.
 *
 * Returns:
 *   null                                     when neither flag is present
 *   { action, name }                         when a valid value follows the flag
 *   { action, name: null, error }            when the value is missing or looks
 *                                            like a flag (starts with "-")
 *
 * @param {string[]} argv  Typically process.argv.
 * @returns {{action:'allow'|'unallow', name:string|null, error?:string}|null}
 */
function parseAllowlistArgs(argv) {
  const find = (flag, action) => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return null;
    const value = argv[idx + 1];
    if (!value || value.startsWith('-')) return { action, name: null, error: 'missing broker name' };
    return { action, name: value };
  };
  return find('--allow', 'allow') || find('--unallow', 'unallow');
}
```

  And extend the export from:

```js
module.exports = { addToAllowlist, removeFromAllowlist };
```

  to:

```js
module.exports = { addToAllowlist, removeFromAllowlist, parseAllowlistArgs };
```

  (b) Wire the subcommands into `watcher.js`. First add the require near the other lib requires (after line 21, the `applyFilter` require):

```js
const { applyFilter, loadLastLog, extractFailedBrokers } = require('./lib/filter');
```

  Change that line to also pull in `isAllowlisted` is not needed here; instead add a new require line right after it:

```js
const { addToAllowlist, removeFromAllowlist, parseAllowlistArgs } = require('./lib/allowlist-edit');
```

  Then insert this early-exit block immediately AFTER the `--pending` block closes (after the `process.exit(0);` and `}` that end the `if (PENDING_MODE)` block, currently around line 92) and BEFORE the `if (CONFIRM_EMAILS)` block:

```js
// ── --allow / --unallow <name>: edit config.json allowlist, then exit ────────
const _allowlistCmd = parseAllowlistArgs(process.argv);
if (_allowlistCmd) {
  const { CONFIG_PATH } = require('./lib/config');
  if (_allowlistCmd.error || !_allowlistCmd.name) {
    console.error(`❌ ${_allowlistCmd.action === 'unallow' ? '--unallow' : '--allow'} requires a broker name, e.g. --${_allowlistCmd.action} Spokeo`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`❌ could not read config.json: ${err.message}`);
    process.exit(1);
  }
  const next = _allowlistCmd.action === 'allow'
    ? addToAllowlist(cfg, _allowlistCmd.name)
    : removeFromAllowlist(cfg, _allowlistCmd.name);
  // Atomic write: tmp -> rename (mirrors lib/config.js saveState semantics).
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  const verb = _allowlistCmd.action === 'allow' ? 'Added to' : 'Removed from';
  console.log(`\n📌 ${verb} allowlist: ${_allowlistCmd.name}`);
  console.log(`   Allowlist now: ${(next.allowlist || []).join(', ') || '(empty)'}\n`);
  process.exit(0);
}

```

  Finally, pass `config` into both `brokerRunner.configure(...)` calls so the run-loop guard (Task 3) sees the allowlist. Change line 197 from:

```js
brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: persons[0], capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length });
```

  to:

```js
brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person: persons[0], capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, config });
```

  And change the in-loop call at line 371 from:

```js
    brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length });
```

  to:

```js
    brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, config });
```

  (d) Wire `config` into the `--verify` call so the verify-loop allowlist guard (Task 5) actually fires in production. WITHOUT this edit the Task 5 guard is dead code in real runs - allowlisted brokers would still be re-searched and flagged `still_listed`, breaking the feature goal "verification never flags them as still-listed". `config` is the module-level constant defined at `watcher.js` line 191 and is in scope inside `main()`. Change line 289 from:

```js
    const result = await runVerify(context, brokers, persons, { state });
```

  to:

```js
    const result = await runVerify(context, brokers, persons, { state, config });
```

  Note: the `--allow`/`--unallow` block is placed before the `if (CONFIRM_EMAILS) { ... } else { ... }` ladder, so it short-circuits cleanly with `process.exit(0)` and never reaches the browser-launch path. `fs` is already required at the top of `watcher.js` (line 11), so no new require for it is needed.

- [ ] Step 7.4: Run, expect pass. Command: `node --test test/allowlist-cli-args.test.js`. Expect 5 passing tests. Then sanity-check the wiring loads without syntax errors: `node -e "require('/Users/stephen/scripts/auto-identity-remove/lib/allowlist-edit')"` (should exit 0, print nothing).

- [ ] Step 7.5: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add watcher.js lib/allowlist-edit.js test/allowlist-cli-args.test.js
rtk git commit -m "Add --allow/--unallow CLI subcommands and wire config into broker-runner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Surface the allowlist in the dashboard config UI

The config form (`dashboard/public/index.html`) and its loader/saver (`dashboard/public/app.js`) treat `allowlist` exactly like `person.aliases`: a comma-separated text input that maps to a string array. The server's `mergeConfig` already handles arrays (it replaces them wholesale: `if (Array.isArray(incoming)) return incoming;`), and the field is non-secret so `maskConfig` leaves it untouched. No server-side change is required.

Files:
- Modify: `dashboard/public/index.html` (config form, after the Person fieldset, before the CapSolver fieldset, around line 86)
- Modify: `dashboard/public/app.js` (`loadConfig` lines 310-321; save handler lines 322-336)
- Test: `dashboard/validate.test.js` is not the right home (no DOM); the behavior is exercised by the manual smoke step below and the array round-trip is already covered by the existing `dashboard/server.test.js` `mergeConfig` coverage. No new automated test is added for the static HTML/JS (consistent with the repo, which has no DOM test harness).

- [ ] Step 8.1: Implement the HTML field. In `dashboard/public/index.html`, insert a new fieldset immediately after the closing `</fieldset>` of the Person block (line 86) and before the CapSolver `<fieldset>` (line 87). Change:

```html
          <label>Phone formatted <input name="person.phoneFormatted" /></label>
        </fieldset>
        <fieldset><legend>CapSolver (CAPTCHA solving)</legend>
```

  to:

```html
          <label>Phone formatted <input name="person.phoneFormatted" /></label>
        </fieldset>
        <fieldset><legend>Allowlist (keep me listed here)</legend>
          <label>Brokers to keep listed (comma) <input name="allowlist" placeholder="e.g. Spokeo, BeenVerified" /></label>
          <p class="dim">Brokers on this list are never opted out and are not flagged by verification. Case-insensitive; match the broker name from the Brokers tab.</p>
        </fieldset>
        <fieldset><legend>CapSolver (CAPTCHA solving)</legend>
```

- [ ] Step 8.2: Implement the loader. In `dashboard/public/app.js` `loadConfig` (lines 316-320), the field-fill loop currently special-cases only `person.aliases`. Change:

```js
  $$('#configForm input').forEach(inp => {
    let v = getPath(c, inp.name);
    if (inp.name === 'person.aliases' && Array.isArray(v)) v = v.join(', ');
    inp.value = v == null ? '' : v;
  });
```

  to (also join the top-level `allowlist` array):

```js
  $$('#configForm input').forEach(inp => {
    let v = getPath(c, inp.name);
    if ((inp.name === 'person.aliases' || inp.name === 'allowlist') && Array.isArray(v)) v = v.join(', ');
    inp.value = v == null ? '' : v;
  });
```

- [ ] Step 8.3: Implement the saver. In the `#saveConfig` click handler (lines 324-332), the value-coercion currently special-cases only `person.aliases` and `email.smtp.port`. Change:

```js
  $$('#configForm input').forEach(inp => {
    let v = inp.value;
    // Fix 5: skip only the mask sentinel (untouched secret fields - preserve on server).
    // All other values including empty string are sent so users can clear non-secret fields.
    if (v === MASK) return;
    if (inp.name === 'person.aliases') v = v.split(',').map(s => s.trim()).filter(Boolean);
    if (inp.name === 'email.smtp.port') v = parseInt(v, 10) || v;
    setPath(cfg, inp.name, v);
  });
```

  to (split `allowlist` into a trimmed, non-empty array too):

```js
  $$('#configForm input').forEach(inp => {
    let v = inp.value;
    // Fix 5: skip only the mask sentinel (untouched secret fields - preserve on server).
    // All other values including empty string are sent so users can clear non-secret fields.
    if (v === MASK) return;
    if (inp.name === 'person.aliases' || inp.name === 'allowlist') v = v.split(',').map(s => s.trim()).filter(Boolean);
    if (inp.name === 'email.smtp.port') v = parseInt(v, 10) || v;
    setPath(cfg, inp.name, v);
  });
```

  `setPath` with name `allowlist` (no dot) sets the top-level `cfg.allowlist`, which `mergeConfig` then writes wholesale - exactly what we want.

- [ ] Step 8.4: Verify the dashboard still loads and tests pass. Run the dashboard test suite (its own `node --test`), which loads `server.js` and exercises `mergeConfig` round-trips:
```bash
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```
  Expect green (no regressions). The HTML/JS edits are static assets not loaded by these tests; confirm no syntax error by loading app.js through node's parser:
```bash
node --check /Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js
```
  Expect exit 0 (no output).

- [ ] Step 8.5: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add dashboard/public/index.html dashboard/public/app.js
rtk git commit -m "Surface broker allowlist in dashboard config UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Document the allowlist key in config.example.json

So new users discover the feature, add an empty `allowlist` to `config.example.json`. (The live `config.json` is gitignored; do NOT edit it as part of the committed change.)

Files:
- Modify: `config.example.json` (add a top-level `"allowlist": []` key)

- [ ] Step 9.1: Read the current example to find a safe insertion point.
```bash
rtk read /Users/stephen/scripts/auto-identity-remove/config.example.json
```

- [ ] Step 9.2: Implement. Add a top-level `"allowlist": []` member to `config.example.json`. Insert it as the first key inside the top-level object (immediately after the opening `{`), with a trailing comma, so it reads:

```json
{
  "allowlist": [],
```

  (Keep the rest of the file unchanged. `allowlist` is a sibling of `person`, `persons`, `capsolver`, etc. - a top-level array of broker names.) If JSON formatting is uncertain after the edit, validate it:
```bash
node -e "JSON.parse(require('fs').readFileSync('/Users/stephen/scripts/auto-identity-remove/config.example.json','utf8')); console.log('valid')"
```
  Expect `valid`.

- [ ] Step 9.3: Commit.
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add config.example.json
rtk git commit -m "Document allowlist key in config.example.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Full suite green

Run the complete root suite and the dashboard suite exactly as CI does (`.github/workflows/test.yml`), confirming no regressions across all 56+ test files plus the new ones.

Files: none modified (verification only).

- [ ] Step 10.1: Run the root suite (matches `package.json` `test` script and CI job `test`):
```bash
cd /Users/stephen/scripts/auto-identity-remove && node --test test/*.test.js dashboard/validate.test.js
```
  Expect: all tests pass (look for `# fail 0`). The new files (`test/allowlist.test.js`, `test/allowlist-logger.test.js`, `test/allowlist-broker-runner.test.js`, `test/allowlist-generic-runner.test.js`, `test/allowlist-verify-loop.test.js`, `test/allowlist-cli-args.test.js`) are picked up by the `test/*.test.js` glob.

- [ ] Step 10.2: Run the dashboard suite (matches CI job `dashboard`):
```bash
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```
  Expect: all tests pass (`# fail 0`).

- [ ] Step 10.3: If anything fails, fix the smallest cause and re-run BOTH commands above before proceeding. Do not claim completion until both report zero failures (evidence-before-assertions).

- [ ] Step 10.4: Final commit (only if Step 10.3 required a fix; otherwise skip). Example:
```bash
cd /Users/stephen/scripts/auto-identity-remove
rtk git add -A
rtk git commit -m "Fix allowlist test regressions surfaced by full suite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage (all required behaviors from the feature brief):
- `config.json` gains `allowlist: string[]` (case-insensitive): documented in `config.example.json` (Task 9); read everywhere via `isAllowlisted` (Task 1), which lower-cases and trims both sides.
- `lib/filter.js` gains `isAllowlisted(name, config)`: Task 1, exported alongside the real existing exports `parseList, applyFilter, loadLastLog, extractFailedBrokers`.
- Run loops skip allowlisted brokers with a distinct `allowlisted` status: `lib/broker-runner.js` `processBrokerWithPerson` (Task 3) and `generic-runner.js` `processGenericUrl` (Task 4).
- `lib/logger.js` `STATUS_BUCKET` learns `allowlisted` (routed to `skipped`) plus an `ICONS` entry: Task 2.
- `verify-loop.js` skips allowlisted brokers, never counting them `still_listed`: Task 5 (per-broker Gate 0).
- `--allow <name>` / `--unallow <name>` CLI subcommands edit `config.json` atomically: Task 7 (early-exit block, tmp->rename mirroring `lib/config.js` `saveState`).
- Dashboard config UI surfaces the allowlist: Task 8 (HTML field + app.js load/save, reusing the existing array-field pattern).

No placeholders: every code step contains complete, runnable code - full function bodies for `isAllowlisted`, `addToAllowlist`, `removeFromAllowlist`, `parseAllowlistArgs`, the broker-runner/generic-runner/verify-loop guards, the watcher.js subcommand block, and exact before/after edits for `lib/logger.js`, `dashboard/public/index.html`, and `dashboard/public/app.js`. No TBD, no "similar to above", no "add error handling".

Signature / export consistency with the verified repo map:
- `lib/filter.js` final export object extended (real current export: `{ parseList, applyFilter, loadLastLog, extractFailedBrokers }`).
- `lib/broker-runner.js` `configure(o)` merges into module-level `opts` (real) - adding a `config` key is consistent with the existing `{ dryRun, person, capsolver, noCapsolver, snapshot, personCount }` shape; `processBrokerWithPerson(context, broker, person)` signature unchanged.
- `generic-runner.js` `processGenericUrl(page, broker, state, dryRun, injectedDeadSet)` and `classifyOutcome(status, detail)` signatures unchanged; `runGenericBrokers(context, explicitBrokerHosts, state, logResult, recordSuccess, opts)` unchanged; the dynamically-keyed `stats[bucket]` accumulator absorbs the new `allowlisted` bucket without a shape change to the returned `genericStats`.
- `lib/verify-loop.js` `runVerify(context, brokers, persons, opts)` unchanged externally; `opts.config` defaults to `null` so older callers stay safe (no config = no allowlist = current behavior). Task 7 step 7.3(d) updates the real `--verify` call site (`watcher.js` line 289) to pass `{ state, config }` - this wiring is REQUIRED, not optional: without it the Task 5 guard never fires in production and allowlisted brokers would still be flagged `still_listed`, breaking the feature goal.
- `lib/logger.js` `STATUS_BUCKET` / `ICONS` are plain maps; the new `allowlisted` key is additive and unknown-status fallback to `'errors'` is now unnecessary for this status.
- `lib/config.js` is untouched; the CLI write reuses its exported `CONFIG_PATH` constant and replicates its tmp->rename atomic strategy.

Hermeticity: every new test stubs Playwright pages/contexts and injects deps. `isAllowlisted`, the edit helpers, and `parseAllowlistArgs` are pure. The broker-runner and generic-runner tests use `Module._load` interception scoped by `parent.filename.includes(...)` and bust `require.cache` before re-requiring, restoring `Module._load` immediately after - matching `test/broker-runner-buckets.test.js`. No test reads or writes the real `config.json`/`state.json`; the only disk write to `config.json` is the runtime CLI path (Task 7), which is deliberately not unit-tested per the hermeticity rule, with its pure core covered by Task 6.

Conventions: CommonJS throughout (`require`/`module.exports`); no TypeScript; no em dashes in authored prose (hyphens only); RTK prefix on all bash read/git commands; new-dependency count is zero (Node built-ins `fs` and global `JSON` only).
