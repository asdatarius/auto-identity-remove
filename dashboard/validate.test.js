/**
 * dashboard/validate.test.js
 *
 * Security regression tests for the dashboard run-request validation, added
 * after a security review of the web-dashboard PR. These cover:
 *   1. Flag-injection via --only/--skip filter values.
 *   2. Server-side confirmation requirement for live (real-action) modes.
 *
 * Pure logic only - no express dependency - so it runs under the repo's
 * top-level `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLiveMode, validateFilter, validateRunRequest } = require('./validate');

// Mirror of server.js MODE_ARGS keys (values irrelevant to validation).
const MODE_ARGS = {
  preview: ['--preview'],
  real: [],
  verify: ['--verify'],
  doctor: ['--doctor'],
  list: ['--list'],
  pending: ['--pending'],
  confirm: ['--confirm-emails'],
  retry: ['--retry-failed'],
  serp: ['--serp-scan'],
  snapshot: ['--snapshot'],
};

// ── validateFilter ───────────────────────────────────────────────────────────

test('validateFilter: undefined/empty is allowed and yields undefined', () => {
  for (const v of [undefined, null, '', '   ', ',']) {
    const r = validateFilter(v);
    assert.equal(r.ok, true, `value ${JSON.stringify(v)} should be ok`);
    assert.equal(r.value, undefined);
  }
});

test('validateFilter: plain broker names pass through trimmed', () => {
  const r = validateFilter(' Spokeo , BeenVerified ');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'Spokeo,BeenVerified');
});

test('validateFilter: rejects a value that starts with "-" (flag injection)', () => {
  for (const bad of ['--no-capsolver', '--serp-scan', '--snapshot', '--resume', '--pollute', '-x']) {
    const r = validateFilter(bad);
    assert.equal(r.ok, false, `"${bad}" must be rejected`);
    assert.match(r.error, /flag injection|cannot start/i);
  }
});

test('validateFilter: rejects an injected flag hidden among valid names', () => {
  const r = validateFilter('Spokeo,--pollute,BeenVerified');
  assert.equal(r.ok, false, 'a "-"-prefixed token anywhere must reject the whole value');
});

test('validateFilter: rejects non-string values', () => {
  for (const bad of [42, {}, ['x'], true]) {
    const r = validateFilter(bad);
    assert.equal(r.ok, false);
  }
});

// ── isLiveMode ───────────────────────────────────────────────────────────────

test('isLiveMode: real/retry/snapshot/confirm are live; others are not', () => {
  for (const m of ['real', 'retry', 'snapshot', 'confirm']) assert.equal(isLiveMode(m), true, `${m} live`);
  for (const m of ['preview', 'verify', 'doctor', 'list', 'pending', 'serp']) assert.equal(isLiveMode(m), false, `${m} not live`);
});

// ── validateRunRequest ───────────────────────────────────────────────────────

test('validateRunRequest: defaults to preview when no mode given', () => {
  const r = validateRunRequest({}, MODE_ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'preview');
});

test('validateRunRequest: rejects an unknown mode', () => {
  const r = validateRunRequest({ mode: 'evil' }, MODE_ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /unknown mode/);
});

test('validateRunRequest: live mode WITHOUT confirm is rejected', () => {
  for (const mode of ['real', 'retry', 'snapshot', 'confirm']) {
    const r = validateRunRequest({ mode }, MODE_ARGS);
    assert.equal(r.ok, false, `${mode} without confirm must be rejected`);
    assert.equal(r.status, 400);
    assert.match(r.error, /confirm/);
  }
});

test('validateRunRequest: live mode WITH confirm:true is accepted', () => {
  for (const mode of ['real', 'retry', 'snapshot', 'confirm']) {
    const r = validateRunRequest({ mode, confirm: true }, MODE_ARGS);
    assert.equal(r.ok, true, `${mode} with confirm should pass`);
    assert.equal(r.mode, mode);
  }
});

test('validateRunRequest: confirm must be exactly true (not truthy)', () => {
  for (const c of ['true', 1, 'yes', {}]) {
    const r = validateRunRequest({ mode: 'real', confirm: c }, MODE_ARGS);
    assert.equal(r.ok, false, `confirm=${JSON.stringify(c)} must not satisfy the gate`);
  }
});

test('validateRunRequest: non-live modes do not require confirm', () => {
  for (const mode of ['preview', 'verify', 'doctor', 'list', 'pending', 'serp']) {
    const r = validateRunRequest({ mode }, MODE_ARGS);
    assert.equal(r.ok, true, `${mode} should not require confirm`);
  }
});

test('validateRunRequest: flag-injection in only/skip is rejected even for a safe mode', () => {
  const r1 = validateRunRequest({ mode: 'preview', only: '--pollute' }, MODE_ARGS);
  assert.equal(r1.ok, false);
  assert.equal(r1.status, 400);
  const r2 = validateRunRequest({ mode: 'preview', skip: '--serp-scan' }, MODE_ARGS);
  assert.equal(r2.ok, false);
});

test('validateRunRequest: clean filters are normalized onto the result', () => {
  const r = validateRunRequest({ mode: 'preview', only: ' Spokeo , Radaris ', skip: 'MyLife' }, MODE_ARGS);
  assert.equal(r.ok, true);
  assert.equal(r.only, 'Spokeo,Radaris');
  assert.equal(r.skip, 'MyLife');
});
