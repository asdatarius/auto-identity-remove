# Credit / Identity Freeze Guided Checklist Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Add a guided, status-tracked checklist that helps the user freeze credit at the 3 bureaus plus ChexSystems, NCTUE, Innovis, and OptOutPrescreen, tracked in an additive `state.freezes` namespace and surfaced via a new `--freeze` CLI mode, `--freeze-done`/`--freeze-clear` subcommands, dashboard API endpoints, and a checklist card.

Architecture: A new pure-functional module `lib/freeze.js` owns the canonical target list (`FREEZE_TARGETS`) and three state helpers (`getFreezeStatus`, `recordFreezeDone`, `recordFreezeCleared`) that read/write `state.freezes[key] = { doneAt }` and persist through the existing `lib/config.js` atomic `saveState()`. The watcher gains a list/subcommand mode that mutates that state under the same process lock; the dashboard exposes `GET /api/freeze` and `POST /api/freeze` (reusing its existing auth + CSRF middleware and atomic JSON write) plus a read-only checklist card in the browser UI.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict`. Browser automation uses Playwright (not exercised by this feature - the freeze flow is guidance only, no page automation). No new npm dependencies.

New dependencies: NONE (Node built-ins only: `fs`, `os`, `path`, `crypto`; plus the already-present `express` for the dashboard).

---

## File map

| File | Status | Responsibility |
|------|--------|----------------|
| `/Users/stephen/scripts/auto-identity-remove/lib/freeze.js` | Created | `FREEZE_TARGETS` array + pure helpers `getFreezeStatus(state)`, `recordFreezeDone(state, key)`, `recordFreezeCleared(state, key)`. Calls `saveState()` for persistence. |
| `/Users/stephen/scripts/auto-identity-remove/test/freeze.test.js` | Created | Unit tests for `FREEZE_TARGETS` shape + status helpers + a temp-state round-trip through `saveState`. |
| `/Users/stephen/scripts/auto-identity-remove/watcher.js` | Modified | New `--freeze` list mode + `--freeze-done <key>` / `--freeze-clear <key>` subcommands, dispatched before the main run path, under the state lock. |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js` | Modified | `GET /api/freeze` (status) + `POST /api/freeze` (mark done/cleared) endpoints, writing `state.freezes` via the existing atomic writer. |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js` | Modified | Endpoint tests for `GET /api/freeze` and `POST /api/freeze` (mark done, clear, bad key, auth gating). |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/public/index.html` | Modified | A "Freeze" tab + checklist card markup. |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js` | Modified | Load + render the freeze checklist and POST done/clear toggles. |

---

## Task 1: `lib/freeze.js` - targets + status helper

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/freeze.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/freeze.test.js`

This task builds the target list and the pure read helper `getFreezeStatus(state)`. The write helpers come in Task 2 so each step stays small.

- [ ] **Step 1.1: Write the failing test.** Create `/Users/stephen/scripts/auto-identity-remove/test/freeze.test.js` with the complete content below. It asserts the 7 targets exist with the real URLs, the right `type` split (3 credit-bureau + 4 specialty), unique keys, https URLs, and that `getFreezeStatus` reports done/not-done from a plain state object (no disk).

```js
/**
 * test/freeze.test.js
 *
 * Credit / identity freeze guided checklist.
 *
 * Two layers under test:
 *  1. FREEZE_TARGETS - the canonical, hard-coded list of freeze destinations.
 *  2. Pure status helpers - getFreezeStatus / recordFreezeDone / recordFreezeCleared.
 *
 * The status helpers operate on a plain state object. recordFreezeDone /
 * recordFreezeCleared persist through lib/config's saveState(); that disk
 * round-trip is exercised against a temp state path so the real state.json is
 * never touched.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const freeze = require('../lib/freeze');
const cfg = require('../lib/config');

const EXPECTED_KEYS = ['equifax', 'experian', 'transunion', 'chexsystems', 'nctue', 'innovis', 'optoutprescreen'];

test('FREEZE_TARGETS lists all 7 freeze destinations with the expected keys', () => {
  assert.ok(Array.isArray(freeze.FREEZE_TARGETS), 'FREEZE_TARGETS must be an array');
  assert.equal(freeze.FREEZE_TARGETS.length, 7, 'exactly 7 targets');
  const keys = freeze.FREEZE_TARGETS.map(t => t.key);
  for (const k of EXPECTED_KEYS) {
    assert.ok(keys.includes(k), `missing target key: ${k}`);
  }
});

test('FREEZE_TARGETS keys are unique', () => {
  const keys = freeze.FREEZE_TARGETS.map(t => t.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate target keys present');
});

test('FREEZE_TARGETS splits into 3 credit bureaus and 4 specialty agencies', () => {
  const bureaus = freeze.FREEZE_TARGETS.filter(t => t.type === 'credit-bureau');
  const specialty = freeze.FREEZE_TARGETS.filter(t => t.type === 'specialty');
  assert.equal(bureaus.length, 3, '3 credit-bureau targets');
  assert.equal(specialty.length, 4, '4 specialty targets');
  assert.equal(bureaus.length + specialty.length, freeze.FREEZE_TARGETS.length, 'no other type values');
});

test('FREEZE_TARGETS every entry has name, https url and notes', () => {
  for (const t of freeze.FREEZE_TARGETS) {
    assert.equal(typeof t.name, 'string', `${t.key}: name must be a string`);
    assert.ok(t.name.length > 0, `${t.key}: name must be non-empty`);
    assert.match(t.url, /^https:\/\//, `${t.key}: url must be https`);
    assert.equal(typeof t.notes, 'string', `${t.key}: notes must be a string`);
    assert.ok(t.notes.length > 0, `${t.key}: notes must be non-empty`);
  }
});

test('FREEZE_TARGETS uses the real current freeze URLs', () => {
  const byKey = Object.fromEntries(freeze.FREEZE_TARGETS.map(t => [t.key, t.url]));
  assert.match(byKey.equifax, /equifax\.com/);
  assert.match(byKey.experian, /experian\.com/);
  assert.match(byKey.transunion, /transunion\.com/);
  assert.match(byKey.chexsystems, /chexsystems\.com/);
  assert.match(byKey.nctue, /nctue\.com/);
  assert.match(byKey.innovis, /innovis\.com/);
  assert.match(byKey.optoutprescreen, /optoutprescreen\.com/);
});

test('getFreezeStatus returns every target with done:false for empty state', () => {
  const status = freeze.getFreezeStatus({ optOuts: {} });
  assert.equal(status.length, 7);
  for (const row of status) {
    assert.equal(row.done, false, `${row.key} should be not-done`);
    assert.equal(row.doneAt, null, `${row.key} doneAt should be null`);
    assert.equal(typeof row.name, 'string');
    assert.match(row.url, /^https:\/\//);
    assert.ok(['credit-bureau', 'specialty'].includes(row.type));
  }
});

test('getFreezeStatus reports done:true with doneAt for completed targets', () => {
  const state = { optOuts: {}, freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' } } };
  const status = freeze.getFreezeStatus(state);
  const eq = status.find(r => r.key === 'equifax');
  const ex = status.find(r => r.key === 'experian');
  assert.equal(eq.done, true);
  assert.equal(eq.doneAt, '2026-06-01T00:00:00.000Z');
  assert.equal(ex.done, false);
  assert.equal(ex.doneAt, null);
});

test('getFreezeStatus ignores unknown keys in state.freezes', () => {
  const state = { freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' }, bogus: { doneAt: 'x' } } };
  const status = freeze.getFreezeStatus(state);
  assert.equal(status.length, 7, 'unknown keys must not add rows');
  assert.ok(!status.some(r => r.key === 'bogus'));
});

test('getFreezeStatus tolerates a state object with no freezes namespace', () => {
  const status = freeze.getFreezeStatus({});
  assert.equal(status.length, 7);
  assert.ok(status.every(r => r.done === false));
});
```

