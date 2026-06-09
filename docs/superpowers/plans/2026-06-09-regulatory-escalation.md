# Regulatory Escalation Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: When a data broker is still listing the user past the legal response window (CCPA 45 days, GDPR 30 days) after a removal request, auto-generate pre-filled regulator complaints (CA AG, FTC, generic EU DPA) as text and PDF.

Architecture: A new pure module `lib/complaint.js` exposes `findOverdue(state, opts)` (computes overdue brokers from state.json timestamps) and `buildComplaint({ person, broker, overdue, regime })` (returns `{ agency, subject, body }` per regulator). A new `--complaints` CLI mode in `watcher.js` lists overdue brokers and writes `<broker>-<agency>.txt` plus `<broker>-<agency>.pdf` files into `logs/complaints/`, rendering the PDF with Playwright's `page.pdf()` from a self-contained HTML wrapper (mirroring how other modes launch a persistent Chromium context). The two core functions are pure and fully unit-tested with injected `now`; the CLI mode is thin and exercised only via the pure functions plus a small file-writer helper.

Tech Stack: Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict` with factory-function fixtures and injected dependencies (no real network/browser/clock). PDF rendering uses the already-present Playwright dependency (`page.pdf()`). No new npm dependencies.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `/Users/stephen/scripts/auto-identity-remove/lib/complaint.js` | Created | Pure `findOverdue` + `buildComplaint` + pure `renderComplaintHtml` + impure `writeComplaintFiles` (text + PDF via injected page factory). |
| `/Users/stephen/scripts/auto-identity-remove/test/complaint-find-overdue.test.js` | Created | Unit tests for `findOverdue` across many date/state shapes with injected `now`. |
| `/Users/stephen/scripts/auto-identity-remove/test/complaint-build.test.js` | Created | Content assertions for `buildComplaint` per regime (CA AG, FTC, EU DPA) + `renderComplaintHtml`. |
| `/Users/stephen/scripts/auto-identity-remove/test/complaint-write.test.js` | Created | Tests `writeComplaintFiles` writes `.txt` to a temp dir and calls the injected PDF page factory; no real browser. |
| `/Users/stephen/scripts/auto-identity-remove/watcher.js` | Modified | Add `--complaints` flag parse (near lines 26-44) and a new mode block in the dispatch ladder (after the `--confirm-emails` block, before `--doctor`, around lines 95-157). |

---

## Task 1: Pure `findOverdue(state, opts)`

`findOverdue` scans `state.optOuts` and returns the brokers whose most recent request timestamp is older than the legal window. The "requested at" timestamp is resolved, in priority order, from: `knowRequestedAt` (an explicit override field if present), else `lastSuccess`, else `pendingConfirm.since`, else `verifiedStillListedAt`, else `lastAttempt`. A broker is only overdue if it is still listed - operationally that means it has NOT been verified clear after the request (`verifiedDeletedAt` absent OR older than the request timestamp). The window is `ccpaDays` (default 45) for non-GDPR regimes and `gdprDays` (default 30) for GDPR. Regime is derived from the entry's `regime` field if present, else defaults to `'ccpa'`.

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/complaint.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/complaint-find-overdue.test.js`

Steps:

- [ ] Step 1.1: Write the failing test.

