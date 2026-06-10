# Continuous SERP monitoring + new-domain alerts Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Extend the on-demand SERP scan into a `--serp-watch` mode that diffs the latest scan against the previous `data/serp-history.json` snapshot and fires `dispatchNotify` only when the user's name appears on a NEW broker/data domain.

Architecture: A new module `lib/serp-watch.js` holds a PURE `diffSerpResults(previous, current)` (no I/O, fully unit-tested) plus a `runSerpWatch(...)` orchestrator that takes injectable dependencies (scan runner, history reader, notify dispatcher) so it can be tested hermetically. `runSerpScan` (in `lib/serp-scan.js`) already persists each broker appearance to `data/serp-history.json`; `runSerpWatch` reads the prior hostnames out of that file, runs a fresh scan, computes the domain diff, and dispatches an alert. `watcher.js` gains a `--serp-watch` boolean flag wired exactly like the existing `--serp-scan` branch.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict`. Browser automation via the already-present Playwright (only reached through injected deps in tests, never live). No new npm dependencies.

---

## File map

| File | Status | Responsibility |
|------|--------|----------------|
| `/Users/stephen/scripts/auto-identity-remove/lib/serp-watch.js` | Create | Pure `diffSerpResults(previous, current)` returning `{ newDomains, goneDomains, stillPresent }`; helpers `historyHostnames(history)`, `summaryHostnames(summary)`, `buildAlert(diff, persons)`; orchestrator `runSerpWatch(context, persons, brokers, opts)` with injectable deps. |
| `/Users/stephen/scripts/auto-identity-remove/test/serp-watch.test.js` | Create | Pure unit tests for `diffSerpResults` (new/gone/same) + helpers; orchestrator tests asserting `dispatchNotify` fires only when `newDomains` is non-empty, using injected scan/history/notify stubs. |
| `/Users/stephen/scripts/auto-identity-remove/lib/serp-scan.js` | Modify | Add an exported `readHistory()` that safely reads + parses `data/serp-history.json` (returns `[]` on any error), and export the module-level `HISTORY_PATH`, so `serp-watch.js` can read prior snapshots without re-deriving the path. Lines ~437-444 (`module.exports`). |
| `/Users/stephen/scripts/auto-identity-remove/watcher.js` | Modify | Add `SERP_WATCH` flag parse (line ~29 area) and a `--serp-watch` mode branch inside `_mainBody()` mirroring the `--serp-scan` branch (after the `SERP_SCAN` branch ends at line ~350). |

---

## Task 1: Export a safe history reader from lib/serp-scan.js

The watch needs to read the previous `data/serp-history.json` snapshot. `serp-scan.js` already owns `HISTORY_PATH` and the atomic append; add a read-only counterpart and export it so `serp-watch.js` does not duplicate the path logic.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/serp-scan.js` (add `readHistory` near `appendToHistory` ~line 421-435; extend `module.exports` at lines 437-444)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/serp-scan.test.js` (append new tests at end of file, after line 538)

- [ ] Step 1.1: Write the failing test. Append the following to the END of `/Users/stephen/scripts/auto-identity-remove/test/serp-scan.test.js` (after the last existing test, line 538). It exercises `readHistory` by temporarily redirecting `fs.readFileSync` the same way the existing M7 tests redirect `fs.writeFileSync`.

```js
// ── readHistory (safe reader for serp-watch) ─────────────────────────────────

const { readHistory, HISTORY_PATH } = require('../lib/serp-scan');

test('readHistory returns parsed array when history file is valid JSON', () => {
  const fsMod = require('fs');
  const sample = [
    { personId: 'abc', broker: 'Spokeo', engine: 'ddg', rank: 1, hostname: 'spokeo.com', scannedAt: '2026-01-01T00:00:00.000Z' },
  ];
  const origRead = fsMod.readFileSync;
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) return JSON.stringify(sample);
    return origRead(p, enc);
  };
  try {
    const out = readHistory();
    assert.deepEqual(out, sample);
  } finally {
    fsMod.readFileSync = origRead;
  }
});

test('readHistory returns empty array when file is missing', () => {
  const fsMod = require('fs');
  const origRead = fsMod.readFileSync;
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return origRead(p, enc);
  };
  try {
    assert.deepEqual(readHistory(), []);
  } finally {
    fsMod.readFileSync = origRead;
  }
});

test('readHistory returns empty array when file is malformed JSON', () => {
  const fsMod = require('fs');
  const origRead = fsMod.readFileSync;
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) return '{ not valid json';
    return origRead(p, enc);
  };
  try {
    assert.deepEqual(readHistory(), []);
  } finally {
    fsMod.readFileSync = origRead;
  }
});

test('readHistory returns empty array when JSON is not an array', () => {
  const fsMod = require('fs');
  const origRead = fsMod.readFileSync;
  fsMod.readFileSync = (p, enc) => {
    if (p === HISTORY_PATH) return JSON.stringify({ optOuts: {} });
    return origRead(p, enc);
  };
  try {
    assert.deepEqual(readHistory(), []);
  } finally {
    fsMod.readFileSync = origRead;
  }
});

