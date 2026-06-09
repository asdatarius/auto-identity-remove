# Live Broker-List Feeds (CA SB-362 + Vermont Registries) Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Replace the stale (Jan 2023) Markup dataset as the sole coverage source by adding auto-updating official data-broker registries (California + Vermont) that feed `generic-runner.js` alongside the existing Markup data, with Markup kept as a fallback.

Architecture: A new pure module `lib/feeds.js` exposes two thin async fetchers (`fetchCaRegistry`, `fetchVtRegistry`) that accept an injectable `fetchImpl` (defaulting to the Node 18+ global `fetch`) plus a pure `normalizeFeedRow(row)` that maps a raw registry record to the generic broker shape `{ name, optOutUrl, method, source }`. A new `--update-brokers` early-exit CLI mode in `watcher.js` fetches both registries, normalizes them, dedups against the explicit `brokers.js` hostnames and against each other by registrable domain (reusing `lib/serp-scan.js` hostname logic), and writes `data/feeds-brokers.json`. `generic-runner.js` `loadGenericBrokers` gains a third source block that loads that file when present, deduped exactly like the Markup/BADBOOL blocks.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict`. Playwright is already a dependency but is NOT needed for this feature (the CLI mode does pure HTTP + file writes; no browser). Network is never hit in tests - `fetchImpl` is always injected with a stub. No new npm dependencies.

---

## File map

| File | Status | Responsibility |
|------|--------|----------------|
| `lib/feeds.js` | Created | Pure `normalizeFeedRow(row)`; `mapHeaderRow`/`parseCsv` CSV helpers; `dedupeFeedBrokers(rows, existingHosts)`; async `fetchCaRegistry({ fetchImpl })` / `fetchVtRegistry({ fetchImpl })`; `buildFeedsFile({ fetchImpl, explicitHosts })`; constants `CA_REGISTRY_URL`, `VT_REGISTRY_URL`, `FEEDS_PATH`. |
| `generic-runner.js` | Modified | Add `FEEDS_PATH` const + a third source block in `loadGenericBrokers` that loads `data/feeds-brokers.json` (deduped by host, like Markup/BADBOOL). |
| `watcher.js` | Modified | Add `--update-brokers` CLI mode (no Playwright) as an `else if` peer of the async `--doctor` handler: build explicit hosts, call `buildFeedsFile`, write `data/feeds-brokers.json`, print a summary, exit 0. |
| `data/feeds-brokers.json` | Created (by CLI at runtime; gitignored) | Normalized + deduped registry brokers consumed by `generic-runner.js`. NOT committed - written by `--update-brokers`. |
| `test/feeds-normalize.test.js` | Created | Pure unit tests for `normalizeFeedRow`, `parseCsv`, `mapHeaderRow`. |
| `test/feeds-fetch.test.js` | Created | `fetchCaRegistry`/`fetchVtRegistry`/`buildFeedsFile` with injected `fetchImpl` stub (no network). |
| `test/feeds-dedupe.test.js` | Created | `dedupeFeedBrokers` registrable-domain dedup against explicit hosts + self. |
| `test/feeds-generic-runner.test.js` | Created | `loadGenericBrokers` picks up `data/feeds-brokers.json` and dedups against explicit hosts. |

---

## Task 1: Pure `normalizeFeedRow` + CSV parsing in `lib/feeds.js`

The registries are published as CSV with human-readable headers (CA: `oag.ca.gov/data-brokers` "Download CSV"; the row has a broker/business name and a website/opt-out URL column). Headers differ between the two states, so normalization needs a header-mapping step that tolerates several aliases. `normalizeFeedRow` is pure: it takes one already-parsed row object (header -> cell value) and returns a generic broker entry `{ name, optOutUrl, method, source }`, or `null` when the row has no usable name. `method` is `'direct-form'` when the URL path looks like an opt-out/request endpoint, otherwise `'manual'`.

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/feeds.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/feeds-normalize.test.js` (Create)

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/feeds-normalize.test.js` with this complete content:

```js
/**
 * test/feeds-normalize.test.js
 *
 * Pure unit tests for lib/feeds.js header mapping, CSV parsing, and row
 * normalization. No network, no file I/O - inline CSV/row fixtures only.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { normalizeFeedRow, parseCsv, mapHeaderRow } = require('../lib/feeds');

// ── mapHeaderRow ───────────────────────────────────────────────────────────────

test('mapHeaderRow lowercases and trims header cells into canonical keys', () => {
  const headers = ['  Business Name ', 'Website', 'Email Address'];
  const cells   = ['Acme Data Co', 'https://acme.example.com', 'privacy@acme.example.com'];
  const row = mapHeaderRow(headers, cells);
  assert.equal(row['business name'], 'Acme Data Co');
  assert.equal(row['website'], 'https://acme.example.com');
  assert.equal(row['email address'], 'privacy@acme.example.com');
});

test('mapHeaderRow tolerates rows with fewer cells than headers', () => {
  const headers = ['name', 'website', 'email'];
  const cells   = ['Acme'];
  const row = mapHeaderRow(headers, cells);
  assert.equal(row['name'], 'Acme');
  assert.equal(row['website'], '');
  assert.equal(row['email'], '');
});

// ── parseCsv ───────────────────────────────────────────────────────────────────

test('parseCsv parses a simple CSV into header-mapped row objects', () => {
  const csv = 'Name,Website\nAcme Data Co,https://acme.example.com\nBeta LLC,https://beta.example.com\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['name'], 'Acme Data Co');
  assert.equal(rows[0]['website'], 'https://acme.example.com');
  assert.equal(rows[1]['name'], 'Beta LLC');
});

test('parseCsv handles quoted fields containing commas', () => {
  const csv = 'Name,Website\n"Acme, Data & Co",https://acme.example.com\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['name'], 'Acme, Data & Co');
  assert.equal(rows[0]['website'], 'https://acme.example.com');
});

test('parseCsv unescapes doubled double-quotes inside a quoted field', () => {
  const csv = 'Name,Website\n"The ""Big"" Broker",https://big.example.com\n';
  const rows = parseCsv(csv);
  assert.equal(rows[0]['name'], 'The "Big" Broker');
});

test('parseCsv ignores blank trailing lines and handles CRLF', () => {
  const csv = 'Name,Website\r\nAcme,https://acme.example.com\r\n\r\n';
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['name'], 'Acme');
});

test('parseCsv returns [] for empty or header-only input', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('Name,Website\n'), []);
});

// ── normalizeFeedRow ─────────────────────────────────────────────────────────────

test('normalizeFeedRow maps a California-style row to a generic broker entry', () => {
  const row = { 'data broker name': 'Acme Data Co', 'website url': 'https://acme.example.com/opt-out' };
  const entry = normalizeFeedRow(row, 'ca');
  assert.deepEqual(entry, {
    name: 'Acme Data Co',
    optOutUrl: 'https://acme.example.com/opt-out',
    method: 'direct-form',
    source: 'ca',
  });
});

test('normalizeFeedRow maps a Vermont-style row using alias headers', () => {
  const row = { 'business name': 'Beta Brokers LLC', 'website': 'https://beta.example.com/privacy' };
  const entry = normalizeFeedRow(row, 'vt');
  assert.equal(entry.name, 'Beta Brokers LLC');
  assert.equal(entry.optOutUrl, 'https://beta.example.com/privacy');
  assert.equal(entry.source, 'vt');
});

test('normalizeFeedRow classifies method as direct-form for opt-out style URLs', () => {
  for (const url of [
    'https://x.example.com/opt-out',
    'https://x.example.com/do-not-sell',
    'https://x.example.com/privacy-request',
    'https://x.example.com/dsar',
    'https://x.example.com/remove',
  ]) {
    const entry = normalizeFeedRow({ name: 'X', website: url }, 'ca');
    assert.equal(entry.method, 'direct-form', `expected direct-form for ${url}`);
  }
});

test('normalizeFeedRow classifies method as manual for a bare homepage URL', () => {
  const entry = normalizeFeedRow({ name: 'X', website: 'https://x.example.com/' }, 'ca');
  assert.equal(entry.method, 'manual');
});

test('normalizeFeedRow trims surrounding whitespace from name and url', () => {
  const entry = normalizeFeedRow({ name: '  Acme  ', website: '  https://acme.example.com  ' }, 'ca');
  assert.equal(entry.name, 'Acme');
  assert.equal(entry.optOutUrl, 'https://acme.example.com');
});

test('normalizeFeedRow prepends https:// to a scheme-less website', () => {
  const entry = normalizeFeedRow({ name: 'Acme', website: 'acme.example.com/opt-out' }, 'ca');
  assert.equal(entry.optOutUrl, 'https://acme.example.com/opt-out');
  assert.equal(entry.method, 'direct-form');
});

test('normalizeFeedRow returns null when no usable name is present', () => {
  assert.equal(normalizeFeedRow({ website: 'https://x.example.com' }, 'ca'), null);
  assert.equal(normalizeFeedRow({ name: '   ', website: 'https://x.example.com' }, 'ca'), null);
});

test('normalizeFeedRow keeps a name-only row with an empty optOutUrl as manual', () => {
  const entry = normalizeFeedRow({ name: 'Nameonly Broker' }, 'vt');
  assert.equal(entry.name, 'Nameonly Broker');
  assert.equal(entry.optOutUrl, '');
  assert.equal(entry.method, 'manual');
});
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test test/feeds-normalize.test.js`. Expected failure: `Cannot find module '../lib/feeds'` (the module does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/feeds.js` with this complete content:

```js
/**
 * lib/feeds.js
 *
 * Live broker-list feeds from official state registries (California + Vermont).
 *
 * Replaces reliance on the stale (Jan 2023) Markup dataset as the only coverage
 * source. The registries are public CSV exports; this module fetches them
 * (fetchImpl injectable for tests), normalizes each row to the generic broker
 * shape { name, optOutUrl, method, source }, dedups by registrable domain
 * against the explicit brokers.js list (and against each other), and the result
 * is written by watcher.js --update-brokers to data/feeds-brokers.json.
 *
 * Pure helpers (normalizeFeedRow, parseCsv, mapHeaderRow, dedupeFeedBrokers)
 * have no network or file I/O. Only fetchCaRegistry / fetchVtRegistry /
 * buildFeedsFile touch the (injected) network.
 */

