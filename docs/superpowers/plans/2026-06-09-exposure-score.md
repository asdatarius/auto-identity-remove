# Exposure Score with trend line Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Synthesize the project's existing privacy signals (still-listed brokers, SERP-history broker appearances, and an optional breach count) into one 0-100 exposure score (lower is better), persist a dated monthly snapshot, expose it via a `--score` CLI mode and a `GET /api/exposure` dashboard endpoint, and render the current score plus a month-over-month trend in the dashboard UI.

Architecture: A new pure function `computeExposureScore({ state, serpResults, breachCount, brokers })` in `lib/exposure.js` does all scoring math with zero I/O so it can be unit-tested across many state shapes. A separate impure helper in the same module persists a dated snapshot to `data/exposure-history.json` using the same tmp -> rename -> bak atomic-write strategy as `config.saveState`. `watcher.js` gains a read-only `--score` mode implemented as a top-level early-exit block alongside `--list` / `--pending` (no browser, unlike `--verify`, which runs inside `_mainBody`). It computes the score, prints score + breakdown + trend, and snapshots it. The dashboard adds an authenticated `GET /api/exposure` endpoint returning the current score plus history, rendered as a trend number and inline SVG sparkline in `public/index.html` + `public/app.js` with existing `esc()` escaping preserved.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict` run via `node --test`. Browser automation is Playwright (not exercised by these tests). New npm dependencies: NONE (Node built-ins `fs`/`path`/`crypto` only).

---

## File map

| File | Status | Responsibility |
|------|--------|----------------|
| `/Users/stephen/scripts/auto-identity-remove/lib/exposure.js` | Create | Pure `computeExposureScore(...)`; impure `snapshotExposure(...)` / `loadExposureHistory(...)` with atomic write; reconstruction + formatting helpers; test path override. |
| `/Users/stephen/scripts/auto-identity-remove/test/exposure.test.js` | Create | Unit tests for `computeExposureScore` across many state shapes + history snapshot round-trip (temp paths only) + helper tests. |
| `/Users/stephen/scripts/auto-identity-remove/watcher.js` | Modify | Add `--score` boolean flag (parse block lines 26-44) and a read-only `--score` early-exit mode block (inserted between the `--list` block ending line 71 and the `--pending` block starting line 73). |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js` | Modify | Add path constants after line 50 and a `GET /api/exposure` endpoint after `/api/state` (lines 327-331). |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js` | Modify | Add hermetic tests for `GET /api/exposure` (auth + shape). |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/public/index.html` | Modify | Add an exposure-score card with sparkline container as the first child of `<main>` (~line 16). |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js` | Modify | Add `loadExposure()` + `sparklineSvg()` that fetch `/api/exposure` and render score + trend + escaped sparkline; call on boot (~line 358). |
| `/Users/stephen/scripts/auto-identity-remove/.gitignore` | Modify | Add `data/exposure-history.json`. |

---

## Task 1: Pure `computeExposureScore` in `lib/exposure.js`

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/exposure.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/exposure.test.js`

Scoring contract (locked here so the test and implementation agree exactly):

- A broker key is "still listed" when EITHER:
  - `verifiedStillListedAt` exists AND (`verifiedDeletedAt` is absent OR `verifiedStillListedAt` is newer than `verifiedDeletedAt`); OR
  - `lastSuccess` exists AND `verifiedDeletedAt` is absent AND `verifiedStillListedAt` is absent (submitted but never verified -> treat as still exposed).