test('serp-scan exports HISTORY_PATH ending in data/serp-history.json', () => {
  assert.ok(HISTORY_PATH.endsWith('serp-history.json'), `HISTORY_PATH was ${HISTORY_PATH}`);
});
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test test/serp-scan.test.js`. Expected failure: the destructured `readHistory` is `undefined` so `readHistory()` throws `TypeError: readHistory is not a function`, and `HISTORY_PATH` is `undefined` so `HISTORY_PATH.endsWith` throws `TypeError: Cannot read properties of undefined (reading 'endsWith')`.

- [ ] Step 1.3: Implement. In `/Users/stephen/scripts/auto-identity-remove/lib/serp-scan.js`, add the `readHistory` function immediately AFTER the existing `appendToHistory` function (after its closing brace on line 435, before `module.exports`):

```js
/**
 * Safely read and parse data/serp-history.json.
 * Returns an array of history entries, or [] on any error (missing file,
 * malformed JSON, or a non-array top-level value).
 *
 * @returns {Array<{ personId: string, broker: string, engine: string, rank: number, hostname: string, scannedAt: string }>}
 */
function readHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}
```

Then replace the existing `module.exports` block (lines 437-444):

```js
module.exports = {
  parseSerp,
  hostnameOf,
  matchBrokers,
  buildQuery,
  hashPerson,
  runSerpScan,
};
```

with:

```js
module.exports = {
  parseSerp,
  hostnameOf,
  matchBrokers,
  buildQuery,
  hashPerson,
  runSerpScan,
  readHistory,
  HISTORY_PATH,
};
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test test/serp-scan.test.js`. Expected: all existing tests plus the 5 new ones pass (`# pass` count increases by 5, `# fail 0`).

- [ ] Step 1.5: Commit. Run:

```
git add lib/serp-scan.js test/serp-scan.test.js
git commit -m "Add readHistory + export HISTORY_PATH from serp-scan

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure diffSerpResults + hostname helpers in lib/serp-watch.js

Create the new module with the PURE diff function and the small pure helpers it needs. No I/O, no orchestration yet.

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/serp-watch.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/serp-watch.test.js` (create)

- [ ] Step 2.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/serp-watch.test.js` with the following content. (Only the pure-helper tests here; the orchestrator tests are added in Task 3.)

```js
/**
 * test/serp-watch.test.js
 *
 * Pure unit tests for lib/serp-watch.js.
 * No live network. No real browser. No disk I/O (deps are injected).
 *
 * Tested behaviours (this task):
 *  1. diffSerpResults(previous, current) - { newDomains, goneDomains, stillPresent }
 *  2. summaryHostnames(summary)          - broker hostnames from a runSerpScan summary
 *  3. historyHostnames(history)          - distinct hostnames from a history array
 *  4. buildAlert(diff, persons)          - concise alert string for new domains
 */

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

let origLog;
beforeEach(() => { origLog = console.log; console.log = () => {}; });
afterEach(() => { console.log = origLog; });

const {
  diffSerpResults,
  summaryHostnames,
  historyHostnames,
  buildAlert,
} = require('../lib/serp-watch');

// ─── diffSerpResults ──────────────────────────────────────────────────────────

test('diffSerpResults reports a domain present in current but not previous as new', () => {
  const diff = diffSerpResults(['spokeo.com'], ['spokeo.com', 'radaris.com']);
  assert.deepEqual(diff.newDomains, ['radaris.com']);
});

test('diffSerpResults reports a domain present in previous but not current as gone', () => {
  const diff = diffSerpResults(['spokeo.com', 'radaris.com'], ['spokeo.com']);
  assert.deepEqual(diff.goneDomains, ['radaris.com']);
});

test('diffSerpResults reports a domain present in both as stillPresent', () => {
  const diff = diffSerpResults(['spokeo.com', 'radaris.com'], ['spokeo.com', 'radaris.com']);
  assert.deepEqual(diff.stillPresent.sort(), ['radaris.com', 'spokeo.com']);
  assert.deepEqual(diff.newDomains, []);
  assert.deepEqual(diff.goneDomains, []);
});

test('diffSerpResults with empty previous treats every current domain as new', () => {
  const diff = diffSerpResults([], ['spokeo.com', 'radaris.com']);
  assert.deepEqual(diff.newDomains.sort(), ['radaris.com', 'spokeo.com']);
  assert.deepEqual(diff.goneDomains, []);
  assert.deepEqual(diff.stillPresent, []);
});

test('diffSerpResults with empty current reports everything gone', () => {
  const diff = diffSerpResults(['spokeo.com'], []);
  assert.deepEqual(diff.newDomains, []);
  assert.deepEqual(diff.goneDomains, ['spokeo.com']);
  assert.deepEqual(diff.stillPresent, []);
});

test('diffSerpResults with both empty returns all-empty arrays', () => {
  const diff = diffSerpResults([], []);
  assert.deepEqual(diff, { newDomains: [], goneDomains: [], stillPresent: [] });
});

test('diffSerpResults deduplicates repeated domains in inputs', () => {
  const diff = diffSerpResults(['spokeo.com', 'spokeo.com'], ['spokeo.com', 'spokeo.com', 'radaris.com', 'radaris.com']);
  assert.deepEqual(diff.newDomains, ['radaris.com']);
  assert.deepEqual(diff.stillPresent, ['spokeo.com']);
});

test('diffSerpResults result arrays are sorted for stable output', () => {
  const diff = diffSerpResults([], ['zlocate.com', 'apeople.com', 'mradaris.com']);
  assert.deepEqual(diff.newDomains, ['apeople.com', 'mradaris.com', 'zlocate.com']);
});

test('diffSerpResults ignores empty-string and falsy entries', () => {
  const diff = diffSerpResults(['', null, 'spokeo.com'], [undefined, '', 'radaris.com']);
  assert.deepEqual(diff.newDomains, ['radaris.com']);
  assert.deepEqual(diff.goneDomains, ['spokeo.com']);
});

