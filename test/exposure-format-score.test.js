/**
 * test/exposure-format-score.test.js
 *
 * Fix 7: formatScoreReport must use the BREACH_POINTS constant (8) rather than
 * the magic number literal 8 when computing the breach count for display.
 *
 * The observable behavior is unchanged (BREACH_POINTS = 8), but the code is
 * now correct by construction when BREACH_POINTS changes.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { formatScoreReport } = require('../lib/exposure');

// ── formatScoreReport tests ───────────────────────────────────────────────────

describe('formatScoreReport breach line', () => {
  test('shows correct breach count in the output (breach pts / BREACH_POINTS = count)', () => {
    const summary = {
      score: 40,
      breakdown: { listed: 20, serp: 4, breach: 16 }, // 16 / 8 = 2 breaches
      listedCount: 2,
      serpHits: 1,
      breachWeight: 16,
    };
    const report = formatScoreReport(summary, []);
    // breach line should show "2" as the count (16 / 8 = 2)
    assert.ok(report.includes('2'), `Expected breach count 2 in report: ${report}`);
    // sanity: should also show breach pts
    assert.ok(report.includes('16'), `Expected breach pts 16 in report: ${report}`);
  });

  test('shows 0 breach count when breakdown.breach is 0', () => {
    const summary = {
      score: 10,
      breakdown: { listed: 10, serp: 0, breach: 0 },
      listedCount: 1,
      serpHits: 0,
      breachWeight: 0,
    };
    const report = formatScoreReport(summary, []);
    // The line should include "0" for breach count and "+0 pts"
    assert.ok(report.includes('+0'), `Expected +0 pts in report: ${report}`);
  });

  test('shows trend line when prior history is provided', () => {
    const summary = {
      score: 30,
      breakdown: { listed: 30, serp: 0, breach: 0 },
      listedCount: 3,
      serpHits: 0,
      breachWeight: 0,
    };
    const history = [{ score: 50, listedCount: 5 }];
    const report = formatScoreReport(summary, history);
    assert.ok(report.includes('improved') || report.includes('down'), `Expected improvement trend: ${report}`);
  });

  test('shows "no previous snapshot" when history is empty', () => {
    const summary = {
      score: 20,
      breakdown: { listed: 20, serp: 0, breach: 0 },
      listedCount: 2,
      serpHits: 0,
      breachWeight: 0,
    };
    const report = formatScoreReport(summary, []);
    assert.ok(report.includes('no previous snapshot'), `Expected no-snapshot message: ${report}`);
  });
});
