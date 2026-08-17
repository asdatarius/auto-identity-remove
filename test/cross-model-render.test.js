/**
 * test/cross-model-render.test.js
 *
 * The cross-model review pipeline decides whether a merge is blocked, so the
 * part that counts severities and renders the committed report is worth testing
 * without spending a model call on it. scripts/cross-model-review.sh reads the
 * "<p1> <p2> <p3>" line this module prints and turns it into an exit code.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseFindings, countBySeverity, renderReport, cell } = require('../scripts/cross-model-render');

const FINDING = {
  severity: 'P1',
  file: 'lib/config.js',
  line: 315,
  title: 'state write fails under a bind mount',
  what: 'renameSync onto a mounted file returns EBUSY',
  trigger: 'the documented docker run recipe',
  impact: 'no state is ever persisted',
  fix: 'fall back to an in-place write',
};

test('parseFindings reads a well-formed payload', () => {
  const out = parseFindings(JSON.stringify({ summary: 'one P1', findings: [FINDING] }));
  assert.equal(out.summary, 'one P1');
  assert.equal(out.findings.length, 1);
});

test('parseFindings accepts an already-parsed object', () => {
  const out = parseFindings({ summary: 's', findings: [FINDING] });
  assert.equal(out.findings.length, 1);
});

test('parseFindings degrades to empty rather than throwing on garbage', () => {
  // A model that returns prose instead of JSON must not crash the review run;
  // the shell wrapper treats an empty findings file as exit 6 on its own.
  for (const bad of ['not json at all', '', 'null', '[]', '{"findings":"nope"}']) {
    const out = parseFindings(bad);
    assert.deepEqual(out.findings, [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

test('countBySeverity counts each bucket', () => {
  const counts = countBySeverity([
    { severity: 'P1' }, { severity: 'P1' }, { severity: 'P2' }, { severity: 'P3' },
  ]);
  assert.deepEqual(counts, { P1: 2, P2: 1, P3: 1 });
});

test('countBySeverity ignores unknown or missing severities', () => {
  // An off-schema severity must not be silently counted as a blocker, and must
  // not throw either.
  const counts = countBySeverity([{ severity: 'CRITICAL' }, {}, null, { severity: 'P2' }]);
  assert.deepEqual(counts, { P1: 0, P2: 1, P3: 0 });
});

test('cell escapes pipes and newlines so the table cannot break', () => {
  assert.equal(cell('a|b'), 'a\\|b');
  assert.equal(cell('line1\nline2'), 'line1 line2');
  assert.equal(cell(undefined), '');
  assert.equal(cell(null), '');
});

const META = {
  family: 'OpenAI (non-Anthropic)',
  tool: 'codex CLI',
  model: 'codex default',
  base: 'origin/main',
  head: 'abc1234',
  files: ['lib/config.js', 'brokers.js'],
};

test('the report header records what was reviewed and by what', () => {
  const md = renderReport({ summary: 'one P1 found', findings: [FINDING] }, META);
  assert.match(md, /# Cross-model review - abc1234/);
  assert.match(md, /reviewer family \| OpenAI \(non-Anthropic\)/);
  assert.match(md, /base \| origin\/main/);
  assert.match(md, /files reviewed \| 2/);
  assert.match(md, /P1: 1, P2: 0, P3: 0/);
});

test('the report lists every reviewed file', () => {
  const md = renderReport({ summary: '', findings: [] }, META);
  assert.match(md, /- `lib\/config\.js`/);
  assert.match(md, /- `brokers\.js`/);
});

test('findings are ordered P1 first', () => {
  const md = renderReport({
    summary: '',
    findings: [
      { ...FINDING, severity: 'P3', title: 'third' },
      { ...FINDING, severity: 'P1', title: 'first' },
      { ...FINDING, severity: 'P2', title: 'second' },
    ],
  }, META);
  assert.ok(md.indexOf('first') < md.indexOf('second'), 'P1 must come before P2');
  assert.ok(md.indexOf('second') < md.indexOf('third'), 'P2 must come before P3');
});

test('every finding gets a disposition slot so the record is auditable', () => {
  const md = renderReport({ summary: '', findings: [FINDING] }, META);
  assert.match(md, /Disposition/);
  assert.match(md, /_pending_/, 'an unreviewed finding must be visibly pending');
});

test('a clean review says so explicitly', () => {
  const md = renderReport({ summary: 'no P1', findings: [] }, META);
  assert.match(md, /None\. The reviewer reported no findings/);
  assert.doesNotMatch(md, /_pending_/);
});

test('a finding containing a pipe does not corrupt the table', () => {
  const md = renderReport({
    summary: '',
    findings: [{ ...FINDING, title: 'a | b', impact: 'x\ny' }],
  }, META);
  const rows = md.split('\n').filter(l => l.startsWith('| 1 |'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].split(' | ').length, 7, 'the row must still have exactly 7 columns');
});