- [ ] **Step 1.2: Run it, expect fail.** Run `node --test test/freeze.test.js` from the repo root. Expected failure: `Cannot find module '../lib/freeze'` (the module does not exist yet).

- [ ] **Step 1.3: Implement.** Create `/Users/stephen/scripts/auto-identity-remove/lib/freeze.js` with the complete content below. (The `recordFreezeDone` / `recordFreezeCleared` bodies are real and final - they are tested in Task 2, but writing them now keeps the module complete and avoids a second edit.)

```js
/**
 * lib/freeze.js
 *
 * Credit / identity freeze guided checklist.
 *
 * Freezing credit at the bureaus (and the specialty agencies) is the
 * highest-impact privacy action, but every target requires identity
 * verification that cannot be safely automated. So this module is GUIDANCE +
 * TRACKING, not automation: it owns the canonical list of freeze destinations
 * and persists which ones the user has completed.
 *
 * State is additive: completion is stored under state.freezes[key] = { doneAt }
 * and never touches the existing state.optOuts namespace. Persistence reuses
 * lib/config's atomic saveState().
 */

const config = require('./config');

// Canonical freeze destinations. URLs are the current dedicated freeze /
// opt-out landing pages for each agency.
const FREEZE_TARGETS = [
  {
    key: 'equifax',
    name: 'Equifax',
    url: 'https://www.equifax.com/personal/credit-report-services/credit-freeze/',
    type: 'credit-bureau',
    notes: 'One of the 3 major credit bureaus. Free freeze; keep your PIN/account login safe to thaw later.',
  },
  {
    key: 'experian',
    name: 'Experian',
    url: 'https://www.experian.com/freeze/center.html',
    type: 'credit-bureau',
    notes: 'One of the 3 major credit bureaus. Free freeze; you can thaw temporarily when applying for credit.',
  },
  {
    key: 'transunion',
    name: 'TransUnion',
    url: 'https://www.transunion.com/credit-freeze',
    type: 'credit-bureau',
    notes: 'One of the 3 major credit bureaus. Free freeze; save your credentials to lift it when needed.',
  },
  {
    key: 'chexsystems',
    name: 'ChexSystems',
    url: 'https://www.chexsystems.com/security-freeze/place-freeze',
    type: 'specialty',
    notes: 'Banking-history bureau used to open checking/savings accounts. Freeze blocks fraudulent account opening.',
  },
  {
    key: 'nctue',
    name: 'NCTUE',
    url: 'https://www.nctue.com/consumers',
    type: 'specialty',
    notes: 'Telecom / utility / pay-TV credit exchange. Freeze blocks fraudulent phone and utility accounts.',
  },
  {
    key: 'innovis',
    name: 'Innovis',
    url: 'https://www.innovis.com/personal/securityFreeze',
    type: 'specialty',
    notes: 'The "fourth" credit bureau. Often overlooked; freeze it for complete coverage.',
  },
  {
    key: 'optoutprescreen',
    name: 'OptOutPrescreen',
    url: 'https://www.optoutprescreen.com/',
    type: 'specialty',
    notes: 'Official site to stop prescreened credit/insurance offers (reduces mailed offers a thief could intercept).',
  },
];

// Fast lookup of valid keys (single source of truth for validation).
const TARGET_KEYS = new Set(FREEZE_TARGETS.map(t => t.key));

/**
 * Return the freeze checklist with completion status merged in.
 *
 * Pure read: does not mutate state and does not touch disk. Unknown keys in
 * state.freezes are ignored - only the canonical FREEZE_TARGETS are returned.
 *
 * @param {{ freezes?: Record<string, { doneAt?: string }> }} state
 * @returns {Array<{ key, name, url, type, notes, done: boolean, doneAt: string|null }>}
 */
function getFreezeStatus(state) {
  const freezes = (state && state.freezes) || {};
  return FREEZE_TARGETS.map(t => {
    const entry = freezes[t.key];
    const doneAt = entry && entry.doneAt ? entry.doneAt : null;
    return { ...t, done: !!doneAt, doneAt };
  });
}

/**
 * Mark a freeze target as completed and persist via saveState().
 *
 * Mutates state.freezes in place (additive - never touches state.optOuts) and
 * returns the updated state. Throws on an unknown key so the caller can surface
 * a clear error.
 *
 * @param {object} state  The shared mutable state object (from loadState()).
 * @param {string} key    A FREEZE_TARGETS key.
 * @returns {object} the mutated state
 */
function recordFreezeDone(state, key) {
  if (!TARGET_KEYS.has(key)) {
    throw new Error(`unknown freeze target: ${key}`);
  }
  if (!state.freezes || typeof state.freezes !== 'object') state.freezes = {};
  state.freezes[key] = { doneAt: new Date().toISOString() };
  config.saveState();
  return state;
}

/**
 * Clear a previously-recorded freeze completion and persist via saveState().
 *
 * Mutates state.freezes in place and returns the updated state. Clearing an
 * already-absent key is a no-op (still persisted, idempotent). Throws on an
 * unknown key.
 *
 * @param {object} state  The shared mutable state object (from loadState()).
 * @param {string} key    A FREEZE_TARGETS key.
 * @returns {object} the mutated state
 */
function recordFreezeCleared(state, key) {
  if (!TARGET_KEYS.has(key)) {
    throw new Error(`unknown freeze target: ${key}`);
  }
  if (state.freezes && typeof state.freezes === 'object') {
    delete state.freezes[key];
  }
  config.saveState();
  return state;
}

module.exports = {
  FREEZE_TARGETS,
  TARGET_KEYS,
  getFreezeStatus,
  recordFreezeDone,
  recordFreezeCleared,
};
```