'use strict';

const path = require('path');
const { hostnameOf } = require('./serp-scan');

// ── Registry endpoints (real, public) ────────────────────────────────────────
// California: legacy AG registry CSV export (2020-2023) at oag.ca.gov/data-brokers.
// The current registry is maintained by the CPPA (cppa.ca.gov/data_broker_registry);
// the AG CSV remains the most machine-readable historical export and is used as
// the default. Override via the CA_REGISTRY_URL env var when the CPPA publishes a
// stable CSV endpoint.
const CA_REGISTRY_URL = process.env.CA_REGISTRY_URL
  || 'https://oag.ca.gov/data-brokers/csv';

// Vermont: Secretary of State data-broker registry bulk export.
// Override via VT_REGISTRY_URL.
const VT_REGISTRY_URL = process.env.VT_REGISTRY_URL
  || 'https://bizfilings.vermont.gov/online/DatabrokerInquire/DatabrokerExport';

const FEEDS_PATH = path.join(__dirname, '..', 'data', 'feeds-brokers.json');

// Header aliases -> canonical fields. Registries use different column titles.
const NAME_HEADERS = ['data broker name', 'business name', 'name', 'company name', 'registrant'];
const URL_HEADERS  = ['website url', 'website', 'url', 'opt-out url', 'opt out url', 'privacy url'];

// URL path keywords that indicate a directly-actionable opt-out / request page.
const DIRECT_FORM_KEYWORDS = [
  'opt-out', 'optout', 'opt_out',
  'do-not-sell', 'donotsell', 'do_not_sell',
  'privacy-request', 'privacyrequest',
  'data-request', 'datarequest',
  'dsar', 'remove', 'delete', 'request',
];

/**
 * Parse a single CSV line into an array of cell strings, honoring double-quoted
 * fields, embedded commas, and doubled-quote ("") escapes.
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * Map a header array and a cell array into a row object keyed by lowercased,
 * trimmed header names. Tolerates rows shorter than the header row.
 * @param {string[]} headers
 * @param {string[]} cells
 * @returns {Record<string,string>}
 */
function mapHeaderRow(headers, cells) {
  const row = {};
  for (let i = 0; i < headers.length; i++) {
    const key = String(headers[i] || '').trim().toLowerCase();
    if (!key) continue;
    row[key] = cells[i] !== undefined ? cells[i] : '';
  }
  return row;
}

/**
 * Parse a CSV string into an array of header-mapped row objects. The first
 * non-empty line is treated as the header. Blank lines are skipped.
 * @param {string} csv
 * @returns {Array<Record<string,string>>}
 */
function parseCsv(csv) {
  if (!csv) return [];
  const lines = String(csv).split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    rows.push(mapHeaderRow(headers, cells));
  }
  return rows;
}

function pickField(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && String(row[key]).trim().length > 0) {
      return String(row[key]).trim();
    }
  }
  return '';
}

function normalizeUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function classifyMethod(url) {
  if (!url) return 'manual';
  const lower = url.toLowerCase();
  for (const kw of DIRECT_FORM_KEYWORDS) {
    if (lower.includes(kw)) return 'direct-form';
  }
  return 'manual';
}

/**
 * Normalize one parsed registry row into a generic broker entry.
 * @param {Record<string,string>} row  header-mapped row (lowercased keys)
 * @param {string} source  'ca' | 'vt'
 * @returns {{ name: string, optOutUrl: string, method: string, source: string } | null}
 */
function normalizeFeedRow(row, source) {
  if (!row || typeof row !== 'object') return null;
  const name = pickField(row, NAME_HEADERS);
  if (!name) return null;
  const optOutUrl = normalizeUrl(pickField(row, URL_HEADERS));
  return {
    name,
    optOutUrl,
    method: classifyMethod(optOutUrl),
    source,
  };
}

/**
 * Dedupe normalized feed brokers by registrable domain, dropping any whose
 * host collides with an explicit broker host (or with an earlier feed entry).
 * Entries with no parseable host (empty optOutUrl) are kept as-is - they are
 * manual rows that carry no dedupe key.
 * @param {Array<{name,optOutUrl,method,source}>} brokers
 * @param {Iterable<string>} explicitHosts  bare hostnames (www-stripped) from brokers.js
 * @returns {Array<{name,optOutUrl,method,source}>}
 */
function dedupeFeedBrokers(brokers, explicitHosts) {
  const seen = new Set(explicitHosts);
  const out = [];
  for (const b of brokers) {
    if (!b) continue;
    const host = hostnameOf(b.optOutUrl);
    if (!host) { out.push(b); continue; }
    if (seen.has(host)) continue;
    seen.add(host);
    out.push(b);
  }
  return out;
}

async function fetchText(url, fetchImpl) {
  const impl = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!impl) throw new Error('No fetch implementation available (Node 18+ global fetch or inject fetchImpl)');
  const res = await impl(url);
  if (!res || !res.ok) {
    const status = res ? res.status : 'no-response';
    throw new Error(`Feed fetch failed for ${url}: HTTP ${status}`);
  }
  return res.text();
}

/**
 * Fetch + normalize the California data-broker registry.
 * @param {{ fetchImpl?: Function, url?: string }} [opts]
 * @returns {Promise<Array<{name,optOutUrl,method,source}>>}
 */
async function fetchCaRegistry(opts = {}) {
  const url = opts.url || CA_REGISTRY_URL;
  const csv = await fetchText(url, opts.fetchImpl);
  return parseCsv(csv).map(r => normalizeFeedRow(r, 'ca')).filter(Boolean);
}