// ─── summaryHostnames ─────────────────────────────────────────────────────────

test('summaryHostnames maps a runSerpScan summary to its broker hostnames', () => {
  const summary = {
    total_brokers_appearing: 2,
    results: [
      { broker: 'Spokeo', hostname: 'spokeo.com', ranks: { ddg: 1, bing: null, google: null } },
      { broker: 'Radaris', hostname: 'radaris.com', ranks: { ddg: null, bing: 2, google: null } },
    ],
    blocked: [],
  };
  assert.deepEqual(summaryHostnames(summary).sort(), ['radaris.com', 'spokeo.com']);
});

test('summaryHostnames returns empty array for an empty summary', () => {
  assert.deepEqual(summaryHostnames({ total_brokers_appearing: 0, results: [], blocked: [] }), []);
});

test('summaryHostnames tolerates a null or malformed summary', () => {
  assert.deepEqual(summaryHostnames(null), []);
  assert.deepEqual(summaryHostnames({}), []);
  assert.deepEqual(summaryHostnames({ results: null }), []);
});

// ─── historyHostnames ─────────────────────────────────────────────────────────

test('historyHostnames returns distinct hostnames from a history array', () => {
  const history = [
    { hostname: 'spokeo.com' },
    { hostname: 'spokeo.com' },
    { hostname: 'radaris.com' },
  ];
  assert.deepEqual(historyHostnames(history).sort(), ['radaris.com', 'spokeo.com']);
});

test('historyHostnames returns empty array for empty / non-array input', () => {
  assert.deepEqual(historyHostnames([]), []);
  assert.deepEqual(historyHostnames(null), []);
  assert.deepEqual(historyHostnames(undefined), []);
});

test('historyHostnames skips entries with no hostname', () => {
  const history = [{ hostname: 'spokeo.com' }, { broker: 'X' }, { hostname: '' }];
  assert.deepEqual(historyHostnames(history), ['spokeo.com']);
});

// ─── buildAlert ───────────────────────────────────────────────────────────────

test('buildAlert lists the new domains in a concise string', () => {
  const persons = [{ firstName: 'Jane', lastName: 'Doe' }];
  const msg = buildAlert({ newDomains: ['radaris.com', 'spokeo.com'], goneDomains: [], stillPresent: [] }, persons);
  assert.match(msg, /SERP watch/i);
  assert.match(msg, /radaris\.com/);
  assert.match(msg, /spokeo\.com/);
});

test('buildAlert includes the person name when a single person is watched', () => {
  const persons = [{ firstName: 'Jane', lastName: 'Doe' }];
  const msg = buildAlert({ newDomains: ['radaris.com'], goneDomains: [], stillPresent: [] }, persons);
  assert.match(msg, /Jane Doe/);
});

test('buildAlert summarises a count when multiple persons are watched', () => {
  const persons = [{ firstName: 'Jane', lastName: 'Doe' }, { firstName: 'Bob', lastName: 'Smith' }];
  const msg = buildAlert({ newDomains: ['radaris.com'], goneDomains: [], stillPresent: [] }, persons);
  assert.match(msg, /2 watched/i);
});
```

- [ ] Step 2.2: Run it, expect fail. Command: `node --test test/serp-watch.test.js`. Expected failure: `Cannot find module '../lib/serp-watch'` (the require throws because the module file does not exist yet).

- [ ] Step 2.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/serp-watch.js` with the pure helpers (the orchestrator is added in Task 3; keep `module.exports` listing it now so Task 3 only adds the function body):

