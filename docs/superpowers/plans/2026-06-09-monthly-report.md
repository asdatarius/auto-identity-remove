# Monthly PDF + plain-English email report Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Generate a monthly opt-out report (PDF + emailable HTML) that summarizes what happened in plain English, attaches form-submission snapshots as receipts, lists the "things that need you" actions, and either emails it via SMTP or saves it and notifies.

Architecture: A new pure module `lib/report.js` exports `buildReportModel({ state, diff, brokers, exposure })` (no I/O, fully unit-tested) and `renderReportHtml(model)` (returns an escaped HTML string). A second function `renderReportPdf({ html, outPath, context })` uses the already-present Playwright `context.newPage()` + `page.setContent(html)` + `page.pdf({ path })` to write a PDF - no new PDF dependency. A new `--report` CLI mode in `watcher.js` builds the model from the live state + last run log, renders HTML, writes the PDF under `logs/reports/`, then emails the HTML via `lib/email.js` SMTP when configured, otherwise notifies via `lib/notify.js`. The scheduler entry already runs monthly, so `--report` simply becomes a separately schedulable invocation.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict` in the existing factory-function style (no `beforeEach`/`let`-mutation; reset modules in place). Browser automation uses the already-present Playwright; tests NEVER launch a real browser - the Playwright `context` is injected and stubbed. No new npm dependencies.

---

## File map

| File | Created / Modified | Responsibility |
| --- | --- | --- |
| `lib/report.js` | Created | Pure `buildReportModel`, escaped `renderReportHtml`, Playwright-backed `renderReportPdf`, plus `_escapeHtml`, `REPORT_DIR`, `reportPdfPath`. |
| `test/report-model.test.js` | Created | Unit tests for `buildReportModel` over many state shapes (verified, submitted, still-listed, pending, captcha/manual, score trend). |
| `test/report-html.test.js` | Created | Unit tests for `renderReportHtml` (HTML escaping of PII, section presence, action-list rendering). |
| `test/report-pdf.test.js` | Created | Unit test for `renderReportPdf` using a fake Playwright context (no real browser). |
| `watcher.js` | Modified (lines 26-44 flag block; new mode branch before/at the doctor ladder; bottom else-block) | Adds `--report` flag parsing and a `runReport()` mode that builds the model, renders HTML+PDF, emails or notifies, then exits. |
| `.gitignore` | Modified (after line 11 `logs/snapshots/`) | Ignore `logs/reports/` (PDFs contain PII). |

---

## Task 1: Pure `buildReportModel` in `lib/report.js`

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/report.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/report-model.test.js`

`buildReportModel` is pure: it reads a `state` object (the `lib/config.js` state schema, `{ optOuts: { <key>: { history, lastSuccess, lastAttempt, pendingConfirm, verifiedDeletedAt, verifiedStillListedAt, verifyHistory } } }`), an optional `diff` (the `lib/diff.js` `diffResults` shape `{ newExposures, newlyRemoved, regressed, summary }`), the `brokers` array (used only to resolve `expectedSender` hints for pending entries), and an optional `exposure` object (the `lib/serp-scan.js` `runSerpScan` summary shape `{ total_brokers_appearing }`, possibly with a `previous` count for trend). It returns:

```
{
  period: string,                  // e.g. "2026-06"
  removedVerified: [{ broker, verifiedAt }],
  submitted: [{ broker, lastSuccess }],
  stillListed: [{ broker, verifiedStillListedAt }],
  awaitingConfirmation: [{ broker, since, expectedSender }],
  errors: [{ broker, lastHistory }],
  actionsNeeded: [{ kind, broker, detail }],
  scoreTrend: { current, previous, delta, direction }
}
```

Action-list rules (from the feature spec):
- `pendingConfirm` older than `staleAfterDays` (default 14) -> action `kind: 'confirm_email'` ("click the confirmation email").
- `verifiedStillListedAt` newer than `lastSuccess` -> action `kind: 'still_listed'` ("broker re-listed you").
- last history entry is `captcha_failed` or `error` -> action `kind: 'manual'` ("manual action needed").

- [ ] **Step 1.1: Write the failing test.** Create `/Users/stephen/scripts/auto-identity-remove/test/report-model.test.js` with this COMPLETE content:

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildReportModel } = require('../lib/report');

// ── Factory helpers (no shared mutable state) ──────────────────────────────────

const BROKERS = [
  { name: 'Spokeo', expectedSender: 'privacy@spokeo.com' },
  { name: 'Radaris' },
  { name: 'BeenVerified' },
  { name: 'MyLife' },
];

function makeState(optOuts) {
  return { optOuts };
}

// A fixed "now" so day-based gates are deterministic.
const NOW = new Date('2026-06-09T12:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

// ── period ─────────────────────────────────────────────────────────────────────

describe('buildReportModel period', () => {
  it('derives the period as YYYY-MM from the provided now', () => {
    const model = buildReportModel({ state: makeState({}), brokers: BROKERS, now: NOW });
    assert.equal(model.period, '2026-06');
  });
});

// ── removedVerified ──────────────────────────────────────────────────────────

describe('buildReportModel removedVerified', () => {
  it('lists brokers whose verifiedDeletedAt is newer than lastSuccess', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(40), verifiedDeletedAt: daysAgo(10) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.removedVerified, [
      { broker: 'Spokeo', verifiedAt: daysAgo(10) },
    ]);
  });

  it('does not list a broker whose verifiedDeletedAt is older than lastSuccess', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(5), verifiedDeletedAt: daysAgo(40) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.removedVerified, []);
  });
});

// ── submitted ────────────────────────────────────────────────────────────────