- `listedCount` = number of state keys that are still listed.
- `serpHits` = number of distinct broker entries in `serpResults` (the de-duplicated `results` array from `runSerpScan`). Each is weighted by best rank: rank 1-3 -> weight 3, rank 4-10 -> weight 2, rank 11+ or unknown -> weight 1. `serpWeight` is the sum of those weights. A broker with ranks across multiple engines uses its single best (lowest) numeric rank.
- `breachWeight` = `breachCount` (default 0) clamped to >= 0 (floored to an integer), multiplied by `BREACH_POINTS` (8) per breach.
- Raw points: `listedCount * LISTED_POINTS (10)` + `serpWeight * SERP_POINTS (4)` + `breachWeight`.
- `score` = `Math.min(100, Math.round(rawPoints))`. Zero signals -> 0. Lower is better.
- Return shape: `{ score, breakdown: { listed, serp, breach }, listedCount, serpHits, breachWeight }` where `breakdown.listed = listedCount * 10`, `breakdown.serp = serpWeight * 4`, `breakdown.breach = breachWeight`.

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/exposure.test.js` with the complete contents below.

```js
/**
 * test/exposure.test.js
 *
 * Pure unit tests for lib/exposure.js computeExposureScore across many state
 * shapes, plus an atomic-write round-trip for the snapshot history helpers.
 * No live network, no real browser, no writes to the real data dir
 * (history path is overridden to a temp file via setTestExposureHistoryPath).
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  computeExposureScore,
  snapshotExposure,
  loadExposureHistory,
  setTestExposureHistoryPath,
} = require('../lib/exposure');

function tmpFile() {
  return path.join(os.tmpdir(), `aidr-exposure-${crypto.randomBytes(6).toString('hex')}.json`);
}

afterEach(() => {
  setTestExposureHistoryPath(null);
});

// computeExposureScore: empty / no-signal shapes

test('computeExposureScore: empty state and no serp/breach -> score 0', () => {
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.score, 0);
  assert.equal(r.listedCount, 0);
  assert.equal(r.serpHits, 0);
  assert.equal(r.breachWeight, 0);
  assert.deepEqual(r.breakdown, { listed: 0, serp: 0, breach: 0 });
});

test('computeExposureScore: tolerates missing/garbage inputs (defaults applied)', () => {
  const r = computeExposureScore({});
  assert.equal(r.score, 0);
  assert.equal(r.listedCount, 0);
  assert.equal(r.serpHits, 0);
  assert.equal(r.breachWeight, 0);
});

// still-listed detection

test('computeExposureScore: lastSuccess with no verification counts as still listed', () => {
  const state = { optOuts: { Spokeo: { lastSuccess: '2026-01-01T00:00:00.000Z' } } };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 1);
  assert.equal(r.breakdown.listed, 10);
  assert.equal(r.score, 10);
});

test('computeExposureScore: verifiedDeletedAt newer than success is NOT still listed', () => {
  const state = {
    optOuts: {
      Spokeo: {
        lastSuccess: '2026-01-01T00:00:00.000Z',
        verifiedDeletedAt: '2026-02-01T00:00:00.000Z',
      },
    },
  };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 0);
  assert.equal(r.score, 0);
});

test('computeExposureScore: verifiedStillListedAt newer than verifiedDeletedAt IS still listed', () => {
  const state = {
    optOuts: {
      Radaris: {
        lastSuccess: '2026-01-01T00:00:00.000Z',
        verifiedDeletedAt: '2026-02-01T00:00:00.000Z',
        verifiedStillListedAt: '2026-03-01T00:00:00.000Z',
      },
    },
  };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 1);
  assert.equal(r.score, 10);
});

test('computeExposureScore: verifiedStillListedAt OLDER than verifiedDeletedAt is NOT still listed', () => {
  const state = {
    optOuts: {
      MyLife: {
        lastSuccess: '2026-01-01T00:00:00.000Z',
        verifiedStillListedAt: '2026-02-01T00:00:00.000Z',
        verifiedDeletedAt: '2026-03-01T00:00:00.000Z',
      },
    },
  };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 0);
  assert.equal(r.score, 0);
});

test('computeExposureScore: entry with no lastSuccess at all is not counted', () => {
  const state = { optOuts: { Foo: { history: ['error'] } } };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 0);
  assert.equal(r.score, 0);
});

test('computeExposureScore: multi-person keys are each counted independently', () => {
  const state = {
    optOuts: {
      'Spokeo|Jane Doe': { lastSuccess: '2026-01-01T00:00:00.000Z' },
      'Spokeo|John Doe': { lastSuccess: '2026-01-01T00:00:00.000Z', verifiedDeletedAt: '2026-02-01T00:00:00.000Z' },
    },
  };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 1);
  assert.equal(r.score, 10);
});

// SERP hit weighting

test('computeExposureScore: serp rank 1-3 weighted 3 each', () => {
  const serpResults = [
    { broker: 'Spokeo', ranks: { ddg: 2, bing: null, google: null } },
    { broker: 'Radaris', ranks: { ddg: null, bing: 3, google: null } },
  ];
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults, breachCount: 0, brokers: [] });
  assert.equal(r.serpHits, 2);
  // weight 3 + 3 = 6; serp points = 6 * 4 = 24
  assert.equal(r.breakdown.serp, 24);
  assert.equal(r.score, 24);
});

test('computeExposureScore: serp uses best (lowest) rank across engines', () => {
  const serpResults = [
    { broker: 'Spokeo', ranks: { ddg: 12, bing: 2, google: 40 } },
  ];
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults, breachCount: 0, brokers: [] });
  // best rank 2 -> weight 3 -> 3 * 4 = 12
  assert.equal(r.breakdown.serp, 12);
});

test('computeExposureScore: serp rank 4-10 weighted 2, rank 11+ weighted 1', () => {
  const serpResults = [
    { broker: 'A', ranks: { ddg: 5, bing: null, google: null } },   // weight 2
    { broker: 'B', ranks: { ddg: 25, bing: null, google: null } },  // weight 1
  ];
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults, breachCount: 0, brokers: [] });
  assert.equal(r.serpHits, 2);
  // weight 2 + 1 = 3; serp points = 3 * 4 = 12
  assert.equal(r.breakdown.serp, 12);
});

test('computeExposureScore: serp entry with all-null ranks weighted 1', () => {
  const serpResults = [
    { broker: 'A', ranks: { ddg: null, bing: null, google: null } },
  ];
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults, breachCount: 0, brokers: [] });
  assert.equal(r.serpHits, 1);
  assert.equal(r.breakdown.serp, 4); // weight 1 * 4
});

// breach weighting + default

test('computeExposureScore: breachCount defaults to 0 when omitted', () => {
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults: [] });
  assert.equal(r.breachWeight, 0);
  assert.equal(r.breakdown.breach, 0);
});

test('computeExposureScore: each breach adds 8 points', () => {
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults: [], breachCount: 3, brokers: [] });
  assert.equal(r.breachWeight, 24); // 3 * 8
  assert.equal(r.breakdown.breach, 24);
  assert.equal(r.score, 24);
});

test('computeExposureScore: negative breachCount is clamped to 0', () => {
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults: [], breachCount: -5, brokers: [] });
  assert.equal(r.breachWeight, 0);
  assert.equal(r.score, 0);
});

// combined + cap

test('computeExposureScore: combines listed + serp + breach', () => {
  const state = { optOuts: { Spokeo: { lastSuccess: '2026-01-01T00:00:00.000Z' } } };
  const serpResults = [{ broker: 'Spokeo', ranks: { ddg: 1, bing: null, google: null } }];
  const r = computeExposureScore({ state, serpResults, breachCount: 1, brokers: [] });
  // listed: 1*10 = 10 ; serp: weight 3 *4 = 12 ; breach: 1*8 = 8 ; total 30
  assert.equal(r.breakdown.listed, 10);
  assert.equal(r.breakdown.serp, 12);
  assert.equal(r.breakdown.breach, 8);
  assert.equal(r.score, 30);
});

test('computeExposureScore: score is capped at 100', () => {
  const optOuts = {};
  for (let i = 0; i < 50; i++) optOuts['B' + i] = { lastSuccess: '2026-01-01T00:00:00.000Z' };
  const r = computeExposureScore({ state: { optOuts }, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 50);
  assert.equal(r.score, 100); // 50*10 = 500 capped to 100
});

// snapshot history round-trip (impure, temp path only)

test('snapshotExposure: appends a dated entry and loadExposureHistory reads it back', () => {
  const p = tmpFile();
  setTestExposureHistoryPath(p);
  try {
    assert.deepEqual(loadExposureHistory(), []); // none yet
    const summary = { score: 30, breakdown: { listed: 10, serp: 12, breach: 8 }, listedCount: 1, serpHits: 1, breachWeight: 8 };
    const entry = snapshotExposure(summary, { now: new Date('2026-06-09T12:00:00.000Z') });
    assert.equal(entry.score, 30);
    assert.equal(entry.at, '2026-06-09T12:00:00.000Z');
    const hist = loadExposureHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].score, 30);
    assert.deepEqual(hist[0].breakdown, { listed: 10, serp: 12, breach: 8 });
  } finally {
    try { fs.unlinkSync(p); } catch (_) {}
    try { fs.unlinkSync(p + '.bak'); } catch (_) {}
  }
});

test('snapshotExposure: a second snapshot appends rather than overwrites', () => {
  const p = tmpFile();
  setTestExposureHistoryPath(p);
  try {
    const s1 = { score: 30, breakdown: { listed: 10, serp: 12, breach: 8 }, listedCount: 1, serpHits: 1, breachWeight: 8 };
    const s2 = { score: 10, breakdown: { listed: 10, serp: 0, breach: 0 }, listedCount: 1, serpHits: 0, breachWeight: 0 };
    snapshotExposure(s1, { now: new Date('2026-05-09T00:00:00.000Z') });
    snapshotExposure(s2, { now: new Date('2026-06-09T00:00:00.000Z') });
    const hist = loadExposureHistory();
    assert.equal(hist.length, 2);
    assert.equal(hist[0].score, 30);
    assert.equal(hist[1].score, 10);
  } finally {
    try { fs.unlinkSync(p); } catch (_) {}
    try { fs.unlinkSync(p + '.bak'); } catch (_) {}
  }
});

test('loadExposureHistory: returns [] when the file is absent or unparseable', () => {
  const p = tmpFile();
  setTestExposureHistoryPath(p);
  try {
    assert.deepEqual(loadExposureHistory(), []); // absent
    fs.writeFileSync(p, 'not json{');
    assert.deepEqual(loadExposureHistory(), []); // unparseable
    fs.writeFileSync(p, JSON.stringify({ not: 'an array' }));
    assert.deepEqual(loadExposureHistory(), []); // wrong shape
  } finally {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});
```

- [ ] Step 1.2: Run it, expect fail. Run `node --test test/exposure.test.js` from the repo root. Expect failure: `Cannot find module '../lib/exposure'` (the module does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/exposure.js` with the complete contents below.

```js
/**
 * lib/exposure.js
 *
 * Exposure Score: synthesizes the project's existing privacy signals into one
 * 0-100 number a non-technical person understands. Lower is better.
 *
 * Signals:
 *   - still-listed brokers   (state.optOuts entries verified still listed, or
 *                             submitted-but-never-verified)            10 pts each
 *   - SERP hits              (broker domains appearing in serp results,
 *                             weighted by best search rank)             4 pts/weight
 *   - breach exposure        (breachCount input, default 0)             8 pts each
 *
 * computeExposureScore is PURE (no I/O) and unit-tested across many state
 * shapes. snapshotExposure / loadExposureHistory persist a dated history to
 * data/exposure-history.json using the same tmp -> rename -> bak atomic-write
 * strategy as lib/config.js saveState. The history path is overridable in tests
 * via setTestExposureHistoryPath.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR     = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'exposure-history.json');

// Point weights. Tuned so a single still-listed broker (10) reads as a clear
// signal, an above-the-fold SERP hit (weight 3 -> 12) is comparable, and a known
// breach (8) is meaningful but not dominant.
const LISTED_POINTS = 10;
const SERP_POINTS   = 4;
const BREACH_POINTS = 8;
const MAX_SCORE     = 100;
const HISTORY_MAX   = 120; // ~10 years of monthly snapshots; avoids unbounded growth

// Test-only override for the history file path. null means use HISTORY_PATH.
let _testHistoryPath = null;

function setTestExposureHistoryPath(p) {
  _testHistoryPath = p || null;
}

function _getHistoryPath() {
  return _testHistoryPath || HISTORY_PATH;
}

/**
 * Decide whether a single state.optOuts entry represents a broker that is still
 * exposing the person's data.
 *
 * Still listed when EITHER:
 *   (a) verifiedStillListedAt exists AND it is newer than verifiedDeletedAt
 *       (or verifiedDeletedAt is absent), OR
 *   (b) lastSuccess exists AND the entry was never verified either way
 *       (submitted but unconfirmed -> treat as still exposed).
 *
 * @param {object} entry  a value from state.optOuts
 * @returns {boolean}
 */
