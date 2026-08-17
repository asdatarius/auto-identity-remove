/**
 * test/docs-commands.test.js
 *
 * Every Quick Start step in README.md and install.sh told the user to run
 * `./node_modules/.bin/aidr <cmd>`. That path never exists: npm creates
 * node_modules/.bin shims for a package's *dependencies*, never for the
 * package's own "bin" entry. So steps 3, 4 and 5 of the documented install
 * failed with "no such file or directory" for every user who followed them, and
 * nothing in a 1255-test suite noticed, because nothing tested the docs.
 *
 * These are cheap static checks. They cannot verify that a command does the
 * right thing, only that the thing the docs tell you to run exists at all -
 * which is the failure that actually shipped.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const install = fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
const pkg = require(path.join(ROOT, 'package.json'));

/** All capture-group-1 matches of `re` in `text`, deduplicated. */
function captures(text, re) {
  return [...new Set([...text.matchAll(re)].map(m => m[1]))];
}

test('no doc tells the user to run ./node_modules/.bin/aidr', () => {
  // Allowed only in prose that explains why it does not exist.
  const offenders = [];
  for (const [name, text] of [['README.md', readme], ['install.sh', install]]) {
    for (const line of text.split('\n')) {
      if (!line.includes('node_modules/.bin/aidr')) continue;
      if (/There is no|never creates|does not exist/i.test(line)) continue;
      offenders.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "npm does not create a .bin shim for the root package's own bin:\n" + offenders.join('\n'),
  );
});

test("the package's bin target exists and carries a shebang", () => {
  const binSpec = pkg.bin && pkg.bin.aidr;
  assert.ok(binSpec, 'package.json must declare bin.aidr');
  const target = path.join(ROOT, binSpec);
  assert.ok(fs.existsSync(target), `bin.aidr points at ${binSpec}, which does not exist`);
  assert.match(fs.readFileSync(target, 'utf8'), /^#!/, 'the bin entry should carry a shebang');
});

test('every `node <file>` command in the README points at a real file', () => {
  const referenced = captures(
    readme,
    /\bnode\s+((?:bin|lib|scripts|dashboard)\/[\w./-]+\.js|watcher\.js|setup\.js)/g,
  );
  assert.ok(referenced.length > 0, 'precondition: the README documents some node commands');
  const missing = referenced.filter(f => !fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(missing, [], 'README references files that do not exist');
});

test('every npm script the README mentions is defined in package.json', () => {
  const referenced = captures(readme, /\bnpm run ([\w:-]+)/g);
  const missing = referenced.filter(s => !(pkg.scripts && pkg.scripts[s]));
  assert.deepEqual(missing, [], 'README references undefined npm scripts');
});

test('every script install.sh invokes exists', () => {
  const referenced = captures(install, /\b(?:bash|node)\s+(scripts\/[\w./-]+)/g);
  const missing = referenced.filter(f => !fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(missing, [], 'install.sh invokes scripts that do not exist');
});

test('install.sh installs the dashboard dependencies', () => {
  // express lives only in dashboard/package.json, so without this step
  // `aidr dashboard` fails with MODULE_NOT_FOUND right after a clean install.
  const dashPkg = require(path.join(ROOT, 'dashboard', 'package.json'));
  assert.ok(dashPkg.dependencies && dashPkg.dependencies.express, 'precondition: express is a dashboard-only dep');
  assert.match(
    install,
    /cd dashboard && npm ci/,
    'install.sh must install dashboard deps or `aidr dashboard` cannot start',
  );
});

test('the paths listed in package.json "files" all exist', () => {
  // A missing entry produces a broken `npm pack` / global install, which is the
  // path the README recommends via `npm link`.
  const missing = (pkg.files || []).filter(f => !fs.existsSync(path.join(ROOT, f.replace(/\/$/, ''))));
  assert.deepEqual(missing, [], 'package.json "files" lists paths that do not exist');
});

test('the governance files referenced by the docs exist', () => {
  for (const f of ['LICENSE', 'SECURITY.md', 'docs/CROSS_MODEL_REVIEW.md', 'docs/SYNOLOGY.md']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is referenced but missing`);
  }
});

test('package.json declares the license it actually ships', () => {
  assert.equal(pkg.license, 'MIT');
  assert.match(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8'), /MIT License/);
});

test('every relative markdown link in the README resolves', () => {
  const targets = captures(readme, /\]\((?!https?:|#|mailto:)([^)\s]+)\)/g);
  const broken = targets
    .map(t => t.split('#')[0])
    .filter(Boolean)
    .filter(t => !fs.existsSync(path.join(ROOT, t)));
  assert.deepEqual(broken, [], 'README has broken relative links');
});

test('the cross-model review scripts the policy documents exist and parse', () => {
  const policy = fs.readFileSync(path.join(ROOT, 'docs', 'CROSS_MODEL_REVIEW.md'), 'utf8');
  assert.match(policy, /npm run review:cross-model/, 'the policy should name the entry point');
  assert.ok(pkg.scripts['review:cross-model'], 'package.json must define review:cross-model');
  for (const f of ['scripts/cross-model-review.sh', 'scripts/cross-model-gate.sh', 'scripts/cross-model-review.schema.json']) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing`);
  }
  // The schema is what constrains the reviewer's output; a syntax error there
  // silently degrades every review to unstructured prose.
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/cross-model-review.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false, 'strict mode requires additionalProperties: false');
  assert.deepEqual(schema.required, ['summary', 'findings']);
});

test('the README broker count matches brokers.js', () => {
  // The README said 42 while brokers.js exported 44. Small, but the confidence
  // table beside it is the main thing a user leans on when deciding whether to
  // trust the output, so it should not drift.
  const brokers = require('../brokers');
  const claimed = readme.match(/\|\s*\*\*Explicit brokers\*\*[^|]*\|\s*(\d+)\s*\|/);
  assert.ok(claimed, 'the README should state an explicit-broker count');
  assert.equal(
    Number(claimed[1]),
    brokers.length,
    `README claims ${claimed[1]} explicit brokers; brokers.js exports ${brokers.length}`,
  );
});

test('the README does not claim brokers are verified when none are', () => {
  // STATUS.md says every broker is untested. The README used to imply a
  // `verified` tier existed, which overstates how much the output can be trusted.
  const brokers = require('../brokers');
  const verified = brokers.filter(b => b.confidence === 'verified');
  if (verified.length === 0) {
    assert.match(
      readme,
      /None are currently marked `verified`/,
      'with zero verified brokers, the README must say so plainly',
    );
  } else {
    assert.match(readme, /`verified`/, 'the README should explain what verified means');
  }
});