describe('buildReportModel submitted', () => {
  it('lists brokers with a lastSuccess that are not yet verified-clear', () => {
    const state = makeState({
      Radaris: { lastSuccess: daysAgo(3) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.submitted, [
      { broker: 'Radaris', lastSuccess: daysAgo(3) },
    ]);
  });

  it('excludes from submitted any broker already in removedVerified', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(40), verifiedDeletedAt: daysAgo(10) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.submitted, []);
    assert.equal(model.removedVerified.length, 1);
  });
});

// ── stillListed ──────────────────────────────────────────────────────────────

describe('buildReportModel stillListed', () => {
  it('lists brokers re-listed after a successful submit', () => {
    const state = makeState({
      BeenVerified: { lastSuccess: daysAgo(30), verifiedStillListedAt: daysAgo(2) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.stillListed, [
      { broker: 'BeenVerified', verifiedStillListedAt: daysAgo(2) },
    ]);
  });
});

// ── awaitingConfirmation ──────────────────────────────────────────────────────

describe('buildReportModel awaitingConfirmation', () => {
  it('lists pending-confirm brokers with sender hint from the broker def', () => {
    const state = makeState({
      Spokeo: { pendingConfirm: { since: daysAgo(3), snippet: 'check inbox' } },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.awaitingConfirmation, [
      { broker: 'Spokeo', since: daysAgo(3), expectedSender: 'privacy@spokeo.com' },
    ]);
  });

  it('omits a broker from awaitingConfirmation once a later success exists', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(1), pendingConfirm: { since: daysAgo(10) } },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.awaitingConfirmation, []);
  });
});

// ── errors ───────────────────────────────────────────────────────────────────