function isStillListed(entry) {
  if (!entry || typeof entry !== 'object') return false;

  const stillMs = entry.verifiedStillListedAt ? Date.parse(entry.verifiedStillListedAt) : NaN;
  const goneMs  = entry.verifiedDeletedAt ? Date.parse(entry.verifiedDeletedAt) : NaN;

  if (!Number.isNaN(stillMs)) {
    // Confirmed still listed unless a deletion was confirmed at the same time or later.
    if (Number.isNaN(goneMs) || stillMs > goneMs) return true;
    return false;
  }

  // No "still listed" verification. If a deletion was confirmed, it is gone.
  if (!Number.isNaN(goneMs)) return false;

  // Never verified either way: a recorded submission means it is still exposed.
  return !!entry.lastSuccess;
}

/**
 * Map a best (lowest) search rank to a SERP weight.
 *   rank 1-3   -> 3 (above the fold)
 *   rank 4-10  -> 2 (first page)
 *   rank 11+   -> 1
 *   unknown    -> 1
 *
 * @param {number|null|undefined} bestRankValue
 * @returns {number}
 */
function serpWeightForRank(bestRankValue) {
  if (typeof bestRankValue !== 'number' || !Number.isFinite(bestRankValue)) return 1;
  if (bestRankValue <= 3) return 3;
  if (bestRankValue <= 10) return 2;
  return 1;
}

/**
 * Return the best (lowest positive) numeric rank from a ranks object, or null.
 *
 * @param {{ ddg?: number|null, bing?: number|null, google?: number|null }} ranks
 * @returns {number|null}
 */
function bestRank(ranks) {
  if (!ranks || typeof ranks !== 'object') return null;
  const nums = [ranks.ddg, ranks.bing, ranks.google].filter(
    n => typeof n === 'number' && Number.isFinite(n) && n > 0
  );
  if (nums.length === 0) return null;
  return Math.min(...nums);
}

/**
 * Compute the exposure score (PURE - no I/O).
 *
 * @param {object}   args
 * @param {object}   [args.state]        shared state object ({ optOuts: {...} })
 * @param {object[]} [args.serpResults]  runSerpScan summary.results array
 *                                       ([{ broker, ranks: {ddg,bing,google} }])
 * @param {number}   [args.breachCount]  number of known breaches (default 0)
 * @param {object[]} [args.brokers]      broker definitions (reserved; unused today)
 * @returns {{ score: number, breakdown: { listed: number, serp: number, breach: number },
 *             listedCount: number, serpHits: number, breachWeight: number }}
 */
