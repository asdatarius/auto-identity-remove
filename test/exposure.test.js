/**
 * test/exposure.test.js
 *
 * Pure unit tests for lib/exposure.js computeExposureScore across many state
 * shapes, plus an atomic-write round-trip for the snapshot history helpers.
 * No live network, no real browser, no writes to the real data dir
 * (history path is overridden to a temp file via setTestExposureHistoryPath).
 */

'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  computeExposureScore,
  snapshotExposure,
  loadExposureHistory,
  setTestExposureHistoryPath,
} = require('../lib/exposure');

function tmpFile() {
  return path.join(os.tmpdir(), `aidr-exposure-${crypto.randomBytes(6).toString('hex')}.json`);
}

afterEach(() => {
  setTestExposureHistoryPath(null);
});

// computeExposureScore: empty / no-signal shapes

test('computeExposureScore: empty state and no serp/breach -> score 0', () => {
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.score, 0);
  assert.equal(r.listedCount, 0);
  assert.equal(r.serpHits, 0);
  assert.equal(r.breachWeight, 0);
  assert.deepEqual(r.breakdown, { listed: 0, serp: 0, breach: 0 });
});

test('computeExposureScore: tolerates missing/garbage inputs (defaults applied)', () => {
  const r = computeExposureScore({});
  assert.equal(r.score, 0);
  assert.equal(r.listedCount, 0);
  assert.equal(r.serpHits, 0);
  assert.equal(r.breachWeight, 0);
});

// still-listed detection

test('computeExposureScore: lastSuccess with no verification counts as still listed', () => {
  const state = { optOuts: { Spokeo: { lastSuccess: '2026-01-01T00:00:00.000Z' } } };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 1);
  assert.equal(r.breakdown.listed, 10);
  assert.equal(r.score, 10);
});

test('computeExposureScore: verifiedDeletedAt newer than success is NOT still listed', () => {
  const state = {
    optOuts: {
      Spokeo: {
        lastSuccess: '2026-01-01T00:00:00.000Z',
        verifiedDeletedAt: '2026-02-01T00:00:00.000Z',
      },
    },
  };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 0);
  assert.equal(r.score, 0);
});

test('computeExposureScore: verifiedStillListedAt newer than verifiedDeletedAt IS still listed', () => {
  const state = {
    optOuts: {
      Radaris: {
        lastSuccess: '2026-01-01T00:00:00.000Z',
        verifiedDeletedAt: '2026-02-01T00:00:00.000Z',
        verifiedStillListedAt: '2026-03-01T00:00:00.000Z',
      },
    },
  };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 1);
  assert.equal(r.score, 10);
});

test('computeExposureScore: verifiedStillListedAt OLDER than verifiedDeletedAt is NOT still listed', () => {
  const state = {
    optOuts: {
      MyLife: {
        lastSuccess: '2026-01-01T00:00:00.000Z',
        verifiedStillListedAt: '2026-02-01T00:00:00.000Z',
        verifiedDeletedAt: '2026-03-01T00:00:00.000Z',
      },
    },
  };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 0);
  assert.equal(r.score, 0);
});

test('computeExposureScore: entry with no lastSuccess at all is not counted', () => {
  const state = { optOuts: { Foo: { history: ['error'] } } };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 0);
  assert.equal(r.score, 0);
});

test('computeExposureScore: multi-person keys are each counted independently', () => {
  const state = {
    optOuts: {
      'Spokeo|Jane Doe': { lastSuccess: '2026-01-01T00:00:00.000Z' },
      'Spokeo|John Doe': { lastSuccess: '2026-01-01T00:00:00.000Z', verifiedDeletedAt: '2026-02-01T00:00:00.000Z' },
    },
  };
  const r = computeExposureScore({ state, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 1);
  assert.equal(r.score, 10);
});

// SERP hit weighting

test('computeExposureScore: serp rank 1-3 weighted 3 each', () => {
  const serpResults = [
    { broker: 'Spokeo', ranks: { ddg: 2, bing: null, google: null } },
    { broker: 'Radaris', ranks: { ddg: null, bing: 3, google: null } },
  ];
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults, breachCount: 0, brokers: [] });
  assert.equal(r.serpHits, 2);
  // weight 3 + 3 = 6; serp points = 6 * 4 = 24
  assert.equal(r.breakdown.serp, 24);
  assert.equal(r.score, 24);
});

test('computeExposureScore: serp uses best (lowest) rank across engines', () => {
  const serpResults = [
    { broker: 'Spokeo', ranks: { ddg: 12, bing: 2, google: 40 } },
  ];
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults, breachCount: 0, brokers: [] });
  // best rank 2 -> weight 3 -> 3 * 4 = 12
  assert.equal(r.breakdown.serp, 12);
});