```js
/**
 * lib/serp-watch.js
 *
 * Continuous SERP monitoring + new-domain alerts.
 *
 * Extends the on-demand SERP scan (lib/serp-scan.js) into a watch: run a fresh
 * scan, diff the broker hostnames it surfaces against the hostnames recorded in
 * the previous data/serp-history.json snapshot, and fire a desktop/webhook alert
 * via lib/notify.js dispatchNotify ONLY when the user's name appears on a NEW
 * domain.
 *
 * Exported helpers (pure, no I/O - fully unit-testable):
 *   diffSerpResults(previous, current) -> { newDomains, goneDomains, stillPresent }
 *   summaryHostnames(summary)          -> string[]  broker hostnames in a scan summary
 *   historyHostnames(history)          -> string[]  distinct hostnames in a history array
 *   buildAlert(diff, persons)          -> string     concise alert text for new domains
 *
 * Orchestrator (deps injected so it is testable without a live browser):
 *   runSerpWatch(context, persons, brokers, opts)
 */

'use strict';

const serpScan = require('./serp-scan');
const notify   = require('./notify');

/**
 * Deduplicate a list of hostname strings, dropping falsy / empty values.
 * @param {Array<string>} list
 * @returns {string[]}
 */
function _cleanSet(list) {
  const out = new Set();
  for (const h of Array.isArray(list) ? list : []) {
    if (h && typeof h === 'string') out.add(h);
  }
  return out;
}

/**
 * Pure set diff of two hostname lists.
 *
 * @param {string[]} previous  Hostnames seen in the previous snapshot.
 * @param {string[]} current   Hostnames seen in the current scan.
 * @returns {{ newDomains: string[], goneDomains: string[], stillPresent: string[] }}
 *   newDomains   - in current, not in previous (the alert trigger)
 *   goneDomains  - in previous, not in current
 *   stillPresent - in both
 *   All arrays are deduplicated and sorted ascending.
 */
function diffSerpResults(previous, current) {
  const prev = _cleanSet(previous);
  const cur  = _cleanSet(current);

  const newDomains   = [...cur].filter(h => !prev.has(h)).sort();
  const goneDomains  = [...prev].filter(h => !cur.has(h)).sort();
  const stillPresent = [...cur].filter(h => prev.has(h)).sort();

  return { newDomains, goneDomains, stillPresent };
}

/**
 * Extract broker hostnames from a runSerpScan summary object.
 * Each result entry carries a `hostname` (added by runSerpScan); fall back to
 * deriving it from the broker name's absence by returning only present strings.
 *
 * @param {{ results?: Array<{ hostname?: string }> }} summary
 * @returns {string[]}
 */
function summaryHostnames(summary) {
  const results = summary && Array.isArray(summary.results) ? summary.results : [];
  const out = new Set();
  for (const r of results) {
    if (r && r.hostname) out.add(r.hostname);
  }
  return [...out];
}

/**
 * Extract the distinct set of hostnames recorded in a serp-history array.
 *
 * @param {Array<{ hostname?: string }>} history
 * @returns {string[]}
 */
function historyHostnames(history) {
  const out = new Set();
  for (const e of Array.isArray(history) ? history : []) {
    if (e && e.hostname) out.add(e.hostname);
  }
  return [...out];
}

/**
 * Build a concise alert string describing the newly-appeared domains.
 *
 * @param {{ newDomains: string[] }} diff
 * @param {Array<{ firstName?: string, lastName?: string }>} persons
 * @returns {string}
 */
function buildAlert(diff, persons) {
  const who = Array.isArray(persons) && persons.length === 1
    ? `${persons[0].firstName || ''} ${persons[0].lastName || ''}`.trim()
    : `${(persons || []).length} watched identities`;
  const list = diff.newDomains.join(', ');
  const n = diff.newDomains.length;
  return `SERP watch: ${who} now appears on ${n} new domain${n === 1 ? '' : 's'}: ${list}`;
}

/**
 * Run a SERP scan, diff against the previous history snapshot, and alert on new
 * domains. Dependencies are injectable so this is testable without a live
 * browser or real disk:
 *   opts._runSerpScan(context, persons, brokers)  -> Promise<summary>
 *   opts._readHistory()                           -> history array
 *   opts._dispatchNotify(text, cfg)               -> Promise<void>
 *   opts.cfg                                      -> config (for notify.cfg.notify)
 *
 * @param {import('playwright').BrowserContext} context
 * @param {object[]} persons
 * @param {object[]} brokers
 * @param {object} [opts]
 * @returns {Promise<{ diff: object, alerted: boolean, summary: object }>}
 */
async function runSerpWatch(context, persons, brokers, opts) {
  throw new Error('not implemented');
}

module.exports = {
  diffSerpResults,
  summaryHostnames,
  historyHostnames,
  buildAlert,
  runSerpWatch,
};
```

- [ ] Step 2.4: Run, expect pass. Command: `node --test test/serp-watch.test.js`. Expected: all pure-helper tests pass (`# fail 0`). The `runSerpWatch` body still throws but no test calls it yet.

- [ ] Step 2.5: Commit. Run:

```
git add lib/serp-watch.js test/serp-watch.test.js
git commit -m "Add pure diffSerpResults + hostname helpers (serp-watch)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: runSerpWatch orchestrator alerts only on new domains

Implement the orchestrator. It must read the previous history snapshot BEFORE running the scan (the scan appends to the same file), run the scan, diff prior-hostnames vs current-summary-hostnames, and call `dispatchNotify` only when `newDomains` is non-empty. All side-effecting deps are injected.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/serp-watch.js` (replace the `runSerpWatch` body, lines ~) 
- Test: `/Users/stephen/scripts/auto-identity-remove/test/serp-watch.test.js` (append orchestrator tests)

- [ ] Step 3.1: Write the failing test. Append the following to the END of `/Users/stephen/scripts/auto-identity-remove/test/serp-watch.test.js`:

```js
// ─── runSerpWatch orchestrator (deps injected) ───────────────────────────────

const { runSerpWatch } = require('../lib/serp-watch');

const WATCH_PERSONS = [
  { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', city: 'Austin', state: 'TX', email: 'jane@example.com' },
];
const WATCH_BROKERS = [
  { name: 'Spokeo',  optOutUrl: 'https://www.spokeo.com/optout' },
  { name: 'Radaris', optOutUrl: 'https://radaris.com/control/privacy' },
];

/** Capture dispatchNotify invocations. */
function makeNotifyStub() {
  const calls = [];
  return {
    fn: async (text, cfg) => { calls.push({ text, cfg }); },
    calls,
  };
}

test('runSerpWatch fires dispatchNotify when a new domain appears', async () => {
  const notifyStub = makeNotifyStub();
  const result = await runSerpWatch({}, WATCH_PERSONS, WATCH_BROKERS, {
    cfg: { notify: { webhook: 'https://ntfy.sh/x' } },
    _readHistory: () => [{ hostname: 'spokeo.com' }],
    _runSerpScan: async () => ({
      total_brokers_appearing: 2,
      results: [
        { broker: 'Spokeo',  hostname: 'spokeo.com',  ranks: { ddg: 1, bing: null, google: null } },
        { broker: 'Radaris', hostname: 'radaris.com', ranks: { ddg: 2, bing: null, google: null } },
      ],
      blocked: [],
    }),
    _dispatchNotify: notifyStub.fn,
  });

  assert.equal(result.alerted, true);
  assert.deepEqual(result.diff.newDomains, ['radaris.com']);
  assert.equal(notifyStub.calls.length, 1, 'dispatchNotify should fire exactly once');
  assert.match(notifyStub.calls[0].text, /radaris\.com/);
  assert.deepEqual(notifyStub.calls[0].cfg, { notify: { webhook: 'https://ntfy.sh/x' } });
});

test('runSerpWatch does NOT fire dispatchNotify when there are no new domains', async () => {
  const notifyStub = makeNotifyStub();
  const result = await runSerpWatch({}, WATCH_PERSONS, WATCH_BROKERS, {
    cfg: { notify: { webhook: 'https://ntfy.sh/x' } },
    _readHistory: () => [{ hostname: 'spokeo.com' }, { hostname: 'radaris.com' }],
    _runSerpScan: async () => ({
      total_brokers_appearing: 1,
      results: [
        { broker: 'Spokeo', hostname: 'spokeo.com', ranks: { ddg: 1, bing: null, google: null } },
      ],
      blocked: [],
    }),
    _dispatchNotify: notifyStub.fn,
  });

  assert.equal(result.alerted, false);
  assert.deepEqual(result.diff.newDomains, []);
  assert.deepEqual(result.diff.goneDomains, ['radaris.com']);
  assert.equal(notifyStub.calls.length, 0, 'dispatchNotify must not fire when nothing is new');
});

test('runSerpWatch treats first-ever run (empty history) as all-new and alerts', async () => {
  const notifyStub = makeNotifyStub();
  const result = await runSerpWatch({}, WATCH_PERSONS, WATCH_BROKERS, {
    cfg: { notify: {} },
    _readHistory: () => [],
    _runSerpScan: async () => ({
      total_brokers_appearing: 1,
      results: [{ broker: 'Spokeo', hostname: 'spokeo.com', ranks: { ddg: 1, bing: null, google: null } }],
      blocked: [],
    }),
    _dispatchNotify: notifyStub.fn,
  });

  assert.equal(result.alerted, true);
  assert.deepEqual(result.diff.newDomains, ['spokeo.com']);
  assert.equal(notifyStub.calls.length, 1);
});

test('runSerpWatch does not alert when the scan finds nothing', async () => {
  const notifyStub = makeNotifyStub();
  const result = await runSerpWatch({}, WATCH_PERSONS, WATCH_BROKERS, {
    cfg: { notify: { webhook: 'https://ntfy.sh/x' } },
    _readHistory: () => [{ hostname: 'spokeo.com' }],
    _runSerpScan: async () => ({ total_brokers_appearing: 0, results: [], blocked: [] }),
    _dispatchNotify: notifyStub.fn,
  });

  assert.equal(result.alerted, false);
  assert.deepEqual(result.diff.newDomains, []);
  assert.equal(notifyStub.calls.length, 0);
});

test('runSerpWatch reads history BEFORE running the scan (snapshot is pre-scan)', async () => {
  const order = [];
  const notifyStub = makeNotifyStub();
  await runSerpWatch({}, WATCH_PERSONS, WATCH_BROKERS, {
    cfg: { notify: {} },
    _readHistory: () => { order.push('read'); return [{ hostname: 'spokeo.com' }]; },
    _runSerpScan: async () => {
      order.push('scan');
      return { total_brokers_appearing: 1, results: [{ broker: 'Spokeo', hostname: 'spokeo.com', ranks: { ddg: 1, bing: null, google: null } }], blocked: [] };
    },
    _dispatchNotify: notifyStub.fn,
  });
  assert.deepEqual(order, ['read', 'scan'], 'history must be read before the scan appends to it');
});

test('runSerpWatch returns the scan summary on the result for callers to print', async () => {
  const summary = {
    total_brokers_appearing: 1,
    results: [{ broker: 'Radaris', hostname: 'radaris.com', ranks: { ddg: null, bing: 3, google: null } }],
    blocked: ['google'],
  };
  const result = await runSerpWatch({}, WATCH_PERSONS, WATCH_BROKERS, {
    cfg: { notify: {} },
    _readHistory: () => [],
    _runSerpScan: async () => summary,
    _dispatchNotify: makeNotifyStub().fn,
  });
  assert.equal(result.summary, summary);
});
```

- [ ] Step 3.2: Run it, expect fail. Command: `node --test test/serp-watch.test.js`. Expected failure: the orchestrator tests fail because the current body throws `Error: not implemented` (each `runSerpWatch(...)` call rejects).

- [ ] Step 3.3: Implement. In `/Users/stephen/scripts/auto-identity-remove/lib/serp-watch.js`, replace the placeholder `runSerpWatch` body:

```js
async function runSerpWatch(context, persons, brokers, opts) {
  throw new Error('not implemented');
}
```

with the real implementation:

```js
async function runSerpWatch(context, persons, brokers, opts = {}) {
  const readHistoryFn   = opts._readHistory   || serpScan.readHistory;
  const runScanFn       = opts._runSerpScan   || serpScan.runSerpScan;
  const dispatchFn      = opts._dispatchNotify || notify.dispatchNotify;
  const cfg             = opts.cfg || {};

  // Snapshot the PREVIOUS hostnames before the scan appends new entries to the
  // same history file.
  const previousHosts = historyHostnames(readHistoryFn());

  const summary = await runScanFn(context, persons, brokers);
  const currentHosts = summaryHostnames(summary);

  const diff = diffSerpResults(previousHosts, currentHosts);

  let alerted = false;
  if (diff.newDomains.length > 0) {
    await dispatchFn(buildAlert(diff, persons), cfg);
    alerted = true;
  }

  return { diff, alerted, summary };
}
```

