const { test } = require('node:test');
const assert = require('node:assert/strict');
const brokers = require('../brokers');
const cfg = require('../lib/config');

test('at least 5 brokers have expectedSender defined', () => {
  const withSender = brokers.filter(b => b.expectedSender);
  assert.ok(withSender.length >= 5, `expected >= 5 brokers with expectedSender, got ${withSender.length}`);
});

test('all expectedSender values contain @', () => {
  const bad = brokers.filter(b => b.expectedSender && !b.expectedSender.includes('@'));
  assert.equal(bad.length, 0, `brokers with invalid expectedSender: ${bad.map(b => b.name).join(', ')}`);
});

test('getPendingConfirmations(brokers) includes expectedSender when broker has it', () => {
  const state = cfg.loadState();
  const name = '__test_sender_hint__';
  const prev = state.optOuts[name];
  cfg.setDryRun(true);

  state.optOuts[name] = { pendingConfirm: { since: new Date().toISOString(), snippet: 'check email' } };
  const fakeBrokers = [{ name, expectedSender: 'noreply@test.com' }];
  const results = cfg.getPendingConfirmations(fakeBrokers);
  const entry = results.find(r => r.name === name);
  assert.ok(entry, 'entry should be present');
  assert.equal(entry.expectedSender, 'noreply@test.com');

  cfg.setDryRun(false);
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('getPendingConfirmations(brokers) falls back to snippet when no expectedSender', () => {
  const state = cfg.loadState();
  const name = '__test_no_sender__';
  const prev = state.optOuts[name];
  cfg.setDryRun(true);

  state.optOuts[name] = { pendingConfirm: { since: new Date().toISOString(), snippet: 'please confirm' } };
  const fakeBrokers = [{ name }]; // no expectedSender
  const results = cfg.getPendingConfirmations(fakeBrokers);
  const entry = results.find(r => r.name === name);
  assert.ok(entry);
  assert.equal(entry.expectedSender, undefined);
  assert.equal(entry.snippet, 'please confirm');

  cfg.setDryRun(false);
  if (prev === undefined) delete state.optOuts[name]; else state.optOuts[name] = prev;
});

test('getPendingConfirmations() with no args still works (backward compat)', () => {
  // Should not throw even without brokers array
  const results = cfg.getPendingConfirmations();
  assert.ok(Array.isArray(results));
});