test('computeExposureScore: serp rank 4-10 weighted 2, rank 11+ weighted 1', () => {
  const serpResults = [
    { broker: 'A', ranks: { ddg: 5, bing: null, google: null } },   // weight 2
    { broker: 'B', ranks: { ddg: 25, bing: null, google: null } },  // weight 1
  ];
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults, breachCount: 0, brokers: [] });
  assert.equal(r.serpHits, 2);
  // weight 2 + 1 = 3; serp points = 3 * 4 = 12
  assert.equal(r.breakdown.serp, 12);
});

test('computeExposureScore: serp entry with all-null ranks weighted 1', () => {
  const serpResults = [
    { broker: 'A', ranks: { ddg: null, bing: null, google: null } },
  ];
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults, breachCount: 0, brokers: [] });
  assert.equal(r.serpHits, 1);
  assert.equal(r.breakdown.serp, 4); // weight 1 * 4
});

// breach weighting + default

test('computeExposureScore: breachCount defaults to 0 when omitted', () => {
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults: [] });
  assert.equal(r.breachWeight, 0);
  assert.equal(r.breakdown.breach, 0);
});

test('computeExposureScore: each breach adds 8 points', () => {
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults: [], breachCount: 3, brokers: [] });
  assert.equal(r.breachWeight, 24); // 3 * 8
  assert.equal(r.breakdown.breach, 24);
  assert.equal(r.score, 24);
});

test('computeExposureScore: negative breachCount is clamped to 0', () => {
  const r = computeExposureScore({ state: { optOuts: {} }, serpResults: [], breachCount: -5, brokers: [] });
  assert.equal(r.breachWeight, 0);
  assert.equal(r.score, 0);
});

// combined + cap

test('computeExposureScore: combines listed + serp + breach', () => {
  const state = { optOuts: { Spokeo: { lastSuccess: '2026-01-01T00:00:00.000Z' } } };
  const serpResults = [{ broker: 'Spokeo', ranks: { ddg: 1, bing: null, google: null } }];
  const r = computeExposureScore({ state, serpResults, breachCount: 1, brokers: [] });
  // listed: 1*10 = 10 ; serp: weight 3 *4 = 12 ; breach: 1*8 = 8 ; total 30
  assert.equal(r.breakdown.listed, 10);
  assert.equal(r.breakdown.serp, 12);
  assert.equal(r.breakdown.breach, 8);
  assert.equal(r.score, 30);
});

test('computeExposureScore: score is capped at 100', () => {
  const optOuts = {};
  for (let i = 0; i < 50; i++) optOuts['B' + i] = { lastSuccess: '2026-01-01T00:00:00.000Z' };
  const r = computeExposureScore({ state: { optOuts }, serpResults: [], breachCount: 0, brokers: [] });
  assert.equal(r.listedCount, 50);
  assert.equal(r.score, 100); // 50*10 = 500 capped to 100
});

// snapshot history round-trip (impure, temp path only)

test('snapshotExposure: appends a dated entry and loadExposureHistory reads it back', () => {
  const p = tmpFile();
  setTestExposureHistoryPath(p);
  try {
    assert.deepEqual(loadExposureHistory(), []); // none yet
    const summary = { score: 30, breakdown: { listed: 10, serp: 12, breach: 8 }, listedCount: 1, serpHits: 1, breachWeight: 8 };
    const entry = snapshotExposure(summary, { now: new Date('2026-06-09T12:00:00.000Z') });
    assert.equal(entry.score, 30);
    assert.equal(entry.at, '2026-06-09T12:00:00.000Z');
    const hist = loadExposureHistory();
    assert.equal(hist.length, 1);
    assert.equal(hist[0].score, 30);
    assert.deepEqual(hist[0].breakdown, { listed: 10, serp: 12, breach: 8 });
  } finally {
    try { fs.unlinkSync(p); } catch (_) {}
    try { fs.unlinkSync(p + '.bak'); } catch (_) {}
  }
});

test('snapshotExposure: a second snapshot appends rather than overwrites', () => {
  const p = tmpFile();
  setTestExposureHistoryPath(p);
  try {
    const s1 = { score: 30, breakdown: { listed: 10, serp: 12, breach: 8 }, listedCount: 1, serpHits: 1, breachWeight: 8 };
    const s2 = { score: 10, breakdown: { listed: 10, serp: 0, breach: 0 }, listedCount: 1, serpHits: 0, breachWeight: 0 };
    snapshotExposure(s1, { now: new Date('2026-05-09T00:00:00.000Z') });
    snapshotExposure(s2, { now: new Date('2026-06-09T00:00:00.000Z') });
    const hist = loadExposureHistory();
    assert.equal(hist.length, 2);
    assert.equal(hist[0].score, 30);
    assert.equal(hist[1].score, 10);
  } finally {
    try { fs.unlinkSync(p); } catch (_) {}
    try { fs.unlinkSync(p + '.bak'); } catch (_) {}
  }
});