describe('buildReportModel errors', () => {
  it('lists brokers whose most recent history entry is error', () => {
    const state = makeState({
      MyLife: { history: ['success', 'error'] },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.errors, [
      { broker: 'MyLife', lastHistory: 'error' },
    ]);
  });
});

// ── actionsNeeded ────────────────────────────────────────────────────────────

describe('buildReportModel actionsNeeded', () => {
  it('flags confirm_email for pending older than staleAfterDays', () => {
    const state = makeState({
      Spokeo: { pendingConfirm: { since: daysAgo(20) } },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW, staleAfterDays: 14 });
    const confirm = model.actionsNeeded.find(a => a.broker === 'Spokeo');
    assert.equal(confirm.kind, 'confirm_email');
  });

  it('does NOT flag confirm_email for pending newer than staleAfterDays', () => {
    const state = makeState({
      Spokeo: { pendingConfirm: { since: daysAgo(3) } },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW, staleAfterDays: 14 });
    assert.equal(model.actionsNeeded.find(a => a.broker === 'Spokeo'), undefined);
  });

  it('flags still_listed for a broker re-listed after success', () => {
    const state = makeState({
      BeenVerified: { lastSuccess: daysAgo(30), verifiedStillListedAt: daysAgo(2) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    const action = model.actionsNeeded.find(a => a.broker === 'BeenVerified');
    assert.equal(action.kind, 'still_listed');
  });

  it('flags manual for captcha_failed or error as the latest history', () => {
    const state = makeState({
      Radaris: { history: ['captcha_failed'] },
      MyLife: { history: ['success', 'error'] },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    const kinds = model.actionsNeeded.filter(a => a.kind === 'manual').map(a => a.broker).sort();
    assert.deepEqual(kinds, ['MyLife', 'Radaris']);
  });

  it('returns an empty action list when nothing needs the user', () => {
    const state = makeState({
      Spokeo: { lastSuccess: daysAgo(40), verifiedDeletedAt: daysAgo(10) },
    });
    const model = buildReportModel({ state, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.actionsNeeded, []);
  });
});

// ── scoreTrend ───────────────────────────────────────────────────────────────

describe('buildReportModel scoreTrend', () => {
  it('reports improving when exposure dropped versus previous', () => {
    const model = buildReportModel({
      state: makeState({}),
      brokers: BROKERS,
      now: NOW,
      exposure: { total_brokers_appearing: 2, previous: 5 },
    });
    assert.deepEqual(model.scoreTrend, { current: 2, previous: 5, delta: -3, direction: 'improving' });
  });

  it('reports worsening when exposure grew versus previous', () => {
    const model = buildReportModel({
      state: makeState({}),
      brokers: BROKERS,
      now: NOW,
      exposure: { total_brokers_appearing: 6, previous: 4 },
    });
    assert.deepEqual(model.scoreTrend, { current: 6, previous: 4, delta: 2, direction: 'worsening' });
  });

  it('reports flat / null-previous safely when no exposure data provided', () => {
    const model = buildReportModel({ state: makeState({}), brokers: BROKERS, now: NOW });
    assert.deepEqual(model.scoreTrend, { current: null, previous: null, delta: null, direction: 'unknown' });
  });
});

// ── robustness ───────────────────────────────────────────────────────────────

describe('buildReportModel robustness', () => {
  it('handles an empty state without throwing', () => {
    const model = buildReportModel({ state: makeState({}), brokers: BROKERS, now: NOW });
    assert.deepEqual(model.removedVerified, []);
    assert.deepEqual(model.submitted, []);
    assert.deepEqual(model.stillListed, []);
    assert.deepEqual(model.awaitingConfirmation, []);
    assert.deepEqual(model.errors, []);
    assert.deepEqual(model.actionsNeeded, []);
  });

  it('tolerates a missing optOuts object', () => {
    const model = buildReportModel({ state: {}, brokers: BROKERS, now: NOW });
    assert.deepEqual(model.submitted, []);
  });
});
```

- [ ] **Step 1.2: Run it, expect fail.** Run `node --test test/report-model.test.js`. Expected failure: `Cannot find module '../lib/report'` (the module does not exist yet).

- [ ] **Step 1.3: Implement.** Create `/Users/stephen/scripts/auto-identity-remove/lib/report.js` with the `buildReportModel` function (and the module skeleton). Write this COMPLETE content (the HTML/PDF functions are added in Tasks 2 and 3 - for now create the file with `buildReportModel` plus placeholder exports so requiring works):

```js
'use strict';

/**
 * lib/report.js
 *
 * Monthly opt-out report:
 *   - buildReportModel(opts)  pure data model (unit-tested, no I/O)
 *   - renderReportHtml(model) escaped HTML string (unit-tested)
 *   - renderReportPdf(opts)   Playwright-backed PDF writer (context injected)
 *
 * PDFs contain PII; they are written under logs/reports/ which is gitignored.
 */

const path = require('path');

const REPORT_DIR = path.join(__dirname, '..', 'logs', 'reports');

const STALE_PENDING_DAYS = 14;

function _daysBetween(laterIso, earlierMs) {
  return (earlierMs - new Date(laterIso).getTime()) / (1000 * 60 * 60 * 24);
}

function _isVerifiedClear(entry) {
  if (!entry || !entry.verifiedDeletedAt) return false;
  if (!entry.lastSuccess) return true;
  return new Date(entry.verifiedDeletedAt).getTime() > new Date(entry.lastSuccess).getTime();
}

function _isStillListed(entry) {
  if (!entry || !entry.verifiedStillListedAt) return false;
  if (!entry.lastSuccess) return true;
  return new Date(entry.verifiedStillListedAt).getTime() > new Date(entry.lastSuccess).getTime();
}

function _isPending(entry) {
  if (!entry || !entry.pendingConfirm || !entry.pendingConfirm.since) return false;
  if (!entry.lastSuccess) return true;
  return new Date(entry.pendingConfirm.since).getTime() > new Date(entry.lastSuccess).getTime();
}

function _lastHistory(entry) {
  if (!entry || !Array.isArray(entry.history) || entry.history.length === 0) return null;
  return entry.history[entry.history.length - 1];
}

function _scoreTrend(exposure) {
  if (!exposure || typeof exposure.total_brokers_appearing !== 'number') {
    return { current: null, previous: null, delta: null, direction: 'unknown' };
  }
  const current = exposure.total_brokers_appearing;
  const previous = typeof exposure.previous === 'number' ? exposure.previous : null;
  if (previous === null) {
    return { current, previous: null, delta: null, direction: 'unknown' };
  }
  const delta = current - previous;
  const direction = delta < 0 ? 'improving' : delta > 0 ? 'worsening' : 'flat';
  return { current, previous, delta, direction };
}

/**
 * Build the pure report data model.
 *
 * @param {object} opts
 * @param {{ optOuts?: Record<string, object> }} opts.state  config.js state object
 * @param {Array<{ name: string, expectedSender?: string }>} [opts.brokers]
 * @param {object} [opts.diff]      diffResults() output (optional, surfaced as-is)
 * @param {{ total_brokers_appearing?: number, previous?: number }} [opts.exposure]
 * @param {Date}   [opts.now]       injectable clock (default new Date())
 * @param {number} [opts.staleAfterDays]  pending-confirm staleness threshold (default 14)
 * @returns {object}
 */
function buildReportModel(opts = {}) {
  const { state = {}, brokers = [], diff = null, exposure = null } = opts;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const staleAfterDays = typeof opts.staleAfterDays === 'number' ? opts.staleAfterDays : STALE_PENDING_DAYS;
  const nowMs = now.getTime();

  const optOuts = (state && state.optOuts) || {};
  const brokerMap = new Map(brokers.map(b => [b.name, b]));

  const removedVerified = [];
  const submitted = [];
  const stillListed = [];
  const awaitingConfirmation = [];
  const errors = [];
  const actionsNeeded = [];

  for (const [key, entry] of Object.entries(optOuts)) {
    const brokerName = key.includes('|') ? key.slice(0, key.indexOf('|')) : key;

    if (_isVerifiedClear(entry)) {
      removedVerified.push({ broker: brokerName, verifiedAt: entry.verifiedDeletedAt });
    } else if (entry.lastSuccess) {
      submitted.push({ broker: brokerName, lastSuccess: entry.lastSuccess });
    }

    if (_isStillListed(entry)) {
      stillListed.push({ broker: brokerName, verifiedStillListedAt: entry.verifiedStillListedAt });
      actionsNeeded.push({ kind: 'still_listed', broker: brokerName, detail: 'This broker re-listed you after removal.' });
    }

    if (_isPending(entry)) {
      const expectedSender = (brokerMap.get(brokerName) || {}).expectedSender;
      awaitingConfirmation.push({ broker: brokerName, since: entry.pendingConfirm.since, expectedSender });
      const ageDays = _daysBetween(entry.pendingConfirm.since, nowMs);
      if (ageDays >= staleAfterDays) {
        actionsNeeded.push({ kind: 'confirm_email', broker: brokerName, detail: 'Click the confirmation link in the broker email.' });
      }
    }

    const last = _lastHistory(entry);
    if (last === 'error' || last === 'captcha_failed') {
      if (last === 'error') errors.push({ broker: brokerName, lastHistory: 'error' });
      actionsNeeded.push({ kind: 'manual', broker: brokerName, detail: 'Manual action needed - the automated submit could not complete.' });
    }
  }

  return {
    period: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    diff,
    removedVerified,
    submitted,
    stillListed,
    awaitingConfirmation,
    errors,
    actionsNeeded,
    scoreTrend: _scoreTrend(exposure),
  };
}

module.exports = {
  buildReportModel,
  REPORT_DIR,
  STALE_PENDING_DAYS,
};
```

- [ ] **Step 1.4: Run, expect pass.** Run `node --test test/report-model.test.js`. Expected: all tests pass (look for `# pass` count matching and `# fail 0`).

- [ ] **Step 1.5: Commit.** Run:
```
git add lib/report.js test/report-model.test.js
git commit -m "$(cat <<'EOF'
Add pure buildReportModel for monthly opt-out report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Escaped `renderReportHtml`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/report.js` (add `_escapeHtml` and `renderReportHtml`; extend `module.exports`)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/report-html.test.js`

`renderReportHtml(model)` returns a complete self-contained HTML document string (inline `<style>`, no external assets, so Playwright can render it offline). Every dynamic value (broker names, sender hints, snippet text) is escaped via `_escapeHtml` to prevent broken markup or injection from broker-supplied text.

- [ ] **Step 2.1: Write the failing test.** Create `/Users/stephen/scripts/auto-identity-remove/test/report-html.test.js` with this COMPLETE content:

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildReportModel, renderReportHtml } = require('../lib/report');

const NOW = new Date('2026-06-09T12:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('renderReportHtml', () => {
  it('returns a full HTML document string', () => {
    const model = buildReportModel({ state: { optOuts: {} }, brokers: [], now: NOW });
    const html = renderReportHtml(model);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<\/html>\s*$/);
    assert.match(html, /<style>/);
  });

  it('includes the reporting period in the document', () => {
    const model = buildReportModel({ state: { optOuts: {} }, brokers: [], now: NOW });
    const html = renderReportHtml(model);
    assert.match(html, /2026-06/);
  });

  it('escapes HTML-special characters in broker-supplied text', () => {
    const state = {
      optOuts: {
        'Evil<script>': { pendingConfirm: { since: daysAgo(1) } },
      },
    };
    const brokers = [{ name: 'Evil<script>', expectedSender: 'a&b@"x".com' }];
    const model = buildReportModel({ state, brokers, now: NOW });
    const html = renderReportHtml(model);
    assert.ok(!html.includes('<script>'), 'raw <script> tag must not appear');
    assert.match(html, /Evil&lt;script&gt;/);
    assert.match(html, /a&amp;b@&quot;x&quot;\.com/);
  });

  it('renders an action list when actions are needed', () => {
    const state = {
      optOuts: {
        Radaris: { history: ['captcha_failed'] },
      },
    };
    const model = buildReportModel({ state, brokers: [{ name: 'Radaris' }], now: NOW });
    const html = renderReportHtml(model);
    assert.match(html, /Radaris/);
    assert.match(html, /Manual action needed/);
  });

  it('renders an all-clear message when no actions are needed', () => {
    const state = {
      optOuts: {
        Spokeo: { lastSuccess: daysAgo(40), verifiedDeletedAt: daysAgo(10) },
      },
    };
    const model = buildReportModel({ state, brokers: [{ name: 'Spokeo' }], now: NOW });
    const html = renderReportHtml(model);
    assert.match(html, /Nothing needs your attention|No action needed/i);
  });

  it('shows the score trend direction when exposure data is present', () => {
    const model = buildReportModel({
      state: { optOuts: {} },
      brokers: [],
      now: NOW,
      exposure: { total_brokers_appearing: 2, previous: 5 },
    });
    const html = renderReportHtml(model);
    assert.match(html, /improving/i);
  });
});
```

- [ ] **Step 2.2: Run it, expect fail.** Run `node --test test/report-html.test.js`. Expected failure: `renderReportHtml is not a function` (the function is not exported yet).

- [ ] **Step 2.3: Implement.** Edit `/Users/stephen/scripts/auto-identity-remove/lib/report.js`. Insert `_escapeHtml` and `renderReportHtml` just before the `module.exports` block, and extend the exports.

Insert this block immediately before `module.exports = {`:

```js
function _escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _renderList(items, mapFn) {
  if (!items || items.length === 0) return '<p class="empty">None.</p>';
  return '<ul>' + items.map(mapFn).join('') + '</ul>';
}

function _renderActions(actions) {
  if (!actions || actions.length === 0) {
    return '<p class="all-clear">Nothing needs your attention this month.</p>';
  }
  const label = { confirm_email: 'Confirm email', still_listed: 'Re-listed', manual: 'Manual action needed' };
  return '<ul class="actions">' + actions.map(a => {
    const tag = _escapeHtml(label[a.kind] || a.kind);
    return `<li><strong>${tag}:</strong> ${_escapeHtml(a.broker)} - ${_escapeHtml(a.detail)}</li>`;
  }).join('') + '</ul>';
}

/**
 * Render the report model to a self-contained, escaped HTML document.
 * @param {object} model  Output of buildReportModel.
 * @returns {string}
 */
function renderReportHtml(model) {
  const m = model || {};
  const trend = m.scoreTrend || { direction: 'unknown' };
  const trendLine = trend.direction === 'unknown'
    ? 'Exposure trend: not enough data yet.'
    : `Exposure trend: ${_escapeHtml(trend.direction)} (${_escapeHtml(trend.current)} brokers visible, was ${_escapeHtml(trend.previous)}).`;

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>Privacy report - ${_escapeHtml(m.period)}</title>`,
    '<style>',
    'body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;margin:40px;line-height:1.5}',
    'h1{font-size:22px}h2{font-size:16px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px}',
    'ul{margin:6px 0;padding-left:20px}.empty{color:#888;font-style:italic}',
    '.all-clear{color:#0a7d28;font-weight:600}.actions li{margin:4px 0}',
    '.trend{background:#f4f6fb;padding:10px 14px;border-radius:6px;margin:14px 0}',
    '</style>',
    '</head>',
    '<body>',
    `<h1>Monthly privacy report - ${_escapeHtml(m.period)}</h1>`,
    `<p class="trend">${trendLine}</p>`,
    '<h2>Things that need you</h2>',
    _renderActions(m.actionsNeeded),
    '<h2>Verified removed</h2>',
    _renderList(m.removedVerified, r => `<li>${_escapeHtml(r.broker)} (verified ${_escapeHtml((r.verifiedAt || '').slice(0, 10))})</li>`),
    '<h2>Submitted (awaiting verification)</h2>',
    _renderList(m.submitted, r => `<li>${_escapeHtml(r.broker)} (submitted ${_escapeHtml((r.lastSuccess || '').slice(0, 10))})</li>`),
    '<h2>Awaiting your email confirmation</h2>',
    _renderList(m.awaitingConfirmation, r => `<li>${_escapeHtml(r.broker)}${r.expectedSender ? ` (from ${_escapeHtml(r.expectedSender)})` : ''}</li>`),
    '<h2>Re-listed (still showing your data)</h2>',
    _renderList(m.stillListed, r => `<li>${_escapeHtml(r.broker)} (checked ${_escapeHtml((r.verifiedStillListedAt || '').slice(0, 10))})</li>`),
    '<h2>Errors</h2>',
    _renderList(m.errors, r => `<li>${_escapeHtml(r.broker)} (${_escapeHtml(r.lastHistory)})</li>`),
    '<p style="margin-top:30px;color:#888;font-size:12px">Submitted is not the same as confirmed deleted. Run node watcher.js --verify to spot-check.</p>',
    '</body>',
    '</html>',
  ].join('\n');
}
```

Then change the exports block from:
```js
module.exports = {
  buildReportModel,
  REPORT_DIR,
  STALE_PENDING_DAYS,
};
```
to:
```js
module.exports = {
  buildReportModel,
  renderReportHtml,
  REPORT_DIR,
  STALE_PENDING_DAYS,
  _escapeHtml,
};
```

- [ ] **Step 2.4: Run, expect pass.** Run `node --test test/report-html.test.js`. Expected: `# fail 0`. Also re-run `node --test test/report-model.test.js` to confirm no regression.

- [ ] **Step 2.5: Commit.** Run:
```
git add lib/report.js test/report-html.test.js
git commit -m "$(cat <<'EOF'
Render escaped HTML for monthly opt-out report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `renderReportPdf` via injected Playwright context

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/report.js` (add `reportPdfPath` and `renderReportPdf`; extend exports)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/report-pdf.test.js`

`renderReportPdf({ html, outPath, context })` opens a new page on the injected Playwright `context`, sets the HTML, writes the PDF to `outPath`, closes the page, and returns `outPath`. Tests pass a FAKE context object (no real browser): they assert `setContent` got the html, `pdf` got `{ path: outPath }`, and `close` was called. `reportPdfPath(now, dir)` builds `logs/reports/report-<YYYY-MM-DD>.pdf`.

- [ ] **Step 3.1: Write the failing test.** Create `/Users/stephen/scripts/auto-identity-remove/test/report-pdf.test.js` with this COMPLETE content:

```js
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { renderReportPdf, reportPdfPath, REPORT_DIR } = require('../lib/report');

// A fake Playwright context/page that records calls and never touches a browser.
function makeFakeContext() {
  const calls = { setContent: [], pdf: [], closed: 0, newPage: 0 };
  const page = {
    async setContent(html, opts) { calls.setContent.push({ html, opts }); },
    async pdf(opts) { calls.pdf.push(opts); },
    async close() { calls.closed += 1; },
  };
  const context = {
    async newPage() { calls.newPage += 1; return page; },
  };
  return { context, calls };
}

describe('reportPdfPath', () => {
  it('builds logs/reports/report-<date>.pdf under REPORT_DIR by default', () => {
    const now = new Date('2026-06-09T12:00:00.000Z');
    const p = reportPdfPath(now);
    assert.equal(p, path.join(REPORT_DIR, 'report-2026-06-09.pdf'));
  });

  it('honors an explicit output directory', () => {
    const now = new Date('2026-06-09T12:00:00.000Z');
    const p = reportPdfPath(now, '/tmp/out');
    assert.equal(p, path.join('/tmp/out', 'report-2026-06-09.pdf'));
  });
});

describe('renderReportPdf', () => {
  it('opens a page, sets the html, writes the pdf, and closes the page', async () => {
    const { context, calls } = makeFakeContext();
    const out = '/tmp/report-test.pdf';
    const result = await renderReportPdf({ html: '<html>x</html>', outPath: out, context });

    assert.equal(result, out);
    assert.equal(calls.newPage, 1);
    assert.equal(calls.setContent.length, 1);
    assert.equal(calls.setContent[0].html, '<html>x</html>');
    assert.equal(calls.pdf.length, 1);
    assert.equal(calls.pdf[0].path, out);
    assert.equal(calls.closed, 1);
  });

  it('closes the page even if pdf() throws', async () => {
    const calls = { closed: 0 };
    const page = {
      async setContent() {},
      async pdf() { throw new Error('pdf boom'); },
      async close() { calls.closed += 1; },
    };
    const context = { async newPage() { return page; } };

    await assert.rejects(
      renderReportPdf({ html: '<html></html>', outPath: '/tmp/x.pdf', context }),
      /pdf boom/
    );
    assert.equal(calls.closed, 1);
  });
});
```

- [ ] **Step 3.2: Run it, expect fail.** Run `node --test test/report-pdf.test.js`. Expected failure: `renderReportPdf is not a function` / `reportPdfPath is not a function`.

- [ ] **Step 3.3: Implement.** Edit `/Users/stephen/scripts/auto-identity-remove/lib/report.js`. Insert `reportPdfPath` and `renderReportPdf` just before the `module.exports` block (after `renderReportHtml`):

```js
/**
 * Build the absolute path for a report PDF.
 * @param {Date}   [now]  Defaults to new Date().
 * @param {string} [dir]  Output directory. Defaults to REPORT_DIR.
 * @returns {string}
 */
function reportPdfPath(now, dir) {
  const d = now instanceof Date ? now : new Date();
  const dateStr = d.toISOString().slice(0, 10);
  return path.join(dir || REPORT_DIR, `report-${dateStr}.pdf`);
}

/**
 * Render an HTML string to a PDF file using an injected Playwright context.
 * The context is injected so tests can supply a fake (no real browser).
 *
 * @param {object} opts
 * @param {string} opts.html
 * @param {string} opts.outPath
 * @param {{ newPage: function }} opts.context  Playwright browser context.
 * @returns {Promise<string>} outPath
 */
async function renderReportPdf({ html, outPath, context }) {
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true });
    return outPath;
  } finally {
    await page.close();
  }
}
```

Then update the exports block to:
```js
module.exports = {
  buildReportModel,
  renderReportHtml,
  renderReportPdf,
  reportPdfPath,
  REPORT_DIR,
  STALE_PENDING_DAYS,
  _escapeHtml,
};
```

- [ ] **Step 3.4: Run, expect pass.** Run `node --test test/report-pdf.test.js`. Expected: `# fail 0`. Then run `node --test test/report-model.test.js test/report-html.test.js test/report-pdf.test.js` to confirm all three report suites are green together.

- [ ] **Step 3.5: Commit.** Run:
```
git add lib/report.js test/report-pdf.test.js
git commit -m "$(cat <<'EOF'
Render report HTML to PDF via injected Playwright context

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Gitignore `logs/reports/`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/.gitignore` (after line 11 `logs/snapshots/`)

PDFs contain PII (names, addresses, emails) and must never be committed. `logs/` is already ignored, but add an explicit `logs/reports/` line to mirror the existing `logs/snapshots/` convention and make intent obvious.

- [ ] **Step 4.1: No new test.** This is a config-only change; verification is the grep in Step 4.3. (Skipping a test here is intentional - `.gitignore` has no runtime behavior to assert.)

- [ ] **Step 4.2: Implement.** Edit `/Users/stephen/scripts/auto-identity-remove/.gitignore`. Replace the line:
```
logs/snapshots/
```
with:
```
logs/snapshots/
logs/reports/
```

- [ ] **Step 4.3: Verify.** Run `rtk grep -n "logs/reports/" /Users/stephen/scripts/auto-identity-remove/.gitignore`. Expected output: one line showing `logs/reports/`.

- [ ] **Step 4.4: Commit.** Run:
```
git add .gitignore
git commit -m "$(cat <<'EOF'
Gitignore logs/reports (report PDFs contain PII)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `--report` CLI mode into `watcher.js`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js`
  - Flag parse block: lines 26-44 (add `REPORT` boolean near the other booleans).
  - New `runReport()` mode branch: add a dedicated top-level branch that early-exits, modeled on the existing `--confirm-emails` branch (lines 94-156) which already does the Playwright import + lock + persistent context + early `process.exit`.
- Test: none new for `watcher.js` itself (it is a thin orchestrator with no exported functions and the existing suite does not unit-test it; the report logic is fully covered by Tasks 1-3). The integration is verified by a manual dry-run smoke check in Step 5.4.

The `--report` mode:
1. Loads `brokers`, `loadConfig()`, `loadState()`, `getPendingConfirmations` indirectly via the model.
2. Builds the model: `buildReportModel({ state, brokers, diff, exposure })` where `diff` comes from `diffResults(loadPreviousLog(LOG_DIR, ''), results-from-last-log)` is overkill - instead pass `diff: null` and let the model stand alone (the run-log diff is a run-time artifact; the monthly report is state-driven). `exposure` is left `undefined` unless a serp-history summary is available; pass `undefined` for now (scoreTrend renders "not enough data").
3. Renders HTML, writes the PDF under `logs/reports/` using the launched Playwright `context`.
4. If `config.email && config.email.smtp` is set, emails the HTML; else writes the file and calls `desktopNotify`.
5. Releases the lock and exits.

Email send: `lib/email.js` does not export a generic "send arbitrary HTML" function - it only sends opt-out templates per broker. To avoid changing `lib/email.js` behavior, the report mode lazily `require('nodemailer')` directly (the same optional dep `lib/email.js` uses) guarded by try/catch, exactly mirroring `_sendViaSMTP`'s lazy-require + transport-build pattern from `lib/email.js` lines 115-146. When nodemailer or SMTP is absent, fall back to file + notify.

New config key: the report is emailed only when BOTH `config.email.smtp` (already documented in `config.example.json`) is present AND a new optional `config.notify.emailReportTo` recipient address is set. `emailReportTo` is a NEW key not currently in `config.example.json`; it is read defensively (`reportConfig.notify && reportConfig.notify.emailReportTo`) so its absence simply routes to the save+notify fallback - no schema migration or `setup.js` change is required for this task. (Documenting it in `config.example.json` is a follow-up, intentionally out of scope here.)

- [ ] **Step 5.1: Confirm the baseline (no network).** There is no unit test to add for the orchestrator. The post-implementation behavior is verified in Step 5.4: `node watcher.js --report` must NOT throw, must print a line containing `Report` and a path ending in `.pdf` OR a "saved" message, and must exit 0. Before implementing, confirm the `--report` flag is NOT yet recognized WITHOUT triggering a real broker run (a bare `node watcher.js --report` would otherwise fall through to the normal run path and start hitting broker sites - do NOT do that here). Use a grep instead:
  - Run `rtk grep -n "REPORT" /Users/stephen/scripts/auto-identity-remove/watcher.js`.
  - Expected (pre-implementation): no match for a `REPORT` flag constant or an `else if (REPORT)` branch. That is the "failing" baseline - `--report` is not handled yet. (We deliberately avoid invoking `node watcher.js --report` pre-implementation because, with the flag unhandled, it would launch a browser and start contacting data-broker endpoints.)

- [ ] **Step 5.2: Add the flag.** Edit `/Users/stephen/scripts/auto-identity-remove/watcher.js`. Find the boolean-flag block (around lines 41-44):
```js
const PENDING_MODE    = process.argv.includes('--pending');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
```
Add a `REPORT` constant right after `SNAPSHOT`:
```js
const PENDING_MODE    = process.argv.includes('--pending');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
const REPORT          = process.argv.includes('--report');
```

- [ ] **Step 5.3: Add the `--report` mode branch.** Edit `/Users/stephen/scripts/auto-identity-remove/watcher.js`. Insert a new `if (REPORT) { ... } else {` branch immediately AFTER the `--confirm-emails` closing of the `if (CONFIRM_EMAILS) { ... } else {` ladder. Concretely, locate this existing line (it is the `else {` that opens the non-confirm-emails path, currently at line 157):
```js
} else {

// ── --doctor: self-diagnose and exit ─────────────────────────────────────────
if (DOCTOR) {
```
Replace it with (note: the new `--report` block lives INSIDE the existing `else {` so it shares the same non-confirm-emails scope, and it opens its own `else {` that the existing doctor branch falls into - so add a matching closing brace at the very bottom in Step 5.5):
```js
} else if (REPORT) {

// ── --report: build monthly PDF + emailable HTML report and exit ─────────────
const brokers = require('./brokers');
const { buildReportModel, renderReportHtml, renderReportPdf, reportPdfPath, REPORT_DIR } = require('./lib/report');

let chromiumForReport;
try {
  ({ chromium: chromiumForReport } = require('playwright'));
} catch (_) {
  const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', 'playwright');
  ({ chromium: chromiumForReport } = require(fallback));
}

const reportConfig = loadConfig();
const profileDirForReport = (reportConfig.profileDir || '~/.config/auto-identity-remove')
  .replace(/^~(?=\/|$)/, os.homedir());

const REPORT_LOCK_PATH = STATE_PATH + '.lock';
try {
  lock.acquire(REPORT_LOCK_PATH);
} catch (err) {
  const pidMatch = err.message.match(/pid (\d+)/);
  console.error(`Another instance is running, pid=${pidMatch ? pidMatch[1] : '?'}. Exiting.`);
  process.exit(1);
}

(async () => {
  const state = loadState();
  const model = buildReportModel({ state, brokers });
  const html = renderReportHtml(model);

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = reportPdfPath(new Date());

  const context = await chromiumForReport.launchPersistentContext(profileDirForReport, {
    headless: true,
    viewport: { width: 1280, height: 900 },
  });

  try {
    await renderReportPdf({ html, outPath, context });
    console.log(`\nReport PDF written: ${outPath}`);

    const smtp = reportConfig.email && reportConfig.email.smtp;
    let emailed = false;
    if (smtp && reportConfig.notify && reportConfig.notify.emailReportTo) {
      let nodemailer;
      try {
        nodemailer = require('nodemailer');
      } catch (_) {
        nodemailer = null;
      }
      if (nodemailer) {
        try {
          const transporter = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port || 587,
            secure: (smtp.port || 587) === 465,
            auth: { user: smtp.user, pass: smtp.pass },
          });
          await transporter.sendMail({
            from: smtp.from || smtp.user,
            to: reportConfig.notify.emailReportTo,
            subject: `Privacy report - ${model.period}`,
            html,
            attachments: [{ path: outPath }],
          });
          emailed = true;
          console.log(`Report emailed to ${reportConfig.notify.emailReportTo}`);
        } catch (err) {
          console.error(`Report email failed: ${err.message.slice(0, 80)}`);
        }
      }
    }

    if (!emailed) {
      desktopNotify('Privacy report', `Monthly report saved: ${outPath}`);
      console.log(`Report saved (no SMTP configured or email failed). Actions needed: ${model.actionsNeeded.length}`);
    }
  } finally {
    await context.close().catch(() => {});
    lock.release(REPORT_LOCK_PATH);
  }
  process.exit(0);
})().catch(err => {
  lock.release(REPORT_LOCK_PATH);
  console.error('report error:', err.message);
  process.exit(1);
});

} else {

// ── --doctor: self-diagnose and exit ─────────────────────────────────────────
if (DOCTOR) {
```

- [ ] **Step 5.4: Run the smoke check, expect success.** Run `node /Users/stephen/scripts/auto-identity-remove/watcher.js --report 2>&1 | head -40`. Expected: it launches a headless browser, writes a PDF, prints `Report PDF written: .../logs/reports/report-<date>.pdf`, then either `Report emailed to ...` or `Report saved ...`, and exits 0. Confirm the PDF exists: `rtk ls /Users/stephen/scripts/auto-identity-remove/logs/reports/`. Note: this is the ONE step that exercises a real browser (the binary is already installed for this tool); it does NOT hit any data-broker network endpoints. If a headless Chromium is unavailable in the execution environment, instead verify wiring by `node -e` requiring `./lib/report` and confirming `buildReportModel`/`renderReportHtml` produce output, and confirm `node --test` (Task 6) is green - the orchestrator change is a thin glue layer fully backed by the unit-tested functions.

- [ ] **Step 5.5: Confirm brace balance.** The new `} else if (REPORT) { ... } else {` adds exactly one new branch into the existing two-level `if/else` ladder; the existing two trailing braces at the bottom of the file already close the `else` (not-doctor) and `else` (not-confirm-emails) scopes. Because `--report` is an `else if` chained onto the existing confirm-emails `if/else` (NOT a new nested block), no extra closing brace is required. Verify the file still parses: run `node --check /Users/stephen/scripts/auto-identity-remove/watcher.js`. Expected: no output, exit 0 (syntax OK).

- [ ] **Step 5.6: Commit.** Run:
```
git add watcher.js
git commit -m "$(cat <<'EOF'
Add --report CLI mode: monthly PDF + emailable HTML report

Builds the report from state, renders HTML to PDF via Playwright,
emails via SMTP when configured, else saves and notifies.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Full suite green

Files:
- Test: runs the entire root suite (`test/*.test.js dashboard/validate.test.js`, per `package.json` `test` script) plus the dashboard suite. No dashboard files were touched, but the dashboard suite is run for completeness since the repo CI runs both jobs.

- [ ] **Step 6.1: Run the root suite exactly as CI does.** Run `node --test test/*.test.js dashboard/validate.test.js` from `/Users/stephen/scripts/auto-identity-remove`. Expected: `# fail 0`, including the three new files `report-model.test.js`, `report-html.test.js`, `report-pdf.test.js`.

- [ ] **Step 6.2: Run the dashboard suite.** Run `cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test`. Expected: `# fail 0`. (No dashboard code changed; this confirms no incidental breakage. `dashboard/server.test.js` and `dashboard/validate.test.js` both exist in this directory.)

- [ ] **Step 6.3: Confirm `package.json` `test` script still passes.** Run `rtk npm test` from `/Users/stephen/scripts/auto-identity-remove`. Expected: the `node --test test/*.test.js dashboard/validate.test.js` invocation exits 0.

- [ ] **Step 6.4: Final verification of new module exports.** Run `node -e "const r=require('/Users/stephen/scripts/auto-identity-remove/lib/report'); console.log(Object.keys(r).sort().join(','))"`. Expected output exactly: `REPORT_DIR,STALE_PENDING_DAYS,_escapeHtml,buildReportModel,renderReportHtml,renderReportPdf,reportPdfPath`.

- [ ] **Step 6.5: Commit (only if any incidental fixes were needed).** If Steps 6.1-6.4 required no changes, there is nothing to commit (all prior tasks already committed). If a fix was needed, run:
```
git add -A
git commit -m "$(cat <<'EOF'
Fix test regressions surfaced by full-suite run for monthly report

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

Spec coverage (every requirement from the feature brief is addressed):
- New `lib/report.js` exporting a PURE `buildReportModel({ state, diff, brokers, exposure })` returning `{ period, removedVerified, submitted, stillListed, awaitingConfirmation, errors, actionsNeeded[], scoreTrend }`: Task 1 (the model also accepts injectable `now`/`staleAfterDays` for hermetic tests; `diff` is passed through untouched).
- `renderReportHtml(model)` returning an escaped HTML string: Task 2, with an explicit escaping test covering `<script>`, `&`, and `"` in broker-supplied text.
- Render HTML to PDF using the ALREADY-PRESENT Playwright (`page.setContent(html)` then `page.pdf({ path })`), NO new PDF dependency: Task 3 - `renderReportPdf` takes an injected `context`, uses `context.newPage()` + `page.setContent` + `page.pdf({ path })`, and the test uses a fake context (no real browser).
- Save to `logs/reports/report-<date>.pdf`; gitignore `logs/reports`: `reportPdfPath` (Task 3) builds exactly that path under `REPORT_DIR = <root>/logs/reports`; Task 4 adds the gitignore line.
- Email the HTML via existing `lib/email.js` SMTP when configured; else write the file and notify via `lib/notify.js`: Task 5 mirrors `lib/email.js`'s lazy `require('nodemailer')` + `createTransport({ host, port||587, secure: port===465, auth })` pattern (lines 115-146) and falls back to `desktopNotify` from `lib/notify.js` (imported in watcher.js line 17) when SMTP/nodemailer is absent.
- New `--report` CLI mode, schedulable: Task 5 adds the `--report` boolean and an early-exiting branch in the watcher's mode ladder; the existing monthly scheduler (`lib/scheduler.js`, runs 1st of month 09:00) already invokes the tool, so `--report` is schedulable as a separate invocation with no scheduler change required.
- Action list built from state per the rules (pending_confirm older than N days -> confirm_email; still_listed -> re-listed; captcha_failed/manual -> manual): Task 1, with dedicated tests for each rule and the staleness boundary.
- Tests: `buildReportModel` pure tests over many state shapes (Task 1), `renderReportHtml` escaping test (Task 2), and NO real browser launched in tests (Task 3 uses a fake context) - satisfied.

No placeholders: every code step contains complete, runnable code (full function bodies, full test files, exact edits). No "TBD", no "add error handling later", no ellipses in code blocks.

Signature consistency with the real repo (verified against the read files):
- `lib/config.js` exports used: `STATE_PATH`, `loadConfig`, `loadState` (watcher already imports these at line 14). The state schema fields read by the model (`optOuts`, `history`, `lastSuccess`, `pendingConfirm.since`, `verifiedDeletedAt`, `verifiedStillListedAt`) match config.js exactly (verified lines 145-187 and the verify-loop-written fields in the reference map).
- `lib/diff.js` `diffResults` / `loadPreviousLog` shapes are passed through, not re-implemented - matches the real exports (verified lines 20-92).
- `lib/email.js` SMTP send pattern is mirrored, not modified - `sendOptOutEmails` and `_sendViaSMTP` are left untouched; the report's nodemailer use copies the exact `createTransport` options shape (verified lines 115-146).
- `lib/notify.js` `desktopNotify(title, message)` is the real signature (verified lines 127-147) and is already imported in watcher.js line 17.
- `lib/snapshot.js` `snapshotPath`/`SNAPSHOT_DIR` define the `logs/snapshots/` scheme; the report mirrors it with `logs/reports/` and a sanitized date-stamped filename (verified lines 13-28).
- Playwright import/launch pattern (`require('playwright')` with `~/.openclaw/...` fallback, `chromium.launchPersistentContext(profileDir, { headless: true, viewport })`, lock acquire/release in `finally`, `process.exit`) is copied verbatim from the existing `--confirm-emails` branch (verified watcher.js lines 94-156).
- `node:test` + `node:assert/strict`, factory-function style, no `beforeEach`/`let`-mutation: matches `test/diff.test.js` (verified). The PDF test uses an injected fake context rather than `Module._load` because `renderReportPdf` takes `context` as an explicit argument - no module interception needed.
- No new npm dependencies: only Node built-ins (`path`), the already-present Playwright (injected), and the already-optional `nodemailer` (lazy-required, guarded) are used.
- No em dashes in any authored text or code (hyphens only).
