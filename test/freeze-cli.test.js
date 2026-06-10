/**
 * test/freeze-cli.test.js
 *
 * Exercises the --freeze list mode and the --freeze-done / --freeze-clear
 * subcommands by spawning watcher.js as a child process. The freeze mode is
 * self-contained (no Playwright, no network), so this is hermetic.
 *
 * State isolation: watcher.js's freeze mode honours AIDR_STATE_PATH for its
 * state file (via lib/config), so the real state.json is never touched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WATCHER = path.join(__dirname, '..', 'watcher.js');

function runWatcher(args, statePath) {
  return spawnSync('node', [WATCHER, ...args], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, AIDR_STATE_PATH: statePath, HEADLESS: '1', CI: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-cli-'));
  return { dir, stateFile: path.join(dir, 'state.json') };
}

test('--freeze lists all 7 targets with URLs and a not-done marker', () => {
  const { dir, stateFile } = tmpStatePath();
  fs.writeFileSync(stateFile, JSON.stringify({ optOuts: {} }, null, 2));
  const r = runWatcher(['--freeze'], stateFile);
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /Equifax/);
  assert.match(r.stdout, /Experian/);
  assert.match(r.stdout, /TransUnion/);
  assert.match(r.stdout, /ChexSystems/);
  assert.match(r.stdout, /NCTUE/);
  assert.match(r.stdout, /Innovis/);
  assert.match(r.stdout, /OptOutPrescreen/);
  assert.match(r.stdout, /equifax\.com/);
  assert.match(r.stdout, /optoutprescreen\.com/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--freeze-done <key> records completion and exits 0', () => {
  const { dir, stateFile } = tmpStatePath();
  fs.writeFileSync(stateFile, JSON.stringify({ optOuts: {} }, null, 2));
  const r = runWatcher(['--freeze-done', 'equifax'], stateFile);
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}: ${r.stderr}`);
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.freezes && persisted.freezes.equifax, 'equifax freeze must be persisted');
  assert.match(persisted.freezes.equifax.doneAt, /^\d{4}-\d{2}-\d{2}T/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--freeze after --freeze-done shows the target marked done', () => {
  const { dir, stateFile } = tmpStatePath();
  fs.writeFileSync(stateFile, JSON.stringify({ optOuts: {} }, null, 2));
  runWatcher(['--freeze-done', 'innovis'], stateFile);
  const r = runWatcher(['--freeze'], stateFile);
  assert.equal(r.status, 0);
  // The done marker is [x]; assert the Innovis row carries it.
  const innovisLine = r.stdout.split('\n').find(l => /Innovis/.test(l));
  assert.ok(innovisLine, 'Innovis row must be present');
  assert.match(innovisLine, /\[x\]/i, 'Innovis row must indicate done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--freeze-clear <key> removes a recorded completion', () => {
  const { dir, stateFile } = tmpStatePath();
  fs.writeFileSync(stateFile, JSON.stringify({ optOuts: {}, freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' } } }, null, 2));
  const r = runWatcher(['--freeze-clear', 'equifax'], stateFile);
  assert.equal(r.status, 0, `exit 0 expected, got ${r.status}: ${r.stderr}`);
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(!persisted.freezes.equifax, 'equifax freeze must be cleared on disk');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--freeze-done with an unknown key exits non-zero and prints an error', () => {
  const { dir, stateFile } = tmpStatePath();
  fs.writeFileSync(stateFile, JSON.stringify({ optOuts: {} }, null, 2));
  const r = runWatcher(['--freeze-done', 'bogus'], stateFile);
  assert.notEqual(r.status, 0, 'unknown key must be a non-zero exit');
  assert.match(r.stdout + r.stderr, /unknown freeze target|valid keys/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--freeze-done does not disturb existing optOuts', () => {
  const { dir, stateFile } = tmpStatePath();
  fs.writeFileSync(stateFile, JSON.stringify({ optOuts: { delta: { history: ['success'] } } }, null, 2));
  runWatcher(['--freeze-done', 'transunion'], stateFile);
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.optOuts.delta, 'optOuts must survive a freeze subcommand');
  assert.ok(persisted.freezes.transunion, 'freeze must be recorded alongside optOuts');
  fs.rmSync(dir, { recursive: true, force: true });
});