function computeExposureScore(args) {
  const {
    state = { optOuts: {} },
    serpResults = [],
    breachCount = 0,
  } = (args || {});

  const optOuts = (state && state.optOuts && typeof state.optOuts === 'object') ? state.optOuts : {};

  let listedCount = 0;
  for (const entry of Object.values(optOuts)) {
    if (isStillListed(entry)) listedCount += 1;
  }

  const serpList = Array.isArray(serpResults) ? serpResults : [];
  let serpWeight = 0;
  for (const r of serpList) {
    serpWeight += serpWeightForRank(bestRank(r && r.ranks));
  }
  const serpHits = serpList.length;

  const breaches = Math.max(0, Math.floor(Number(breachCount) || 0));
  const breachWeight = breaches * BREACH_POINTS;

  const listedPoints = listedCount * LISTED_POINTS;
  const serpPoints   = serpWeight * SERP_POINTS;
  const rawPoints    = listedPoints + serpPoints + breachWeight;
  const score        = Math.min(MAX_SCORE, Math.round(rawPoints));

  return {
    score,
    breakdown: { listed: listedPoints, serp: serpPoints, breach: breachWeight },
    listedCount,
    serpHits,
    breachWeight,
  };
}

/**
 * Read the persisted exposure history. Returns [] on absent / unparseable /
 * wrong-shape files (never throws).
 *
 * @returns {Array<object>}
 */