- [ ] **Step 1.4: Run, expect pass.** Run `node --test test/freeze.test.js` from the repo root. All tests in this file should pass (the `recordFreeze*` round-trip tests are added in Task 2; the current file only exercises `FREEZE_TARGETS` and `getFreezeStatus`).

- [ ] **Step 1.5: Commit.** From the repo root:
```bash
git add lib/freeze.js test/freeze.test.js
git commit -m "Add lib/freeze.js with FREEZE_TARGETS and getFreezeStatus

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Freeze write helpers - temp-state round-trip

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/test/freeze.test.js` (append tests to the file created in Task 1)
- Test target: `lib/freeze.js` `recordFreezeDone` / `recordFreezeCleared` (already implemented in Step 1.3)

This task adds the disk round-trip tests proving `recordFreezeDone` / `recordFreezeCleared` persist `state.freezes` through `saveState()` without disturbing `state.optOuts`, against a temp state path.

- [ ] **Step 2.1: Write the failing test.** Append the block below to the END of `/Users/stephen/scripts/auto-identity-remove/test/freeze.test.js` (after the last `getFreezeStatus` test). It uses `cfg.setTestStatePath` + a temp dir (the exact pattern from `test/config-atomic-write.test.js`) so the real `state.json` is never touched, and `cfg.resetState()` to load the temp state into the shared object before mutating.

