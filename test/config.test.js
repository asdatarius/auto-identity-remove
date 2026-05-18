/**
 * test/config.test.js
 *
 * Covers the pure opt-out-history logic in lib/config.js:
 *   - lastOptOutDaysAgo: no entry → Infinity; recent → small; old → large
 *   - the dry-run state-save guard semantics (run-log is gated by DRY_RUN in
 *     watcher.js; recordSuccess writes state.json verbatim as in the monolith)
 *
 * The module's `state` is loaded from the real state.json at require time, so
 * these tests mutate the live shared object (matching process semantics) and
 * restore it afterward.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cfg = require('../lib/config');

test('lastOptOutDaysAgo: no entry → Infinity', () => {
  const state = cfg.loadState();
  const name = '__test_missing_broker__';
  delete state.optOuts[name];
  assert.equal(cfg.lastOptOutDaysAgo(name), Infinity);
});

test('lastOptOutDaysAgo: recent success → small number of days', () => {
  const state = cfg.loadState();
  const name = '__test_recent_broker__';
  const prev = state.optOuts[name];
  state.optOuts[name] = { lastSuccess: new Date().toISOString(), totalRuns: 1 };
  const days = cfg.lastOptOutDaysAgo(name);
  assert.ok(days >= 0 && days < 1, `expected <1 day, got ${days}`);
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('lastOptOutDaysAgo: old success → large number of days', () => {
  const state = cfg.loadState();
  const name = '__test_old_broker__';
  const prev = state.optOuts[name];
  const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  state.optOuts[name] = { lastSuccess: old, totalRuns: 1 };
  const days = cfg.lastOptOutDaysAgo(name);
  assert.ok(days > 360 && days < 370, `expected ~365 days, got ${days}`);
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('lastOptOutDaysAgo: entry without lastSuccess → Infinity', () => {
  const state = cfg.loadState();
  const name = '__test_no_lastsuccess__';
  const prev = state.optOuts[name];
  state.optOuts[name] = { totalRuns: 3 };
  assert.equal(cfg.lastOptOutDaysAgo(name), Infinity);
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('RECHECK_DAYS constant is 90 (unchanged from monolith)', () => {
  assert.equal(cfg.RECHECK_DAYS, 90);
});

test('setDryRun(true): recordSuccess does NOT write state.json to disk', () => {
  const fs = require('node:fs');
  const before = fs.existsSync(cfg.STATE_PATH)
    ? fs.readFileSync(cfg.STATE_PATH, 'utf8')
    : null;
  const state = cfg.loadState();
  const name = '__test_dryrun_no_persist__';
  const prev = state.optOuts[name];

  cfg.setDryRun(true);
  cfg.recordSuccess(name, 'should-not-persist');
  const after = fs.existsSync(cfg.STATE_PATH)
    ? fs.readFileSync(cfg.STATE_PATH, 'utf8')
    : null;
  cfg.setDryRun(false); // restore for other tests

  assert.equal(after, before, 'state.json must be byte-identical after dry-run recordSuccess');
  assert.ok(state.optOuts[name], 'in-memory mutation still happens (harmless)');

  // cleanup in-memory
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('resetState(): reloads from disk in place, reference stays valid', () => {
  const state = cfg.loadState();
  const name = '__test_reset_marker__';
  state.optOuts[name] = { lastSuccess: new Date().toISOString(), totalRuns: 99 };
  const sameRef = cfg.resetState();
  assert.equal(sameRef, state, 'resetState returns the same shared reference');
  assert.equal(state.optOuts[name], undefined, 'in-memory-only change is wiped by reload');
});

test('setDryRun is exported and resets cleanly', () => {
  assert.equal(typeof cfg.setDryRun, 'function');
  assert.equal(typeof cfg.resetState, 'function');
  cfg.setDryRun(false);
});
