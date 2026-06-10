/**
 * test/freeze.test.js
 *
 * Credit / identity freeze guided checklist.
 *
 * Two layers under test:
 *  1. FREEZE_TARGETS - the canonical, hard-coded list of freeze destinations.
 *  2. Pure status helpers - getFreezeStatus / recordFreezeDone / recordFreezeCleared.
 *
 * The status helpers operate on a plain state object. recordFreezeDone /
 * recordFreezeCleared persist through lib/config's saveState(); that disk
 * round-trip is exercised against a temp state path so the real state.json is
 * never touched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const freeze = require('../lib/freeze');
const cfg = require('../lib/config');

const EXPECTED_KEYS = ['equifax', 'experian', 'transunion', 'chexsystems', 'nctue', 'innovis', 'optoutprescreen'];

test('FREEZE_TARGETS lists all 7 freeze destinations with the expected keys', () => {
  assert.ok(Array.isArray(freeze.FREEZE_TARGETS), 'FREEZE_TARGETS must be an array');
  assert.equal(freeze.FREEZE_TARGETS.length, 7, 'exactly 7 targets');
  const keys = freeze.FREEZE_TARGETS.map(t => t.key);
  for (const k of EXPECTED_KEYS) {
    assert.ok(keys.includes(k), `missing target key: ${k}`);
  }
});

test('FREEZE_TARGETS keys are unique', () => {
  const keys = freeze.FREEZE_TARGETS.map(t => t.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate target keys present');
});

test('FREEZE_TARGETS splits into 3 credit bureaus and 4 specialty agencies', () => {
  const bureaus = freeze.FREEZE_TARGETS.filter(t => t.type === 'credit-bureau');
  const specialty = freeze.FREEZE_TARGETS.filter(t => t.type === 'specialty');
  assert.equal(bureaus.length, 3, '3 credit-bureau targets');
  assert.equal(specialty.length, 4, '4 specialty targets');
  assert.equal(bureaus.length + specialty.length, freeze.FREEZE_TARGETS.length, 'no other type values');
});

test('FREEZE_TARGETS every entry has name, https url and notes', () => {
  for (const t of freeze.FREEZE_TARGETS) {
    assert.equal(typeof t.name, 'string', `${t.key}: name must be a string`);
    assert.ok(t.name.length > 0, `${t.key}: name must be non-empty`);
    assert.match(t.url, /^https:\/\//, `${t.key}: url must be https`);
    assert.equal(typeof t.notes, 'string', `${t.key}: notes must be a string`);
    assert.ok(t.notes.length > 0, `${t.key}: notes must be non-empty`);
  }
});

test('FREEZE_TARGETS uses the real current freeze URLs', () => {
  const byKey = Object.fromEntries(freeze.FREEZE_TARGETS.map(t => [t.key, t.url]));
  assert.match(byKey.equifax, /equifax\.com/);
  assert.match(byKey.experian, /experian\.com/);
  assert.match(byKey.transunion, /transunion\.com/);
  assert.match(byKey.chexsystems, /chexsystems\.com/);
  assert.match(byKey.nctue, /nctue\.com/);
  assert.match(byKey.innovis, /innovis\.com/);
  assert.match(byKey.optoutprescreen, /optoutprescreen\.com/);
});

test('getFreezeStatus returns every target with done:false for empty state', () => {
  const status = freeze.getFreezeStatus({ optOuts: {} });
  assert.equal(status.length, 7);
  for (const row of status) {
    assert.equal(row.done, false, `${row.key} should be not-done`);
    assert.equal(row.doneAt, null, `${row.key} doneAt should be null`);
    assert.equal(typeof row.name, 'string');
    assert.match(row.url, /^https:\/\//);
    assert.ok(['credit-bureau', 'specialty'].includes(row.type));
  }
});

test('getFreezeStatus reports done:true with doneAt for completed targets', () => {
  const state = { optOuts: {}, freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' } } };
  const status = freeze.getFreezeStatus(state);
  const eq = status.find(r => r.key === 'equifax');
  const ex = status.find(r => r.key === 'experian');
  assert.equal(eq.done, true);
  assert.equal(eq.doneAt, '2026-06-01T00:00:00.000Z');
  assert.equal(ex.done, false);
  assert.equal(ex.doneAt, null);
});

test('getFreezeStatus ignores unknown keys in state.freezes', () => {
  const state = { freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' }, bogus: { doneAt: 'x' } } };
  const status = freeze.getFreezeStatus(state);
  assert.equal(status.length, 7, 'unknown keys must not add rows');
  assert.ok(!status.some(r => r.key === 'bogus'));
});

test('getFreezeStatus tolerates a state object with no freezes namespace', () => {
  const status = freeze.getFreezeStatus({});
  assert.equal(status.length, 7);
  assert.ok(status.every(r => r.done === false));
});

// ---- write helpers: temp-state round-trip ----------------------------------
// These mirror test/config-atomic-write.test.js: redirect lib/config's state
// path to a temp file, drive the helpers, then read the temp file back.

function makeTmpState(initialData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-state-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(initialData || { optOuts: {} }, null, 2));
  return { dir, stateFile };
}

test('recordFreezeDone persists state.freezes[key].doneAt to disk', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();

  const state = cfg.loadState();
  freeze.recordFreezeDone(state, 'equifax');

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.freezes, 'freezes namespace must exist on disk');
  assert.ok(persisted.freezes.equifax, 'equifax entry must be persisted');
  assert.match(persisted.freezes.equifax.doneAt, /^\d{4}-\d{2}-\d{2}T/, 'doneAt must be an ISO timestamp');

  cfg.setTestStatePath(null);
  cfg.resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordFreezeDone does not disturb the existing optOuts namespace', () => {
  const { dir, stateFile } = makeTmpState({ optOuts: { spokeo: { history: ['success'], lastSuccess: '2026-01-01T00:00:00.000Z' } } });
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();

  const state = cfg.loadState();
  freeze.recordFreezeDone(state, 'innovis');

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.optOuts.spokeo, 'optOuts must survive a freeze write');
  assert.equal(persisted.optOuts.spokeo.lastSuccess, '2026-01-01T00:00:00.000Z');
  assert.ok(persisted.freezes.innovis, 'innovis freeze recorded alongside optOuts');

  cfg.setTestStatePath(null);
  cfg.resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordFreezeCleared removes the entry and persists', () => {
  const { dir, stateFile } = makeTmpState({ optOuts: {}, freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' } } });
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();

  const state = cfg.loadState();
  freeze.recordFreezeCleared(state, 'equifax');

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(!persisted.freezes.equifax, 'cleared entry must be gone from disk');

  cfg.setTestStatePath(null);
  cfg.resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordFreezeDone throws on an unknown target key', () => {
  const state = { optOuts: {} };
  assert.throws(() => freeze.recordFreezeDone(state, 'bogus'), /unknown freeze target/);
});

test('recordFreezeCleared throws on an unknown target key', () => {
  const state = { optOuts: {} };
  assert.throws(() => freeze.recordFreezeCleared(state, 'bogus'), /unknown freeze target/);
});

test('recordFreezeDone then getFreezeStatus reflects done:true (round-trip)', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();

  const state = cfg.loadState();
  freeze.recordFreezeDone(state, 'transunion');
  const row = freeze.getFreezeStatus(state).find(r => r.key === 'transunion');
  assert.equal(row.done, true);
  assert.ok(row.doneAt, 'doneAt should be populated after recordFreezeDone');

  cfg.setTestStatePath(null);
  cfg.resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});