```js

// ---- write helpers: temp-state round-trip ----------------------------------
// These mirror test/config-atomic-write.test.js: redirect lib/config's state
// path to a temp file, drive the helpers, then read the temp file back.

function makeTmpState(initialData) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-state-'));
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify(initialData || { optOuts: {} }, null, 2));
  return { dir, stateFile };
}

test('recordFreezeDone persists state.freezes[key].doneAt to disk', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();

  const state = cfg.loadState();
  freeze.recordFreezeDone(state, 'equifax');

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.freezes, 'freezes namespace must exist on disk');
  assert.ok(persisted.freezes.equifax, 'equifax entry must be persisted');
  assert.match(persisted.freezes.equifax.doneAt, /^\d{4}-\d{2}-\d{2}T/, 'doneAt must be an ISO timestamp');

  cfg.setTestStatePath(null);
  cfg.resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordFreezeDone does not disturb the existing optOuts namespace', () => {
  const { dir, stateFile } = makeTmpState({ optOuts: { spokeo: { history: ['success'], lastSuccess: '2026-01-01T00:00:00.000Z' } } });
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();

  const state = cfg.loadState();
  freeze.recordFreezeDone(state, 'innovis');

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.optOuts.spokeo, 'optOuts must survive a freeze write');
  assert.equal(persisted.optOuts.spokeo.lastSuccess, '2026-01-01T00:00:00.000Z');
  assert.ok(persisted.freezes.innovis, 'innovis freeze recorded alongside optOuts');

  cfg.setTestStatePath(null);
  cfg.resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordFreezeCleared removes the entry and persists', () => {
  const { dir, stateFile } = makeTmpState({ optOuts: {}, freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' } } });
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();

  const state = cfg.loadState();
  freeze.recordFreezeCleared(state, 'equifax');

  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(!persisted.freezes.equifax, 'cleared entry must be gone from disk');

  cfg.setTestStatePath(null);
  cfg.resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recordFreezeDone throws on an unknown target key', () => {
  const state = { optOuts: {} };
  assert.throws(() => freeze.recordFreezeDone(state, 'bogus'), /unknown freeze target/);
});

test('recordFreezeCleared throws on an unknown target key', () => {
  const state = { optOuts: {} };
  assert.throws(() => freeze.recordFreezeCleared(state, 'bogus'), /unknown freeze target/);
});

test('recordFreezeDone then getFreezeStatus reflects done:true (round-trip)', () => {
  const { dir, stateFile } = makeTmpState();
  cfg.setTestStatePath(stateFile);
  cfg.setDryRun(false);
  cfg.resetState();

  const state = cfg.loadState();
  freeze.recordFreezeDone(state, 'transunion');
  const row = freeze.getFreezeStatus(state).find(r => r.key === 'transunion');
  assert.equal(row.done, true);
  assert.ok(row.doneAt, 'doneAt should be populated after recordFreezeDone');

  cfg.setTestStatePath(null);
  cfg.resetState();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2.2: Run it, expect pass immediately (helpers already implemented).** Run `node --test test/freeze.test.js`. Because `recordFreezeDone` / `recordFreezeCleared` were written in full in Step 1.3, these new tests should pass. If any fail, treat the failure as a real defect in `lib/freeze.js` and fix the module (do NOT weaken the test). The likely failure if the module were a stub would be: `freeze.recordFreezeDone is not a function`.

- [ ] **Step 2.3: Confirm no real state.json was touched.** Run `git status --short` from the repo root. There must be NO change to `state.json` (it is gitignored anyway, but confirm the temp-path redirect worked and the file content is unchanged via `rtk read state.json` if present).

- [ ] **Step 2.4: Run the full unit suite once.** Run `node --test test/*.test.js dashboard/validate.test.js` from the repo root. Confirm the existing 57 test files still pass alongside the new `freeze.test.js` (the freeze helpers call into the shared `lib/config` state singleton, so verify no cross-test leakage - each freeze test resets the state path with `setTestStatePath(null)` + `resetState()` in its cleanup).

- [ ] **Step 2.5: Commit.** From the repo root:
```bash
git add test/freeze.test.js
git commit -m "Add temp-state round-trip tests for freeze write helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `--freeze` CLI mode + `--freeze-done` / `--freeze-clear` subcommands

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/config.js` (honor `AIDR_STATE_PATH` env in the `STATE_PATH` constant, line 23)
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js` (add flag parsing near lines 26-44; add a new mode block to the dispatch ladder before line 57)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/freeze-cli.test.js` (Created)

The CLI test runs `watcher.js` as a child process with a redirected state path. `watcher.js` reads `STATE_PATH` from `lib/config` at module level, so we teach `lib/config.js` to honor an `AIDR_STATE_PATH` env var when computing `STATE_PATH`. The freeze mode is fully self-contained: it does not launch Playwright, so it is hermetic.

- [ ] **Step 3.1: Write the failing test.** Create `/Users/stephen/scripts/auto-identity-remove/test/freeze-cli.test.js` with the complete content below. It spawns `node watcher.js --freeze` and the subcommands with `AIDR_STATE_PATH` pointed at a temp file, asserting stdout content and the persisted JSON. No network, no browser.

```js
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
```

- [ ] **Step 3.2: Run it, expect fail.** Run `node --test test/freeze-cli.test.js` from the repo root. Expected failure: every assertion on `r.status === 0` for `--freeze` will fail because the flag is unrecognized and `watcher.js` falls through to the main run path (which tries to launch Playwright / load config and exits non-zero in CI), and the `freezes` namespace is never written. The exact first failure will read like `exit 0 expected, got 1`.

- [ ] **Step 3.3: Implement - add the env-state hook to `lib/config.js`.** Edit `/Users/stephen/scripts/auto-identity-remove/lib/config.js`. Change the `STATE_PATH` constant (line 23) to honor `AIDR_STATE_PATH`. Replace:

```js
const STATE_PATH  = path.join(__dirname, '..', 'state.json');
```
with:
```js
const STATE_PATH  = process.env.AIDR_STATE_PATH
  ? path.resolve(process.env.AIDR_STATE_PATH)
  : path.join(__dirname, '..', 'state.json');
```

The initial-load block (lines 82-84) already reads `STATE_PATH`, so it now picks up the env override automatically. No further change there.

- [ ] **Step 3.4: Implement - add flag parsing in `watcher.js`.** Edit `/Users/stephen/scripts/auto-identity-remove/watcher.js`. After the `SNAPSHOT` flag line (line 44), add the freeze flag parsing:

```js

// ── Credit / identity freeze guided checklist ────────────────────────────────
const FREEZE_LIST = process.argv.includes('--freeze');
const freezeDoneIdx  = process.argv.indexOf('--freeze-done');
const FREEZE_DONE_KEY  = freezeDoneIdx !== -1 ? (process.argv[freezeDoneIdx + 1] || '') : null;
const freezeClearIdx = process.argv.indexOf('--freeze-clear');
const FREEZE_CLEAR_KEY = freezeClearIdx !== -1 ? (process.argv[freezeClearIdx + 1] || '') : null;
const FREEZE_MODE = FREEZE_LIST || FREEZE_DONE_KEY !== null || FREEZE_CLEAR_KEY !== null;
```

- [ ] **Step 3.5: Implement - add the freeze mode block.** Still in `/Users/stephen/scripts/auto-identity-remove/watcher.js`, insert a new mode block at the top of the dispatch ladder, immediately BEFORE the `if (LIST_MODE) {` block (currently line 57). The freeze mode exits early and never reaches the Playwright path. Insert:

```js
// ── --freeze / --freeze-done <key> / --freeze-clear <key> ─────────────────────
// Guided credit/identity freeze checklist. Pure guidance + tracking; no browser
// is launched. Subcommands persist state.freezes under the same state lock as a
// normal run so a concurrent run cannot race the write.
if (FREEZE_MODE) {
  const { FREEZE_TARGETS, getFreezeStatus, recordFreezeDone, recordFreezeCleared, TARGET_KEYS } = require('./lib/freeze');
  const state = loadState();

  // Mutating subcommands take the lock; the read-only list does not need it.
  const isMutation = FREEZE_DONE_KEY !== null || FREEZE_CLEAR_KEY !== null;
  const FREEZE_LOCK_PATH = STATE_PATH + '.lock';
  if (isMutation) {
    try {
      lock.acquire(FREEZE_LOCK_PATH);
    } catch (err) {
      const pidMatch = err.message.match(/pid (\d+)/);
      console.error(`Another instance is running, pid=${pidMatch ? pidMatch[1] : '?'}. Exiting.`);
      process.exit(1);
    }
  }

  try {
    if (FREEZE_DONE_KEY !== null) {
      if (!TARGET_KEYS.has(FREEZE_DONE_KEY)) {
        console.error(`unknown freeze target: "${FREEZE_DONE_KEY}". Valid keys: ${[...TARGET_KEYS].join(', ')}`);
        process.exit(1);
      }
      recordFreezeDone(state, FREEZE_DONE_KEY);
      console.log(`✅ Marked freeze done: ${FREEZE_DONE_KEY}`);
    } else if (FREEZE_CLEAR_KEY !== null) {
      if (!TARGET_KEYS.has(FREEZE_CLEAR_KEY)) {
        console.error(`unknown freeze target: "${FREEZE_CLEAR_KEY}". Valid keys: ${[...TARGET_KEYS].join(', ')}`);
        process.exit(1);
      }
      recordFreezeCleared(state, FREEZE_CLEAR_KEY);
      console.log(`↩️  Cleared freeze: ${FREEZE_CLEAR_KEY}`);
    }
  } finally {
    if (isMutation) lock.release(FREEZE_LOCK_PATH);
  }

  // Always print the checklist after a list request or a mutation.
  const rows = getFreezeStatus(state);
  const doneCount = rows.filter(r => r.done).length;
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n🧊 Credit / identity freeze checklist');
  console.log('   Freezing your credit is the single highest-impact privacy action.');
  console.log('   Each target needs identity verification, so this is guidance, not automation.\n');
  console.log('   ' + pad('Done', 6) + pad('Target', 18) + pad('Type', 16) + 'URL');
  console.log('   ' + '-'.repeat(86));
  for (const r of rows) {
    const mark = r.done ? '[x]' : '[ ]';
    console.log('   ' + pad(mark, 6) + pad(r.name, 18) + pad(r.type, 16) + r.url);
  }
  console.log(`\n   ${doneCount}/${rows.length} complete.`);
  console.log('   Mark one done:  node watcher.js --freeze-done <key>');
  console.log('   Undo a mark:    node watcher.js --freeze-clear <key>');
  console.log(`   Keys: ${FREEZE_TARGETS.map(t => t.key).join(', ')}\n`);
  process.exit(0);
}

```

Placement note: this block sits at the very top of the `if (LIST_MODE)` ladder. The freeze flags are checked via `process.argv.includes` / `indexOf`, exactly matching the existing flag-parsing convention (lines 26-54), and it calls `process.exit(0|1)` before any other mode is considered.

- [ ] **Step 3.6: Run, expect pass.** Run `node --test test/freeze-cli.test.js` from the repo root. All freeze-cli tests should pass. The done-marker test checks for `[x]` on the Innovis row; the implementation prints `[x]`.

- [ ] **Step 3.7: Guard against AIDR_STATE_PATH leaking into other suites.** Run `node --test test/*.test.js dashboard/validate.test.js` from the repo root with NO `AIDR_STATE_PATH` set in the shell, confirming the env hook in `lib/config.js` defaults to the real path when the var is absent and the full suite is green.

- [ ] **Step 3.8: Commit.** From the repo root:
```bash
git add watcher.js lib/config.js test/freeze-cli.test.js
git commit -m "Add --freeze CLI mode and --freeze-done/--freeze-clear subcommands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Dashboard `GET /api/freeze` + `POST /api/freeze`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js` (add freeze import near line 44; add two routes before the static handler at line 502; document routes in the header comment)
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js` (append endpoint tests)

The dashboard already has a `STATE` path constant (`path.join(ROOT, 'state.json')`), an atomic `writeJsonAtomic`, auth + CSRF middleware, and a `readJsonMeta` helper. We read `FREEZE_TARGETS` + `getFreezeStatus` from `../lib/freeze` (pure, no disk) for the GET, and for POST we read state, mutate `state.freezes`, and write atomically with `writeJsonAtomic` (NOT via `lib/config.saveState`, to keep the server self-contained and matching the existing config-write pattern). The server test harness writes `state.json` at the real project root and restores it on close.

- [ ] **Step 4.1: Write the failing test.** Append the block below to the END of `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js`. It reuses the existing `buildServer` / `request` / `basicAuth` helpers already defined at the top of that file.

```js

// ---- freeze checklist endpoints --------------------------------------------

test('GET /api/freeze returns 7 targets with done:false for empty state', async () => {
  const { server, close } = await buildServer({ stateContent: { optOuts: {} } });
  try {
    const r = await request(server, {
      pathname: '/api/freeze',
      headers: { Authorization: basicAuth('testuser', 'testpass') },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
    assert.ok(Array.isArray(r.json.targets), 'response.targets must be an array');
    assert.equal(r.json.targets.length, 7);
    assert.ok(r.json.targets.every(t => t.done === false), 'all targets not-done for empty state');
    const eq = r.json.targets.find(t => t.key === 'equifax');
    assert.match(eq.url, /equifax\.com/);
    assert.equal(eq.type, 'credit-bureau');
  } finally {
    await close();
  }
});

test('GET /api/freeze reflects completed targets from state.freezes', async () => {
  const { server, close } = await buildServer({
    stateContent: { optOuts: {}, freezes: { experian: { doneAt: '2026-06-02T00:00:00.000Z' } } },
  });
  try {
    const r = await request(server, {
      pathname: '/api/freeze',
      headers: { Authorization: basicAuth('testuser', 'testpass') },
    });
    assert.equal(r.status, 200);
    const ex = r.json.targets.find(t => t.key === 'experian');
    assert.equal(ex.done, true);
    assert.equal(ex.doneAt, '2026-06-02T00:00:00.000Z');
  } finally {
    await close();
  }
});

test('POST /api/freeze action=done records the target on disk', async () => {
  const { server, close, realState } = await buildServer({ stateContent: { optOuts: {} } });
  try {
    const r = await request(server, {
      method: 'POST',
      pathname: '/api/freeze',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { key: 'equifax', action: 'done' },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
    assert.equal(r.json.ok, true);
    const saved = JSON.parse(fs.readFileSync(realState, 'utf8'));
    assert.ok(saved.freezes.equifax, 'equifax freeze must be persisted');
    assert.match(saved.freezes.equifax.doneAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await close();
  }
});

test('POST /api/freeze action=clear removes a recorded target', async () => {
  const { server, close, realState } = await buildServer({
    stateContent: { optOuts: {}, freezes: { equifax: { doneAt: '2026-06-01T00:00:00.000Z' } } },
  });
  try {
    const r = await request(server, {
      method: 'POST',
      pathname: '/api/freeze',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { key: 'equifax', action: 'clear' },
    });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.raw}`);
    const saved = JSON.parse(fs.readFileSync(realState, 'utf8'));
    assert.ok(!saved.freezes.equifax, 'equifax freeze must be cleared on disk');
  } finally {
    await close();
  }
});

test('POST /api/freeze does not disturb the existing optOuts namespace', async () => {
  const { server, close, realState } = await buildServer({
    stateContent: { optOuts: { spokeo: { history: ['success'], lastSuccess: '2026-01-01T00:00:00.000Z' } } },
  });
  try {
    const r = await request(server, {
      method: 'POST',
      pathname: '/api/freeze',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { key: 'innovis', action: 'done' },
    });
    assert.equal(r.status, 200);
    const saved = JSON.parse(fs.readFileSync(realState, 'utf8'));
    assert.ok(saved.optOuts.spokeo, 'optOuts must survive a freeze write');
    assert.equal(saved.optOuts.spokeo.lastSuccess, '2026-01-01T00:00:00.000Z');
    assert.ok(saved.freezes.innovis, 'innovis recorded alongside optOuts');
  } finally {
    await close();
  }
});

test('POST /api/freeze with an unknown key returns 400', async () => {
  const { server, close } = await buildServer({ stateContent: { optOuts: {} } });
  try {
    const r = await request(server, {
      method: 'POST',
      pathname: '/api/freeze',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { key: 'bogus', action: 'done' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown freeze target|bad key/i);
  } finally {
    await close();
  }
});

test('POST /api/freeze with a bad action returns 400', async () => {
  const { server, close } = await buildServer({ stateContent: { optOuts: {} } });
  try {
    const r = await request(server, {
      method: 'POST',
      pathname: '/api/freeze',
      headers: {
        Authorization: basicAuth('testuser', 'testpass'),
        Origin: `http://127.0.0.1:${server.address().port}`,
      },
      body: { key: 'equifax', action: 'nope' },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /bad action|action/i);
  } finally {
    await close();
  }
});

test('GET /api/freeze requires auth (401 without credentials)', async () => {
  const { server, close } = await buildServer({ stateContent: { optOuts: {} } });
  try {
    const r = await request(server, { pathname: '/api/freeze' });
    assert.equal(r.status, 401);
  } finally {
    await close();
  }
});
```

- [ ] **Step 4.2: Run it, expect fail.** Run `node --test` from the `dashboard/` directory (`cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test`). Expected failure: `GET /api/freeze` returns 404 (no route registered), so `r.status` is 404 not 200, and `r.json` is `null` causing the `targets` assertion to throw.

- [ ] **Step 4.3: Implement - import freeze in `server.js`.** Edit `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js`. After the `validate` import (line 44), add the freeze import:

```js
const { FREEZE_TARGETS, TARGET_KEYS, getFreezeStatus } = require('../lib/freeze');
```

- [ ] **Step 4.4: Implement - add the two routes.** Still in `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js`, insert the freeze routes immediately BEFORE the static-and-start section (before `app.use(express.static(...))` at line 502). Insert:

```js
// ---- freeze checklist ------------------------------------------------------
// Guided credit/identity freeze tracking. GET returns the canonical targets
// merged with completion status from state.freezes; POST marks a target
// done/cleared. State is additive - only state.freezes is touched, never
// state.optOuts. Auth + CSRF are enforced by the global middleware above.
app.get('/api/freeze', (_req, res) => {
  const m = readJsonMeta(STATE);
  const state = (m.exists && !m.parseError && m.data) ? m.data : { optOuts: {} };
  res.json({ targets: getFreezeStatus(state) });
});

app.post('/api/freeze', (req, res) => {
  const { key, action } = req.body || {};
  if (!TARGET_KEYS.has(key)) return res.status(400).json({ error: `unknown freeze target: ${key}` });
  if (action !== 'done' && action !== 'clear') return res.status(400).json({ error: 'bad action (expected "done" or "clear")' });

  const m = readJsonMeta(STATE);
  if (m.parseError) return res.status(409).json({ error: 'state.json could not be parsed' });
  const state = (m.exists && m.data) ? m.data : { optOuts: {} };
  if (!state.freezes || typeof state.freezes !== 'object') state.freezes = {};

  if (action === 'done') {
    state.freezes[key] = { doneAt: new Date().toISOString() };
  } else {
    delete state.freezes[key];
  }

  try {
    writeJsonAtomic(STATE, state, 0o600);
    res.json({ ok: true, targets: getFreezeStatus(state) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4.5: Implement - document the routes in the header comment.** Edit the endpoint list comment block at the top of `server.js` (lines 11-27). After the `POST /api/schedule` line (line 25), add two lines:

```js
 *   GET  /api/freeze             -> credit/identity freeze checklist + status
 *   POST /api/freeze             -> { key, action: done|clear } mark a freeze target
```

- [ ] **Step 4.6: Run, expect pass.** Run `node --test` from the `dashboard/` directory. All new freeze endpoint tests should pass alongside the existing server tests.

- [ ] **Step 4.7: Commit.** From the repo root:
```bash
git add dashboard/server.js dashboard/server.test.js
git commit -m "Add GET/POST /api/freeze endpoints to dashboard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Dashboard UI - freeze checklist card

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/public/index.html` (add a Freeze tab button + panel)
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js` (load + render + toggle)
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/public/styles.css` (small card styles)
- Test: `/Users/stephen/scripts/auto-identity-remove/dashboard/freeze-ui.test.js` (Created)

This is browser glue with no DOM test harness in the repo (`app.js`/`index.html` are not in any `node --test` glob). It is verified by a lightweight structural assertion test that parses the static files as text (hermetic, no browser). This keeps the wiring honest without adding a DOM testing dependency. The render code reuses the repo's existing `esc()` escaper exactly as `renderBrokers` (line 66-92) and `loadSummary` (line 28-43) do.

- [ ] **Step 5.1: Write the failing test.** Create `/Users/stephen/scripts/auto-identity-remove/dashboard/freeze-ui.test.js` with the complete content below. It runs under the dashboard suite (`cd dashboard && node --test`).

```js
/**
 * dashboard/freeze-ui.test.js
 *
 * Structural assertions for the freeze checklist UI. The project has no DOM
 * test harness, so we verify the static assets as text: the Freeze tab, its
 * panel, and the app.js wiring (load function, /freeze fetches, render target).
 * Hermetic - reads files only, no browser, no server.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');

test('index.html has a Freeze tab button wired to the freeze panel', () => {
  assert.match(HTML, /data-tab="freeze"/, 'a tab button with data-tab="freeze" must exist');
  assert.match(HTML, /id="tab-freeze"/, 'a panel with id="tab-freeze" must exist');
});

test('index.html has a container the freeze checklist renders into', () => {
  assert.match(HTML, /id="freezeList"/, 'a #freezeList container must exist');
});

test('app.js loads the freeze checklist from /freeze', () => {
  assert.match(APP, /api\('\/freeze'\)/, "app.js must GET /freeze");
  assert.match(APP, /function loadFreeze/, 'app.js must define loadFreeze()');
});

test('app.js posts done/clear toggles to /freeze', () => {
  assert.match(APP, /'\/freeze',\s*\{\s*method:\s*'POST'/, 'app.js must POST to /freeze');
  assert.match(APP, /action:\s*btn\.dataset\.act/, 'app.js must send an action field from the button');
});

test('app.js calls loadFreeze when the freeze tab is selected', () => {
  assert.match(APP, /dataset\.tab === 'freeze'\)\s*loadFreeze\(\)/, 'loadFreeze must be invoked on tab switch');
});

test('app.js escapes freeze data before rendering it', () => {
  assert.match(APP, /esc\(t\.name\)/, 'broker/target names must be escaped before render');
  assert.match(APP, /safeUrl\(t\.url\)/, 'target urls must pass through safeUrl');
});
```

- [ ] **Step 5.2: Run it, expect fail.** Run `node --test freeze-ui.test.js` from the `dashboard/` directory. Expected failure: the `data-tab="freeze"` assertion fails (no such markup yet).

- [ ] **Step 5.3: Implement - add the Freeze tab button.** Edit `/Users/stephen/scripts/auto-identity-remove/dashboard/public/index.html`. In the `<nav class="tabs">` block (lines 44-50), add a Freeze tab button after the Brokers tab button (after line 45). Insert:

```html
      <button class="tab" id="tabbtn-freeze" role="tab" aria-selected="false" aria-controls="tab-freeze" data-tab="freeze">Freeze</button>
```

- [ ] **Step 5.4: Implement - add the Freeze panel.** Still in `index.html`, add the panel after the brokers panel's closing `</section>` (after line 66, before the config panel at line 68). Insert:

```html
    <section class="card tab-panel hidden" id="tab-freeze" role="tabpanel" aria-labelledby="tabbtn-freeze">
      <h3>🧊 Credit / identity freeze checklist</h3>
      <p class="dim">Freezing your credit is the single highest-impact privacy action. Each target requires identity verification, so this is a guided checklist - open the link, complete the freeze, then mark it done. Nothing here is automated.</p>
      <ul class="freeze-list" id="freezeList"><li class="dim">loading…</li></ul>
    </section>
```

- [ ] **Step 5.5: Implement - add the loadFreeze wiring in app.js.** Edit `/Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js`. Add a freeze section before the `// ---------- footer (version) ----------` block (line 352). The row markup is built with the same `esc()` / `safeUrl()` escaping the rest of this file uses for data-influenced values; the assembled string is assigned to the list element via the same rendering pattern as `renderBrokers`. Insert:

```js
// ---------- freeze checklist ----------
function freezeRowHtml(t) {
  const url = safeUrl(t.url);
  const link = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t.name)}</a>`
    : esc(t.name);
  const badge = t.done
    ? `<span class="badge ok">done</span>`
    : `<span class="badge none">not yet</span>`;
  const when = t.done && t.doneAt ? `<span class="dim"> · ${esc(fmtDate(t.doneAt))}</span>` : '';
  const btnLabel = t.done ? 'Mark not done' : 'Mark done';
  const act = t.done ? 'clear' : 'done';
  return `<li class="freeze-row">
    <div class="freeze-main">${link} ${badge}${when}
      <span class="pill muted">${esc(t.type)}</span></div>
    <div class="dim freeze-notes">${esc(t.notes || '')}</div>
    <button class="btn freeze-toggle" data-key="${esc(t.key)}" data-act="${act}">${btnLabel}</button>
  </li>`;
}
async function loadFreeze() {
  const el = $('#freezeList');
  try {
    const r = await api('/freeze');
    const targets = (r && Array.isArray(r.targets)) ? r.targets : [];
    const markup = targets.length
      ? targets.map(freezeRowHtml).join('')
      : '<li class="dim">no freeze targets</li>';
    el.innerHTML = markup; // all interpolations escaped via esc()/safeUrl above
    $$('.freeze-toggle').forEach(btn => btn.addEventListener('click', async () => {
      const body = { key: btn.dataset.key, action: btn.dataset.act };
      const res = await api('/freeze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res && res.error) { btn.textContent = '⚠️ ' + res.error; return; }
      loadFreeze();
    }));
  } catch (err) {
    el.textContent = 'failed to load freeze checklist: ' + (err && err.message || String(err));
  }
}
```

- [ ] **Step 5.6: Implement - invoke loadFreeze on tab switch.** Still in `app.js`, in the tab-switch handler (lines 261-270), add a freeze branch alongside the existing `if (t.dataset.tab === ...)` lines. After the `if (t.dataset.tab === 'admin') loadWhoami();` line (line 269), add:

```js
  if (t.dataset.tab === 'freeze') loadFreeze();
```

- [ ] **Step 5.7: Add minimal CSS for the card.** Edit `/Users/stephen/scripts/auto-identity-remove/dashboard/public/styles.css` and append at the end of the file:

```css
.freeze-list { list-style: none; padding: 0; margin: 0; }
.freeze-row { padding: 10px 0; border-bottom: 1px solid var(--border); display: grid; gap: 4px; }
.freeze-row .freeze-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.freeze-row .freeze-notes { font-size: 12px; }
.freeze-row .freeze-toggle { justify-self: start; }
```

- [ ] **Step 5.8: Run, expect pass.** Run `node --test freeze-ui.test.js` from the `dashboard/` directory. All structural assertions should pass.

- [ ] **Step 5.9: Commit.** From the repo root:
```bash
git add dashboard/public/index.html dashboard/public/app.js dashboard/public/styles.css dashboard/freeze-ui.test.js
git commit -m "Add freeze checklist card to dashboard UI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full-suite verification (root + dashboard) - confirm green

Files:
- No source changes. This task only runs the suites and fixes any regression surfaced.

- [ ] **Step 6.1: Run the root suite.** From the repo root, run exactly what CI runs:
```bash
node --test test/*.test.js dashboard/validate.test.js
```
Confirm zero failures. This includes the new `test/freeze.test.js` and `test/freeze-cli.test.js`. If `test/freeze-cli.test.js` is slow (it spawns child processes), confirm it stays well under the 30s per-call timeout set in the test.

- [ ] **Step 6.2: Run the dashboard suite.** From the repo root:
```bash
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```
Confirm zero failures, including `dashboard/server.test.js` (with the new freeze endpoint tests) and `dashboard/freeze-ui.test.js`.

- [ ] **Step 6.3: Confirm no real state.json / config.json drift.** From the repo root, run `git status --short`. Confirm `state.json` and `config.json` are unchanged (gitignored, and the tests redirect via `AIDR_STATE_PATH` / temp paths / restore-on-close). If the dashboard server test left the real `state.json` modified, that indicates a restore bug in the harness - investigate before proceeding (the existing `buildServer` close() restores original files at lines 156-166).

- [ ] **Step 6.4: Verify the `package.json` test globs still cover the new files.** Read `/Users/stephen/scripts/auto-identity-remove/package.json` and confirm the root `test` script is `node --test test/*.test.js dashboard/validate.test.js` (the new `test/freeze*.test.js` files match `test/*.test.js`; `dashboard/freeze-ui.test.js` runs under the dashboard suite via the dashboard `test` script `node --test`). No edit needed unless the glob changed. The CI `dashboard` job runs `node --test` in `dashboard/`, which picks up `dashboard/freeze-ui.test.js` and `dashboard/server.test.js` automatically.

- [ ] **Step 6.5: Final commit (only if Step 6.x required a fix).** If any regression fix was needed, commit it. Otherwise skip. From the repo root:
```bash
git add -A
git commit -m "Fix regressions surfaced by full-suite freeze verification

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6.6: Push (only when the user asks).** Per repo convention, do not push automatically unless the user has approved it. If approved and on a non-default branch, run `git push -u origin HEAD`.

---

## Self-review

Spec coverage (every requirement from the feature brief mapped to a task):
- New `lib/freeze.js` exporting `FREEZE_TARGETS` (array of `{key, name, url, type: credit-bureau|specialty, notes}`) - Task 1, Step 1.3. `type` is exactly `'credit-bureau'` (3 entries) or `'specialty'` (4 entries), asserted in Task 1.
- Helpers `getFreezeStatus(state)` / `recordFreezeDone(state, key)` / `recordFreezeCleared(state, key)` - Task 1 (read) + Task 2 (writes). They persist under `state.freezes[key] = { doneAt }`, additive (never touch `state.optOuts`, asserted in Steps 2.x/4.x), via the existing atomic `saveState()` (CLI/helper path) and `writeJsonAtomic` (dashboard path).
- Real current freeze URLs for Equifax, Experian, TransUnion, chexsystems.com, nctue.com, innovis.com, optoutprescreen.com - Task 1, Step 1.3 + asserted in the "real current freeze URLs" test.
- New `--freeze` CLI mode listing each target with URL + done status - Task 3, Steps 3.4-3.5.
- `--freeze-done <key>` / `--freeze-clear <key>` subcommands (value-taking flags, mirroring `--only <arg>` parsing via `indexOf` + next argv) - Task 3, Steps 3.4-3.5; run under the same `STATE_PATH + '.lock'` process lock as `main()`.
- `GET /api/freeze` + `POST /api/freeze` (mark done/cleared) endpoints - Task 4; reuse the dashboard's existing auth + CSRF middleware and atomic `writeJsonAtomic`.
- Checklist card in the UI - Task 5 (Freeze tab + panel + render + toggle).
- Tests: pure status helpers (Task 1), temp-state round-trip (Task 2), CLI subcommands (Task 3), endpoints (Task 4), UI structure (Task 5), full-suite green (Task 6).

Signature consistency with the real repo (verified against the files read):
- `lib/config.js` exports used: `loadState`, `saveState`, `setDryRun`, `setTestStatePath`, `resetState`, `STATE_PATH`. All present in the real `module.exports` (lines 329-355). The `AIDR_STATE_PATH` env hook (Step 3.3) edits the real `STATE_PATH` definition (line 23) and leaves the initial-load block (lines 82-84) reading `STATE_PATH` unchanged.
- `watcher.js` flag-parsing convention matched exactly: booleans via `process.argv.includes`, value flags via `indexOf(flag)` + next argv (mirrors `--only`/`--skip`/`--confirm-emails` at lines 34-54). The freeze mode block is inserted at the top of the existing if/else dispatch ladder and `process.exit`s early, before the Playwright path - so it stays hermetic. The lock pattern reuses `lock.acquire`/`lock.release` with `STATE_PATH + '.lock'` exactly as `main()` (lines 232-249) and the confirm-emails path (lines 113-149). `loadState` and `lock` are already imported at the top of `watcher.js` (lines 14 and 20).
- `dashboard/server.js` reuses real helpers: `readJsonMeta` (lines 163-169), `writeJsonAtomic` (lines 171-175), `STATE` constant (line 48), and the global auth (lines 115-120) + CSRF (lines 123-131) middleware. Routes are registered before `app.use(express.static(...))` (line 502), consistent with all other `app.get`/`app.post` route placement.
- `dashboard/public/app.js` reuses real helpers `api`, `esc`, `safeUrl`, `fmtDate`, `$`, `$$` and the existing badge classes `ok`/`none` and `pill muted` (confirmed present in `statusFor`, `loadSummary`, and `styles.css`). The tab-switch handler (lines 261-270) is the real extension point. Every data-influenced interpolation into `innerHTML` is escaped with `esc()` / `safeUrl()` (the same XSS-defense the file already documents at lines 13-19); the error path uses `textContent`.
- Test style matches the repo: `node:test` + `node:assert/strict`, factory helpers (`makeTmpState`, `tmpStatePath`), `cfg.setTestStatePath` + temp dirs (copied from `test/config-atomic-write.test.js`), and the dashboard's `buildServer`/`request`/`basicAuth` harness (from `dashboard/server.test.js`) with `Origin` headers to satisfy CSRF.

No placeholders: every step contains complete, runnable code - no TBD, no "add error handling", no "similar to above", no ellipses in any code block (every `...` is a real JavaScript spread operator). No em dashes are used anywhere in this plan (authored prose or code comments use hyphens only, per repo convention); the box-drawing `──` characters in the freeze-mode comment match the existing `watcher.js` section-comment style and are intentional.

No new npm dependencies: only Node built-ins (`fs`, `os`, `path`, `crypto`, `child_process`) and the already-present `express` (dashboard) are used. Playwright is not invoked by the freeze flow.