/**
 * Fetch + normalize the Vermont data-broker registry.
 * @param {{ fetchImpl?: Function, url?: string }} [opts]
 * @returns {Promise<Array<{name,optOutUrl,method,source}>>}
 */
async function fetchVtRegistry(opts = {}) {
  const url = opts.url || VT_REGISTRY_URL;
  const csv = await fetchText(url, opts.fetchImpl);
  return parseCsv(csv).map(r => normalizeFeedRow(r, 'vt')).filter(Boolean);
}

/**
 * Fetch both registries, merge, and dedupe against the explicit broker hosts.
 * Pure aside from the (injected) fetches; does NOT write to disk - callers
 * (watcher.js --update-brokers) own the write.
 * @param {{ fetchImpl?: Function, explicitHosts?: Iterable<string> }} [opts]
 * @returns {Promise<{ brokers: Array, stats: { ca: number, vt: number, total: number } }>}
 */
async function buildFeedsFile(opts = {}) {
  const fetchImpl = opts.fetchImpl;
  const explicitHosts = opts.explicitHosts || [];
  const ca = await fetchCaRegistry({ fetchImpl });
  const vt = await fetchVtRegistry({ fetchImpl });
  const merged = dedupeFeedBrokers([...ca, ...vt], explicitHosts);
  return {
    brokers: merged,
    stats: { ca: ca.length, vt: vt.length, total: merged.length },
  };
}

module.exports = {
  normalizeFeedRow,
  parseCsv,
  parseCsvLine,
  mapHeaderRow,
  dedupeFeedBrokers,
  fetchCaRegistry,
  fetchVtRegistry,
  buildFeedsFile,
  CA_REGISTRY_URL,
  VT_REGISTRY_URL,
  FEEDS_PATH,
};
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test test/feeds-normalize.test.js`. Expected: all tests pass (15 passing assertions across the file; `tests N` / `pass N` / `fail 0`).

- [ ] Step 1.5: Commit.

```bash
rtk git add lib/feeds.js test/feeds-normalize.test.js
rtk git commit -m "$(cat <<'EOF'
Add lib/feeds.js with pure normalizeFeedRow + CSV parsing

New module for live broker-list feeds (CA + VT registries). This commit
covers the pure layer: parseCsv/parseCsvLine, mapHeaderRow, normalizeFeedRow,
plus the network/build scaffolding wired in later tasks.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Registrable-domain dedup (`dedupeFeedBrokers`)

`dedupeFeedBrokers` is already implemented in `lib/feeds.js` (Task 1). This task adds its dedicated test coverage, exercising the reuse of `lib/serp-scan.js` `hostnameOf` for the dedup key, the explicit-host collision drop, and the keep-on-no-host behavior for name-only manual rows.

Files:
- Modify: none (function already present from Task 1)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/feeds-dedupe.test.js` (Create)

- [ ] Step 2.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/feeds-dedupe.test.js` with this complete content:

```js
/**
 * test/feeds-dedupe.test.js
 *
 * Unit tests for dedupeFeedBrokers - registrable-domain dedup of normalized
 * feed brokers against the explicit brokers.js hosts and against each other.
 * Pure, no network, no file I/O.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { dedupeFeedBrokers } = require('../lib/feeds');

function entry(name, url) {
  return { name, optOutUrl: url, method: 'manual', source: 'ca' };
}

test('dedupeFeedBrokers drops a feed broker whose host matches an explicit host', () => {
  const feed = [entry('Spokeo', 'https://www.spokeo.com/opt_out')];
  const out = dedupeFeedBrokers(feed, ['spokeo.com']);
  assert.equal(out.length, 0);
});

test('dedupeFeedBrokers keeps a feed broker whose host is not in the explicit set', () => {
  const feed = [entry('Acme', 'https://acme.example.com/opt-out')];
  const out = dedupeFeedBrokers(feed, ['spokeo.com', 'beenverified.com']);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Acme');
});

test('dedupeFeedBrokers strips www. when comparing hosts (reuses serp-scan hostnameOf)', () => {
  const feed = [entry('Spokeo WWW', 'https://www.spokeo.com/optout')];
  const out = dedupeFeedBrokers(feed, ['spokeo.com']);
  assert.equal(out.length, 0);
});

test('dedupeFeedBrokers dedups duplicate feed entries against each other by host', () => {
  const feed = [
    entry('Acme One', 'https://acme.example.com/opt-out'),
    entry('Acme Two', 'https://acme.example.com/do-not-sell'),
  ];
  const out = dedupeFeedBrokers(feed, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Acme One');
});

test('dedupeFeedBrokers keeps name-only rows with no parseable host', () => {
  const feed = [
    { name: 'Nameonly A', optOutUrl: '', method: 'manual', source: 'vt' },
    { name: 'Nameonly B', optOutUrl: '', method: 'manual', source: 'vt' },
  ];
  const out = dedupeFeedBrokers(feed, []);
  assert.equal(out.length, 2);
});

test('dedupeFeedBrokers accepts a Set or array for explicitHosts', () => {
  const feed = [entry('Acme', 'https://acme.example.com/opt-out')];
  const fromSet = dedupeFeedBrokers(feed, new Set(['acme.example.com']));
  assert.equal(fromSet.length, 0);
  const fromArr = dedupeFeedBrokers(feed, ['acme.example.com']);
  assert.equal(fromArr.length, 0);
});

test('dedupeFeedBrokers tolerates null/undefined entries', () => {
  const feed = [null, entry('Acme', 'https://acme.example.com/opt-out'), undefined];
  const out = dedupeFeedBrokers(feed, []);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Acme');
});
```

- [ ] Step 2.2: Run it, expect fail. Command: `node --test test/feeds-dedupe.test.js`. Expected: PASS if Task 1 implemented `dedupeFeedBrokers` correctly. If any test fails, the failure message points at the divergent assertion - fix `dedupeFeedBrokers` in `lib/feeds.js` to match (it is the spec). This task is the dedup contract; do not weaken the tests.

- [ ] Step 2.3: Implement. No production change expected - `dedupeFeedBrokers` was written in Task 1 Step 1.3 to satisfy exactly these assertions (Set-or-array `explicitHosts`, `hostnameOf` www-stripping, keep-on-no-host, null-tolerant). If Step 2.2 surfaced a real gap, the only allowed fix is in `lib/feeds.js` `dedupeFeedBrokers`; re-run after editing.

- [ ] Step 2.4: Run, expect pass. Command: `node --test test/feeds-dedupe.test.js`. Expected: `pass 7`, `fail 0`.

- [ ] Step 2.5: Commit.

```bash
rtk git add test/feeds-dedupe.test.js
rtk git commit -m "$(cat <<'EOF'
Add registrable-domain dedup tests for feed brokers

Covers dedupeFeedBrokers: explicit-host collision drop, www-stripping via
serp-scan hostnameOf, self-dedup, name-only keep, Set/array hosts, null entries.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Injected-`fetchImpl` fetchers + `buildFeedsFile`

`fetchCaRegistry`, `fetchVtRegistry`, and `buildFeedsFile` are implemented in Task 1. This task adds hermetic tests that inject a fake `fetchImpl` returning inline CSV - no network is ever touched. It verifies CSV-to-broker mapping, the `source` tag per registry, the HTTP-error path, and that `buildFeedsFile` merges both registries and dedups against explicit hosts.

Files:
- Modify: none (functions already present from Task 1)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/feeds-fetch.test.js` (Create)

