/**
 * test/pending.test.js
 *
 * Tests for getPendingConfirmations() in lib/config.js.
 *
 * Mutates the shared state.optOuts object directly (matching the approach
 * in test/config.test.js) and restores it afterward.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cfg = require('../lib/config');

test('getPendingConfirmations: empty when no pending entries', () => {
  cfg.setDryRun(true);
  const state = cfg.loadState();
  const name = '__pending_test_empty__';
  const prev = state.optOuts[name];
  delete state.optOuts[name];

  const result = cfg.getPendingConfirmations();
  // should not include our test key (it doesn't exist)
  assert.ok(Array.isArray(result));
  assert.ok(!result.some(e => e.name === name));

  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
  cfg.setDryRun(false);
});

test('getPendingConfirmations: returns entry when pendingConfirm exists and no success', () => {
  cfg.setDryRun(true);
  const state = cfg.loadState();
  const name = '__pending_test_no_success__';
  const prev = state.optOuts[name];

  state.optOuts[name] = {
    pendingConfirm: { since: '2026-04-01T00:00:00.000Z', snippet: 'Check inbox for confirm' },
  };

  const result = cfg.getPendingConfirmations();
  const match = result.find(e => e.name === name);
  assert.ok(match, 'should include the broker with pendingConfirm');
  assert.equal(match.since, '2026-04-01T00:00:00.000Z');
  assert.equal(match.snippet, 'Check inbox for confirm');

  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
  cfg.setDryRun(false);
});

test('getPendingConfirmations: excludes entry when success is newer than pendingConfirm', () => {
  cfg.setDryRun(true);
  const state = cfg.loadState();
  const name = '__pending_test_success_newer__';
  const prev = state.optOuts[name];

  state.optOuts[name] = {
    pendingConfirm: { since: '2026-03-01T00:00:00.000Z', snippet: 'Old confirmation' },
    lastSuccess: '2026-04-01T00:00:00.000Z', // success is newer
  };

  const result = cfg.getPendingConfirmations();
  const match = result.find(e => e.name === name);
  assert.ok(!match, 'should NOT include broker where success is newer than pendingConfirm');

  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
  cfg.setDryRun(false);
});

test('getPendingConfirmations: includes entry when pendingConfirm is newer than lastSuccess', () => {
  cfg.setDryRun(true);
  const state = cfg.loadState();
  const name = '__pending_test_pending_newer__';
  const prev = state.optOuts[name];

  state.optOuts[name] = {
    pendingConfirm: { since: '2026-04-15T00:00:00.000Z', snippet: 'Resubmitted later' },
    lastSuccess: '2026-01-01T00:00:00.000Z', // success is older
  };

  const result = cfg.getPendingConfirmations();
  const match = result.find(e => e.name === name);
  assert.ok(match, 'should include broker where pendingConfirm is newer than lastSuccess');
  assert.equal(match.since, '2026-04-15T00:00:00.000Z');

  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
  cfg.setDryRun(false);
});

test('getPendingConfirmations: result is sorted by since ascending', () => {
  cfg.setDryRun(true);
  const state = cfg.loadState();
  const nameA = '__pending_sort_a__';
  const nameB = '__pending_sort_b__';
  const nameC = '__pending_sort_c__';
  const prevA = state.optOuts[nameA];
  const prevB = state.optOuts[nameB];
  const prevC = state.optOuts[nameC];

  state.optOuts[nameA] = { pendingConfirm: { since: '2026-04-10T00:00:00.000Z', snippet: 'A' } };
  state.optOuts[nameB] = { pendingConfirm: { since: '2026-02-01T00:00:00.000Z', snippet: 'B' } };
  state.optOuts[nameC] = { pendingConfirm: { since: '2026-03-15T00:00:00.000Z', snippet: 'C' } };

  const result = cfg.getPendingConfirmations();
  const subset = result.filter(e => [nameA, nameB, nameC].includes(e.name));
  assert.equal(subset.length, 3);
  assert.equal(subset[0].name, nameB, 'nameB has earliest since');
  assert.equal(subset[1].name, nameC, 'nameC is in the middle');
  assert.equal(subset[2].name, nameA, 'nameA has latest since');

  if (prevA === undefined) delete state.optOuts[nameA]; else state.optOuts[nameA] = prevA;
  if (prevB === undefined) delete state.optOuts[nameB]; else state.optOuts[nameB] = prevB;
  if (prevC === undefined) delete state.optOuts[nameC]; else state.optOuts[nameC] = prevC;
  cfg.setDryRun(false);
});