```js
// test/complaint-find-overdue.test.js
/**
 * Unit tests for lib/complaint.js findOverdue().
 *
 * findOverdue is PURE: it reads a plain state object and an injected `now`,
 * and returns the brokers still listed past their legal response window.
 * No clock, no disk, no network.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findOverdue } = require('../lib/complaint');

// Fixed reference clock for every test: 2026-06-09T00:00:00Z.
const NOW = new Date('2026-06-09T00:00:00.000Z');

// Helper: an ISO timestamp `days` days before NOW.
function daysBefore(days) {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeState(optOuts) {
  return { optOuts };
}

test('returns empty array when there are no opt-outs', () => {
  const out = findOverdue(makeState({}), { now: NOW });
  assert.deepEqual(out, []);
});

test('CCPA broker requested 50 days ago and still listed is overdue (window 45)', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(50) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'Spokeo');
  assert.equal(out[0].requestedAt, daysBefore(50));
  assert.equal(out[0].daysOverdue, 5); // 50 - 45
  assert.equal(out[0].regime, 'ccpa');
});

test('CCPA broker requested 40 days ago is NOT overdue (under 45-day window)', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(40) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

test('GDPR broker requested 35 days ago is overdue (window 30)', () => {
  const state = makeState({
    AcmeEU: { lastSuccess: daysBefore(35), regime: 'gdpr' },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'AcmeEU');
  assert.equal(out[0].regime, 'gdpr');
  assert.equal(out[0].daysOverdue, 5); // 35 - 30
});

test('GDPR broker requested 28 days ago is NOT overdue (under 30-day window)', () => {
  const state = makeState({
    AcmeEU: { lastSuccess: daysBefore(28), regime: 'gdpr' },
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

test('falls back to pendingConfirm.since when lastSuccess is absent', () => {
  const state = makeState({
    InfoTracer: { pendingConfirm: { since: daysBefore(60), snippet: 'x' } },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'InfoTracer');
  assert.equal(out[0].requestedAt, daysBefore(60));
  assert.equal(out[0].daysOverdue, 15); // 60 - 45
});

test('falls back to verifiedStillListedAt when no lastSuccess/pendingConfirm', () => {
  const state = makeState({
    Radaris: { verifiedStillListedAt: daysBefore(70) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'Radaris');
  assert.equal(out[0].requestedAt, daysBefore(70));
});

test('knowRequestedAt overrides lastSuccess when both present', () => {
  const state = makeState({
    Intelius: { knowRequestedAt: daysBefore(90), lastSuccess: daysBefore(10) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].requestedAt, daysBefore(90));
  assert.equal(out[0].daysOverdue, 45); // 90 - 45
});

test('falls back to lastAttempt when no other timestamp present', () => {
  const state = makeState({
    PeopleFinders: { lastAttempt: daysBefore(55) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'PeopleFinders');
  assert.equal(out[0].requestedAt, daysBefore(55));
});

test('entry with no usable timestamp is ignored', () => {
  const state = makeState({
    Ghost: { history: ['error'] },
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

test('broker verified clear AFTER the request is not overdue', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(60), verifiedDeletedAt: daysBefore(2) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out, []);
});

test('broker verified clear BEFORE the request (then re-listed) is still overdue', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(60), verifiedDeletedAt: daysBefore(80) },
  });
  const out = findOverdue(state, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].broker, 'Spokeo');
});

test('custom ccpaDays/gdprDays windows are honored', () => {
  const state = makeState({
    Spokeo: { lastSuccess: daysBefore(20) },
    AcmeEU: { lastSuccess: daysBefore(20), regime: 'gdpr' },
  });
  const out = findOverdue(state, { now: NOW, ccpaDays: 10, gdprDays: 15 });
  const names = out.map(o => o.broker).sort();
  assert.deepEqual(names, ['AcmeEU', 'Spokeo']);
});

test('results are sorted by daysOverdue descending (most overdue first)', () => {
  const state = makeState({
    A: { lastSuccess: daysBefore(50) }, // 5 overdue
    B: { lastSuccess: daysBefore(100) }, // 55 overdue
    C: { lastSuccess: daysBefore(60) }, // 15 overdue
  });
  const out = findOverdue(state, { now: NOW });
  assert.deepEqual(out.map(o => o.broker), ['B', 'C', 'A']);
});

test('missing optOuts key is treated as empty', () => {
  const out = findOverdue({}, { now: NOW });
  assert.deepEqual(out, []);
});

test('defaults now to current time when omitted (does not throw)', () => {
  const state = makeState({ Spokeo: { lastSuccess: daysBefore(50) } });
  const out = findOverdue(state);
  assert.ok(Array.isArray(out));
});
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test test/complaint-find-overdue.test.js`. Expected failure: `Error: Cannot find module '../lib/complaint'` (the module does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/complaint.js` with the complete contents below. (`buildComplaint`, `renderComplaintHtml`, and `writeComplaintFiles` are filled in by later tasks; for now write the whole file so subsequent tasks only edit it.)

```js
'use strict';

/**
 * lib/complaint.js
 *
 * Auto-generate regulator complaints when a broker ignores a removal request
 * past its legal response window.
 *
 *   findOverdue(state, opts)            - PURE. Returns overdue brokers.
 *   buildComplaint({ person, broker, overdue, regime })
 *                                        - PURE. Returns { agency, subject, body }.
 *   renderComplaintHtml({ agency, subject, body })
 *                                        - PURE. Returns a standalone HTML string.
 *   writeComplaintFiles(opts)            - IMPURE. Writes .txt + .pdf to a dir.
 *
 * Legal windows:
 *   CCPA - 45 days for a business to respond/delete.
 *   GDPR - 30 days (one month) for erasure under Article 17.
 */

const fs = require('fs');
const path = require('path');

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const CCPA_DAYS = 45;
const GDPR_DAYS = 30;

/**
 * Resolve the "request submitted" timestamp for a state entry.
 * Priority: explicit knowRequestedAt > lastSuccess > pendingConfirm.since >
 * verifiedStillListedAt > lastAttempt.
 * @param {object} entry
 * @returns {string|null} ISO timestamp or null when none present.
 */
function resolveRequestedAt(entry) {
  if (!entry) return null;
  if (entry.knowRequestedAt) return entry.knowRequestedAt;
  if (entry.lastSuccess) return entry.lastSuccess;
  if (entry.pendingConfirm && entry.pendingConfirm.since) return entry.pendingConfirm.since;
  if (entry.verifiedStillListedAt) return entry.verifiedStillListedAt;
  if (entry.lastAttempt) return entry.lastAttempt;
  return null;
}

/**
 * Determine the regime for a state entry. Defaults to 'ccpa'.
 * @param {object} entry
 * @returns {'ccpa'|'gdpr'}
 */
function resolveRegime(entry) {
  return entry && entry.regime === 'gdpr' ? 'gdpr' : 'ccpa';
}

/**
 * Find brokers still listed past their legal response window.
 *
 * @param {{ optOuts?: object }} state - state.json shape.
 * @param {object} [opts]
 * @param {Date} [opts.now] - injected clock; defaults to new Date().
 * @param {number} [opts.ccpaDays=45]
 * @param {number} [opts.gdprDays=30]
 * @returns {Array<{ broker: string, requestedAt: string, daysOverdue: number, regime: string }>}
 *   Sorted by daysOverdue descending.
 */
function findOverdue(state, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const ccpaDays = typeof opts.ccpaDays === 'number' ? opts.ccpaDays : CCPA_DAYS;
  const gdprDays = typeof opts.gdprDays === 'number' ? opts.gdprDays : GDPR_DAYS;
  const optOuts = (state && state.optOuts) || {};

  const overdue = [];
  for (const [broker, entry] of Object.entries(optOuts)) {
    const requestedAt = resolveRequestedAt(entry);
    if (!requestedAt) continue;

    const requestedMs = new Date(requestedAt).getTime();
    if (Number.isNaN(requestedMs)) continue;

    // Skip if verified clear AFTER the request (broker actually complied).
    if (entry.verifiedDeletedAt) {
      const verifiedMs = new Date(entry.verifiedDeletedAt).getTime();
      if (!Number.isNaN(verifiedMs) && verifiedMs > requestedMs) continue;
    }

    const regime = resolveRegime(entry);
    const windowDays = regime === 'gdpr' ? gdprDays : ccpaDays;
    const ageDays = Math.floor((now.getTime() - requestedMs) / MS_PER_DAY);
    const daysOverdue = ageDays - windowDays;
    if (daysOverdue <= 0) continue;

    overdue.push({ broker, requestedAt, daysOverdue, regime });
  }

  return overdue.sort((a, b) => b.daysOverdue - a.daysOverdue);
}

// ── Complaint templates ────────────────────────────────────────────────────

const AGENCY_BY_REGIME = {
  ccpa: ['CA_AG', 'FTC'],
  gdpr: ['EU_DPA'],
};

const AGENCY_META = {
  CA_AG: {
    name: 'California Attorney General - Consumer Complaint',
    portal: 'https://oag.ca.gov/contact/consumer-complaint-against-business-or-company',
    law: 'the California Consumer Privacy Act (CCPA)',
    windowDays: CCPA_DAYS,
  },
  FTC: {
    name: 'Federal Trade Commission - ReportFraud',
    portal: 'https://reportfraud.ftc.gov/',
    law: 'the California Consumer Privacy Act (CCPA) and applicable federal consumer-protection law',
    windowDays: CCPA_DAYS,
  },
  EU_DPA: {
    name: 'Data Protection Authority - GDPR Complaint',
    portal: 'https://edpb.europa.eu/about-edpb/about-edpb/members_en',
    law: 'the General Data Protection Regulation (GDPR), Article 17',
    windowDays: GDPR_DAYS,
  },
};

function _fullName(person) {
  return person.fullName || [person.firstName, person.lastName].filter(Boolean).join(' ');
}

function _locationLine(person) {
  const parts = [person.city, person.state, person.zip].filter(Boolean).join(', ');
  return parts || '(location not provided)';
}

/**
 * Build a single pre-filled regulator complaint.
 *
 * @param {object} opts
 * @param {object} opts.person - { fullName/firstName/lastName, city, state, zip, email, phoneFormatted }
 * @param {object} opts.broker - { name, optOutUrl?, emailTo? }
 * @param {{ requestedAt: string, daysOverdue: number }} opts.overdue
 * @param {'CA_AG'|'FTC'|'EU_DPA'} opts.regime - the target agency code.
 * @returns {{ agency: string, subject: string, body: string }}
 */
function buildComplaint({ person, broker, overdue, regime }) {
  const meta = AGENCY_META[regime];
  if (!meta) throw new Error(`Unknown complaint regime: ${regime}`);

  const name = _fullName(person);
  const requestedDate = String(overdue.requestedAt).slice(0, 10);
  const brokerName = broker.name;
  const brokerContact = broker.optOutUrl || broker.emailTo || '(no public opt-out contact on file)';

  const subject = `Consumer privacy complaint: ${brokerName} failed to honor data-deletion request`;

  const body = [
    `To: ${meta.name}`,
    `Portal: ${meta.portal}`,
    '',
    'Complainant:',
    `  Name: ${name}`,
    `  Location: ${_locationLine(person)}`,
    `  Email: ${person.email || '(not provided)'}`,
    `  Phone: ${person.phoneFormatted || '(not provided)'}`,
    '',
    `Business complained about: ${brokerName}`,
    `Business opt-out contact: ${brokerContact}`,
    '',
    'Summary of complaint:',
    `On ${requestedDate} I submitted a verified request to ${brokerName} to delete all of`,
    `my personal information, exercising my rights under ${meta.law}.`,
    `The legal response window is ${meta.windowDays} days. As of today, ${overdue.daysOverdue} day(s)`,
    'have elapsed beyond that deadline and my personal information is still being',
    `listed and sold by ${brokerName}. The business has not deleted my data and has`,
    'not provided a lawful basis for refusing.',
    '',
    'Requested action:',
    `I ask that ${meta.name} investigate ${brokerName} for its failure to comply with`,
    `${meta.law} within the required ${meta.windowDays}-day window, and compel deletion of`,
    'my personal information.',
    '',
    'Signed,',
    name,
  ].join('\n');

  return { agency: regime, subject, body };
}

/**
 * Build the list of complaints for one overdue broker.
 * CCPA brokers get CA AG + FTC; GDPR brokers get an EU DPA complaint.
 *
 * @param {object} opts
 * @param {object} opts.person
 * @param {object} opts.broker - broker definition (or { name } when unknown).
 * @param {{ requestedAt, daysOverdue, regime }} opts.overdue
 * @returns {Array<{ agency, subject, body }>}
 */
function buildComplaintsForBroker({ person, broker, overdue }) {
  const agencies = AGENCY_BY_REGIME[overdue.regime] || AGENCY_BY_REGIME.ccpa;
  return agencies.map(regime => buildComplaint({ person, broker, overdue, regime }));
}

/**
 * Render a complaint as a standalone printable HTML document.
 * PURE - used by writeComplaintFiles to produce the PDF.
 *
 * @param {{ agency: string, subject: string, body: string }} complaint
 * @returns {string} HTML string.
 */
function renderComplaintHtml({ agency, subject, body }) {
  const esc = s => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    `<title>${esc(subject)}</title>`,
    '<style>',
    'body { font-family: Georgia, "Times New Roman", serif; font-size: 12pt;',
    '  line-height: 1.5; margin: 1in; color: #111; }',
    'h1 { font-size: 14pt; margin-bottom: 0.5em; }',
    'pre { font-family: inherit; white-space: pre-wrap; word-wrap: break-word; }',
    '</style></head><body>',
    `<h1>${esc(subject)}</h1>`,
    `<pre>${esc(body)}</pre>`,
    '</body></html>',
  ].join('\n');
}