- [ ] Step 3.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/feeds-fetch.test.js` with this complete content:

```js
/**
 * test/feeds-fetch.test.js
 *
 * Tests fetchCaRegistry / fetchVtRegistry / buildFeedsFile with an injected
 * fetchImpl that returns inline CSV. No real network is used.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { fetchCaRegistry, fetchVtRegistry, buildFeedsFile } = require('../lib/feeds');

// A fetch stub: maps a URL -> CSV text. Mirrors the WHATWG fetch Response shape
// just enough (ok, status, text()).
function makeFetch(byUrl) {
  return async (url) => {
    if (!(url in byUrl)) {
      return { ok: false, status: 404, text: async () => '' };
    }
    const body = byUrl[url];
    return { ok: true, status: 200, text: async () => body };
  };
}

const CA_CSV =
  'Data Broker Name,Website URL\n' +
  'Acme Data Co,https://acme.example.com/opt-out\n' +
  'Beta Brokers LLC,https://beta.example.com/\n';

const VT_CSV =
  'Business Name,Website\n' +
  'Gamma Insights,https://gamma.example.com/do-not-sell\n' +
  'Acme Data Co,https://acme.example.com/optout\n';  // duplicate host with CA

test('fetchCaRegistry parses injected CSV into ca-sourced broker entries', async () => {
  const fetchImpl = makeFetch({ 'https://ca.test/registry.csv': CA_CSV });
  const brokers = await fetchCaRegistry({ fetchImpl, url: 'https://ca.test/registry.csv' });
  assert.equal(brokers.length, 2);
  assert.equal(brokers[0].name, 'Acme Data Co');
  assert.equal(brokers[0].method, 'direct-form');
  assert.equal(brokers[0].source, 'ca');
  assert.equal(brokers[1].name, 'Beta Brokers LLC');
  assert.equal(brokers[1].method, 'manual');
});

test('fetchVtRegistry tags entries with source vt', async () => {
  const fetchImpl = makeFetch({ 'https://vt.test/registry.csv': VT_CSV });
  const brokers = await fetchVtRegistry({ fetchImpl, url: 'https://vt.test/registry.csv' });
  assert.equal(brokers.length, 2);
  assert.ok(brokers.every(b => b.source === 'vt'));
  assert.equal(brokers[0].name, 'Gamma Insights');
  assert.equal(brokers[0].method, 'direct-form');
});

test('fetchCaRegistry throws a descriptive error on non-OK responses', async () => {
  const fetchImpl = makeFetch({});  // any URL -> 404
  await assert.rejects(
    () => fetchCaRegistry({ fetchImpl, url: 'https://ca.test/missing.csv' }),
    /Feed fetch failed.*HTTP 404/,
  );
});

test('buildFeedsFile merges both registries and dedups across them and explicit hosts', async () => {
  const fetchImpl = makeFetch({
    'https://ca.test/registry.csv': CA_CSV,
    'https://vt.test/registry.csv': VT_CSV,
  });
  // Override URLs via the dedicated fetch fns by passing url through buildFeedsFile?
  // buildFeedsFile uses default URLs, so we exercise it via env override instead.
  process.env.CA_REGISTRY_URL = 'https://ca.test/registry.csv';
  process.env.VT_REGISTRY_URL = 'https://vt.test/registry.csv';
  delete require.cache[require.resolve('../lib/feeds')];
  const feeds = require('../lib/feeds');
  try {
    const result = await feeds.buildFeedsFile({
      fetchImpl,
      explicitHosts: ['beta.example.com'],  // collides with CA "Beta Brokers LLC"
    });
    // CA: Acme + Beta (2). VT: Gamma + Acme-dup (2).
    // Dedup: Beta dropped (explicit), VT Acme dropped (dup of CA Acme).
    // Survivors: Acme (ca), Gamma (vt) = 2.
    assert.equal(result.stats.ca, 2);
    assert.equal(result.stats.vt, 2);
    assert.equal(result.stats.total, 2);
    const names = result.brokers.map(b => b.name).sort();
    assert.deepEqual(names, ['Acme Data Co', 'Gamma Insights']);
    const acme = result.brokers.find(b => b.name === 'Acme Data Co');
    assert.equal(acme.source, 'ca');  // CA wins because it is merged first
  } finally {
    delete process.env.CA_REGISTRY_URL;
    delete process.env.VT_REGISTRY_URL;
    delete require.cache[require.resolve('../lib/feeds')];
  }
});

test('buildFeedsFile returns empty brokers when both registries are empty', async () => {
  const empty = 'Name,Website\n';
  const fetchImpl = makeFetch({
    'https://ca.test/empty.csv': empty,
    'https://vt.test/empty.csv': empty,
  });
  process.env.CA_REGISTRY_URL = 'https://ca.test/empty.csv';
  process.env.VT_REGISTRY_URL = 'https://vt.test/empty.csv';
  delete require.cache[require.resolve('../lib/feeds')];
  const feeds = require('../lib/feeds');
  try {
    const result = await feeds.buildFeedsFile({ fetchImpl, explicitHosts: [] });
    assert.deepEqual(result.brokers, []);
    assert.equal(result.stats.total, 0);
  } finally {
    delete process.env.CA_REGISTRY_URL;
    delete process.env.VT_REGISTRY_URL;
    delete require.cache[require.resolve('../lib/feeds')];
  }
});
```

- [ ] Step 3.2: Run it, expect fail. Command: `node --test test/feeds-fetch.test.js`. Expected: PASS if Task 1 is correct. The two `buildFeedsFile` tests re-require `lib/feeds` after setting env-var URLs (the module reads `process.env.CA_REGISTRY_URL` / `VT_REGISTRY_URL` at load time). If a test fails, read the assertion and reconcile against `lib/feeds.js` - the test is the spec for merge/dedup ordering (CA merged before VT, so CA wins ties).

- [ ] Step 3.3: Implement. No production change expected - `fetchCaRegistry`, `fetchVtRegistry`, and `buildFeedsFile` were written in Task 1 Step 1.3. If Step 3.2 revealed a gap (e.g. error message format, merge order), fix only `lib/feeds.js` and re-run.

- [ ] Step 3.4: Run, expect pass. Command: `node --test test/feeds-fetch.test.js`. Expected: `pass 5`, `fail 0`.

- [ ] Step 3.5: Commit.

```bash
rtk git add test/feeds-fetch.test.js
rtk git commit -m "$(cat <<'EOF'
Add injected-fetchImpl tests for registry fetchers + buildFeedsFile

Hermetic: a fake fetchImpl returns inline CSV (no network). Covers ca/vt
source tagging, the HTTP-error path, cross-registry + explicit-host dedup,
and the empty-registry case.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `generic-runner.js` loads `data/feeds-brokers.json`

`loadGenericBrokers(explicitBrokerHosts)` in `generic-runner.js` (lines 382-415) currently loads two sources (Markup at `MARKUP_PATH`, BADBOOL at `BADBOOL_PATH`), each deduped against the running `seen` set. Add a third source block that loads `data/feeds-brokers.json` when present, after the existing two, so registry brokers are appended and deduped against both the explicit hosts and the already-loaded Markup/BADBOOL hosts. Markup stays as the fallback (it loads first and is unaffected). Each feeds entry is `{ name, optOutUrl, method, source }`; the generic runner needs `{ name, url, source }`, so map `optOutUrl` -> `url` and skip entries with an empty/invalid `optOutUrl` (manual name-only rows have no actionable URL for the generic navigator).

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/generic-runner.js` (const block lines 25-29; `loadGenericBrokers` body lines 382-415)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/feeds-generic-runner.test.js` (Create)

- [ ] Step 4.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/feeds-generic-runner.test.js` with this complete content:

```js
/**
 * test/feeds-generic-runner.test.js
 *
 * loadGenericBrokers must pick up data/feeds-brokers.json (the live registry
 * feed file written by watcher.js --update-brokers) as a third source, deduped
 * against the explicit broker hosts and the Markup/BADBOOL hosts.
 *
 * Strategy: intercept fs.existsSync / fs.readFileSync via Module._load so the
 * three data files (markup, badbool, feeds) return controlled fixtures and no
 * real data/ files are read.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const Module   = require('module');
const path     = require('path');

const ROOT = path.join(__dirname, '..');
const MARKUP_PATH  = path.join(ROOT, 'data', 'markup-parsed.json');
const BADBOOL_PATH = path.join(ROOT, 'data', 'badbool-extra.json');
const FEEDS_PATH   = path.join(ROOT, 'data', 'feeds-brokers.json');

// Fixture contents keyed by absolute path.
function makeFsMock(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p, enc) => {
      if (Object.prototype.hasOwnProperty.call(files, p)) return files[p];
      // config.json is loaded lazily and not needed by loadGenericBrokers; throw
      // so any unexpected read is loud rather than silently passing real data.
      const err = new Error(`ENOENT mock: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

function freshGenericRunnerWith(fsMock) {
  const originalLoad = Module._load.bind(Module);
  function patchedLoad(request, parent, isMain) {
    if (!parent || !parent.filename || !parent.filename.includes('generic-runner')) {
      return originalLoad(request, parent, isMain);
    }
    if (request === 'fs') return fsMock;
    return originalLoad(request, parent, isMain);
  }
  Module._load = patchedLoad;
  const grPath = require.resolve('../generic-runner');
  delete require.cache[grPath];
  let gr;
  try {
    gr = require('../generic-runner');
  } finally {
    Module._load = originalLoad;
  }
  // Bust cache again so later requires get the real fs-backed module.
  delete require.cache[grPath];
  return gr;
}

test('loadGenericBrokers includes feeds-brokers.json entries as source=ca/vt', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([
      { name: 'Markup Co', urlFinal: 'https://markup.example.com/optout' },
    ]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Acme Data Co', optOutUrl: 'https://acme.example.com/opt-out', method: 'direct-form', source: 'ca' },
      { name: 'Gamma Insights', optOutUrl: 'https://gamma.example.com/do-not-sell', method: 'direct-form', source: 'vt' },
    ]),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  const byName = Object.fromEntries(brokers.map(b => [b.name, b]));
  assert.ok(byName['Acme Data Co'], 'feed broker present');
  assert.equal(byName['Acme Data Co'].url, 'https://acme.example.com/opt-out');
  assert.equal(byName['Acme Data Co'].source, 'ca');
  assert.equal(byName['Gamma Insights'].source, 'vt');
  assert.ok(byName['Markup Co'], 'markup fallback still loaded');
});

test('loadGenericBrokers dedups feed entries against explicit broker hosts', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Spokeo Feed', optOutUrl: 'https://www.spokeo.com/opt_out', method: 'direct-form', source: 'ca' },
      { name: 'Acme Data Co', optOutUrl: 'https://acme.example.com/opt-out', method: 'direct-form', source: 'ca' },
    ]),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set(['spokeo.com']));
  const names = brokers.map(b => b.name);
  assert.equal(names.includes('Spokeo Feed'), false, 'explicit-host collision dropped');
  assert.equal(names.includes('Acme Data Co'), true, 'non-colliding feed kept');
});

test('loadGenericBrokers dedups feed entries against Markup hosts loaded first', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([
      { name: 'Dupe Co', urlFinal: 'https://dupe.example.com/privacy' },
    ]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Dupe Feed', optOutUrl: 'https://dupe.example.com/opt-out', method: 'direct-form', source: 'vt' },
    ]),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  const names = brokers.map(b => b.name);
  assert.equal(names.includes('Dupe Co'), true, 'markup entry kept (loaded first)');
  assert.equal(names.includes('Dupe Feed'), false, 'feed dup of markup host dropped');
});

test('loadGenericBrokers skips feed entries with no usable http url', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([]),
    [BADBOOL_PATH]: JSON.stringify([]),
    [FEEDS_PATH]: JSON.stringify([
      { name: 'Nameonly Broker', optOutUrl: '', method: 'manual', source: 'vt' },
      { name: 'Good Broker', optOutUrl: 'https://good.example.com/optout', method: 'direct-form', source: 'vt' },
    ]),
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  const names = brokers.map(b => b.name);
  assert.equal(names.includes('Nameonly Broker'), false, 'url-less feed entry skipped');
  assert.equal(names.includes('Good Broker'), true);
});

test('loadGenericBrokers works when feeds-brokers.json is absent (markup-only fallback)', () => {
  const files = {
    [MARKUP_PATH]: JSON.stringify([
      { name: 'Markup Co', urlFinal: 'https://markup.example.com/optout' },
    ]),
    [BADBOOL_PATH]: JSON.stringify([]),
    // FEEDS_PATH intentionally omitted -> existsSync false
  };
  const gr = freshGenericRunnerWith(makeFsMock(files));
  const brokers = gr.loadGenericBrokers(new Set());
  assert.equal(brokers.length, 1);
  assert.equal(brokers[0].name, 'Markup Co');
  assert.equal(brokers[0].source, 'markup');
});
```

- [ ] Step 4.2: Run it, expect fail. Command: `node --test test/feeds-generic-runner.test.js`. Expected failure: the first three feed-aware tests fail because `loadGenericBrokers` does not yet read `FEEDS_PATH` (e.g. `feed broker present` assertion: `undefined` is not truthy). The markup-only fallback test should already pass.

- [ ] Step 4.3: Implement. Make two edits in `/Users/stephen/scripts/auto-identity-remove/generic-runner.js`.

Edit A - add the feeds path constant. Find this block (lines 25-29):

```js
const CONFIG_PATH     = path.join(__dirname, 'config.json');
const STATE_PATH      = path.join(__dirname, 'state.json');
const MARKUP_PATH     = path.join(__dirname, 'data', 'markup-parsed.json');
const BADBOOL_PATH    = path.join(__dirname, 'data', 'badbool-extra.json');
const DEAD_URLS_PATH  = path.join(__dirname, 'data', 'dead-urls.json');
```

Replace it with:

```js
const CONFIG_PATH     = path.join(__dirname, 'config.json');
const STATE_PATH      = path.join(__dirname, 'state.json');
const MARKUP_PATH     = path.join(__dirname, 'data', 'markup-parsed.json');
const BADBOOL_PATH    = path.join(__dirname, 'data', 'badbool-extra.json');
const FEEDS_PATH      = path.join(__dirname, 'data', 'feeds-brokers.json');
const DEAD_URLS_PATH  = path.join(__dirname, 'data', 'dead-urls.json');
```

Edit B - add the third source block. Find the end of `loadGenericBrokers` where the BADBOOL block ends and the function returns (lines 400-415):

```js
  // BADBOOL extras (27 additional people-search sites)
  if (fs.existsSync(BADBOOL_PATH)) {
    const extra = JSON.parse(fs.readFileSync(BADBOOL_PATH, 'utf8'));
    for (const url of extra) {
      if (!url.startsWith('http')) continue;
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (seen.has(host)) continue;
        seen.add(host);
        brokers.push({ name: host, url, source: 'badbool' });
      } catch(_) {}
    }
  }

  return brokers;
}
```

Replace it with:

```js
  // BADBOOL extras (27 additional people-search sites)
  if (fs.existsSync(BADBOOL_PATH)) {
    const extra = JSON.parse(fs.readFileSync(BADBOOL_PATH, 'utf8'));
    for (const url of extra) {
      if (!url.startsWith('http')) continue;
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (seen.has(host)) continue;
        seen.add(host);
        brokers.push({ name: host, url, source: 'badbool' });
      } catch(_) {}
    }
  }

  // Live registry feeds (California + Vermont), written by
  // `node watcher.js --update-brokers` to data/feeds-brokers.json. Loaded after
  // Markup/BADBOOL so the Markup dataset stays the fallback and feed entries are
  // deduped against everything already loaded. Each row is the normalized shape
  // { name, optOutUrl, method, source }; the generic runner navigates `url`, so
  // url-less manual rows are skipped here.
  if (fs.existsSync(FEEDS_PATH)) {
    try {
      const feeds = JSON.parse(fs.readFileSync(FEEDS_PATH, 'utf8'));
      if (Array.isArray(feeds)) {
        for (const row of feeds) {
          const url = row && row.optOutUrl;
          if (!url || !url.startsWith('http')) continue;
          try {
            const host = new URL(url).hostname.replace(/^www\./, '');
            if (seen.has(host)) continue;
            seen.add(host);
            brokers.push({ name: row.name || host, url, source: row.source || 'feed' });
          } catch(_) {}
        }
      }
    } catch(_) {}
  }

  return brokers;
}
```

- [ ] Step 4.4: Run, expect pass. Command: `node --test test/feeds-generic-runner.test.js`. Expected: `pass 5`, `fail 0`.

- [ ] Step 4.5: Commit.

```bash
rtk git add generic-runner.js test/feeds-generic-runner.test.js
rtk git commit -m "$(cat <<'EOF'
generic-runner: load data/feeds-brokers.json as a third source

loadGenericBrokers now appends live registry feeds (CA + VT) after Markup and
BADBOOL, deduped by host against the explicit list and earlier sources. Markup
stays as the fallback. url-less manual feed rows are skipped.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `--update-brokers` CLI mode in `watcher.js`

Add an early-exit CLI mode that fetches both registries, dedups against the explicit `brokers.js` hosts, and writes `data/feeds-brokers.json`. It must NOT launch Playwright (pure HTTP + file write), and it must use the default global `fetch` in production while staying testable via the injectable functions in `lib/feeds.js`. Because the handler is async (`runUpdateBrokers(...).then(process.exit)`), it must be wired as a peer branch of the existing async `--doctor` handler inside the `CONFIRM_EMAILS` else block - NOT as a standalone pre-ladder `if` like `--list`/`--pending`. The synchronous `--list`/`--pending` blocks `process.exit(0)` before falling through; an async handler placed there would instead fall through into the normal `loadConfig()`/Playwright/`main()` flow and run it concurrently. Wiring it as an `else if (UPDATE_BROKERS)` peer of `--doctor` short-circuits cleanly before any config load or browser launch. The handler builds the explicit-host Set from `brokers.js`, calls `buildFeedsFile`, `fs.writeFileSync`s the result, prints a summary, and `process.exit(0)`s - all inside `runUpdateBrokers` in `lib/feeds.js`.

The mode logic is extracted into a small pure-ish helper so it can be unit-tested without invoking `watcher.js` as a subprocess. Add `runUpdateBrokers({ buildFn, writeFn, brokers, logFn })` to `lib/feeds.js` (it orchestrates: derive explicit hosts -> buildFeedsFile -> write -> return stats). `watcher.js` calls it with real deps.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/feeds.js` (add `runUpdateBrokers` + export)
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js` (flag parse near lines 41-44; new `else if (UPDATE_BROKERS)` branch peered with the `--doctor` handler at lines 159-168)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/feeds-update-mode.test.js` (Create)

- [ ] Step 5.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/feeds-update-mode.test.js` with this complete content:

```js
/**
 * test/feeds-update-mode.test.js
 *
 * Tests runUpdateBrokers - the orchestration behind `watcher.js --update-brokers`.
 * All deps are injected (buildFn, writeFn, logFn), so there is no network and
 * no real file write.
 */

