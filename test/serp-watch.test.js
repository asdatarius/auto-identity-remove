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

// --- diffSerpResults ---------------------------------------------------------

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

// --- summaryHostnames --------------------------------------------------------

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

// --- historyHostnames --------------------------------------------------------

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

// --- buildAlert --------------------------------------------------------------

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

// --- runSerpWatch orchestrator (deps injected) --------------------------------

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