/**
 * Sanitize a string for use in a filename.
 * @param {string} s
 * @returns {string}
 */
function _slug(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Write complaint .txt and .pdf files to outDir.
 *
 * The PDF is produced via Playwright: a page is created (injectable for tests),
 * loaded with the rendered HTML, and exported with page.pdf(). This mirrors the
 * persistent-context pattern used elsewhere in the tool.
 *
 * @param {object} opts
 * @param {string} opts.outDir - directory to write into (created if missing).
 * @param {Array<{ broker: string, complaints: Array<{agency, subject, body}> }>} opts.entries
 * @param {() => Promise<{ setContent: Function, pdf: Function, close: Function }>} [opts.newPage]
 *   Factory returning a Playwright-like page. When omitted, the .pdf step is skipped.
 * @returns {Promise<{ written: string[] }>} absolute paths written.
 */
async function writeComplaintFiles({ outDir, entries, newPage }) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];

  for (const entry of entries) {
    for (const complaint of entry.complaints) {
      const base = `${_slug(entry.broker)}-${_slug(complaint.agency)}`;
      const txtPath = path.join(outDir, `${base}.txt`);
      fs.writeFileSync(txtPath, complaint.body, 'utf8');
      written.push(txtPath);

      if (typeof newPage === 'function') {
        const pdfPath = path.join(outDir, `${base}.pdf`);
        const page = await newPage();
        try {
          await page.setContent(renderComplaintHtml(complaint), { waitUntil: 'load' });
          await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true });
          written.push(pdfPath);
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
  }

  return { written };
}

