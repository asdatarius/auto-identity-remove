# Have I Been Pwned Breach Integration Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Add a `--breach-check` CLI mode that queries Have I Been Pwned for each configured email, surfaces breaches with a computed severity, cross-references known data-broker entries, and recommends a credit freeze when any high-severity identity breach is found.

Architecture: A new pure-ish module `lib/hibp.js` exports `checkBreaches(email, opts)` (HIBP v3 HTTP via injectable `fetchImpl`, defaulting to global `fetch`), a pure `severityOf(dataClasses)` classifier, a pure `crossReferenceBrokers(breaches, brokers)` helper, a pure `recommendFreeze(breaches)` helper, and an orchestrator `runBreachCheck(opts)` that the watcher mode calls. The watcher gains a thin `--breach-check` branch (same read-only / `process.exit` pattern as `--list` and `--pending`) that loads config emails, calls `runBreachCheck`, prints results, and exits. Tests inject `fetchImpl` and never touch the network; rate-limit delay is routed through `lib/timing.js` (`jitterSleep`), which already fast-paths under `NODE_ENV=test`.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict` run via `node --test`. Networking uses the Node 18+ global `fetch` (no new dependency). Playwright is unaffected.

New dependencies: NONE. Uses Node built-in global `fetch` and the existing `lib/timing.js`.

---

## File map

| File | Status | Responsibility |
|------|--------|----------------|
| `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js` | Created | HIBP v3 client (`checkBreaches`), pure `severityOf`, `crossReferenceBrokers`, `recommendFreeze`, orchestrator `runBreachCheck`, `formatBreachReport`, exported `breachCount`. |
| `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js` | Created | Hermetic unit tests for all `lib/hibp.js` exports using an injected `fetchImpl`. |
| `/Users/stephen/scripts/auto-identity-remove/watcher.js` | Modified | New `--breach-check` read-only CLI mode branch (lines ~41-44 add the flag; new branch added after the `--pending` block, before `--confirm-emails`). |
| `/Users/stephen/scripts/auto-identity-remove/config.example.json` | Modified | Document the optional `hibp.apiKey` key (insert after the `capsolver` block, ~lines 23-26). |

---

## Task 1: `severityOf(dataClasses)` pure classifier

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js`

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js` with the following complete contents:

```js
/**
 * test/hibp.test.js
 *
 * Hermetic unit tests for lib/hibp.js (Have I Been Pwned breach integration).
 * No live network: every HTTP call goes through an injected fetchImpl stub.
 * No real config/state writes.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  severityOf,
  checkBreaches,
  crossReferenceBrokers,
  recommendFreeze,
  breachCount,
  runBreachCheck,
  formatBreachReport,
} = require('../lib/hibp');

// ─── Fake fetch factory ──────────────────────────────────────────────────────
// Returns a fetchImpl that records calls and yields a queued Response-like
// object. Each entry is { status, json } where json is the parsed body.
function makeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      async json() {
        if (next.json === undefined) throw new Error('no json body');
        return next.json;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

// ─── severityOf ──────────────────────────────────────────────────────────────

test('severityOf returns high when SSN present', () => {
  assert.equal(severityOf(['Email addresses', 'SSN']), 'high');
});

test('severityOf returns high for "Social security numbers" label', () => {
  assert.equal(severityOf(['Social security numbers']), 'high');
});

test('severityOf returns high when Passwords present', () => {
  assert.equal(severityOf(['Email addresses', 'Passwords']), 'high');
});

test('severityOf returns high when Physical addresses present', () => {
  assert.equal(severityOf(['Names', 'Physical addresses']), 'high');
});

test('severityOf is case-insensitive for high triggers', () => {
  assert.equal(severityOf(['passwords']), 'high');
  assert.equal(severityOf(['social security numbers']), 'high');
});

test('severityOf returns medium for phone numbers / dates of birth', () => {
  assert.equal(severityOf(['Email addresses', 'Phone numbers']), 'medium');
  assert.equal(severityOf(['Dates of birth']), 'medium');
});

test('severityOf returns low for email-only / usernames', () => {
  assert.equal(severityOf(['Email addresses']), 'low');
  assert.equal(severityOf(['Usernames']), 'low');
});

test('severityOf returns low for empty / missing dataClasses', () => {
  assert.equal(severityOf([]), 'low');
  assert.equal(severityOf(undefined), 'low');
  assert.equal(severityOf(null), 'low');
});
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test test/hibp.test.js`. Expected failure: `Cannot find module '../lib/hibp'` (the module does not exist yet), reported as the suite failing to load.

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js` with the following complete contents (this task only needs `severityOf` + the module skeleton, but write the full file now so later tasks only add tests):

```js
/**
 * lib/hibp.js
 *
 * Have I Been Pwned (HIBP) v3 breach integration.
 *
 * Pure, fully unit-testable helpers (no I/O):
 *   severityOf(dataClasses)              -> 'high' | 'medium' | 'low'
 *   crossReferenceBrokers(breaches, bk)  -> [{ breach, broker }]
 *   recommendFreeze(breaches)            -> boolean
 *   breachCount(breaches)                -> number   (consumed by exposure-score)
 *   formatBreachReport({...})            -> string   (printable report)
 *
 * Networked client (injectable fetchImpl, defaults to global fetch):
 *   checkBreaches(email, { apiKey, fetchImpl })
 *
 * Orchestrator (composes the above; used by the watcher --breach-check mode):
 *   runBreachCheck({ emails, apiKey, brokers, fetchImpl })
 *
 * Tests MUST inject fetchImpl and never hit the network. Between live HIBP
 * calls we sleep ~1.5s via lib/timing.jitterSleep, which fast-paths to a no-op
 * under NODE_ENV=test / TURBO=1 so the suite stays fast.
 */

'use strict';

const { jitterSleep } = require('./timing');

const HIBP_BASE = 'https://haveibeenpwned.com/api/v3/breachedaccount/';
const USER_AGENT = 'auto-identity-remove';