'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { runUpdateBrokers } = require('../lib/feeds');

const EXPLICIT_BROKERS = [
  { name: 'Spokeo', searchUrl: 'https://www.spokeo.com/' },
  { name: 'BeenVerified', optOutUrl: 'https://www.beenverified.com/app/optout/search' },
  { name: 'EmailOnly', method: 'email', emailTo: 'privacy@x.example.com' }, // no host
];

test('runUpdateBrokers derives explicit hosts and passes them to buildFn', async () => {
  let capturedHosts = null;
  const buildFn = async ({ explicitHosts }) => {
    capturedHosts = explicitHosts;
    return { brokers: [], stats: { ca: 0, vt: 0, total: 0 } };
  };
  const writeFn = () => {};
  await runUpdateBrokers({ buildFn, writeFn, brokers: EXPLICIT_BROKERS, logFn: () => {} });
  assert.ok(capturedHosts instanceof Set);
  assert.equal(capturedHosts.has('spokeo.com'), true);
  assert.equal(capturedHosts.has('beenverified.com'), true);
  // EmailOnly contributes no host
  assert.equal(capturedHosts.size, 2);
});

test('runUpdateBrokers writes the normalized broker array via writeFn', async () => {
  const brokerList = [
    { name: 'Acme', optOutUrl: 'https://acme.example.com/opt-out', method: 'direct-form', source: 'ca' },
  ];
  const buildFn = async () => ({ brokers: brokerList, stats: { ca: 1, vt: 0, total: 1 } });
  let written = null;
  const writeFn = (payload) => { written = payload; };
  const result = await runUpdateBrokers({ buildFn, writeFn, brokers: [], logFn: () => {} });
  assert.deepEqual(written, brokerList);
  assert.equal(result.stats.total, 1);
});