test('loadExposureHistory: returns [] when the file is absent or unparseable', () => {
  const p = tmpFile();
  setTestExposureHistoryPath(p);
  try {
    assert.deepEqual(loadExposureHistory(), []); // absent
    fs.writeFileSync(p, 'not json{');
    assert.deepEqual(loadExposureHistory(), []); // unparseable
    fs.writeFileSync(p, JSON.stringify({ not: 'an array' }));
    assert.deepEqual(loadExposureHistory(), []); // wrong shape
  } finally {
    try { fs.unlinkSync(p); } catch (_) {}
  }
});

// serpResultsFromHistory (reconstruct best-rank summary from history)

const { serpResultsFromHistory, formatScoreReport } = require('../lib/exposure');

test('serpResultsFromHistory: collapses raw serp-history rows into best-rank-per-broker', () => {
  const rows = [
    { personId: 'x', broker: 'Spokeo', engine: 'ddg', rank: 5, hostname: 'spokeo.com', scannedAt: '2026-06-01T00:00:00.000Z' },
    { personId: 'x', broker: 'Spokeo', engine: 'bing', rank: 2, hostname: 'spokeo.com', scannedAt: '2026-06-01T00:00:00.000Z' },
    { personId: 'x', broker: 'Radaris', engine: 'google', rank: 12, hostname: 'radaris.com', scannedAt: '2026-06-01T00:00:00.000Z' },
  ];
  const out = serpResultsFromHistory(rows);
  const spokeo = out.find(r => r.broker === 'Spokeo');
  const radaris = out.find(r => r.broker === 'Radaris');
  assert.ok(spokeo);
  assert.equal(spokeo.ranks.ddg, 5);
  assert.equal(spokeo.ranks.bing, 2);
  assert.equal(spokeo.ranks.google, null);
  assert.ok(radaris);
  assert.equal(radaris.ranks.google, 12);
});

test('serpResultsFromHistory: empty / non-array input -> []', () => {
  assert.deepEqual(serpResultsFromHistory([]), []);
  assert.deepEqual(serpResultsFromHistory(null), []);
  assert.deepEqual(serpResultsFromHistory(undefined), []);
});

test('serpResultsFromHistory: keeps the lowest rank when a broker/engine repeats', () => {
  const rows = [
    { broker: 'Spokeo', engine: 'ddg', rank: 9 },
    { broker: 'Spokeo', engine: 'ddg', rank: 4 },
  ];
  const out = serpResultsFromHistory(rows);
  assert.equal(out[0].ranks.ddg, 4);
});

// formatScoreReport (presentational, returns a multi-line string)

test('formatScoreReport: includes the score, each breakdown line, and no trend when history is empty', () => {
  const summary = { score: 30, breakdown: { listed: 10, serp: 12, breach: 8 }, listedCount: 1, serpHits: 1, breachWeight: 8 };
  const out = formatScoreReport(summary, []);
  assert.match(out, /Exposure score/i);
  assert.match(out, /30\s*\/\s*100/);
  assert.match(out, /still-listed/i);
  assert.match(out, /search/i);
  assert.match(out, /breach/i);
  assert.match(out, /no previous snapshot/i);
});

test('formatScoreReport: shows a downward (better) trend vs the last snapshot', () => {
  const summary = { score: 10, breakdown: { listed: 10, serp: 0, breach: 0 }, listedCount: 1, serpHits: 0, breachWeight: 0 };
  const history = [{ at: '2026-05-09T00:00:00.000Z', score: 30 }];
  const out = formatScoreReport(summary, history);
  // current 10 vs previous 30 -> delta -20 (improvement). Lower is better.
  assert.match(out, /-20/);
  assert.match(out, /improv|better|down/i);
});

test('formatScoreReport: shows an upward (worse) trend vs the last snapshot', () => {
  const summary = { score: 40, breakdown: { listed: 30, serp: 8, breach: 0 }, listedCount: 3, serpHits: 2, breachWeight: 0 };
  const history = [{ at: '2026-05-09T00:00:00.000Z', score: 25 }];
  const out = formatScoreReport(summary, history);
  assert.match(out, /\+15/);
  assert.match(out, /worse|up/i);
});