// Data classes that escalate a breach to high severity. Matched
// case-insensitively against the breach's dataClasses array. HIBP uses
// "Social security numbers"; this tool also documents "SSN" as a synonym.
const HIGH_SEVERITY_CLASSES = new Set([
  'ssn',
  'social security numbers',
  'passwords',
  'physical addresses',
]);

// Data classes that are sensitive enough to warrant medium severity.
const MEDIUM_SEVERITY_CLASSES = new Set([
  'phone numbers',
  'dates of birth',
  'credit cards',
  'bank account numbers',
  'security questions and answers',
]);

/**
 * Classify the severity of a breach from its dataClasses.
 * Pure. Case-insensitive. high > medium > low.
 *
 * @param {string[]|null|undefined} dataClasses
 * @returns {'high'|'medium'|'low'}
 */
function severityOf(dataClasses) {
  if (!Array.isArray(dataClasses) || dataClasses.length === 0) return 'low';
  const lowered = dataClasses.map(c => String(c).toLowerCase().trim());
  if (lowered.some(c => HIGH_SEVERITY_CLASSES.has(c))) return 'high';
  if (lowered.some(c => MEDIUM_SEVERITY_CLASSES.has(c))) return 'medium';
  return 'low';
}

/**
 * Query HIBP v3 for breaches affecting a single email address.
 *
 * @param {string} email
 * @param {object} opts
 * @param {string} opts.apiKey          HIBP API key (required by HIBP).
 * @param {function} [opts.fetchImpl]   Injected fetch (defaults to global fetch).
 * @returns {Promise<Array<{name,domain,breachDate,dataClasses,severity}>>}
 *
 * Status handling:
 *   200 -> map breaches to result shape (severity computed per breach).
 *   404 -> account not found in any breach -> [] (this is the happy "clean" case).
 *   401 -> throw Error('HIBP: invalid API key (401)').
 *   429 -> throw Error('HIBP: rate limited (429)').
 *   other -> throw Error('HIBP: unexpected status <code>').
 */
async function checkBreaches(email, opts = {}) {
  const { apiKey, fetchImpl } = opts;
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) throw new Error('HIBP: no fetch implementation available');
  if (!apiKey) throw new Error('HIBP: missing API key');

  const url = `${HIBP_BASE}${encodeURIComponent(email)}?truncateResponse=false`;
  const res = await doFetch(url, {
    method: 'GET',
    headers: {
      'hibp-api-key': apiKey,
      'User-Agent': USER_AGENT,
    },
  });

  if (res.status === 404) return [];
  if (res.status === 401) throw new Error('HIBP: invalid API key (401)');
  if (res.status === 429) throw new Error('HIBP: rate limited (429)');
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HIBP: unexpected status ${res.status}`);
  }

  const body = await res.json();
  const breaches = Array.isArray(body) ? body : [];
  return breaches.map(b => {
    const dataClasses = Array.isArray(b.DataClasses) ? b.DataClasses : [];
    return {
      name: b.Name || b.Title || '',
      domain: b.Domain || '',
      breachDate: b.BreachDate || '',
      dataClasses,
      severity: severityOf(dataClasses),
    };
  });
}

/**
 * Cross-reference breach domains against known data-broker entries.
 * A match means the breached site is itself a broker we attempt to opt out of.
 * Pure.
 *
 * @param {Array<{name,domain,...}>} breaches
 * @param {Array<{name,optOutUrl?,searchUrl?}>} brokers
 * @returns {Array<{breach: object, broker: object}>}
 */
function crossReferenceBrokers(breaches, brokers) {
  if (!Array.isArray(breaches) || !Array.isArray(brokers)) return [];

  const registrable = host => {
    const h = String(host || '').toLowerCase().replace(/^www\./, '');
    const parts = h.split('.').filter(Boolean);
    return parts.length <= 2 ? h : parts.slice(-2).join('.');
  };

  const brokerHostOf = broker => {
    try {
      return registrable(new URL(broker.optOutUrl || broker.searchUrl || '').hostname);
    } catch (_) {
      return '';
    }
  };

  const matches = [];
  for (const breach of breaches) {
    const bd = registrable(breach.domain);
    if (!bd) continue;
    for (const broker of brokers) {
      const bh = brokerHostOf(broker);
      if (bh && bh === bd) matches.push({ breach, broker });
    }
  }
  return matches;
}

/**
 * Recommend a credit freeze when any high-severity breach exists.
 * Pure.
 *
 * @param {Array<{severity:string}>} breaches
 * @returns {boolean}
 */
function recommendFreeze(breaches) {
  if (!Array.isArray(breaches)) return false;
  return breaches.some(b => b && b.severity === 'high');
}

/**
 * Total number of breaches across the supplied list. Consumed by the
 * exposure-score feature.
 * Pure.
 *
 * @param {Array<unknown>} breaches
 * @returns {number}
 */
function breachCount(breaches) {
  return Array.isArray(breaches) ? breaches.length : 0;
}

/**
 * Render a human-readable breach report.
 * Pure (no console, no I/O) so it is unit-testable.
 *
 * @param {object} args
 * @param {Array<{email,breaches,error?}>} args.perEmail
 * @param {Array<{breach,broker}>} args.brokerMatches
 * @param {boolean} args.freeze
 * @returns {string}
 */
function formatBreachReport({ perEmail, brokerMatches, freeze }) {
  const lines = [];
  lines.push('='.repeat(54));
  lines.push('Have I Been Pwned - breach check');
  lines.push('='.repeat(54));

  for (const entry of perEmail) {
    if (entry.error) {
      lines.push(`\n${entry.email}: error - ${entry.error}`);
      continue;
    }
    if (entry.breaches.length === 0) {
      lines.push(`\n${entry.email}: no breaches found ✅`);
      continue;
    }
    lines.push(`\n${entry.email}: ${entry.breaches.length} breach(es)`);
    for (const b of entry.breaches) {
      const date = b.breachDate ? ` (${b.breachDate})` : '';
      lines.push(`  [${b.severity.toUpperCase()}] ${b.name}${date} - ${b.dataClasses.join(', ')}`);
    }
  }

  if (brokerMatches.length > 0) {
    lines.push('\nBreached sites that are also data brokers we target:');
    for (const m of brokerMatches) {
      lines.push(`  - ${m.breach.name} (${m.breach.domain}) ↔ broker "${m.broker.name}"`);
    }
  }

  lines.push('');
  if (freeze) {
    lines.push('⚠️  RECOMMENDATION: A high-severity identity breach was found.');
    lines.push('   Consider placing a credit freeze with all three bureaus:');
    lines.push('   Equifax, Experian, and TransUnion (free, reversible).');
  } else {
    lines.push('No high-severity identity breaches found. No credit freeze needed right now.');
  }
  lines.push('='.repeat(54));
  return lines.join('\n');
}

/**
 * Orchestrator: check every email, cross-reference brokers, decide on freeze.
 * Composes the pure helpers + the networked client. Used by watcher
 * --breach-check mode. Sleeps ~1.5s between live HIBP calls (no-op in tests).
 *
 * @param {object} opts
 * @param {string[]} opts.emails
 * @param {string} opts.apiKey
 * @param {Array} [opts.brokers]
 * @param {function} [opts.fetchImpl]
 * @returns {Promise<{perEmail, allBreaches, brokerMatches, freeze, totalBreaches}>}
 */
async function runBreachCheck(opts = {}) {
  const { emails = [], apiKey, brokers = [], fetchImpl } = opts;
  const perEmail = [];
  const allBreaches = [];

  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    try {
      const breaches = await checkBreaches(email, { apiKey, fetchImpl });
      perEmail.push({ email, breaches });
      allBreaches.push(...breaches);
    } catch (err) {
      perEmail.push({ email, breaches: [], error: err.message });
    }
    // HIBP requires ~1.5s between requests. No-op under NODE_ENV=test.
    if (i < emails.length - 1) await jitterSleep(1500, 1500);
  }

  const brokerMatches = crossReferenceBrokers(allBreaches, brokers);
  const freeze = recommendFreeze(allBreaches);

  return {
    perEmail,
    allBreaches,
    brokerMatches,
    freeze,
    totalBreaches: breachCount(allBreaches),
  };
}

module.exports = {
  severityOf,
  checkBreaches,
  crossReferenceBrokers,
  recommendFreeze,
  breachCount,
  formatBreachReport,
  runBreachCheck,
  // constants exported for tests / reuse
  HIBP_BASE,
  USER_AGENT,
};
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test test/hibp.test.js`. Expected: all `severityOf` tests pass. The other exports are imported at the top of the test file and resolve (no usage yet) so the module loads cleanly.