function loadExposureHistory() {
  const p = _getHistoryPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Append a dated snapshot of a computeExposureScore summary to the history file
 * using an atomic tmp -> rename -> bak write (mirrors lib/config.js saveState).
 *
 * @param {object} summary  result of computeExposureScore
 * @param {object} [opts]
 * @param {Date}   [opts.now]  injectable clock for tests (default new Date())
 * @returns {object} the entry that was appended
 */
function snapshotExposure(summary, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const entry = {
    at: now.toISOString(),
    score: summary.score,
    breakdown: summary.breakdown,
    listedCount: summary.listedCount,
    serpHits: summary.serpHits,
    breachWeight: summary.breachWeight,
  };

  const history = loadExposureHistory();
  history.push(entry);
  const capped = history.slice(-HISTORY_MAX);

  const target = _getHistoryPath();
  const tmp = target + '.tmp';
  const bak = target + '.bak';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Write to .tmp first so a kill mid-write leaves the original intact.
  fs.writeFileSync(tmp, JSON.stringify(capped, null, 2));
  // Single atomic rename: on POSIX the target is never absent.
  fs.renameSync(tmp, target);
  // Rotate a backup AFTER the new file is safely in place (best-effort).
  try { fs.copyFileSync(target, bak); } catch (_) {}

  return entry;
}

module.exports = {
  computeExposureScore,
  snapshotExposure,
  loadExposureHistory,
  setTestExposureHistoryPath,
  // exported for potential reuse / targeted tests
  isStillListed,
  serpWeightForRank,
  bestRank,
  HISTORY_PATH,
};
```

- [ ] Step 1.4: Run, expect pass. Run `node --test test/exposure.test.js` from the repo root. Expect all tests passing (0 failures).

- [ ] Step 1.5: Commit.

```
git add lib/exposure.js test/exposure.test.js
git commit -m "Add pure computeExposureScore + dated snapshot history

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Ignore `data/exposure-history.json`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/.gitignore` (current contents end at line 14; `serp-history.json` is line 7, `data/serp-history.json` line 8, `inbox/` line 9)

- [ ] Step 2.1: Add the ignore line. Use Edit to insert `data/exposure-history.json` immediately after the `data/serp-history.json` line so generated snapshots are never committed.

  - old_string:
    ```
    serp-history.json
    data/serp-history.json
    inbox/
    ```
  - new_string:
    ```
    serp-history.json
    data/serp-history.json
    data/exposure-history.json
    inbox/
    ```

- [ ] Step 2.2: Verify the change. Run `rtk grep -n exposure-history .gitignore` and confirm the line is present.

- [ ] Step 2.3: Commit.

```
git add .gitignore
git commit -m "Gitignore data/exposure-history.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `--score` CLI mode in `watcher.js`

This mode is read-only with respect to brokers (no forms submitted; like `--verify` it never submits opt-out forms, but unlike `--verify` it does not launch a browser at all). It reads `state.json` and `data/serp-history.json` (no browser needed), so it is implemented as a top-level early-exit block alongside `--list` / `--pending` (lines 57-92) rather than inside the browser-launching `_mainBody()` where the `--verify` branch lives (lines 287, 374). `serpResults` is reconstructed from the persisted SERP history (best rank per broker per engine) via a new `serpResultsFromHistory` helper, so `--score` does not need a live SERP scan.

To keep the CLI fully testable and hermetic, the score-mode body relies on two new helpers added to `lib/exposure.js`: `serpResultsFromHistory(rows)` (pure reconstruction) and `formatScoreReport(summary, history)` (pure presentation). Both are unit-tested here; the `watcher.js` wiring itself is verified by the full suite still passing plus a manual smoke run (Step 3.6).

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/exposure.js` (add two helpers before `module.exports`, extend exports)
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js`
  - Flag parse block: lines 26-44 (add `SCORE_MODE` after `LIST_MODE` on line 39).
  - New early-exit block: insert between the `--list` block (ends line 71) and the `--pending` block (begins line 73).
- Test: `/Users/stephen/scripts/auto-identity-remove/test/exposure.test.js` (append helper tests)

- [ ] Step 3.1: Write the failing test. Append the following tests to `/Users/stephen/scripts/auto-identity-remove/test/exposure.test.js` (add at the end of the file, after the existing `loadExposureHistory` test).

```js
// serpResultsFromHistory (reconstruct best-rank summary from history)

const { serpResultsFromHistory, formatScoreReport } = require('../lib/exposure');

test('serpResultsFromHistory: collapses raw serp-history rows into best-rank-per-broker', () => {
  const rows = [
    { personId: 'x', broker: 'Spokeo', engine: 'ddg', rank: 5, hostname: 'spokeo.com', scannedAt: '2026-06-01T00:00:00.000Z' },
    { personId: 'x', broker: 'Spokeo', engine: 'bing', rank: 2, hostname: 'spokeo.com', scannedAt: '2026-06-01T00:00:00.000Z' },
    { personId: 'x', broker: 'Radaris', engine: 'google', rank: 12, hostname: 'radaris.com', scannedAt: '2026-06-01T00:00:00.000Z' },
  ];
  const out = serpResultsFromHistory(rows);
  const spokeo = out.find(r => r.broker === 'Spokeo');
  const radaris = out.find(r => r.broker === 'Radaris');
  assert.ok(spokeo);
  assert.equal(spokeo.ranks.ddg, 5);
  assert.equal(spokeo.ranks.bing, 2);
  assert.equal(spokeo.ranks.google, null);
  assert.ok(radaris);
  assert.equal(radaris.ranks.google, 12);
});

test('serpResultsFromHistory: empty / non-array input -> []', () => {
  assert.deepEqual(serpResultsFromHistory([]), []);
  assert.deepEqual(serpResultsFromHistory(null), []);
  assert.deepEqual(serpResultsFromHistory(undefined), []);
});

test('serpResultsFromHistory: keeps the lowest rank when a broker/engine repeats', () => {
  const rows = [
    { broker: 'Spokeo', engine: 'ddg', rank: 9 },
    { broker: 'Spokeo', engine: 'ddg', rank: 4 },
  ];
  const out = serpResultsFromHistory(rows);
  assert.equal(out[0].ranks.ddg, 4);
});

// formatScoreReport (presentational, returns a multi-line string)

test('formatScoreReport: includes the score, each breakdown line, and no trend when history is empty', () => {
  const summary = { score: 30, breakdown: { listed: 10, serp: 12, breach: 8 }, listedCount: 1, serpHits: 1, breachWeight: 8 };
  const out = formatScoreReport(summary, []);
  assert.match(out, /Exposure score/i);
  assert.match(out, /30\s*\/\s*100/);
  assert.match(out, /still-listed/i);
  assert.match(out, /search/i);
  assert.match(out, /breach/i);
  assert.match(out, /no previous snapshot/i);
});

test('formatScoreReport: shows a downward (better) trend vs the last snapshot', () => {
  const summary = { score: 10, breakdown: { listed: 10, serp: 0, breach: 0 }, listedCount: 1, serpHits: 0, breachWeight: 0 };
  const history = [{ at: '2026-05-09T00:00:00.000Z', score: 30 }];
  const out = formatScoreReport(summary, history);
  // current 10 vs previous 30 -> delta -20 (improvement). Lower is better.
  assert.match(out, /-20/);
  assert.match(out, /improv|better|down/i);
});

test('formatScoreReport: shows an upward (worse) trend vs the last snapshot', () => {
  const summary = { score: 40, breakdown: { listed: 30, serp: 8, breach: 0 }, listedCount: 3, serpHits: 2, breachWeight: 0 };
  const history = [{ at: '2026-05-09T00:00:00.000Z', score: 25 }];
  const out = formatScoreReport(summary, history);
  assert.match(out, /\+15/);
  assert.match(out, /worse|up/i);
});
```

- [ ] Step 3.2: Run it, expect fail. Run `node --test test/exposure.test.js`. Expect failures: `serpResultsFromHistory is not a function` and `formatScoreReport is not a function` (both undefined on the module exports).

- [ ] Step 3.3: Implement the two helpers. In `/Users/stephen/scripts/auto-identity-remove/lib/exposure.js`, insert the two functions immediately BEFORE the `module.exports = {` line, then extend the exports object.

  - First Edit (insert the functions). Anchor on the start of the exports block:

    - old_string:
      ```
      module.exports = {
        computeExposureScore,
        snapshotExposure,
        loadExposureHistory,
        setTestExposureHistoryPath,
        // exported for potential reuse / targeted tests
        isStillListed,
        serpWeightForRank,
        bestRank,
        HISTORY_PATH,
      };
      ```
    - new_string:
      ```
      /**
       * Collapse raw serp-history rows (as written by lib/serp-scan.js
       * appendToHistory: { broker, engine, rank, ... }) into the
       * runSerpScan-style results array, keeping the best (lowest) rank per
       * broker per engine. Lets --score reconstruct a SERP signal from the
       * persisted history without running a live scan.
       *
       * @param {Array<{ broker?: string, engine?: string, rank?: number }>} rows
       * @returns {Array<{ broker: string, ranks: { ddg: number|null, bing: number|null, google: number|null } }>}
       */
      function serpResultsFromHistory(rows) {
        if (!Array.isArray(rows)) return [];
        const byBroker = new Map();
        for (const row of rows) {
          if (!row || !row.broker || !row.engine) continue;
          const rank = (typeof row.rank === 'number' && Number.isFinite(row.rank)) ? row.rank : null;
          if (rank === null) continue;
          if (!byBroker.has(row.broker)) {
            byBroker.set(row.broker, { ddg: null, bing: null, google: null });
          }
          const ranks = byBroker.get(row.broker);
          if (!(row.engine in ranks)) continue; // ignore unknown engines
          if (ranks[row.engine] === null || rank < ranks[row.engine]) {
            ranks[row.engine] = rank;
          }
        }
        return [...byBroker.entries()].map(([broker, ranks]) => ({ broker, ranks }));
      }

      /**
       * Build a human-readable multi-line report for the --score CLI mode.
       * Trend is computed against the most recent prior history entry; lower is
       * better, so a negative delta is an improvement.
       *
       * @param {object} summary  result of computeExposureScore
       * @param {Array<{ score: number }>} history  prior snapshots (chronological)
       * @returns {string}
       */
      function formatScoreReport(summary, history) {
        const lines = [];
        const bar = '='.repeat(54);
        lines.push(bar);
        lines.push(`Exposure score: ${summary.score} / 100  (lower is better)`);
        lines.push(bar);
        lines.push(`  still-listed brokers : ${summary.listedCount}  (+${summary.breakdown.listed} pts)`);
        lines.push(`  search-result hits   : ${summary.serpHits}  (+${summary.breakdown.serp} pts)`);
        lines.push(`  breach exposure      : ${summary.breakdown.breach / 8}  (+${summary.breakdown.breach} pts)`);

        const prior = Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
        if (!prior || typeof prior.score !== 'number') {
          lines.push('  trend                : (no previous snapshot to compare)');
        } else {
          const delta = summary.score - prior.score;
          const sign = delta > 0 ? '+' : '';
          let verdict;
          if (delta < 0) verdict = 'improved (down) since last snapshot';
          else if (delta > 0) verdict = 'worse (up) since last snapshot';
          else verdict = 'unchanged since last snapshot';
          lines.push(`  trend                : ${sign}${delta} vs ${prior.score} - ${verdict}`);
        }
        lines.push(bar);
        return lines.join('\n');
      }

      module.exports = {
        computeExposureScore,
        snapshotExposure,
        loadExposureHistory,
        setTestExposureHistoryPath,
        serpResultsFromHistory,
        formatScoreReport,
        // exported for potential reuse / targeted tests
        isStillListed,
        serpWeightForRank,
        bestRank,
        HISTORY_PATH,
      };
      ```

- [ ] Step 3.4: Run, expect pass. Run `node --test test/exposure.test.js`. Expect all tests (Task 1 + Task 3) passing.

- [ ] Step 3.5: Wire the `--score` mode into `watcher.js`.

  - First Edit (add the flag). In the flag-parsing block, after line 39:

    - old_string:
      ```
      const RETRY_FAILED = process.argv.includes('--retry-failed');
      const LIST_MODE    = process.argv.includes('--list');
      ```
    - new_string:
      ```
      const RETRY_FAILED = process.argv.includes('--retry-failed');
      const LIST_MODE    = process.argv.includes('--list');
      const SCORE_MODE   = process.argv.includes('--score');
      ```

  - Second Edit (add the early-exit block). The `--list` block ends with `process.exit(0);` then `}` then a blank line; the `--pending` comment is on the next line. Insert the new block before that comment:

    - old_string:
      ```
      // ── --pending: print brokers awaiting email confirmation, then exit ──────────
      if (PENDING_MODE) {
      ```
    - new_string:
      ```
      // ── --score: print the exposure score + breakdown + trend, then exit ─────────
      // Read-only: no browser, no forms submitted. Reads state.json and the
      // persisted SERP history; persists a dated snapshot to data/exposure-history.json.
      if (SCORE_MODE) {
        const brokers = require('./brokers');
        const state   = loadState();
        const {
          computeExposureScore,
          serpResultsFromHistory,
          loadExposureHistory,
          snapshotExposure,
          formatScoreReport,
        } = require('./lib/exposure');

        // Reconstruct the SERP signal from persisted history (no live scan).
        let serpRows = [];
        const serpHistoryPath = path.join(__dirname, 'data', 'serp-history.json');
        try {
          serpRows = JSON.parse(fs.readFileSync(serpHistoryPath, 'utf8'));
          if (!Array.isArray(serpRows)) serpRows = [];
        } catch (_) { serpRows = []; }
        const serpResults = serpResultsFromHistory(serpRows);

        // breachCount defaults to 0 until HIBP integration lands.
        const summary = computeExposureScore({ state, serpResults, breachCount: 0, brokers });

        const priorHistory = loadExposureHistory();
        console.log('\n' + formatScoreReport(summary, priorHistory));
        // Persist this run's snapshot (skipped in dry-run to honor that contract).
        if (!DRY_RUN) snapshotExposure(summary);
        console.log('');
        process.exit(0);
      }

      // ── --pending: print brokers awaiting email confirmation, then exit ──────────
      if (PENDING_MODE) {
      ```

- [ ] Step 3.6: Smoke-check the wiring manually (hermetic, no network). Run `node watcher.js --score --dry-run` from the repo root. Expect output containing `Exposure score:` and a `trend` line, exit code 0, and NO write to `data/exposure-history.json`. Then run `node watcher.js --score` once and confirm `data/exposure-history.json` is created; verify with `rtk read data/exposure-history.json`. (This file is gitignored per Task 2.)

- [ ] Step 3.7: Run the full unit suite to confirm nothing regressed. Run `node --test test/*.test.js dashboard/validate.test.js` from the repo root. Expect all passing.

- [ ] Step 3.8: Commit.

```
git add watcher.js lib/exposure.js test/exposure.test.js
git commit -m "Add --score CLI mode: exposure score + breakdown + trend snapshot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `GET /api/exposure` dashboard endpoint

Returns the current computed score plus the persisted history. Reads `state.json` (via the existing `STATE` path constant), the SERP history file, and the exposure history file. Uses the parent repo's `lib/exposure.js`, required by absolute path the same way `server.js` requires `../brokers.js` via the `BROKERS` constant (line 50).

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js`
  - Add path constants after line 50 (`const BROKERS = ...`).
  - Add the endpoint after the `/api/state` route (ends line 331), before `/api/summary` (line 333).
- Test: `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js` (append tests using the existing `buildServer` / `request` / `basicAuth` helpers).

- [ ] Step 4.1: Write the failing test. Append the following two tests to `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js` (at the end of the file, after the last existing test). They reuse the existing top-of-file helpers `buildServer`, `request`, `basicAuth`.

```js
test('/api/exposure returns a current score, breakdown and history array', async () => {
  const stateContent = {
    optOuts: {
      Spokeo: { lastSuccess: '2026-01-01T00:00:00.000Z' }, // still listed (never verified)
      MyLife: { lastSuccess: '2026-01-01T00:00:00.000Z', verifiedDeletedAt: '2026-02-01T00:00:00.000Z' }, // gone
    },
  };
  const { server, close } = await buildServer({ stateContent });
  try {
    const r = await request(server, {
      pathname: '/api/exposure',
      headers: { Authorization: basicAuth('testuser', 'testpass') },
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.score, 'number');
    assert.equal(r.json.listedCount, 1); // Spokeo still listed, MyLife gone
    assert.ok(r.json.breakdown && typeof r.json.breakdown.listed === 'number');
    assert.ok(Array.isArray(r.json.history));
  } finally {
    await close();
  }
});

test('/api/exposure requires auth', async () => {
  const { server, close } = await buildServer();
  try {
    const r = await request(server, { pathname: '/api/exposure' });
    assert.equal(r.status, 401);
  } finally {
    await close();
  }
});
```

- [ ] Step 4.2: Run it, expect fail. From the repo root run `node --test dashboard/server.test.js`. Expect the new exposure shape test to fail: the route is unregistered, so express falls through to the static handler / 404 and `r.json` is null, so `typeof r.json.score === 'number'` throws/fails. (The auth test passes against the missing route only because the auth middleware runs before route resolution; the shape test is the one that drives the implementation.)

- [ ] Step 4.3: Implement.

  - First Edit (add path constants after the BROKERS constant on line 50):

    - old_string:
      ```
      const BROKERS = path.join(ROOT, 'brokers.js');
      ```
    - new_string:
      ```
      const BROKERS = path.join(ROOT, 'brokers.js');
      const SERP_HISTORY = path.join(ROOT, 'data', 'serp-history.json');
      const EXPOSURE_LIB = path.join(ROOT, 'lib', 'exposure.js');
      ```

  - Second Edit (insert the endpoint between `/api/state` and `/api/summary`):

    - old_string:
      ```
      app.get('/api/state', (_req, res) => {
        const m = readJsonMeta(STATE);
        if (m.parseError) return res.json({ error: 'state.json could not be parsed' });
        res.json(m.data || {});
      });

      app.get('/api/summary', (_req, res) => {
      ```
    - new_string:
      ```
      app.get('/api/state', (_req, res) => {
        const m = readJsonMeta(STATE);
        if (m.parseError) return res.json({ error: 'state.json could not be parsed' });
        res.json(m.data || {});
      });

      // GET /api/exposure -> current exposure score (computed from state.json +
      // persisted SERP history) plus the dated snapshot history. The score math
      // lives in the parent repo's lib/exposure.js (pure, unit-tested there).
      app.get('/api/exposure', (_req, res) => {
        let exposure;
        try { exposure = require(EXPOSURE_LIB); }
        catch (e) { return res.status(500).json({ error: 'exposure module unavailable: ' + e.message }); }

        const state = readJsonSafe(STATE, { optOuts: {} });
        const serpRows = readJsonSafe(SERP_HISTORY, []);
        const serpResults = exposure.serpResultsFromHistory(Array.isArray(serpRows) ? serpRows : []);
        const summary = exposure.computeExposureScore({
          state: state && state.optOuts ? state : { optOuts: {} },
          serpResults,
          breachCount: 0,
          brokers: loadBrokers(),
        });
        const history = exposure.loadExposureHistory();
        res.json({ ...summary, history });
      });

      app.get('/api/summary', (_req, res) => {
      ```

- [ ] Step 4.4: Run, expect pass. From the repo root run `node --test dashboard/server.test.js`. Expect all tests passing including the two new exposure tests.

- [ ] Step 4.5: Commit.

```
git add dashboard/server.js dashboard/server.test.js
git commit -m "Add GET /api/exposure dashboard endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Render score + trend + sparkline in the dashboard UI

The frontend has no unit-test harness (it is plain DOM JS loaded by `index.html`). Per the existing convention (see `app.js` `loadSummary`/`renderBrokers`), every data-influenced value MUST pass through `esc()` before entering `innerHTML`, and the sparkline is built from numeric history values only (coerced with `Number(...)` and clamped 0-100), never raw strings interpolated into markup. Error strings use `textContent`, never `innerHTML`. Verification is by code review against the escaping rules plus the server test in Task 4 confirming the API shape.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/public/index.html` (add a card as the first child of `<main>`, ~line 16).
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js` (add `loadExposure()` + `sparklineSvg()`; call on boot ~line 358).

- [ ] Step 5.1: Add the score container to `index.html`. The `<main>` tag is on line 16 and its first child is the `<section class="card run-card">` on line 17. Insert the exposure card before the run card via Edit:

  - old_string:
    ```
      <main>
        <section class="card run-card">
    ```
  - new_string:
    ```
      <main>
        <section class="card exposure-card" id="exposureCard" aria-label="Exposure score">
          <div class="exposure-head">
            <div class="exposure-score">
              <span class="exposure-num" id="exposureNum">—</span>
              <span class="exposure-max">/ 100</span>
            </div>
            <div class="exposure-meta">
              <div class="exposure-title">Exposure score <span class="dim">(lower is better)</span></div>
              <div class="exposure-trend" id="exposureTrend"></div>
            </div>
            <div class="exposure-spark" id="exposureSpark" aria-hidden="true"></div>
          </div>
          <div class="exposure-breakdown" id="exposureBreakdown"></div>
        </section>
        <section class="card run-card">
    ```

- [ ] Step 5.2: Add `loadExposure()` + `sparklineSvg()` to `app.js`. Insert the functions immediately before the `// ---------- footer (version) ----------` comment (line 352). All string fragments are escaped with `esc()`; the SVG path data is built only from `Number`-coerced, clamped numerics; the error path uses `textContent`.

  - First Edit (insert the functions):

    - old_string:
      ```
      // ---------- footer (version) ----------
      api('/version').then(v => {
      ```
    - new_string:
      ```
      // ---------- exposure score ----------
      // Build a tiny inline SVG sparkline from numeric history scores only. Every
      // value is coerced to Number and clamped 0-100, so nothing data-influenced
      // is interpolated as raw text into markup. Trend/breakdown string fragments
      // are escaped with esc(); error text uses textContent.
      function sparklineSvg(scores) {
        const nums = (Array.isArray(scores) ? scores : [])
          .map(n => Number(n))
          .filter(n => Number.isFinite(n))
          .map(n => Math.max(0, Math.min(100, n)));
        if (nums.length < 2) return '';
        const W = 120, H = 28, pad = 2;
        const span = nums.length - 1;
        const pts = nums.map((v, i) => {
          const x = pad + (i / span) * (W - 2 * pad);
          const y = H - pad - (v / 100) * (H - 2 * pad); // higher score = higher line = worse
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        // points/dimensions are numbers only; safe to inline.
        return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="exposure score trend">`
          + `<polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${pts}" /></svg>`;
      }
      async function loadExposure() {
        try {
          const e = await api('/exposure');
          if (!e || e.error || typeof e.score !== 'number') {
            $('#exposureNum').textContent = '—';
            $('#exposureTrend').textContent = e && e.error ? String(e.error) : '';
            return;
          }
          $('#exposureNum').textContent = String(e.score);
          const hist = Array.isArray(e.history) ? e.history : [];
          const prior = hist.length ? hist[hist.length - 1] : null;
          const priorScore = prior && typeof prior.score === 'number' ? prior.score : null;
          const trendEl = $('#exposureTrend');
          if (priorScore === null) {
            trendEl.innerHTML = '<span class="pill muted">no trend yet</span>';
          } else {
            const delta = e.score - priorScore;
            const cls = delta < 0 ? 'good' : delta > 0 ? 'bad' : 'muted';
            const arrow = delta < 0 ? 'down' : delta > 0 ? 'up' : 'flat';
            const sign = delta > 0 ? '+' : '';
            trendEl.innerHTML = `<span class="pill ${cls}">${esc(arrow + ' ' + sign + delta)} vs last</span>`;
          }
          const b = e.breakdown || { listed: 0, serp: 0, breach: 0 };
          $('#exposureBreakdown').innerHTML = [
            `<span class="pill muted">${esc(e.listedCount)} still listed (+${esc(b.listed)})</span>`,
            `<span class="pill muted">${esc(e.serpHits)} search hits (+${esc(b.serp)})</span>`,
            `<span class="pill muted">breach +${esc(b.breach)}</span>`,
          ].join('');
          $('#exposureSpark').innerHTML = sparklineSvg(hist.map(h => h && h.score));
        } catch (_) {
          $('#exposureNum').textContent = '—';
        }
      }

      // ---------- footer (version) ----------
      api('/version').then(v => {
      ```

  - Second Edit (call loadExposure on boot):

    - old_string:
      ```
      // ---------- boot ----------
      loadSummary(); loadBrokers();
      ```
    - new_string:
      ```
      // ---------- boot ----------
      loadSummary(); loadBrokers(); loadExposure();
      ```

- [ ] Step 5.3: Verify escaping and shape by code review. Confirm every interpolation in `loadExposure` / `sparklineSvg` is either (a) routed through `esc()`, (b) a `Number`-coerced numeric clamped 0-100, or (c) assigned via `textContent` (not `innerHTML`). Confirm no raw `e.error` reaches `innerHTML` (it uses `textContent`). Run `rtk grep -n "innerHTML" dashboard/public/app.js` and eyeball the new lines: the only interpolated dynamic values are `esc(...)`-wrapped fragments, the `cls` token (a fixed literal `good`/`bad`/`muted`), and the numeric SVG `points`/dimensions.

- [ ] Step 5.4: Run the dashboard server suite to confirm nothing broke server-side (the frontend has no unit tests; its API contract is covered by Task 4). From the repo root run `node --test dashboard/server.test.js dashboard/validate.test.js`. Expect all passing.

- [ ] Step 5.5: Commit.

```
git add dashboard/public/index.html dashboard/public/app.js
git commit -m "Render exposure score + trend + sparkline in dashboard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full suite green (root + dashboard)

Files: none modified (verification only).

- [ ] Step 6.1: Run the root test suite exactly as CI does (`.github/workflows/test.yml` job `test`). From the repo root run `node --test test/*.test.js dashboard/validate.test.js`. Expect 0 failures. This includes the new `test/exposure.test.js`.

- [ ] Step 6.2: Run the dashboard suite exactly as CI does (job `dashboard`, `working-directory: dashboard`). From the repo root run the compound command `cd dashboard && node --test`. Expect 0 failures including the new `/api/exposure` tests in `server.test.js`.

- [ ] Step 6.3: Confirm the generated history file is gitignored and not staged. Run `rtk git status` and confirm `data/exposure-history.json` (and any `.bak`/`.tmp` sibling) does NOT appear as an untracked file to be added (it is ignored per Task 2).

- [ ] Step 6.4: If everything is green and clean, the feature is complete. Each task was committed individually. If the executing agent is on the default branch, it should have created a feature branch before the first commit per repo workflow rules and should open a PR only when the user asks.

---

## Self-review

Spec coverage:
- New `lib/exposure.js` exports a PURE `computeExposureScore({ state, serpResults, breachCount, brokers })` returning exactly `{ score, breakdown, listedCount, serpHits, breachWeight }` (Task 1). No I/O in that function; all data comes from the passed-in args. Done.
- "Still listed" rule implemented exactly as specified: `verifiedStillListedAt` newer than `verifiedDeletedAt`, OR `lastSuccess` present with no verification (Task 1 `isStillListed`, tested across 7 state shapes including multi-person keys `"Broker|First Last"` which match the real `stateKey` convention in `lib/config.js` lines 265-268 and the fields written by `lib/verify-loop.js` lines 153-165). Done.
- Weighting: still-listed brokers + SERP hits weighted by rank + breach exposure with `breachCount` default 0 (Task 1, tested). The `serpResults` shape matches the real `runSerpScan` summary `results` array `[{ broker, ranks: { ddg, bing, google } }]` from `lib/serp-scan.js` lines 399-411; `--score` reconstructs it from persisted history rows (`{ broker, engine, rank, ... }` written by `appendToHistory`, lib/serp-scan.js lines 385-394) via `serpResultsFromHistory`. Done.
- Dated snapshot persisted to `data/exposure-history.json` via atomic tmp -> rename -> bak, mirroring `lib/config.js` `saveState` (lines 115-129). Added to `.gitignore` (Task 2). Done.
- `--score` CLI mode in `watcher.js`: read-only (no browser, no forms), prints score + breakdown + trend (delta vs last snapshot), persists a snapshot, honors `--dry-run` (no persist). Implemented as an early-exit block alongside `--list`/`--pending`, consistent with flag parsing (lines 26-44) and the read-only-mode pattern (lines 57-92). Done.
- `GET /api/exposure` dashboard endpoint returns current score + history, sits under the existing auth middleware (registered after `/api/state`, before `/api/summary`), requires auth (tested), reuses `readJsonSafe`/`loadBrokers` and requires the parent `lib/exposure.js` the same way `server.js` requires `../brokers.js` (Task 4). Done.
- Dashboard UI renders a trend number + SVG sparkline with escaping intact: every string fragment uses `esc()` (matching the `app.js` convention at lines 16-17, 31-41, 66-92), numeric sparkline values are `Number`-coerced and clamped 0-100, error strings use `textContent` (Task 5). Done.
- Final task runs both CI suites (`node --test test/*.test.js dashboard/validate.test.js` and `cd dashboard && node --test`) confirming green (Task 6). Done.

No placeholders: every code step contains complete, runnable code (full function bodies, full test files, exact `old_string`/`new_string` Edit pairs). No "TBD", no "similar to above", no unfinished error-handling stubs.

Signature consistency with the real repo map:
- `loadState()` returns the shared mutable state object (used read-only by `--score`); `loadConfig`/`getPersonsFromConfig` are not needed by `--score` since the score depends only on state + serp history. Matches `lib/config.js` exports.
- `lib/exposure.js` is new; its exports (`computeExposureScore`, `snapshotExposure`, `loadExposureHistory`, `setTestExposureHistoryPath`, `serpResultsFromHistory`, `formatScoreReport`, plus internal helpers and `HISTORY_PATH`) are self-consistent across the plan's tests, the `watcher.js` require, and the `server.js` require.
- `dashboard/server.js` reuses real helpers `readJsonSafe` (lines 158-161) and `loadBrokers` (lines 181-190) and the `STATE`/`ROOT` path constants (lines 46-49); the new `SERP_HISTORY`/`EXPOSURE_LIB` constants follow the existing `ROOT`-relative pattern. The new route is added under the existing auth + CSRF middleware so it requires auth like every route except `/api/health`.
- `dashboard/public/app.js` reuses real globals `$`, `$$`, `api`, `esc` (lines 2-17); new container ids (`#exposureNum`, `#exposureTrend`, `#exposureBreakdown`, `#exposureSpark`) are added to `index.html` in Task 5.
- Tests use `node:test` + `node:assert/strict`, factory-style temp paths via `crypto.randomBytes`, an injectable clock (`opts.now`), and a test path override (`setTestExposureHistoryPath`) for hermeticity - matching the DI conventions in `test/serp-scan.test.js` (`_skipWrite`, console silencing) and `dashboard/server.test.js` (`buildServer`/`request`/`basicAuth`). No real network, no real browser, no writes to the real `config.json`/`state.json` (the exposure tests touch only temp files; the dashboard tests reuse the existing `buildServer` harness that stashes and restores the real files).
- No em dashes in authored prose (hyphens only; the `—` glyphs inside fenced code blocks are pre-existing UI strings from `index.html`/`app.js` being matched, not authored prose). No new npm dependencies (Node built-ins `fs`/`path`/`crypto` only); CommonJS throughout.