module.exports = {
  findOverdue,
  buildComplaint,
  buildComplaintsForBroker,
  renderComplaintHtml,
  writeComplaintFiles,
  // Internal exports for unit-testing.
  resolveRequestedAt,
  resolveRegime,
  AGENCY_BY_REGIME,
  AGENCY_META,
};
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test test/complaint-find-overdue.test.js`. Expected: all `findOverdue` tests pass (the implementation already includes the later functions, but only `findOverdue` is exercised here).

- [ ] Step 1.5: Commit.

```bash
cd /Users/stephen/scripts/auto-identity-remove && \
  rtk git add lib/complaint.js test/complaint-find-overdue.test.js && \
  git commit -m "Add pure findOverdue for regulator-complaint escalation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure `buildComplaint` + `renderComplaintHtml` content

The implementation of `buildComplaint`, `buildComplaintsForBroker`, and `renderComplaintHtml` was already written into `lib/complaint.js` in Task 1. This task locks the per-regime content with explicit assertions so future edits cannot silently break the legal wording.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/complaint.js` (no change expected; the test pins existing behavior)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/complaint-build.test.js`

Steps:

- [ ] Step 2.1: Write the failing test.

```js
// test/complaint-build.test.js
/**
 * Content assertions for lib/complaint.js buildComplaint / buildComplaintsForBroker
 * / renderComplaintHtml. All pure - no disk, no browser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildComplaint,
  buildComplaintsForBroker,
  renderComplaintHtml,
} = require('../lib/complaint');

const PERSON = {
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'jane@example.com',
  phoneFormatted: '(512) 555-0000',
};

const BROKER = { name: 'Spokeo', optOutUrl: 'https://www.spokeo.com/optout' };

const OVERDUE_CCPA = { requestedAt: '2026-04-01T00:00:00.000Z', daysOverdue: 24, regime: 'ccpa' };
const OVERDUE_GDPR = { requestedAt: '2026-04-20T00:00:00.000Z', daysOverdue: 20, regime: 'gdpr' };

test('CA AG complaint cites CCPA and the California Attorney General', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'CA_AG' });
  assert.equal(c.agency, 'CA_AG');
  assert.match(c.subject, /Spokeo/);
  assert.match(c.body, /California Attorney General/);
  assert.match(c.body, /California Consumer Privacy Act \(CCPA\)/);
  assert.match(c.body, /45[- ]day/);
});

test('FTC complaint cites the Federal Trade Commission ReportFraud portal', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'FTC' });
  assert.equal(c.agency, 'FTC');
  assert.match(c.body, /Federal Trade Commission/);
  assert.match(c.body, /reportfraud\.ftc\.gov/);
});

test('EU DPA complaint cites GDPR Article 17 and a 30-day window', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_GDPR, regime: 'EU_DPA' });
  assert.equal(c.agency, 'EU_DPA');
  assert.match(c.body, /General Data Protection Regulation \(GDPR\), Article 17/);
  assert.match(c.body, /30[- ]day/);
});

test('complaint body includes complainant name, location, email and phone', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'CA_AG' });
  assert.match(c.body, /Jane Doe/);
  assert.match(c.body, /Austin, TX, 73301/);
  assert.match(c.body, /jane@example\.com/);
  assert.match(c.body, /\(512\) 555-0000/);
});

test('complaint body includes the request date and broker contact', () => {
  const c = buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'CA_AG' });
  assert.match(c.body, /2026-04-01/);
  assert.match(c.body, /https:\/\/www\.spokeo\.com\/optout/);
  assert.match(c.body, /24 day\(s\)/);
});

test('falls back gracefully when person lacks optional fields', () => {
  const sparse = { firstName: 'John', lastName: 'Smith' };
  const broker = { name: 'Radaris' };
  const c = buildComplaint({ person: sparse, broker, overdue: OVERDUE_CCPA, regime: 'FTC' });
  assert.match(c.body, /John Smith/);
  assert.match(c.body, /\(not provided\)/);
  assert.match(c.body, /no public opt-out contact on file/);
});

test('unknown regime throws', () => {
  assert.throws(
    () => buildComplaint({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA, regime: 'NOPE' }),
    /Unknown complaint regime/
  );
});

test('buildComplaintsForBroker returns CA AG + FTC for ccpa overdue', () => {
  const list = buildComplaintsForBroker({ person: PERSON, broker: BROKER, overdue: OVERDUE_CCPA });
  assert.deepEqual(list.map(c => c.agency).sort(), ['CA_AG', 'FTC']);
});

test('buildComplaintsForBroker returns a single EU DPA complaint for gdpr overdue', () => {
  const list = buildComplaintsForBroker({ person: PERSON, broker: BROKER, overdue: OVERDUE_GDPR });
  assert.deepEqual(list.map(c => c.agency), ['EU_DPA']);
});

test('renderComplaintHtml produces a standalone HTML doc with escaped body', () => {
  const c = { agency: 'CA_AG', subject: 'Complaint <Spokeo>', body: 'a & b < c > d' };
  const html = renderComplaintHtml(c);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Complaint &lt;Spokeo&gt;/);
  assert.match(html, /a &amp; b &lt; c &gt; d/);
  assert.match(html, /<\/html>/);
});
```