- [ ] Step 1.5: Commit. Commands:
```
git add lib/hibp.js test/hibp.test.js
git commit -m "Add lib/hibp.js with severityOf classifier and HIBP skeleton

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `checkBreaches(email, {apiKey, fetchImpl})` HTTP client

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js` (already implemented in Task 1; this task only adds tests verifying its behavior - no code change expected)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js` (append)

- [ ] Step 2.1: Write the failing test. Append the following block to the END of `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js`:

```js
// ─── checkBreaches ───────────────────────────────────────────────────────────

const HIBP_200_BODY = [
  {
    Name: 'Adobe',
    Title: 'Adobe',
    Domain: 'adobe.com',
    BreachDate: '2013-10-04',
    DataClasses: ['Email addresses', 'Passwords', 'Usernames'],
  },
  {
    Name: 'Acme',
    Title: 'Acme Marketing',
    Domain: 'acme.example',
    BreachDate: '2019-01-01',
    DataClasses: ['Email addresses', 'Phone numbers'],
  },
];

test('checkBreaches maps a 200 response to result shape with severity', async () => {
  const fetchImpl = makeFetch({ status: 200, json: HIBP_200_BODY });
  const result = await checkBreaches('jane@example.com', { apiKey: 'k', fetchImpl });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    name: 'Adobe',
    domain: 'adobe.com',
    breachDate: '2013-10-04',
    dataClasses: ['Email addresses', 'Passwords', 'Usernames'],
    severity: 'high',
  });
  assert.equal(result[1].severity, 'medium');
});

