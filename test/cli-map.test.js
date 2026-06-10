/**
 * test/cli-map.test.js
 *
 * Pure unit tests for the aidr CLI argument-to-target mapping. No spawning,
 * no network, no filesystem - resolveCommand is a pure function.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveCommand, COMMANDS, buildHelp } = require('../lib/cli-map');

test('resolveCommand: no args resolves to help', () => {
  const r = resolveCommand([]);
  assert.equal(r.ok, true);
  assert.equal(r.target, 'help');
});

test('resolveCommand: --help and -h resolve to help', () => {
  for (const flag of ['--help', '-h', 'help']) {
    const r = resolveCommand([flag]);
    assert.equal(r.target, 'help', `${flag} should map to help`);
  }
});

test('resolveCommand: --version and -v resolve to version', () => {
  for (const flag of ['--version', '-v']) {
    const r = resolveCommand([flag]);
    assert.equal(r.target, 'version', `${flag} should map to version`);
  }
});

test('resolveCommand: setup maps to node setup.js with no flags', () => {
  const r = resolveCommand(['setup']);
  assert.equal(r.ok, true);
  assert.equal(r.target, 'node');
  assert.equal(r.file, 'setup.js');
  assert.deepEqual(r.args, ['setup.js']);
  assert.equal(r.cwd, 'root');
  assert.equal(r.command, 'setup');
});

test('resolveCommand: run maps to node watcher.js (real run, no flag)', () => {
  const r = resolveCommand(['run']);
  assert.equal(r.file, 'watcher.js');
  assert.deepEqual(r.args, ['watcher.js']);
});

test('resolveCommand: preview maps to watcher.js --preview', () => {
  const r = resolveCommand(['preview']);
  assert.deepEqual(r.args, ['watcher.js', '--preview']);
});

test('resolveCommand: verify maps to watcher.js --verify', () => {
  const r = resolveCommand(['verify']);
  assert.deepEqual(r.args, ['watcher.js', '--verify']);
});

test('resolveCommand: doctor maps to watcher.js --doctor', () => {
  const r = resolveCommand(['doctor']);
  assert.deepEqual(r.args, ['watcher.js', '--doctor']);
});

test('resolveCommand: score maps to watcher.js --serp-scan', () => {
  const r = resolveCommand(['score']);
  assert.deepEqual(r.args, ['watcher.js', '--serp-scan']);
});

test('resolveCommand: report maps to watcher.js --pending', () => {
  const r = resolveCommand(['report']);
  assert.deepEqual(r.args, ['watcher.js', '--pending']);
});

test('resolveCommand: dashboard maps to dashboard/server.js with dashboard cwd', () => {
  const r = resolveCommand(['dashboard']);
  assert.equal(r.file, 'dashboard/server.js');
  assert.deepEqual(r.args, ['dashboard/server.js']);
  assert.equal(r.cwd, 'dashboard');
});

test('resolveCommand: extra args are passed through after the mapped flags', () => {
  const r = resolveCommand(['run', '--dry-run', '--only', 'Spokeo']);
  assert.deepEqual(r.args, ['watcher.js', '--dry-run', '--only', 'Spokeo']);
});

test('resolveCommand: preview passthrough keeps mapped flag first', () => {
  const r = resolveCommand(['preview', '--only', 'BeenVerified']);
  assert.deepEqual(r.args, ['watcher.js', '--preview', '--only', 'BeenVerified']);
});

test('resolveCommand: unknown command fails and falls back to help', () => {
  const r = resolveCommand(['frobnicate']);
  assert.equal(r.ok, false);
  assert.equal(r.target, 'help');
  assert.match(r.error, /unknown command: frobnicate/);
});

test('COMMANDS lists every public subcommand with a description', () => {
  const expected = ['setup', 'run', 'preview', 'verify', 'dashboard', 'score', 'report', 'doctor'];
  for (const name of expected) {
    assert.ok(COMMANDS[name], `COMMANDS must include ${name}`);
    assert.equal(typeof COMMANDS[name].desc, 'string');
    assert.ok(COMMANDS[name].desc.length > 0, `${name} must have a non-empty description`);
  }
});

test('buildHelp renders the program name and every subcommand', () => {
  const help = buildHelp();
  assert.match(help, /aidr/);
  for (const name of ['setup', 'run', 'preview', 'verify', 'dashboard', 'score', 'report', 'doctor']) {
    assert.match(help, new RegExp(`\\b${name}\\b`), `help must mention ${name}`);
  }
});