test('runUpdateBrokers returns the stats from buildFn for the caller to print', async () => {
  const buildFn = async () => ({ brokers: [], stats: { ca: 3, vt: 4, total: 5 } });
  const result = await runUpdateBrokers({ buildFn, writeFn: () => {}, brokers: [], logFn: () => {} });
  assert.deepEqual(result.stats, { ca: 3, vt: 4, total: 5 });
});

test('runUpdateBrokers logs a human summary line', async () => {
  const logs = [];
  const buildFn = async () => ({ brokers: [], stats: { ca: 2, vt: 1, total: 3 } });
  await runUpdateBrokers({ buildFn, writeFn: () => {}, brokers: [], logFn: (m) => logs.push(m) });
  const joined = logs.join('\n');
  assert.match(joined, /3/);   // total appears in summary
});
```

- [ ] Step 5.2: Run it, expect fail. Command: `node --test test/feeds-update-mode.test.js`. Expected failure: `runUpdateBrokers is not a function` (not yet exported from `lib/feeds.js`).

- [ ] Step 5.3: Implement. Two edits.

Edit A - add `runUpdateBrokers` to `/Users/stephen/scripts/auto-identity-remove/lib/feeds.js`. Insert this function immediately before the `module.exports = {` line:

```js
/**
 * Derive the bare (www-stripped) hostnames an explicit broker covers, from its
 * optOutUrl or searchUrl. Email-only / host-less brokers contribute nothing.
 * @param {Array<{optOutUrl?:string, searchUrl?:string}>} brokers
 * @returns {Set<string>}
 */
function explicitHostsOf(brokers) {
  const hosts = new Set();
  for (const b of brokers || []) {
    const host = hostnameOf((b && (b.optOutUrl || b.searchUrl)) || '');
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * Orchestrate `watcher.js --update-brokers`: derive explicit hosts, fetch +
 * normalize + dedup both registries via buildFn, persist via writeFn, and log a
 * summary via logFn. All side-effecting deps are injected for testability.
 * @param {{
 *   brokers: Array,
 *   buildFn?: (opts:{ explicitHosts:Set<string> }) => Promise<{brokers:Array, stats:object}>,
 *   writeFn?: (brokers:Array) => void,
 *   logFn?: (msg:string) => void,
 * }} deps
 * @returns {Promise<{ brokers: Array, stats: { ca:number, vt:number, total:number } }>}
 */
async function runUpdateBrokers(deps = {}) {
  const { brokers = [] } = deps;
  const buildFn = deps.buildFn || buildFeedsFile;
  const log = deps.logFn || (() => {});
  const writeFn = deps.writeFn || ((arr) => {
    fs.writeFileSync(FEEDS_PATH, JSON.stringify(arr, null, 2));
  });
  const explicitHosts = explicitHostsOf(brokers);
  log(`Fetching live broker registries (CA + Vermont)…`);
  const { brokers: feedBrokers, stats } = await buildFn({ explicitHosts });
  writeFn(feedBrokers);
  log(`Wrote ${stats.total} deduped registry broker(s) to data/feeds-brokers.json`);
  log(`  California: ${stats.ca} fetched · Vermont: ${stats.vt} fetched`);
  return { brokers: feedBrokers, stats };
}
```

Also add `const fs = require('fs');` near the top of `lib/feeds.js` (after the existing `const path = require('path');`), since the default `writeFn` uses it. Find:

```js
const path = require('path');
const { hostnameOf } = require('./serp-scan');
```

Replace with:

```js
const path = require('path');
const fs   = require('fs');
const { hostnameOf } = require('./serp-scan');
```

Then add `runUpdateBrokers` and `explicitHostsOf` to the exports. Find:

```js
module.exports = {
  normalizeFeedRow,
  parseCsv,
  parseCsvLine,
  mapHeaderRow,
  dedupeFeedBrokers,
  fetchCaRegistry,
  fetchVtRegistry,
  buildFeedsFile,
  CA_REGISTRY_URL,
  VT_REGISTRY_URL,
  FEEDS_PATH,
};
```

Replace with:

```js
module.exports = {
  normalizeFeedRow,
  parseCsv,
  parseCsvLine,
  mapHeaderRow,
  dedupeFeedBrokers,
  explicitHostsOf,
  fetchCaRegistry,
  fetchVtRegistry,
  buildFeedsFile,
  runUpdateBrokers,
  CA_REGISTRY_URL,
  VT_REGISTRY_URL,
  FEEDS_PATH,
};
```

Edit B - wire the CLI flag + mode in `/Users/stephen/scripts/auto-identity-remove/watcher.js`.

First, add the flag parse. Find (lines 41-44):

```js
const PENDING_MODE    = process.argv.includes('--pending');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
```

Replace with:

```js
const PENDING_MODE    = process.argv.includes('--pending');
const UPDATE_BROKERS  = process.argv.includes('--update-brokers');
const NO_CAPSOLVER    = process.argv.includes('--no-capsolver');
const RESUME          = process.argv.includes('--resume');
const SNAPSHOT        = process.argv.includes('--snapshot');
```

Then add the mode block.

IMPORTANT placement constraint: `--update-brokers` is async (it kicks off `runUpdateBrokers(...).then(process.exit)`), so unlike `--list`/`--pending` it CANNOT `process.exit(0)` synchronously. The standalone early-exit blocks for `--list`/`--pending` (lines 57-92) only work because they exit synchronously before execution falls through to the rest of the file. If `--update-brokers` were placed there as a standalone `if`, execution would fall through into the `if (CONFIRM_EMAILS) { ... } else { ... }` ladder and run the FULL normal watcher flow (`loadConfig()` at line 191, Playwright launch, `main()`) concurrently with the registry fetch - the opposite of the "no Playwright" goal, and a guaranteed race/crash.

The correct placement is as a peer branch of the existing async `--doctor` handler, inside the `CONFIRM_EMAILS` else block. That branch short-circuits BEFORE the `setDryRun`/`--install-scheduler`/`loadConfig()`/Playwright code (which all live in the final `else`), so update-brokers never touches config or the browser.

Find the `--doctor` block (lines 159-168):

```js
// ── --doctor: self-diagnose and exit ─────────────────────────────────────────
if (DOCTOR) {
  const { runDoctor } = require('./lib/doctor');
  runDoctor().then(results => {
    process.exit(results.exitCode);
  }).catch(err => {
    console.error('doctor error:', err.message);
    process.exit(1);
  });
} else {
```

Replace it with (adds an `else if (UPDATE_BROKERS)` branch; the trailing `} else {` that opens the normal-flow block is preserved unchanged):

```js
// ── --doctor: self-diagnose and exit ─────────────────────────────────────────
if (DOCTOR) {
  const { runDoctor } = require('./lib/doctor');
  runDoctor().then(results => {
    process.exit(results.exitCode);
  }).catch(err => {
    console.error('doctor error:', err.message);
    process.exit(1);
  });
} else if (UPDATE_BROKERS) {
  // ── --update-brokers: refresh data/feeds-brokers.json from live registries ──
  // Pure HTTP + file write; no Playwright, no loadConfig. Fetches the California
  // + Vermont data-broker registries, normalizes, dedups against brokers.js, and
  // writes the feed file consumed by generic-runner.js. Markup data remains the
  // fallback. Async, so this lives as a peer of --doctor (not a standalone
  // pre-ladder block) to avoid falling through into the normal Playwright run.
  const brokers = require('./brokers');
  const { runUpdateBrokers } = require('./lib/feeds');
  runUpdateBrokers({ brokers, logFn: (m) => console.log(m) })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('update-brokers error:', err.message);
      process.exit(1);
    });
} else {
```

Note: the async `.then(process.exit).catch(...)` shape mirrors the `--doctor` handler exactly. Because the branch sits at the `if (DOCTOR)` level inside the `CONFIRM_EMAILS` else, it skips `setDryRun` (line 176), `--install-scheduler` (lines 179-189), and `loadConfig()` (line 191) entirely.

- [ ] Step 5.4: Run, expect pass. Command: `node --test test/feeds-update-mode.test.js`. Expected: `pass 4`, `fail 0`. Also smoke-test that `watcher.js` still parses (no real run): `node -e "process.argv.push('--update-brokers'); require('./watcher.js')"` is NOT safe (it would hit the network); instead just confirm the file requires cleanly with `node --check watcher.js` and `node --check lib/feeds.js`.

- [ ] Step 5.5: Commit.

```bash
rtk git add lib/feeds.js watcher.js test/feeds-update-mode.test.js
rtk git commit -m "$(cat <<'EOF'
Add watcher.js --update-brokers CLI mode

New early-exit mode fetches the CA + Vermont data-broker registries (no
Playwright), normalizes + dedups against brokers.js, and writes
data/feeds-brokers.json. Orchestration lives in lib/feeds.js runUpdateBrokers
with injected build/write/log deps for hermetic testing.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Gitignore the generated feed file + README note

`data/feeds-brokers.json` is generated at runtime and must not be committed (mirrors how `state.json`, `serp-history.json`, and `logs/` are gitignored). Add it to `.gitignore`. Also note the new mode in the README run-modes table so users know to run it.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/.gitignore`
- Modify: `/Users/stephen/scripts/auto-identity-remove/README.md` (run-modes / commands area)
- Test: none (config/doc only) - verified via the full suite in Task 7.

- [ ] Step 6.1: Confirm current ignore entries. Command: `rtk read /Users/stephen/scripts/auto-identity-remove/.gitignore`. Expected: it lists `state.json`, `data/serp-history.json`, `logs/`, etc.

- [ ] Step 6.2: Edit `.gitignore`. Add `data/feeds-brokers.json` next to the other `data/` runtime artifact. Find the line:

```
data/serp-history.json
```

Replace with:

```
data/serp-history.json
data/feeds-brokers.json
```

(If `data/serp-history.json` is not present verbatim, append `data/feeds-brokers.json` on its own line under the existing `serp-history.json` entry instead. Verify with `rtk git status --porcelain data/` after the next `--update-brokers` run that the generated file shows as ignored.)

- [ ] Step 6.3: Edit `README.md`. The README documents modes as prose subsections of the form `### <Title> (\`--flag\`)` (e.g. `### Verifying removals (\`--verify\`)` at line 302, `### Pruning stale / dead URLs` under `## Maintenance` at line 356). It does NOT use a modes table. Add a new prose subsection under the `## Maintenance` section, immediately before the `### Pruning stale / dead URLs` subsection. Find this line (around line 356):

```
### Pruning stale / dead URLs
```

Insert this block immediately BEFORE it (no em dashes):

```
### Refreshing the broker list (`--update-brokers`)

The bundled Markup dataset is from January 2023 and is increasingly stale. Refresh the broker coverage from the official, auto-updating state data-broker registries:

```bash
node watcher.js --update-brokers
```

This fetches the California (SB-362) and Vermont registries over HTTP (no browser is launched), normalizes each entry, dedups it by hostname against the explicit brokers in `brokers.js`, and writes `data/feeds-brokers.json`. The generic runner loads that file alongside the Markup dataset on the next run; the Markup data stays as the fallback, so a failed or skipped refresh never reduces coverage. Override the registry URLs with the `CA_REGISTRY_URL` / `VT_REGISTRY_URL` environment variables if the official endpoints move.

```

- [ ] Step 6.4: Verify the docs/config edits did not break anything parse-wise. Command: `node --check watcher.js && node --check lib/feeds.js && node --check generic-runner.js`. Expected: no output (all parse clean).

- [ ] Step 6.5: Commit.

```bash
rtk git add .gitignore README.md
rtk git commit -m "$(cat <<'EOF'
Gitignore data/feeds-brokers.json + document --update-brokers

The feed file is generated at runtime by --update-brokers, so it joins the
other gitignored data/ artifacts. README now documents the new mode.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Full test suite green

Run the complete root suite (which is what CI runs) plus the dashboard suite, confirming the new tests pass and nothing regressed. No dashboard files were touched, but the dashboard suite is run for completeness since CI runs it.

Files:
- Test: entire `/Users/stephen/scripts/auto-identity-remove/test/` directory + `dashboard/validate.test.js` (root suite) and `dashboard/` (dashboard suite).

- [ ] Step 7.1: Run the root suite exactly as CI / package.json does. Command (from repo root): `node --test test/*.test.js dashboard/validate.test.js`. Expected: `pass` count includes all five new feed test files; `fail 0`. The five new files are `test/feeds-normalize.test.js`, `test/feeds-dedupe.test.js`, `test/feeds-fetch.test.js`, `test/feeds-generic-runner.test.js`, `test/feeds-update-mode.test.js`.

- [ ] Step 7.2: Run the dashboard suite. Command: `cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test`. Expected: `fail 0` (unchanged - no dashboard files modified).

- [ ] Step 7.3: If any test fails, do NOT modify a test to make it pass. Use superpowers:systematic-debugging - read the failing assertion, trace it to the offending production line in `lib/feeds.js`, `generic-runner.js`, or `watcher.js`, fix the production code, and re-run the single failing file before re-running the whole suite.

- [ ] Step 7.4: Final confirmation. Command: `node --test test/*.test.js dashboard/validate.test.js 2>&1 | rtk grep -E "tests |pass |fail "`. Expected: `fail 0`. Record the pass count in the commit body.

- [ ] Step 7.5: Commit (only if any production fix was made in 7.3; otherwise skip - Tasks 1-6 already committed their work).

```bash
rtk git add -A
rtk git commit -m "$(cat <<'EOF'
Fix feed-loading edge case surfaced by full suite

<replace this line with the specific fix made in Step 7.3; delete this task's
commit entirely if the suite was green with no changes>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

Spec coverage (against the FEATURE TO PLAN brief):
- New `lib/feeds.js` exporting `fetchCaRegistry({ fetchImpl })` and `fetchVtRegistry({ fetchImpl })` - Task 1 (implemented), tested in Task 3 with injected `fetchImpl` (no network). Both accept an options object whose `fetchImpl` defaults to the Node 18+ global `fetch`, matching `lib/notify.js`'s existing reliance on global `fetch` (Node engines `>=18`).
- PURE `normalizeFeedRow(row)` returning `{ name, optOutUrl, method: 'manual'|'direct-form', source }`, unit-tested over sample rows - Task 1 (`test/feeds-normalize.test.js`). `method` is `direct-form` for opt-out-style URLs and `manual` otherwise; name-only rows return `null` or a `manual` entry as specified.
- `--update-brokers` CLI mode that fetches, normalizes, dedups against existing explicit brokers by hostname, and writes `data/feeds-brokers.json` - Task 5 (`watcher.js` flag + mode block; orchestration `runUpdateBrokers` in `lib/feeds.js`, hermetically tested in `test/feeds-update-mode.test.js`).
- Consumed by `generic-runner.js` alongside Markup data, Markup kept as fallback - Task 4 adds the third source block AFTER Markup/BADBOOL, so Markup loads first and is untouched; the feed file is optional (`fs.existsSync` guard) so absence falls back to Markup-only (explicitly tested).
- Dedup reuses serp-scan hostname logic - `lib/feeds.js` imports `hostnameOf` from `./lib/serp-scan` (verified exported at `lib/serp-scan.js` line 439); `dedupeFeedBrokers` and `explicitHostsOf` both use it; the generic-runner block uses the same `new URL(...).hostname.replace(/^www\./,'')` pattern already in that file for Markup/BADBOOL.
- Tests: `normalizeFeedRow` + dedup pure tests with inline CSV/row fixtures (Tasks 1-2); `fetchImpl` mocked, no network (Task 3); the header-mapping step is implemented (`mapHeaderRow` + `NAME_HEADERS`/`URL_HEADERS` aliases) and tested.
- Real CSV URLs documented in `lib/feeds.js` constants: CA `oag.ca.gov/data-brokers` (legacy AG CSV; CPPA now maintains the live registry at `cppa.ca.gov/data_broker_registry`, noted in a comment) and Vermont `bizfilings.vermont.gov/online/DatabrokerInquire/...`, both overridable via `CA_REGISTRY_URL`/`VT_REGISTRY_URL` env vars (used by the Task 3 `buildFeedsFile` tests to point at in-memory fixtures).

Signature consistency with the real repo:
- `generic-runner.js` `loadGenericBrokers(explicitBrokerHosts)` signature unchanged; new block matches the existing `seen`-Set dedup pattern (verified against lines 382-415). `module.exports` is not changed by Task 4 (only an internal const + loop), so `runGenericBrokers`/`classifyNavError`/etc. exports are preserved.
- `watcher.js` flag parsing matches the existing `process.argv.includes(...)` style (lines 26-44). The new mode is an `else if (UPDATE_BROKERS)` branch peered with the async `--doctor` handler (inside the `CONFIRM_EMAILS` else block), using `.then(process.exit).catch(...)` exactly like `--doctor` (lines 160-167). It is deliberately NOT a standalone pre-ladder `if` like `--list`/`--pending`: those exit synchronously, whereas an async handler placed there would fall through into the normal `loadConfig()`/Playwright/`main()` run. As a `--doctor` peer it short-circuits before `setDryRun`/`--install-scheduler`/`loadConfig()` (lines 176-191), so there is no change to `loadConfig`/`getPersonsFromConfig`/Playwright launch.
- `lib/serp-scan.js` `hostnameOf(url)` is a real export (line 439) returning a www-stripped bare hostname or `''` on parse error - relied upon by `dedupeFeedBrokers`, `explicitHostsOf`, and the tests. `registrableDomain` is intentionally NOT used (it is not exported); dedup here is by exact bare hostname, consistent with how `generic-runner.js` already dedups Markup/BADBOOL by bare hostname.
- Tests use `node:test` + `node:assert/strict`, factory helpers (`makeFetch`, `makeFsMock`, `entry`), and the scoped `Module._load` interception pattern (`parent.filename.includes('generic-runner')`, bust `require.cache`, restore `Module._load` right after the require) matching `test/broker-runner-buckets.test.js` and the sibling `2026-06-09-broker-allowlist.md` plan.

No placeholders: every code step contains complete, runnable code (full function bodies, full test files, exact find/replace blocks with surrounding context). The only intentionally conditional step is Task 7 Step 7.5, which is a debugging-only commit explicitly marked to be skipped when the suite is already green.

No em dashes: all authored prose uses hyphens. (Source-comment ellipsis characters such as the U+2026 "…" in console strings mirror the existing style in `watcher.js`/`generic-runner.js`; the em-dash prohibition applies to authored hyphenation and no em dashes were introduced.)

New npm dependencies: none. Uses Node built-ins (`path`, `fs`, global `fetch`) and the already-present test runner; Playwright is deliberately not invoked by the new mode.
