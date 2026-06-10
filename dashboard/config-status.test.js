/**
 * dashboard/config-status.test.js
 *
 * Unit tests for the pure configStatus() helper that decides whether the
 * dashboard should show the first-run wizard. No fs / express / network: the
 * helper is a pure function of the parsed config object. Runnable from the
 * root `node --test` suite.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configStatus, REQUIRED_PERSON_FIELDS } = require('./config-status');

test('null / undefined config is not configured and reports every required field missing', () => {
  for (const cfg of [null, undefined]) {
    const s = configStatus(cfg);
    assert.equal(s.configured, false);
    for (const f of REQUIRED_PERSON_FIELDS) {
      assert.ok(s.missing.includes(`person.${f}`), `missing should include person.${f}`);
    }
  }
});

test('empty object is not configured and reports all required fields missing', () => {
  const s = configStatus({});
  assert.equal(s.configured, false);
  assert.deepEqual(
    s.missing.slice().sort(),
    REQUIRED_PERSON_FIELDS.map(f => `person.${f}`).sort()
  );
});

test('a fully filled person is configured with no missing fields', () => {
  const cfg = {
    person: { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' },
  };
  const s = configStatus(cfg);
  assert.equal(s.configured, true);
  assert.deepEqual(s.missing, []);
});

test('the unedited example placeholder (Jane Doe / jane.doe@example.com) is treated as NOT configured', () => {
  const cfg = {
    person: { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com' },
  };
  const s = configStatus(cfg);
  assert.equal(s.configured, false);
  assert.ok(s.missing.includes('person.firstName'));
  assert.ok(s.missing.includes('person.lastName'));
  assert.ok(s.missing.includes('person.email'));
});

test('a partial person reports only the blank required fields as missing', () => {
  const cfg = { person: { firstName: 'Bob', lastName: '', email: '   ' } };
  const s = configStatus(cfg);
  assert.equal(s.configured, false);
  assert.deepEqual(s.missing.slice().sort(), ['person.email', 'person.lastName'].sort());
});

test('whitespace-only values count as missing', () => {
  const cfg = { person: { firstName: '   ', lastName: 'X', email: 'x@y.z' } };
  const s = configStatus(cfg);
  assert.equal(s.configured, false);
  assert.deepEqual(s.missing, ['person.firstName']);
});

test('a non-empty persons[] array satisfies configured even when person is absent', () => {
  const cfg = {
    persons: [{ firstName: 'Carol', lastName: 'Jones', email: 'carol@example.com' }],
  };
  const s = configStatus(cfg);
  assert.equal(s.configured, true);
  assert.deepEqual(s.missing, []);
});

test('an empty persons[] array is not configured (matches getPersonsFromConfig contract)', () => {
  const s = configStatus({ persons: [] });
  assert.equal(s.configured, false);
  assert.ok(s.missing.length > 0);
});

test('persons[] takes precedence: a complete persons[0] wins even if person is a placeholder', () => {
  const cfg = {
    person: { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com' },
    persons: [{ firstName: 'Dan', lastName: 'Lee', email: 'dan@example.com' }],
  };
  const s = configStatus(cfg);
  assert.equal(s.configured, true);
  assert.deepEqual(s.missing, []);
});
