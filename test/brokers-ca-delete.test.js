/**
 * test/brokers-ca-delete.test.js
 *
 * Verifies the California DELETE Portal broker entry exists in brokers.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

// brokers.js reads config.json at load time; use the config.example.json values
// by monkeypatching require before importing.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './config.json' || request === '../config.json') {
    return require('../config.example.json');
  }
  return origLoad.apply(this, arguments);
};

const brokers = require('../brokers');

Module._load = origLoad;

test('brokers.js exports a California DELETE Portal entry', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.ok(entry, 'California DELETE Portal entry must exist in brokers.js');
});

test('California DELETE Portal has priority 1', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.equal(entry.priority, 1);
});

test('California DELETE Portal has method manual', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.equal(entry.method, 'manual', 'CA DROP portal is not yet live; method must be manual');
});

test('California DELETE Portal optOutUrl points to cppa.ca.gov', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.ok(
    entry.optOutUrl && entry.optOutUrl.includes('cppa.ca.gov'),
    `optOutUrl must reference cppa.ca.gov, got: ${entry.optOutUrl}`
  );
});

test('California DELETE Portal has confidence documented_not_live', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  assert.equal(
    entry.confidence,
    'documented_not_live',
    'confidence must be documented_not_live to reflect that the DROP portal is not yet live'
  );
});

test('California DELETE Portal note mentions August 1 2026 deadline', () => {
  const entry = brokers.find(b => b.name === 'California DELETE Portal');
  const noteText = (entry.note || entry.notes || '').toLowerCase();
  assert.ok(
    noteText.includes('2026'),
    'note must mention the 2026 compliance deadline'
  );
});