- [ ] Step 2.2: Run it, expect fail. Command: `node --test test/complaint-build.test.js`. Expected failure BEFORE Task 1 is merged: `Cannot find module '../lib/complaint'`. Since Task 1 already wrote the full implementation, this test should be authored, run, and observed: if every assertion already passes, that confirms the Task 1 implementation matches the spec. If any assertion fails (for example a wording mismatch), proceed to Step 2.3 to reconcile `lib/complaint.js` wording with the test, then re-run. Treat the first run as the RED gate.

- [ ] Step 2.3: Implement / reconcile. If any assertion failed, edit the corresponding template string in `/Users/stephen/scripts/auto-identity-remove/lib/complaint.js` so the wording matches the assertion exactly (for example ensure the CA AG `meta.law` contains the literal `California Consumer Privacy Act (CCPA)` and the `windowDays` interpolation renders `45-day`). Do not weaken the test; change the source to satisfy it. If the first run already passed all assertions, make no source change.

- [ ] Step 2.4: Run, expect pass. Command: `node --test test/complaint-build.test.js`. Expected: all assertions pass.

- [ ] Step 2.5: Commit.

```bash
cd /Users/stephen/scripts/auto-identity-remove && \
  rtk git add lib/complaint.js test/complaint-build.test.js && \
  git commit -m "Pin per-regime complaint content (CA AG, FTC, EU DPA)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `writeComplaintFiles` (text + injected-PDF writer)

`writeComplaintFiles` was written in Task 1. This task verifies it writes `.txt` files to a temp directory and, when given an injected page factory, calls `setContent`/`pdf`/`close` without touching a real browser. The factory injection point keeps the test hermetic.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/complaint.js` (no change expected; the test pins existing behavior)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/complaint-write.test.js`

Steps:

- [ ] Step 3.1: Write the failing test.

```js
// test/complaint-write.test.js
/**
 * Tests lib/complaint.js writeComplaintFiles().
 *
 * Writes .txt files to a real temp dir (cleaned up after) and verifies the PDF
 * path uses an INJECTED page factory - no real Playwright browser is launched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeComplaintFiles } = require('../lib/complaint');

function makeEntries() {
  return [
    {
      broker: 'Spokeo',
      complaints: [
        { agency: 'CA_AG', subject: 'S1', body: 'CA AG body for Spokeo' },
        { agency: 'FTC', subject: 'S2', body: 'FTC body for Spokeo' },
      ],
    },
  ];
}

test('writes one .txt per complaint into outDir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  try {
    const { written } = await writeComplaintFiles({ outDir: dir, entries: makeEntries() });
    const caTxt = path.join(dir, 'Spokeo-CA_AG.txt');
    const ftcTxt = path.join(dir, 'Spokeo-FTC.txt');
    assert.ok(fs.existsSync(caTxt), 'CA AG txt should exist');
    assert.ok(fs.existsSync(ftcTxt), 'FTC txt should exist');
    assert.equal(fs.readFileSync(caTxt, 'utf8'), 'CA AG body for Spokeo');
    assert.ok(written.includes(caTxt));
    assert.ok(written.includes(ftcTxt));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('creates outDir when it does not exist', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  const dir = path.join(base, 'nested', 'complaints');
  try {
    await writeComplaintFiles({ outDir: dir, entries: makeEntries() });
    assert.ok(fs.existsSync(dir), 'nested outDir should be created');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('when newPage is provided, renders PDF via setContent + page.pdf and records the path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  const pdfCalls = [];
  const setContentCalls = [];
  let closes = 0;

  const newPage = async () => ({
    setContent: async (html, opts) => { setContentCalls.push({ html, opts }); },
    pdf: async (opts) => {
      pdfCalls.push(opts);
      fs.writeFileSync(opts.path, '%PDF-1.4 stub'); // emulate Playwright writing the file
    },
    close: async () => { closes += 1; },
  });

  try {
    const { written } = await writeComplaintFiles({ outDir: dir, entries: makeEntries(), newPage });

    assert.equal(setContentCalls.length, 2, 'one setContent per complaint');
    assert.equal(pdfCalls.length, 2, 'one pdf per complaint');
    assert.equal(closes, 2, 'each page closed');

    const caPdf = path.join(dir, 'Spokeo-CA_AG.pdf');
    assert.ok(fs.existsSync(caPdf), 'CA AG pdf should exist');
    assert.equal(pdfCalls[0].format, 'Letter');
    assert.ok(written.includes(caPdf));

    // HTML passed to setContent is the rendered complaint document.
    assert.match(setContentCalls[0].html, /<!doctype html>/);
    assert.match(setContentCalls[0].html, /CA AG body for Spokeo/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips PDF generation entirely when newPage is omitted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  try {
    const { written } = await writeComplaintFiles({ outDir: dir, entries: makeEntries() });
    assert.equal(written.filter(p => p.endsWith('.pdf')).length, 0, 'no PDFs without newPage');
    assert.equal(written.filter(p => p.endsWith('.txt')).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closes the page even if pdf throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaint-test-'));
  let closes = 0;
  const newPage = async () => ({
    setContent: async () => {},
    pdf: async () => { throw new Error('boom'); },
    close: async () => { closes += 1; },
  });
  try {
    await assert.rejects(
      () => writeComplaintFiles({ outDir: dir, entries: makeEntries(), newPage }),
      /boom/
    );
    assert.equal(closes, 1, 'page closed despite pdf error');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] Step 3.2: Run it, expect fail. Command: `node --test test/complaint-write.test.js`. Expected: since `writeComplaintFiles` was implemented in Task 1, author and run this test as the RED gate. If all pass, the Task 1 implementation already satisfies the spec. If any fail (for example `.pdf` path not recorded in `written`, or page not closed on error), proceed to Step 3.3 to fix `lib/complaint.js`, then re-run.

- [ ] Step 3.3: Implement / reconcile. If any assertion failed, edit `writeComplaintFiles` in `/Users/stephen/scripts/auto-identity-remove/lib/complaint.js` to satisfy it - ensure the `try/finally` closes the page, that `.pdf` paths are pushed into `written`, and that `page.pdf` is called with `{ path: pdfPath, format: 'Letter', printBackground: true }`. If the first run passed, make no change.

- [ ] Step 3.4: Run, expect pass. Command: `node --test test/complaint-write.test.js`. Expected: all assertions pass.

- [ ] Step 3.5: Commit.

```bash
cd /Users/stephen/scripts/auto-identity-remove && \
  rtk git add lib/complaint.js test/complaint-write.test.js && \
  git commit -m "Verify writeComplaintFiles text + injected-PDF writer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire `--complaints` CLI mode into `watcher.js`

Add a `--complaints` flag and a new mode block to the dispatch ladder. It loads config + state, computes overdue brokers via `findOverdue`, looks up each broker's definition in `brokers.js` (for `optOutUrl`/`emailTo`/regime), builds complaints, prints a table, and writes text + PDF to `logs/complaints/`. The PDF step launches a persistent Chromium context (same pattern as the `--confirm-emails` block at lines 95-157) and passes a `newPage` factory into `writeComplaintFiles`. In dry-run it skips the browser launch and PDF generation. There is no automated test for the watcher dispatch (consistent with the repo - watcher.js has no dedicated test file); coverage lives in the pure-function tests. Verification is the manual command run in Step 4.4.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js` (add flag near lines 41-44; add mode block after the `--confirm-emails` block that closes at line 157, before the `--doctor` block at line 160)

Steps:

- [ ] Step 4.1: No new unit test (watcher dispatch has no test harness in this repo; the logic delegates to already-tested pure functions). Skip the RED test for this task and rely on the integration command in Step 4.4 plus the full suite in Task 5.

- [ ] Step 4.2: (No-op) - there is no failing unit test to run for the CLI wiring. Confirm the supporting pure functions are green by running `node --test test/complaint-find-overdue.test.js test/complaint-build.test.js test/complaint-write.test.js` and observing all pass before editing the watcher.

- [ ] Step 4.3: Implement. Make the two edits below in `/Users/stephen/scripts/auto-identity-remove/watcher.js`.

Edit A - add the flag. Find this exact block (lines 41-44):

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
const COMPLAINTS_MODE = process.argv.includes('--complaints');
```

Edit B - add the mode block. Find this exact block (lines 94-97, the start of the `--confirm-emails` block):

```js
// ── --confirm-emails [dir]: process .eml files and auto-click confirm links ───
if (CONFIRM_EMAILS) {
  const brokers = require('./brokers');
  const { processConfirmationEmails } = require('./lib/imap-confirm');
```

Insert the following complete block IMMEDIATELY BEFORE that `// ── --confirm-emails` comment line (so the new `if (COMPLAINTS_MODE)` runs first in the ladder):

```js
// ── --complaints: generate regulator complaints for brokers past the legal
//    response window (CCPA 45d / GDPR 30d) and write text + PDF to logs/. ─────
if (COMPLAINTS_MODE) {
  const brokers = require('./brokers');
  const { findOverdue, buildComplaintsForBroker, writeComplaintFiles } = require('./lib/complaint');

  const config  = loadConfig();
  const state   = loadState();
  const persons = getPersonsFromConfig(config);
  const person  = persons[0];
  const brokerMap = new Map(brokers.map(b => [b.name, b]));

  const overdueList = findOverdue(state, {});
  if (overdueList.length === 0) {
    console.log('\nNo brokers are past their legal response window. Nothing to escalate.\n');
    process.exit(0);
  }

  const outDir = path.join(__dirname, 'logs', 'complaints');
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n' + pad('Broker', 32) + pad('Regime', 8) + pad('Days overdue', 14) + 'Requested');
  console.log('-'.repeat(78));

  const entries = overdueList.map(overdue => {
    const broker = brokerMap.get(overdue.broker) || { name: overdue.broker };
    console.log(
      pad(overdue.broker, 32) +
      pad(overdue.regime, 8) +
      pad(String(overdue.daysOverdue), 14) +
      String(overdue.requestedAt).slice(0, 10)
    );
    return { broker: overdue.broker, complaints: buildComplaintsForBroker({ person, broker, overdue }) };
  });

  (async () => {
    let newPage;
    let context;
    if (!DRY_RUN) {
      let chromiumForPdf;
      try {
        ({ chromium: chromiumForPdf } = require('playwright'));
      } catch (_) {
        const fallback = path.join(os.homedir(), '.openclaw', 'plugins', 'node_modules', 'playwright');
        ({ chromium: chromiumForPdf } = require(fallback));
      }
      const profileDirForPdf = (config.profileDir || '~/.config/auto-identity-remove')
        .replace(/^~(?=\/|$)/, os.homedir());
      context = await chromiumForPdf.launchPersistentContext(profileDirForPdf, {
        headless: true,
        viewport: { width: 1280, height: 900 },
      });
      newPage = () => context.newPage();
    } else {
      console.log('\n🧪 DRY RUN - writing complaint text only, skipping PDF generation.');
    }

    try {
      const { written } = await writeComplaintFiles({ outDir, entries, newPage });
      console.log(`\n📝 Wrote ${written.length} complaint file(s) to ${outDir}`);
      const pdfCount = written.filter(p => p.endsWith('.pdf')).length;
      const txtCount = written.filter(p => p.endsWith('.txt')).length;
      console.log(`   ${txtCount} text, ${pdfCount} PDF\n`);
    } finally {
      if (context) await context.close().catch(() => {});
    }
    process.exit(0);
  })().catch(err => {
    console.error('complaints error:', err.message);
    process.exit(1);
  });
} else

```

Note: the trailing `} else` (with no opening brace on its own line) chains the new block into the existing `if (CONFIRM_EMAILS) { ... } else { if (DOCTOR) ... }` ladder. After your insertion the structure reads `if (COMPLAINTS_MODE) { ... } else if (CONFIRM_EMAILS) { ... } else { ... }`. Verify by eye that the original `if (CONFIRM_EMAILS) {` line now follows your `} else` directly.

- [ ] Step 4.4: Run, expect pass (integration smoke). Run the dry-run path, which never launches a browser, against a throwaway state file so the real `state.json` is untouched. Command:

```bash
cd /Users/stephen/scripts/auto-identity-remove && node --test test/complaint-find-overdue.test.js test/complaint-build.test.js test/complaint-write.test.js
```

Expected: all three complaint test files pass (this re-confirms the wiring did not break the pure modules and that the watcher file still parses - if `watcher.js` had a syntax error from the edit, requiring `./brokers` is unaffected, so additionally run a parse check):

```bash
cd /Users/stephen/scripts/auto-identity-remove && node --check watcher.js && echo "watcher.js parses OK"
```

Expected output: `watcher.js parses OK` (no syntax error from the inserted block).

- [ ] Step 4.5: Commit.

```bash
cd /Users/stephen/scripts/auto-identity-remove && \
  rtk git add watcher.js && \
  git commit -m "Add --complaints CLI mode for regulator escalation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full-suite verification

Confirm the entire root suite is green (including the three new complaint test files via the `test/*.test.js` glob) and that the dashboard suite is unaffected. The dashboard was not touched, so its suite is expected to pass unchanged; run it to be safe.

Files:
- Test: runs the full suite; no files created or modified.

Steps:

- [ ] Step 5.1: Run the full root suite exactly as CI does. Command:

```bash
cd /Users/stephen/scripts/auto-identity-remove && node --test test/*.test.js dashboard/validate.test.js
```

Expected: all tests pass (existing 57 `test/*.test.js` files plus the 3 new `complaint-*.test.js` files, so 60 total under `test/`, plus `dashboard/validate.test.js`). `# fail 0` in the summary.

- [ ] Step 5.2: Run the dashboard suite (untouched, but confirm green). Command:

```bash
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```

Expected: all dashboard tests pass, `# fail 0`.

- [ ] Step 5.3: If anything fails, use superpowers:systematic-debugging - read the failing assertion, fix the source (never the test to make it pass trivially), re-run the single file, then re-run the full suite. Do not proceed until both suites are green.

- [ ] Step 5.4: Commit (only if Step 5.3 required a fix; otherwise nothing to commit).

```bash
cd /Users/stephen/scripts/auto-identity-remove && \
  rtk git add -A && \
  git commit -m "Fix test failures surfaced by full-suite run

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage:
- Pure `findOverdue(state, { now, ccpaDays:45, gdprDays:30 })` returning `{ broker, requestedAt, daysOverdue }` (plus `regime`): Task 1. Covered with injected `now`, every fallback timestamp (`knowRequestedAt` > `lastSuccess` > `pendingConfirm.since` > `verifiedStillListedAt` > `lastAttempt`), the verified-clear-after-request skip, custom windows, sort order, and empty/missing-key cases.
- Pure `buildComplaint({ person, broker, overdue, regime })` returning `{ agency, subject, body }` with templates for CA AG consumer complaint, FTC reportfraud, and a generic EU DPA: Task 2. Per-regime content assertions pin the law citations and windows (CCPA 45-day, GDPR 30-day Article 17).
- `--complaints` CLI mode listing overdue brokers and writing complaint text + PDF to `logs/complaints/`, PDF via Playwright `page.pdf()` described self-containedly (HTML wrapper + `setContent` + `page.pdf({ path, format:'Letter', printBackground:true })`): Tasks 3 and 4. The persistent-context launch mirrors the `--confirm-emails` block (watcher.js lines 95-157); dry-run skips the browser.
- Overdue computed from state timestamps (`knowRequestedAt` / `lastSuccess` / `pendingConfirm.since` / `verifiedStillListedAt`, with `lastAttempt` as a final fallback): Task 1 `resolveRequestedAt`.
- Integration/wiring task (CLI flag in watcher.js): Task 4. Final full-suite task: Task 5 (root `node --test test/*.test.js dashboard/validate.test.js` and dashboard `node --test`).

No placeholders: every code block is complete and runnable - full function bodies in `lib/complaint.js`, full test files, and exact watcher.js find/replace + insertion text. No "TBD", no "add error handling", no ellipses.

Signature consistency with the real repo (verified by reading the source):
- `lib/config.js` exports used: `loadConfig`, `loadState`, `getPersonsFromConfig` - all present in `module.exports` (config.js lines 329-355). `findOverdue` reads the documented state schema fields (`lastSuccess`, `lastAttempt`, `pendingConfirm.since`, `verifiedStillListedAt`, `verifiedDeletedAt`) confirmed in config.js (`recordSuccess`/`recordPendingConfirmation`) and the verify-loop schema. `knowRequestedAt` is a new optional override field (does not collide with any existing key) and `regime` is a new optional per-entry hint; both default safely when absent.
- `lib/email.js` template style mirrored: GDPR cites Article 17, CCPA cites CCPA; `_fullName`/`_locationLine` follow the `Name:` / `Location: city, state zip` / `Email:` / `Phone:` shape from `_buildBodyGDPR`/`_buildBodyCCPA` (email.js lines 35-82).
- `watcher.js` integration matches the real dispatch ladder: flags parsed via `process.argv.includes` (lines 26-44), modes chained as top-level `if/else` with `process.exit` (lines 57-168), persistent-context launch + `playwright` local-then-`~/.openclaw` fallback (lines 100-106, 211-217), `path`/`os`/`fs` already required at top (lines 10-12), `loadConfig`/`loadState`/`getPersonsFromConfig` already imported (line 14), and `DRY_RUN` already defined (line 27).
- Test conventions matched: `node:test` + `node:assert/strict`, factory-function fixtures, top-level `const PERSON`/`const BROKER`, temp dirs via `fs.mkdtempSync(os.tmpdir())` with `fs.rmSync` cleanup (as in `test/audit.test.js`), dependency injection via an explicit `newPage` factory argument (no real Playwright). No real network, no real browser, no writes to the real `config.json`/`state.json`.
- No new npm dependencies: uses Node built-ins (`fs`, `path`, `os`) and the already-present `playwright`. CommonJS throughout; no TypeScript; no em dashes in authored text.
