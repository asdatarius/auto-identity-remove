/**
 * test/allowlist-logger.test.js
 *
 * Verifies the logger learns the new 'allowlisted' status and routes it to the
 * 'skipped' bucket (allowlisted brokers are intentionally not acted on, so they
 * belong with skips, not errors).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { STATUS_BUCKET, ICONS, logResult, resetResults, results } = require('../lib/logger');

test('STATUS_BUCKET maps allowlisted -> skipped', () => {
  assert.equal(STATUS_BUCKET.allowlisted, 'skipped');
});

test('ICONS has an entry for allowlisted', () => {
  assert.ok(ICONS.allowlisted, 'expected an icon for the allowlisted status');
});

test('logResult routes an allowlisted entry into results.skipped', () => {
  resetResults();
  logResult('Spokeo', 'allowlisted', 'on allowlist - keeping listing');
  const entry = results.skipped.find(e => e.broker === 'Spokeo');
  assert.ok(entry, 'allowlisted entry should land in the skipped bucket');
  assert.equal(entry.status, 'allowlisted');
});