- [ ] Step 3.4: Run, expect pass. Command: `node --test test/serp-watch.test.js`. Expected: all pure-helper tests AND all six orchestrator tests pass (`# fail 0`).

- [ ] Step 3.5: Commit. Run:

```
git add lib/serp-watch.js test/serp-watch.test.js
git commit -m "Implement runSerpWatch: alert only on new SERP domains

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: runSerpScan summary results carry a hostname (so the watch can diff them)

`summaryHostnames` reads `result.hostname`, but `runSerpScan` currently builds `results` entries with only `{ broker, ranks }` (see `lib/serp-scan.js` lines 399-402). Add the broker hostname to each summary result so the watch has a hostname to diff. This keeps `runSerpScan`'s public shape backward-compatible (existing tests only check `broker` and `ranks`) while adding the field the watch needs.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/serp-scan.js` (the `appearances` map at lines 372-379 and the `resultEntries` map at lines 399-402; the typedef at lines 446-452)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/serp-scan.test.js` (append a test asserting each summary result has a `hostname`)

- [ ] Step 4.1: Write the failing test. Append to the END of `/Users/stephen/scripts/auto-identity-remove/test/serp-scan.test.js`:

```js
// ── runSerpScan summary results carry a hostname (for serp-watch diffing) ─────

test('runSerpScan summary results include a broker hostname', async () => {
  const context = makeContext({
    'duckduckgo.com': `
      <a class="result__a" href="https://duckduckgo.com/?uddg=https%3A%2F%2Fwww.spokeo.com%2FJane">S</a>
    `,
    'bing.com': `<html></html>`,
    'google.com': `<html></html>`,
  });

  const summary = await runSerpScan(context, SAMPLE_PERSONS, SAMPLE_BROKERS, { _skipWrite: true });
  const spokeo = summary.results.find(r => r.broker === 'Spokeo');
  assert.ok(spokeo, 'Spokeo should be in results');
  assert.equal(spokeo.hostname, 'spokeo.com', 'each result should carry the broker registrable hostname');
});
```

Timing note: this new test (like the existing `runSerpScan` tests) drives the REAL `runSerpScan`, which calls `jitterSleep(5000, 15000)` between engines (`lib/serp-scan.js` line 337). `lib/timing.js` (line 15-16) only short-circuits those sleeps when `process.env.TURBO === '1'` or `process.env.NODE_ENV === 'test'`. CI runs the bare command (`.github/workflows/test.yml` line 29, no such env), so the serp-scan suite already tolerates ~10-30s of real wall-clock delay per real-scan test. The commands below stay bare to mirror CI exactly; expect the serp-scan suite to take a couple of minutes. If you want it instant locally, prefix with `NODE_ENV=test` (e.g. `NODE_ENV=test node --test test/serp-scan.test.js`) - this does not change pass/fail, only speed.

- [ ] Step 4.2: Run it, expect fail. Command: `node --test test/serp-scan.test.js`. Expected failure: `spokeo.hostname` is `undefined`, so the assertion fails with `Expected values to be strictly equal: undefined !== 'spokeo.com'`.

- [ ] Step 4.3: Implement. In `/Users/stephen/scripts/auto-identity-remove/lib/serp-scan.js`, in `runSerpScan`, update the `appearances` map so each broker entry remembers its hostname. Replace this block (lines 372-379):

```js
        if (!appearances.has(brokerName)) {
          appearances.set(brokerName, { ddg: null, bing: null, google: null });
        }
        const ranks = appearances.get(brokerName);
        // Keep the best (lowest) rank if seen multiple times on same engine
        if (ranks[eng.id] === null || result.rank < ranks[eng.id]) {
          ranks[eng.id] = result.rank;
        }
```

with:

```js
        if (!appearances.has(brokerName)) {
          appearances.set(brokerName, { hostname: registrableDomain(host), ranks: { ddg: null, bing: null, google: null } });
        }
        const entry = appearances.get(brokerName);
        const ranks = entry.ranks;
        // Keep the best (lowest) rank if seen multiple times on same engine
        if (ranks[eng.id] === null || result.rank < ranks[eng.id]) {
          ranks[eng.id] = result.rank;
        }
```

Then replace the `resultEntries` map (lines 399-402):

```js
  const resultEntries = [...appearances.entries()].map(([broker, ranks]) => ({
    broker,
    ranks,
  }));
```

with:

```js
  const resultEntries = [...appearances.entries()].map(([broker, entry]) => ({
    broker,
    hostname: entry.hostname,
    ranks: entry.ranks,
  }));
```

Finally update the typedef (lines 446-452) so the documented shape matches:

```js
/**
 * @typedef {{
 *   total_brokers_appearing: number,
 *   results: Array<{ broker: string, hostname: string, ranks: { ddg: number|null, bing: number|null, google: number|null } }>,
 *   blocked: string[],
 * }} SerpScanSummary
 */
```

- [ ] Step 4.4: Run, expect pass. Command: `node --test test/serp-scan.test.js`. Expected: all serp-scan tests pass, including the existing `runSerpScan ranks object has ddg, bing, google keys` test (it reads `r.ranks.ddg`, which still resolves through the new `entry.ranks`) and the new hostname test (`# fail 0`).