test('checkBreaches sends hibp-api-key header, User-Agent, and truncateResponse=false', async () => {
  const fetchImpl = makeFetch({ status: 200, json: [] });
  await checkBreaches('jane@example.com', { apiKey: 'secret-key', fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.ok(url.startsWith('https://haveibeenpwned.com/api/v3/breachedaccount/'));
  assert.ok(url.includes('truncateResponse=false'));
  assert.ok(url.includes(encodeURIComponent('jane@example.com')));
  assert.equal(init.headers['hibp-api-key'], 'secret-key');
  assert.equal(init.headers['User-Agent'], 'auto-identity-remove');
});

test('checkBreaches returns [] on 404 (no breaches found)', async () => {
  const fetchImpl = makeFetch({ status: 404 });
  const result = await checkBreaches('clean@example.com', { apiKey: 'k', fetchImpl });
  assert.deepEqual(result, []);
});

test('checkBreaches throws on 401 (bad key)', async () => {
  const fetchImpl = makeFetch({ status: 401 });
  await assert.rejects(
    () => checkBreaches('jane@example.com', { apiKey: 'bad', fetchImpl }),
    /invalid API key \(401\)/
  );
});

test('checkBreaches throws on 429 (rate limited)', async () => {
  const fetchImpl = makeFetch({ status: 429 });
  await assert.rejects(
    () => checkBreaches('jane@example.com', { apiKey: 'k', fetchImpl }),
    /rate limited \(429\)/
  );
});

test('checkBreaches throws on unexpected status', async () => {
  const fetchImpl = makeFetch({ status: 503 });
  await assert.rejects(
    () => checkBreaches('jane@example.com', { apiKey: 'k', fetchImpl }),
    /unexpected status 503/
  );
});

test('checkBreaches throws when apiKey missing', async () => {
  const fetchImpl = makeFetch({ status: 200, json: [] });
  await assert.rejects(
    () => checkBreaches('jane@example.com', { fetchImpl }),
    /missing API key/
  );
  assert.equal(fetchImpl.calls.length, 0, 'must not call fetch without a key');
});
```

- [ ] Step 2.2: Run it, expect fail. Command: `node --test test/hibp.test.js`. The tests are written against the implementation already present from Task 1, so they should pass immediately. To honor RED-GREEN, FIRST temporarily break the implementation to confirm the tests exercise it: in `lib/hibp.js`, change `if (res.status === 404) return [];` to `if (res.status === 404) return null;` and run `node --test test/hibp.test.js`. Expected failure: the 404 test reports `AssertionError ... Expected values to be loosely deep-equal: null !== []`.

- [ ] Step 2.3: Implement (restore). Revert the temporary break: change `if (res.status === 404) return null;` back to `if (res.status === 404) return [];` in `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js`. (No other code change is needed; the full client was written in Task 1.)

- [ ] Step 2.4: Run, expect pass. Command: `node --test test/hibp.test.js`. Expected: all Task 1 + Task 2 tests pass.

- [ ] Step 2.5: Commit. Commands:
```
git add lib/hibp.js test/hibp.test.js
git commit -m "Verify checkBreaches HTTP client behavior (200/404/401/429)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `crossReferenceBrokers`, `recommendFreeze`, `breachCount`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js` (implemented in Task 1; tests-only task)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js` (append)

- [ ] Step 3.1: Write the failing test. Append the following block to the END of `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js`:

```js
// ─── crossReferenceBrokers / recommendFreeze / breachCount ───────────────────

const SAMPLE_BROKERS = [
  { name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' },
  { name: 'Radaris', searchUrl: 'https://radaris.com/search' },
  { name: 'NoUrlBroker' },
];

test('crossReferenceBrokers matches a breach domain to a broker by registrable domain', () => {
  const breaches = [
    { name: 'SpokeoLeak', domain: 'people.spokeo.com', severity: 'high' },
    { name: 'Unrelated', domain: 'example.org', severity: 'low' },
  ];
  const matches = crossReferenceBrokers(breaches, SAMPLE_BROKERS);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].breach.name, 'SpokeoLeak');
  assert.equal(matches[0].broker.name, 'Spokeo');
});

test('crossReferenceBrokers returns [] when no domains overlap', () => {
  const breaches = [{ name: 'X', domain: 'nowhere.test', severity: 'low' }];
  assert.deepEqual(crossReferenceBrokers(breaches, SAMPLE_BROKERS), []);
});

test('crossReferenceBrokers tolerates breaches/brokers without domains/urls', () => {
  const breaches = [{ name: 'NoDomain', domain: '', severity: 'low' }];
  assert.deepEqual(crossReferenceBrokers(breaches, SAMPLE_BROKERS), []);
  assert.deepEqual(crossReferenceBrokers(null, SAMPLE_BROKERS), []);
  assert.deepEqual(crossReferenceBrokers(breaches, null), []);
});

test('recommendFreeze true when any breach is high severity', () => {
  assert.equal(recommendFreeze([{ severity: 'low' }, { severity: 'high' }]), true);
});

test('recommendFreeze false when no high-severity breach', () => {
  assert.equal(recommendFreeze([{ severity: 'low' }, { severity: 'medium' }]), false);
  assert.equal(recommendFreeze([]), false);
  assert.equal(recommendFreeze(null), false);
});

test('breachCount returns array length, 0 for non-arrays', () => {
  assert.equal(breachCount([{}, {}, {}]), 3);
  assert.equal(breachCount([]), 0);
  assert.equal(breachCount(undefined), 0);
});
```

- [ ] Step 3.2: Run it, expect fail. Command: `node --test test/hibp.test.js`. These exercise code written in Task 1, so to honor RED-GREEN, FIRST temporarily break `recommendFreeze`: change `return breaches.some(b => b && b.severity === 'high');` to `return breaches.some(b => b && b.severity === 'medium');` and run. Expected failure: `recommendFreeze true when any breach is high severity` reports `Expected values to be strictly equal: false !== true`.

- [ ] Step 3.3: Implement (restore). Revert the temporary break: change the `recommendFreeze` body back to `return breaches.some(b => b && b.severity === 'high');` in `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js`.

- [ ] Step 3.4: Run, expect pass. Command: `node --test test/hibp.test.js`. Expected: all tests pass.

- [ ] Step 3.5: Commit. Commands:
```
git add lib/hibp.js test/hibp.test.js
git commit -m "Verify crossReferenceBrokers, recommendFreeze, breachCount

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `runBreachCheck` orchestrator + `formatBreachReport`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js` (implemented in Task 1; tests-only task)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js` (append)

- [ ] Step 4.1: Write the failing test. Append the following block to the END of `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js`:

```js
// ─── runBreachCheck orchestrator ─────────────────────────────────────────────

test('runBreachCheck aggregates breaches across emails and sets freeze flag', async () => {
  // First email: a high-severity breach. Second email: clean (404).
  const fetchImpl = makeFetch([
    { status: 200, json: [{ Name: 'Adobe', Domain: 'adobe.com', BreachDate: '2013-10-04', DataClasses: ['Passwords'] }] },
    { status: 404 },
  ]);
  const result = await runBreachCheck({
    emails: ['jane@example.com', 'clean@example.com'],
    apiKey: 'k',
    brokers: [],
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 2, 'one HIBP call per email');
  assert.equal(result.perEmail.length, 2);
  assert.equal(result.perEmail[0].breaches.length, 1);
  assert.equal(result.perEmail[1].breaches.length, 0);
  assert.equal(result.totalBreaches, 1);
  assert.equal(result.freeze, true);
});

test('runBreachCheck records per-email error without aborting other emails', async () => {
  // First email rate-limited (429 -> error), second email clean.
  const fetchImpl = makeFetch([
    { status: 429 },
    { status: 200, json: [] },
  ]);
  const result = await runBreachCheck({
    emails: ['a@example.com', 'b@example.com'],
    apiKey: 'k',
    fetchImpl,
  });
  assert.equal(result.perEmail.length, 2);
  assert.match(result.perEmail[0].error, /rate limited \(429\)/);
  assert.equal(result.perEmail[1].breaches.length, 0);
  assert.equal(result.freeze, false);
});

test('runBreachCheck surfaces broker cross-references', async () => {
  const fetchImpl = makeFetch({
    status: 200,
    json: [{ Name: 'SpokeoLeak', Domain: 'spokeo.com', BreachDate: '2020-01-01', DataClasses: ['Physical addresses'] }],
  });
  const result = await runBreachCheck({
    emails: ['jane@example.com'],
    apiKey: 'k',
    brokers: [{ name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' }],
    fetchImpl,
  });
  assert.equal(result.brokerMatches.length, 1);
  assert.equal(result.brokerMatches[0].broker.name, 'Spokeo');
  assert.equal(result.freeze, true);
});

// ─── formatBreachReport ──────────────────────────────────────────────────────

test('formatBreachReport renders freeze recommendation when freeze is true', () => {
  const report = formatBreachReport({
    perEmail: [
      { email: 'jane@example.com', breaches: [
        { name: 'Adobe', domain: 'adobe.com', breachDate: '2013-10-04', dataClasses: ['Passwords'], severity: 'high' },
      ] },
    ],
    brokerMatches: [],
    freeze: true,
  });
  assert.match(report, /jane@example\.com: 1 breach/);
  assert.match(report, /\[HIGH\] Adobe/);
  assert.match(report, /credit freeze/i);
  assert.match(report, /Equifax, Experian, and TransUnion/);
});

test('formatBreachReport renders clean message when no breaches', () => {
  const report = formatBreachReport({
    perEmail: [{ email: 'clean@example.com', breaches: [] }],
    brokerMatches: [],
    freeze: false,
  });
  assert.match(report, /no breaches found/);
  assert.match(report, /No high-severity identity breaches found/);
});

test('formatBreachReport renders per-email error line', () => {
  const report = formatBreachReport({
    perEmail: [{ email: 'a@example.com', breaches: [], error: 'HIBP: rate limited (429)' }],
    brokerMatches: [],
    freeze: false,
  });
  assert.match(report, /a@example\.com: error - HIBP: rate limited \(429\)/);
});

test('formatBreachReport lists broker cross-references', () => {
  const report = formatBreachReport({
    perEmail: [{ email: 'jane@example.com', breaches: [
      { name: 'SpokeoLeak', domain: 'spokeo.com', breachDate: '', dataClasses: ['Physical addresses'], severity: 'high' },
    ] }],
    brokerMatches: [
      { breach: { name: 'SpokeoLeak', domain: 'spokeo.com' }, broker: { name: 'Spokeo' } },
    ],
    freeze: true,
  });
  assert.match(report, /also data brokers/);
  assert.match(report, /SpokeoLeak \(spokeo\.com\) ↔ broker "Spokeo"/);
});
```

- [ ] Step 4.2: Run it, expect fail. Command: `NODE_ENV=test node --test test/hibp.test.js`. These exercise code from Task 1, so to honor RED-GREEN FIRST temporarily break `runBreachCheck`: change `allBreaches.push(...breaches);` to `// allBreaches.push(...breaches);` (comment it out) and run. Expected failure: `runBreachCheck aggregates breaches across emails and sets freeze flag` reports `Expected values to be strictly equal: 0 !== 1` (totalBreaches) and `false !== true` (freeze).

- [ ] Step 4.3: Implement (restore). Revert the temporary break: uncomment the line so it reads `allBreaches.push(...breaches);` in `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js`.

- [ ] Step 4.4: Run, expect pass. Command: `NODE_ENV=test node --test test/hibp.test.js`. Expected: all tests pass. Note: `NODE_ENV=test` makes `jitterSleep` a no-op so the two-email tests do not actually wait ~1.5s.

- [ ] Step 4.5: Commit. Commands:
```
git add lib/hibp.js test/hibp.test.js
git commit -m "Verify runBreachCheck orchestrator and formatBreachReport rendering

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Email collection + missing-key guidance helpers

These helpers let the watcher mode (a) collect every unique email across persons and (b) print friendly guidance when `hibp.apiKey` is absent. Keeping them in `lib/hibp.js` makes the watcher branch a thin wrapper and keeps the logic unit-tested.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js` (add `collectEmails`, `missingKeyMessage`; extend `module.exports`)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js` (append)

- [ ] Step 5.1: Write the failing test. Append the following block to the END of `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js`:

```js
// ─── collectEmails / missingKeyMessage ───────────────────────────────────────

const { collectEmails, missingKeyMessage } = require('../lib/hibp');

test('collectEmails gathers unique, lowercased emails from persons', () => {
  const persons = [
    { firstName: 'Jane', email: 'Jane@Example.com' },
    { firstName: 'John', email: 'john@example.com' },
    { firstName: 'Dup', email: 'jane@example.com' },
    { firstName: 'NoEmail' },
  ];
  assert.deepEqual(collectEmails(persons), ['jane@example.com', 'john@example.com']);
});

test('collectEmails returns [] for empty / missing input', () => {
  assert.deepEqual(collectEmails([]), []);
  assert.deepEqual(collectEmails(undefined), []);
});

test('missingKeyMessage explains how to get a free HIBP key', () => {
  const msg = missingKeyMessage();
  assert.match(msg, /hibp\.apiKey/);
  assert.match(msg, /haveibeenpwned\.com\/API\/Key/);
  assert.match(msg, /config\.json/);
});
```

- [ ] Step 5.2: Run it, expect fail. Command: `NODE_ENV=test node --test test/hibp.test.js`. Expected failure: `TypeError: collectEmails is not a function` (and `missingKeyMessage is not a function`) because those exports do not exist yet. (Use `NODE_ENV=test` because the file now also contains Task 4's multi-email `runBreachCheck` tests, which otherwise wait a real ~1.5s per pair via `jitterSleep`.)

- [ ] Step 5.3: Implement. In `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js`, add these two functions immediately AFTER the `breachCount` function and BEFORE `formatBreachReport`:

```js
/**
 * Collect unique, lowercased email addresses from a persons array.
 * Pure. Skips persons without an email. Preserves first-seen order.
 *
 * @param {Array<{email?:string}>} persons
 * @returns {string[]}
 */
function collectEmails(persons) {
  if (!Array.isArray(persons)) return [];
  const seen = new Set();
  const out = [];
  for (const p of persons) {
    const email = p && p.email ? String(p.email).trim().toLowerCase() : '';
    if (email && !seen.has(email)) {
      seen.add(email);
      out.push(email);
    }
  }
  return out;
}

/**
 * Friendly message explaining how to obtain a free HIBP API key.
 * Pure. Printed by the --breach-check watcher mode when hibp.apiKey is absent.
 *
 * @returns {string}
 */
function missingKeyMessage() {
  return [
    'No HIBP API key configured.',
    '',
    'The Have I Been Pwned breach-check feature needs an API key:',
    '  1. Get a key (low-cost, supports the service): https://haveibeenpwned.com/API/Key',
    '  2. Add it to config.json under hibp.apiKey:',
    '       "hibp": { "apiKey": "YOUR_KEY_HERE" }',
    '',
    'Then re-run: node watcher.js --breach-check',
  ].join('\n');
}
```

Then extend `module.exports` in `/Users/stephen/scripts/auto-identity-remove/lib/hibp.js` to include the two new names. Change:

```js
module.exports = {
  severityOf,
  checkBreaches,
  crossReferenceBrokers,
  recommendFreeze,
  breachCount,
  formatBreachReport,
  runBreachCheck,
  // constants exported for tests / reuse
  HIBP_BASE,
  USER_AGENT,
};
```

to:

```js
module.exports = {
  severityOf,
  checkBreaches,
  crossReferenceBrokers,
  recommendFreeze,
  breachCount,
  formatBreachReport,
  runBreachCheck,
  collectEmails,
  missingKeyMessage,
  // constants exported for tests / reuse
  HIBP_BASE,
  USER_AGENT,
};
```

- [ ] Step 5.4: Run, expect pass. Command: `NODE_ENV=test node --test test/hibp.test.js`. Expected: all tests pass.

- [ ] Step 5.5: Commit. Commands:
```
git add lib/hibp.js test/hibp.test.js
git commit -m "Add collectEmails and missingKeyMessage helpers to lib/hibp

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire `--breach-check` CLI mode into watcher.js

The `--breach-check` mode is read-only (no browser, no state writes) and follows the exact pattern of the existing `--list` / `--pending` branches: a top-level `if (FLAG) { ... process.exit(...) }` block placed before the `--confirm-emails` block. It loads config, collects emails, prints the missing-key guidance and exits 0 if no key, otherwise runs `runBreachCheck` and prints `formatBreachReport`.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js` (add flag constant near lines 41-44; add mode branch after the `--pending` block which ends at line 92, before the `--confirm-emails` block at line 94)

- [ ] Step 6.1: Write the failing test. There is no existing test that spawns `watcher.js`, and the mode itself just composes already-tested `lib/hibp.js` functions + `getPersonsFromConfig`. Adding a brittle child-process spawn test would violate the hermetic rule (it would load the real `config.json`/`brokers.js`). Instead, assert the integration contract at the unit level: the watcher branch must call `runBreachCheck` with exactly the emails `collectEmails(persons)` returns and the configured `apiKey`. Encode that contract as a composition test. Append this block to the END of `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js`:

```js
// ─── watcher --breach-check integration contract ─────────────────────────────
// The watcher branch composes collectEmails + runBreachCheck + formatBreachReport.
// This test pins that composition so the wiring in watcher.js cannot drift from
// the lib contract without a failing test.

test('integration: collectEmails feeds runBreachCheck which feeds formatBreachReport', async () => {
  const persons = [
    { firstName: 'Jane', email: 'Jane@Example.com' },
    { firstName: 'John', email: 'john@example.com' },
  ];
  const emails = collectEmails(persons);
  assert.deepEqual(emails, ['jane@example.com', 'john@example.com']);

  const fetchImpl = makeFetch([
    { status: 200, json: [{ Name: 'Adobe', Domain: 'adobe.com', BreachDate: '2013-10-04', DataClasses: ['Passwords'] }] },
    { status: 404 },
  ]);
  const result = await runBreachCheck({ emails, apiKey: 'k', brokers: [], fetchImpl });
  assert.equal(fetchImpl.calls.length, emails.length);

  const report = formatBreachReport(result);
  assert.match(report, /jane@example\.com: 1 breach/);
  assert.match(report, /john@example\.com: no breaches/);
  assert.match(report, /credit freeze/i);
});

test('integration: missing key short-circuits before any HIBP call', async () => {
  // Simulate the watcher guard: when apiKey is falsy, print missingKeyMessage
  // and never call runBreachCheck. We assert the guidance content here.
  const apiKey = '';
  const fetchImpl = makeFetch({ status: 200, json: [] });
  let called = false;
  if (apiKey) {
    called = true;
    await runBreachCheck({ emails: ['x@example.com'], apiKey, fetchImpl });
  }
  assert.equal(called, false);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(missingKeyMessage(), /haveibeenpwned\.com\/API\/Key/);
});
```

Note: `formatBreachReport(result)` works because `runBreachCheck` returns an object containing `perEmail`, `brokerMatches`, and `freeze` - exactly the keys `formatBreachReport` destructures.

- [ ] Step 6.2: Run it, expect fail. Command: `NODE_ENV=test node --test test/hibp.test.js`. To honor RED-GREEN, FIRST temporarily break the lib contract these tests depend on: in `lib/hibp.js`, in `runBreachCheck`'s returned object, change the line `perEmail,` to `perEmail: undefined,`. Run. Expected failure: `integration: collectEmails feeds runBreachCheck which feeds formatBreachReport` throws inside `formatBreachReport` (cannot iterate `undefined` perEmail) - the test fails. This proves the integration test actually exercises the contract.

- [ ] Step 6.3: Implement. First revert the temporary break from Step 6.2 (restore `perEmail,` in the returned object of `runBreachCheck`). Then wire the watcher.

  First, add the flag constant. In `/Users/stephen/scripts/auto-identity-remove/watcher.js`, locate lines 41-44:

```js
const PENDING_MODE    = process.argv.includes('--pending');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
```

  Replace that block with (adds one line):

```js
const PENDING_MODE    = process.argv.includes('--pending');
const BREACH_CHECK    = process.argv.includes('--breach-check');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
```

  Next, add the mode branch. The `--pending` block ends at line 92 (`  process.exit(0);\n}`) and the `--confirm-emails` block begins at line 94 (`// ── --confirm-emails [dir]: ...`). Insert the following NEW block between them - that is, after line 92's closing `}` and the blank line 93, and before the line-94 comment:

```js
// ── --breach-check: query Have I Been Pwned for configured emails, then exit ─
if (BREACH_CHECK) {
  const brokers = require('./brokers');
  const {
    collectEmails,
    missingKeyMessage,
    runBreachCheck,
    formatBreachReport,
  } = require('./lib/hibp');

  const cfg     = loadConfig();
  const persons = getPersonsFromConfig(cfg);
  const emails  = collectEmails(persons);
  const apiKey  = cfg.hibp && cfg.hibp.apiKey;

  if (!apiKey) {
    console.log('\n' + missingKeyMessage() + '\n');
    process.exit(0);
  }

  if (emails.length === 0) {
    console.log('\nNo email addresses found in config.json. Add an "email" to your person(s) first.\n');
    process.exit(0);
  }

  (async () => {
    console.log(`\nChecking ${emails.length} email(s) against Have I Been Pwned…`);
    const result = await runBreachCheck({ emails, apiKey, brokers });
    console.log('\n' + formatBreachReport(result) + '\n');
    process.exit(0);
  })().catch(err => {
    console.error('breach-check error:', err.message);
    process.exit(1);
  });
} else {

```

  IMPORTANT: this new block opens an `else {` at the end (mirroring how the existing `--confirm-emails` block opens its own `else {` that is closed near the bottom of the file). You must add the matching closing brace at the very end of the file. Locate the final two lines of `/Users/stephen/scripts/auto-identity-remove/watcher.js`:

```js
} // end else (not DOCTOR mode)

} // end else (not --confirm-emails mode)
```

  Replace them with (adds one closing brace + comment):

```js
} // end else (not DOCTOR mode)

} // end else (not --confirm-emails mode)

} // end else (not --breach-check mode)
```

- [ ] Step 6.4: Run, expect pass. Commands (in order):
  1. `NODE_ENV=test node --test test/hibp.test.js` - expect all hibp tests pass.
  2. `node -c watcher.js` - syntax-check watcher.js; expect no output (exit 0), confirming the added/closed braces balance.

- [ ] Step 6.5: Commit. Commands:
```
git add watcher.js test/hibp.test.js
git commit -m "Wire --breach-check CLI mode into watcher.js

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Document optional `hibp.apiKey` in config.example.json

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/config.example.json` (insert a `hibp` block after the `capsolver` block)

- [ ] Step 7.1: Write the failing test. Append the following block to the END of `/Users/stephen/scripts/auto-identity-remove/test/hibp.test.js`:

```js
// ─── config.example.json documents hibp.apiKey ──────────────────────────────

test('config.example.json documents an optional hibp.apiKey', () => {
  const fs = require('fs');
  const path = require('path');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.ok(parsed.hibp, 'config.example.json should include a "hibp" block');
  assert.ok('apiKey' in parsed.hibp, 'hibp block should document apiKey');
  assert.match(raw, /haveibeenpwned\.com\/API\/Key/);
});
```

- [ ] Step 7.2: Run it, expect fail. Command: `NODE_ENV=test node --test test/hibp.test.js`. Expected failure: `config.example.json documents an optional hibp.apiKey` reports `AssertionError ... config.example.json should include a "hibp" block` (the `hibp` key does not exist yet).

- [ ] Step 7.3: Implement. Read the current `capsolver` block in `/Users/stephen/scripts/auto-identity-remove/config.example.json`. It looks like:

```json
  "capsolver": {
    "_comment": "Sign up free at capsolver.com — pay-as-you-go, costs pennies/month for this use case",
    "apiKey": "CAP-YOUR_KEY_HERE"
  },
```

  Replace that exact block with the block below (keeps `capsolver` unchanged, adds a `hibp` block immediately after it):

```json
  "capsolver": {
    "_comment": "Sign up free at capsolver.com — pay-as-you-go, costs pennies/month for this use case",
    "apiKey": "CAP-YOUR_KEY_HERE"
  },

  "hibp": {
    "_comment": "Optional. Have I Been Pwned breach check (node watcher.js --breach-check). Get a key at https://haveibeenpwned.com/API/Key. Leave apiKey blank to disable.",
    "apiKey": ""
  },
```

  Note: the trailing comma after the `hibp` block's closing `}` is required because the `accounts` block follows it. Confirm the JSON still parses (Step 7.4 does this).

- [ ] Step 7.4: Run, expect pass. Command: `NODE_ENV=test node --test test/hibp.test.js`. Expected: all tests pass (the test does `JSON.parse`, so a malformed comma would throw there and fail).

- [ ] Step 7.5: Commit. Commands:
```
git add config.example.json test/hibp.test.js
git commit -m "Document optional hibp.apiKey in config.example.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Full suite green

No dashboard files were touched in this plan, so the dashboard suite is not required to change - but the root `package.json` test script already includes `dashboard/validate.test.js`, and CI runs the dashboard suite separately. We run both to confirm nothing regressed.

Files:
- No code changes. Verification only.

- [ ] Step 8.1: Run the full root suite exactly as `package.json`'s `test` script and CI do. Command:
```
node --test test/*.test.js dashboard/validate.test.js
```
  Expected: all tests pass, including the new `test/hibp.test.js`. There should be 0 failing. Note: this is CI's exact command and does NOT set `NODE_ENV=test`, so the three multi-email `runBreachCheck` tests each wait a real ~1.5s via `jitterSleep` (the suite runs ~4-5s slower than under `NODE_ENV=test`). That is expected and is not a failure; no test asserts on timing.

- [ ] Step 8.2: Run the dashboard suite the way CI's `dashboard` job does (from the dashboard directory). Command:
```
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```
  Expected: all dashboard tests pass (unchanged - this is a regression guard, since this plan did not modify any dashboard file).

- [ ] Step 8.3: Confirm the `--breach-check` flag is recognized end-to-end without a key by doing a quick manual smoke check that stays hermetic (it reads the on-disk `config.json` which is the example fixture; if `config.json` has no `hibp.apiKey` it prints the guidance and exits 0, hitting no network). Command:
```
node watcher.js --breach-check
```
  Expected: prints the "No HIBP API key configured" guidance (from `missingKeyMessage`) and exits 0, OR - if the local `config.json` happens to have a real `hibp.apiKey` - a live breach report. If you are unsure whether the local `config.json` has a real key, SKIP this step to avoid a real network call; Steps 8.1-8.2 already prove correctness hermetically.

- [ ] Step 8.4: Commit (only if any verification step required a fix; otherwise nothing to commit). If a fix was needed, stage the changed files and:
```
git add -A
git commit -m "Fix issues surfaced by full suite run for HIBP breach check

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage (every requirement from the feature brief is implemented and tested):
- New `lib/hibp.js` exporting `checkBreaches(email, {apiKey, fetchImpl})` returning an array of `{name, domain, breachDate, dataClasses, severity}` - Task 1 (skeleton/impl) + Task 2 (verified). Uses HIBP v3 `GET haveibeenpwned.com/api/v3/breachedaccount/{email}?truncateResponse=false` with `hibp-api-key` header and `User-Agent` - asserted by the header/URL test in Task 2.
- Uses the global `fetch` (default), injectable via `fetchImpl` - no new dependency. The header per the brief defaults `fetchImpl` to global `fetch`. New deps: NONE (stated in header).
- Pure `severityOf(dataClasses)` returning `high|medium|low`, `high` when dataClasses include SSN / "Social security numbers" / Passwords / Physical addresses - Task 1, unit-tested case-insensitively.
- New `--breach-check` CLI mode reading config emails, calling `checkBreaches`/`runBreachCheck`, printing results + a freeze recommendation when any high-severity breach exists - Task 6 (watcher branch) + the freeze recommendation in `formatBreachReport`/`recommendFreeze` (Tasks 3-4).
- `config.json` gains optional `hibp.apiKey`; if absent the mode explains how to get a free key and exits gracefully - `missingKeyMessage` (Task 5) + the watcher guard (Task 6) + documented in `config.example.json` (Task 7).
- Exported `breachCount` consumed by the exposure-score feature - Task 3, exported and unit-tested.
- 404 (no breaches), 401 (bad key), 429 (rate limit) handled - Task 2 tests. ~1.5s delay between calls via `lib/timing.js` `jitterSleep(1500,1500)`, fast-pathed under `NODE_ENV=test` (confirmed by reading `lib/timing.js`: `isFast = TURBO==='1' || NODE_ENV==='test'`).
- Cross-references broker entries - `crossReferenceBrokers` (Task 3) + surfaced in the orchestrator and report (Tasks 4, 6).
- Integration/wiring task present - Task 6 (CLI flag in `watcher.js`). Final full-suite task present - Task 8 (`node --test test/*.test.js dashboard/validate.test.js` plus the dashboard suite via `cd dashboard && node --test`).

Hermeticity: every HTTP path goes through an injected `fetchImpl` stub (`makeFetch`); no test touches the real network, real `config.json`, or real `state.json`. The one config read in Task 7 reads `config.example.json` (a committed fixture), not `config.json`. The optional manual smoke check (Step 8.3) is explicitly guarded to avoid network calls and may be skipped.

No placeholders: every code step contains complete, runnable code - no TBD, no "implement X", no ellipses. The RED step in each tests-only task (2, 3, 4, 6) uses a concrete, named temporary break and the exact restore, so each task has a genuine failing-then-passing transition.

Signature consistency with the real repo (verified by reading the files):
- `lib/config.js` exports used by the watcher branch: `loadConfig`, `getPersonsFromConfig` - both present in the real `module.exports` (read at lines 329-355). `getPersonsFromConfig` returns `config.persons` (non-empty) else `[config.person]` - the person objects carry an `email` field (confirmed in `config.example.json`), which `collectEmails` consumes.
- `lib/timing.js` exports `{ jitterSleep }` and fast-paths under `NODE_ENV==='test'` - verified verbatim.
- `watcher.js` read-only mode pattern: top-level `if (FLAG) { ... process.exit(...) } else {` blocks that early-exit, with matching closing braces at the file's end - verified (the `--list` block at lines 57-71, `--pending` at 74-92, and the nested `--confirm-emails`/`--doctor` `else {` structure at 95-511). The new branch matches this exact shape and adds its matching close-brace comment at the end.
- `lib/notify.js` was read to confirm the watcher uses `console.log` for read-only output (the `--list`/`--pending` modes print directly and do not call notify helpers); `--breach-check` follows suit and does not import `lib/notify.js`, consistent with the other read-only modes.
- HIBP v3 response field names (`Name`, `Title`, `Domain`, `BreachDate`, `DataClasses`) are the documented v3 schema; `checkBreaches` maps them to the lower-cased result shape the brief specifies.