- [ ] Step 4.5: Commit. Run:

```
git add lib/serp-scan.js test/serp-scan.test.js
git commit -m "Carry broker hostname on runSerpScan summary results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire --serp-watch into watcher.js

Add the `--serp-watch` CLI flag and a mode branch in `_mainBody()` that mirrors the existing `--serp-scan` branch (launch context, run the watch, print results, close context, return). The branch uses the live `runSerpWatch` default deps (real `readHistory`, real `runSerpScan`, real `dispatchNotify` with the loaded config).

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js` (flag parse near line 29; branch added after the `SERP_SCAN` branch which ends at line 350)
- Verification: full suite (no new watcher unit test - watcher.js is an entry-point orchestrator with no existing unit tests; behavior is covered by the `runSerpWatch` tests in Task 3. We verify the flag wiring with a `--help`-free smoke check via `node -c`.)

- [ ] Step 5.1: Add the flag parse. In `/Users/stephen/scripts/auto-identity-remove/watcher.js`, find this line (line 29):

```js
const SERP_SCAN         = process.argv.includes('--serp-scan');
```

and add immediately after it:

```js
const SERP_WATCH        = process.argv.includes('--serp-watch');
```

- [ ] Step 5.2: Add the mode branch. In `_mainBody()`, find the end of the existing SERP scan branch. It ends with these lines (around lines 348-350):

```js
    console.log('\n' + '='.repeat(62) + '\n');
    return;
  }
```

Immediately AFTER that closing `}` (and before the `// ── Resolve --retry-failed broker set ──` comment on line 352), insert the new branch:

```js
  // ── SERP watch mode: scan + diff vs history + alert on NEW domains ────────
  if (SERP_WATCH) {
    const { runSerpWatch } = require('./lib/serp-watch');
    console.log('\n🛰  SERP watch - scanning, then diffing against previous history');
    console.log('   Alerts fire only when your name appears on a NEW domain.\n');
    const watch = await runSerpWatch(context, persons, brokers, { cfg: config });
    await context.close().catch(() => {});

    console.log('\n' + '='.repeat(62));
    console.log('SERP Watch Results - ' + new Date().toLocaleString());
    console.log('='.repeat(62));
    if (watch.summary.blocked.length > 0) {
      console.log(`\n  Blocked engines (bot-detection triggered): ${watch.summary.blocked.join(', ')}`);
    }
    console.log(`\n  New domains    : ${watch.diff.newDomains.length}`);
    console.log(`  Gone domains   : ${watch.diff.goneDomains.length}`);
    console.log(`  Still present  : ${watch.diff.stillPresent.length}`);
    if (watch.diff.newDomains.length > 0) {
      console.log('\n  ⚠️  NEW domains your name now appears on:');
      for (const d of watch.diff.newDomains) console.log(`     - ${d}`);
      console.log(watch.alerted ? '\n  An alert was dispatched.' : '\n  (No alert channel configured.)');
    } else {
      console.log('\n  No new broker domains since the last scan.');
    }
    console.log('\n' + '='.repeat(62) + '\n');
    return;
  }
```

- [ ] Step 5.3: Verify the file still parses. Command: `node -c watcher.js`. Expected: no output, exit code 0 (the file is syntactically valid; an unbalanced brace would print a SyntaxError).

- [ ] Step 5.4: Verify nothing else broke. Command: `node --test test/serp-watch.test.js test/serp-scan.test.js`. Expected: `# fail 0`.

- [ ] Step 5.5: Commit. Run:

```
git add watcher.js
git commit -m "Wire --serp-watch CLI mode into watcher

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Document --serp-watch in the scheduler-adjacent help and README

The feature is schedulable under the existing scheduler (which runs `run.sh` -> `watcher.js`). No scheduler code change is needed because `--serp-watch` is just another watcher flag a user can place in `run.sh`. Add a short README note so the flag is discoverable, and a one-line usage hint in the watcher's SERP scan area is already covered by the new branch. This task only touches docs.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/README.md` (insert a `### Continuous SERP monitoring (--serp-watch)` subsection right after the existing `### Verifying removals (--verify)` block)
- Verification: grep confirms the new line is present.

- [ ] Step 6.1: Read the README to find the right insertion point. Command: `rtk read README.md`. The README has no `--serp-scan` flags list (verified: `## Manual run` at line 284 documents `--dry-run`, and `### Verifying removals (--verify)` at line 302 documents `--verify`, but there is no SERP flag documented). So the new SERP-watch section is inserted as a sibling subsection immediately AFTER the `### Verifying removals (--verify)` block ends (after its last paragraph and before the `---` separator and `## Experimental: noise mode` heading).

- [ ] Step 6.2: Add the usage section. Using the Edit tool on `/Users/stephen/scripts/auto-identity-remove/README.md`, find this existing line that closes the verify subsection (the last bullet before the `---` separator):

```
- If the broker's search page is down or slow, the result is classified as `unverifiable` (a timeout is not counted as "still listed").
```

and replace it with that same line followed by the new SERP-watch subsection:

```
- If the broker's search page is down or slow, the result is classified as `unverifiable` (a timeout is not counted as "still listed").

### Continuous SERP monitoring (`--serp-watch`)

`node watcher.js --serp-watch` runs a search-engine scan, diffs the broker domains it finds against the previous `data/serp-history.json` snapshot, and dispatches an alert (via `lib/notify.js` `dispatchNotify`: macOS toast/iMessage, Linux `notify-send`, and/or the `notify.webhook` URL) only when your name appears on a NEW domain. Because the scan appends to `data/serp-history.json`, repeated runs diff against the prior run. Add `--serp-watch` to `run.sh` to have the existing monthly scheduler watch for new exposures.
```

- [ ] Step 6.3: Verify the doc line landed. Command: `rtk grep -n "serp-watch" README.md`. Expected: at least one matching line is printed.

- [ ] Step 6.4: Commit. Run:

```
git add README.md
git commit -m "Document --serp-watch usage and scheduling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Run the full suite and confirm green

Final verification across the whole repo test suite (root + dashboard) to confirm no regressions.

Files:
- No file changes. Verification only.

- [ ] Step 7.1: Run the root suite exactly as CI does. Command: `node --test test/*.test.js dashboard/validate.test.js`. Expected: `# fail 0` (all suites pass). The new `test/serp-watch.test.js` is picked up by the `test/*.test.js` glob.

- [ ] Step 7.2: Run the dashboard suite (only changed indirectly, but CI runs it as a separate job). Command: `cd dashboard && node --test`. Expected: `# fail 0`. (No dashboard files were touched, so this is a regression guard only.)

- [ ] Step 7.3: Confirm the full `npm test` script passes (this is the exact script in root `package.json`). Command: `npm test`. Expected: exits 0 with `# fail 0`.

- [ ] Step 7.4: If anything fails, STOP and apply superpowers:systematic-debugging before proceeding. Do not mark the plan complete with a red suite.

- [ ] Step 7.5: Final commit only if Step 6 left uncommitted doc edits or Step 7 surfaced a fix. Otherwise no commit is needed (Tasks 1-6 each committed their own work). If a fix was made:

```
git add -A
git commit -m "Fix regressions surfaced by full suite for serp-watch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage:
- PURE `diffSerpResults(previous, current)` returning `{ newDomains, goneDomains, stillPresent }` - Task 2, unit-tested for new/gone/same, empty inputs, dedup, sorting, and falsy filtering.
- `--serp-watch` CLI mode that runs a scan, diffs vs the latest serp-history snapshot, and fires `lib/notify.js` `dispatchNotify` on new domains - Task 5 wiring + Task 3 orchestrator (`runSerpWatch`).
- Stores each scan in serp-history so diffs work across runs - relies on the EXISTING `appendToHistory` inside `runSerpScan` (verified in `lib/serp-scan.js` lines 381-394); `runSerpWatch` reads the prior snapshot BEFORE the scan appends (Task 3 test "reads history BEFORE running the scan").
- Schedulable under the existing scheduler - Task 6 documents adding `--serp-watch` to `run.sh`, which the launchd/systemd/crontab/schtasks jobs already invoke (verified in `lib/scheduler.js`); no scheduler code change required.
- Mode test mocking the scan + asserting notify fires only when newDomains is non-empty - Task 3 tests: fires once on new domain; does NOT fire when no new domains; first-ever run alerts; empty scan does not alert.

Signature consistency with the real repo (verified by reading the files):
- `dispatchNotify(summaryText, cfg, _platform)` - `lib/notify.js` line 186. `runSerpWatch` calls `dispatchFn(buildAlert(diff, persons), cfg)` with `cfg` = full config object so `cfg.notify` resolves, matching how `dispatchNotify` reads `cfg?.notify` (line 188). Exported by `lib/notify.js` module.exports line 209.
- `runSerpScan(context, persons, brokers, opts)` - `lib/serp-scan.js` line 314. `runSerpWatch` default dep `serpScan.runSerpScan` and the watcher branch both call it as `(context, persons, brokers)`. Summary shape `{ total_brokers_appearing, results, blocked }` is real (built at lines 404-409); Task 4 adds `hostname` to each `results` entry without breaking the existing `broker`/`ranks` fields (existing test at lines 362-378 still passes because `r.ranks.ddg` resolves).
- `readHistory()` / `HISTORY_PATH` - added to `lib/serp-scan.js` exports in Task 1; `HISTORY_PATH` is the real module-level constant (line 302).
- Watcher flag parse via `process.argv.includes('--serp-watch')` matches the existing `--serp-scan` pattern (line 29); the new branch sits inside `_mainBody()` next to the `SERP_SCAN` branch (lines 313-350) and uses `config`, `persons`, `brokers`, `context` already in scope there.
- `getPersonsFromConfig`, `config.notify`, `context` lifecycle (`context.close().catch(() => {})`) all mirror the existing SERP scan branch verbatim.

No placeholders: every test and implementation step contains complete, runnable code. No "TBD", no "add error handling", no "similar to above". The Task 2 `runSerpWatch` intentionally throws `not implemented` ONLY as the RED state for Task 3, and is replaced with a complete body in Step 3.3.

Hermetic tests: no test performs real network, spawn, or browser work. `serp-watch.test.js` injects `_runSerpScan`, `_readHistory`, and `_dispatchNotify`. `serp-scan.test.js` additions redirect `fs.readFileSync` to a stub for `readHistory` and use the existing in-memory `makeContext` page stub for `runSerpScan`. No writes touch the real `config.json`, `state.json`, or `data/serp-history.json`.

No new npm dependencies. No em dashes in authored text (hyphens only). CommonJS throughout (`require`/`module.exports`); no TypeScript.
