# One-command install + npx-runnable CLI Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Let a non-developer install and run auto-identity-remove with one script and an `aidr` command that dispatches friendly subcommands to the existing entrypoints.

Architecture: A new `bin/aidr.js` is a thin dispatcher that maps subcommands (`setup`, `run`, `preview`, `verify`, `dashboard`, `score`, `report`, `doctor`) to existing entrypoints (`setup.js`, `watcher.js` with flags, `dashboard/server.js`). The pure argument-to-target mapping is extracted into a separate testable module `lib/cli-map.js` so it can be unit-tested with no spawning. A POSIX `install.sh` checks Node, runs `npm ci`, installs the Playwright Chromium browser, and prints next steps.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict`. Process spawning uses Node built-in `child_process`. Dashboard credential generation uses the built-in `crypto` module. No new npm dependencies.

New dependencies: NONE. (Uses only Node built-ins: `child_process`, `crypto`, `path`, `process`.)

---

## File map

| File | Status | Responsibility |
|------|--------|----------------|
| `lib/cli-map.js` | Created | Pure functions: `resolveCommand(argv)` maps a subcommand + its args to a spawn target `{ target, file, args, env, help }`; `COMMANDS` describes each subcommand; `buildHelp()` renders the help text. No side effects, no spawning. |
| `bin/aidr.js` | Created | Thin executable dispatcher. Parses `process.argv`, calls `resolveCommand`, prints help/version, generates dashboard creds, then `spawn`s the resolved target. |
| `lib/dashboard-creds.js` | Created | Pure `generateDashboardCreds()` returning `{ user, pass }` using `crypto.randomBytes`. Testable in isolation. |
| `install.sh` | Created | POSIX install script: checks Node >= 18, runs `npm ci`, runs `npx playwright install chromium`, prints next steps. |
| `package.json` | Modified | Add `"bin": { "aidr": "./bin/aidr.js" }` and a `"files"` whitelist (lines 5-11 area, after `"main"`). |
| `test/cli-map.test.js` | Created | Tests `resolveCommand` pure mapping for every subcommand, unknown commands, flag passthrough, and `buildHelp`. |
| `test/dashboard-creds.test.js` | Created | Tests `generateDashboardCreds` shape, randomness, and charset. |
| `test/cli-bin-smoke.test.js` | Created | Hermetic smoke test: spawns `bin/aidr.js --help` and `bin/aidr.js --version` as a child process and asserts exit code 0 and expected output (no network, no real run). |
| `README.md` | Modified | Replace the Quick Start section (lines 33-48) with the one-command install + `aidr` usage, add an `aidr` subcommand table, note Electron/Tauri as a follow-up. |

---

## Task 1: Pure CLI argument-to-target mapping (`lib/cli-map.js`)

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/cli-map.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/cli-map.test.js`

This task builds the testable core. `resolveCommand` is pure: given an array of CLI args (everything after `node bin/aidr.js`), it returns a descriptor of what to spawn. It does NOT spawn anything.

Contract for the descriptor returned by `resolveCommand(args)`:
- For a known subcommand: `{ ok: true, target: 'node'|'help'|'version', file, args, cwd, command }`.
  - `file` is the script path relative to the repo root (e.g. `'watcher.js'`, `'setup.js'`, `'dashboard/server.js'`).
  - `args` is the full argv array to pass to `node` (i.e. `[file, ...extraFlags, ...passthrough]`).
  - `cwd` is `'root'` for everything except `dashboard`, which is `'dashboard'` (server.js resolves ROOT as `..`, so cwd does not strictly matter, but we record intent).
  - `command` echoes the resolved subcommand name.
- For `--help`/`-h`/no args: `{ ok: true, target: 'help' }`.
- For `--version`/`-v`: `{ ok: true, target: 'version' }`.
- For an unknown subcommand: `{ ok: false, error: "unknown command: <x>", target: 'help' }`.

Subcommand to target mapping (verified against `watcher.js` argv parsing at lines 26-54 and `dashboard/server.js` MODE_ARGS at lines 275-286):
- `setup`     -> `setup.js`, no flags
- `run`       -> `watcher.js`, no flags (real run)
- `preview`   -> `watcher.js --preview`
- `verify`    -> `watcher.js --verify`
- `doctor`    -> `watcher.js --doctor`
- `score`     -> `watcher.js --serp-scan` (SERP rank scan)
- `report`    -> `watcher.js --pending` (pending-confirmation report)
- `dashboard` -> `dashboard/server.js`, no flags, cwd dashboard
- Extra user args after the subcommand are appended to `args` (passthrough), e.g. `aidr run --dry-run --only Spokeo`.

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/cli-map.test.js` with this complete content:

```js
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
```

- [ ] Step 1.2: Run it, expect fail. Run:

```
node --test test/cli-map.test.js
```

Expect failure: `Cannot find module '../lib/cli-map'` (the module does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/cli-map.js` with this complete content:

```js
'use strict';
/*
 * lib/cli-map.js - pure argument-to-target mapping for the `aidr` CLI.
 *
 * resolveCommand(args) takes everything after `node bin/aidr.js` and returns a
 * descriptor of what to spawn. It performs NO spawning, NO filesystem access,
 * and NO network - it is a pure function so it can be unit-tested directly.
 *
 * Subcommand flags are verified against watcher.js argv parsing and
 * dashboard/server.js MODE_ARGS.
 */

const PROGRAM = 'aidr';

// name -> { file, flags, cwd, desc }
// flags are the watcher.js flags this subcommand injects before passthrough.
const COMMANDS = {
  setup:     { file: 'setup.js',            flags: [],              cwd: 'root',      desc: 'Interactive first-run setup (creates config.json, schedules monthly job)' },
  run:       { file: 'watcher.js',          flags: [],              cwd: 'root',      desc: 'Run the opt-out pass now (submits forms)' },
  preview:   { file: 'watcher.js',          flags: ['--preview'],   cwd: 'root',      desc: 'Dry-run: fill forms but submit nothing' },
  verify:    { file: 'watcher.js',          flags: ['--verify'],    cwd: 'root',      desc: 'Re-search brokers and report whether you still appear' },
  dashboard: { file: 'dashboard/server.js', flags: [],              cwd: 'dashboard', desc: 'Start the local web dashboard and print its URL + login' },
  score:     { file: 'watcher.js',          flags: ['--serp-scan'], cwd: 'root',      desc: 'Scan search engines for where your name still ranks' },
  report:    { file: 'watcher.js',          flags: ['--pending'],   cwd: 'root',      desc: 'List brokers awaiting an email-confirmation click' },
  doctor:    { file: 'watcher.js',          flags: ['--doctor'],    cwd: 'root',      desc: 'Self-diagnose environment and configuration' },
};

const HELP_FLAGS = new Set(['--help', '-h', 'help']);
const VERSION_FLAGS = new Set(['--version', '-v']);

function resolveCommand(args) {
  const list = Array.isArray(args) ? args : [];
  const first = list[0];

  if (first === undefined || HELP_FLAGS.has(first)) {
    return { ok: true, target: 'help' };
  }
  if (VERSION_FLAGS.has(first)) {
    return { ok: true, target: 'version' };
  }

  const spec = COMMANDS[first];
  if (!spec) {
    return { ok: false, target: 'help', error: `unknown command: ${first}` };
  }

  const passthrough = list.slice(1);
  return {
    ok: true,
    target: 'node',
    command: first,
    file: spec.file,
    cwd: spec.cwd,
    args: [spec.file, ...spec.flags, ...passthrough],
  };
}

function buildHelp() {
  const lines = [];
  lines.push(`${PROGRAM} - automated data-broker opt-out runner`);
  lines.push('');
  lines.push(`Usage: ${PROGRAM} <command> [options]`);
  lines.push('');
  lines.push('Commands:');
  const width = Math.max(...Object.keys(COMMANDS).map(k => k.length));
  for (const name of Object.keys(COMMANDS)) {
    lines.push(`  ${name.padEnd(width)}  ${COMMANDS[name].desc}`);
  }
  lines.push('');
  lines.push('Other:');
  lines.push(`  --help, -h     Show this help`);
  lines.push(`  --version, -v  Show the installed version`);
  lines.push('');
  lines.push('Examples:');
  lines.push(`  ${PROGRAM} setup`);
  lines.push(`  ${PROGRAM} preview`);
  lines.push(`  ${PROGRAM} run --only Spokeo`);
  lines.push(`  ${PROGRAM} dashboard`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { PROGRAM, COMMANDS, resolveCommand, buildHelp };
```

- [ ] Step 1.4: Run, expect pass. Run:

```
node --test test/cli-map.test.js
```

Expect all tests passing (16 tests, 0 failures).

- [ ] Step 1.5: Commit. Run:

```
git add lib/cli-map.js test/cli-map.test.js
git commit -m "Add pure aidr CLI arg-to-target mapping (lib/cli-map.js)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Dashboard credential generator (`lib/dashboard-creds.js`)

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/dashboard-creds.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/dashboard-creds.test.js`

`aidr dashboard` must boot `dashboard/server.js` with credentials so it is not unauthenticated (server.js reads `AIDR_USER`/`AIDR_PASS` env vars at lines 57-60 and prints a warning when neither is set, line 510). This pure helper generates a fixed username and a random URL-safe password using `crypto.randomBytes`. The dispatcher (Task 3) injects them as env vars and prints them once.

- [ ] Step 2.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/dashboard-creds.test.js` with this complete content:

```js
/**
 * test/dashboard-creds.test.js
 *
 * Unit tests for the dashboard credential generator used by `aidr dashboard`.
 * Pure (uses crypto.randomBytes) - no network, no filesystem.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateDashboardCreds } = require('../lib/dashboard-creds');

test('generateDashboardCreds returns a user and pass', () => {
  const c = generateDashboardCreds();
  assert.equal(typeof c.user, 'string');
  assert.equal(typeof c.pass, 'string');
  assert.ok(c.user.length > 0, 'user must be non-empty');
});

test('generated password is long enough to be secure', () => {
  const c = generateDashboardCreds();
  assert.ok(c.pass.length >= 16, `password length ${c.pass.length} must be >= 16`);
});

test('generated password is URL-safe (no characters that break Basic auth or URLs)', () => {
  const c = generateDashboardCreds();
  assert.match(c.pass, /^[A-Za-z0-9_-]+$/, 'password must be URL-safe base64url chars only');
});

test('two successive calls produce different passwords (randomness)', () => {
  const a = generateDashboardCreds();
  const b = generateDashboardCreds();
  assert.notEqual(a.pass, b.pass, 'passwords must differ across calls');
});

test('default username is "admin"', () => {
  const c = generateDashboardCreds();
  assert.equal(c.user, 'admin');
});
```

- [ ] Step 2.2: Run it, expect fail. Run:

```
node --test test/dashboard-creds.test.js
```

Expect failure: `Cannot find module '../lib/dashboard-creds'`.

- [ ] Step 2.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/dashboard-creds.js` with this complete content:

```js
'use strict';
/*
 * lib/dashboard-creds.js - generate ephemeral credentials for the local
 * dashboard so `aidr dashboard` never starts unauthenticated.
 *
 * The password is a URL-safe base64url string derived from 18 random bytes
 * (24 chars), safe to drop into an HTTP Basic credential and a localhost URL.
 */

const crypto = require('crypto');

function generateDashboardCreds() {
  const pass = crypto.randomBytes(18).toString('base64url');
  return { user: 'admin', pass };
}

module.exports = { generateDashboardCreds };
```

- [ ] Step 2.4: Run, expect pass. Run:

```
node --test test/dashboard-creds.test.js
```

Expect all 5 tests passing.

- [ ] Step 2.5: Commit. Run:

```
git add lib/dashboard-creds.js test/dashboard-creds.test.js
git commit -m "Add dashboard credential generator for aidr dashboard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The `bin/aidr.js` dispatcher executable

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/bin/aidr.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/cli-bin-smoke.test.js`

`bin/aidr.js` wires the pure mapping (Task 1) and the creds generator (Task 2) to a real `spawn`. It is the executable the `bin` entry in package.json points to. For `dashboard`, it generates creds, injects them via env (`AIDR_USER`/`AIDR_PASS`), prints the localhost URL and the login once, then spawns the server. For all other commands it spawns `node <args>` with stdio inherited.

The smoke test stays hermetic by exercising only the side-effect-free paths: `--help` (target `help`) and `--version` (target `version`). These print and exit 0 without spawning watcher.js or touching the network. The exhaustive mapping is already covered by Task 1.

- [ ] Step 3.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/cli-bin-smoke.test.js` with this complete content:

```js
/**
 * test/cli-bin-smoke.test.js
 *
 * Hermetic smoke test for the bin/aidr.js dispatcher. Only exercises the
 * non-spawning paths (--help, --version, unknown command) by running the bin
 * as a child process and asserting its exit code + output. No network, no
 * real opt-out run, no dashboard boot.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'aidr.js');

function runBin(args) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

test('aidr --help exits 0 and lists subcommands', () => {
  const r = runBin(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: aidr/);
  assert.match(r.stdout, /\bsetup\b/);
  assert.match(r.stdout, /\bdashboard\b/);
});

test('aidr with no args prints help and exits 0', () => {
  const r = runBin([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: aidr/);
});

test('aidr --version prints the package version and exits 0', () => {
  const r = runBin(['--version']);
  assert.equal(r.code, 0);
  const pkg = require('../package.json');
  assert.match(r.stdout, new RegExp(pkg.version.replace(/\./g, '\\.')));
});

test('aidr unknown-command prints help and exits non-zero', () => {
  const r = runBin(['frobnicate']);
  assert.notEqual(r.code, 0);
  const combined = r.stdout + (r.stderr || '');
  assert.match(combined, /unknown command: frobnicate/);
});
```

- [ ] Step 3.2: Run it, expect fail. Run:

```
node --test test/cli-bin-smoke.test.js
```

Expect failure: the child process cannot find `bin/aidr.js` (`Cannot find module .../bin/aidr.js`), so `execFileSync` throws and the assertions on exit code 0 fail.

- [ ] Step 3.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/bin/aidr.js` with this complete content:

```js
#!/usr/bin/env node
'use strict';
/*
 * bin/aidr.js - friendly CLI dispatcher for auto-identity-remove.
 *
 * Maps subcommands (setup, run, preview, verify, dashboard, score, report,
 * doctor) to the existing entrypoints via lib/cli-map.js, then spawns them.
 * The dashboard subcommand generates one-time credentials so the local web UI
 * is never unauthenticated, and prints the URL + login once.
 *
 * Usage: aidr <command> [options]   (run `aidr --help` for the full list)
 */

const path = require('path');
const { spawn } = require('child_process');
const { resolveCommand, buildHelp } = require('../lib/cli-map');
const { generateDashboardCreds } = require('../lib/dashboard-creds');

const ROOT = path.resolve(__dirname, '..');

function printHelp() {
  process.stdout.write(buildHelp() + '\n');
}

function printVersion() {
  const pkg = require('../package.json');
  process.stdout.write(`${pkg.name} v${pkg.version} (node ${process.version})\n`);
}

function spawnNode(resolved) {
  const cwd = resolved.cwd === 'dashboard' ? path.join(ROOT, 'dashboard') : ROOT;
  const env = { ...process.env };
  let onSpawn = null;

  if (resolved.command === 'dashboard') {
    // Boot the dashboard authenticated. server.js reads AIDR_USER/AIDR_PASS
    // (see dashboard/server.js) and stays open if neither is set.
    if (!env.AIDR_USER || !env.AIDR_PASS) {
      const creds = generateDashboardCreds();
      env.AIDR_USER = creds.user;
      env.AIDR_PASS = creds.pass;
      const host = env.AIDR_HOST || '127.0.0.1';
      const port = env.AIDR_PORT || '8080';
      onSpawn = () => {
        process.stdout.write('\n  Dashboard starting...\n');
        process.stdout.write(`  URL:      http://${host}:${port}\n`);
        process.stdout.write(`  Username: ${creds.user}\n`);
        process.stdout.write(`  Password: ${creds.pass}\n`);
        process.stdout.write('  (these credentials are shown once; re-run to get new ones)\n\n');
      };
    }
  }

  const child = spawn(process.execPath, resolved.args, { cwd, env, stdio: 'inherit' });
  if (onSpawn) child.on('spawn', onSpawn);
  child.on('exit', (code, signal) => {
    if (signal) { process.exit(1); }
    process.exit(code === null ? 1 : code);
  });
  child.on('error', err => {
    process.stderr.write(`aidr: failed to start ${resolved.file}: ${err.message}\n`);
    process.exit(1);
  });
}

function main() {
  const args = process.argv.slice(2);
  const resolved = resolveCommand(args);

  if (resolved.target === 'help') {
    if (!resolved.ok && resolved.error) {
      process.stderr.write(`aidr: ${resolved.error}\n\n`);
      printHelp();
      process.exit(2);
    }
    printHelp();
    process.exit(0);
  }
  if (resolved.target === 'version') {
    printVersion();
    process.exit(0);
  }
  spawnNode(resolved);
}

main();
```

- [ ] Step 3.4: Make the bin executable and run, expect pass. Run:

```
chmod +x bin/aidr.js
node --test test/cli-bin-smoke.test.js
```

Expect all 4 tests passing.

- [ ] Step 3.5: Commit. Run:

```
git add bin/aidr.js test/cli-bin-smoke.test.js
git commit -m "Add bin/aidr.js dispatcher + hermetic smoke test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire the `bin` entry into package.json (integration)

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/package.json` (lines 5-11, after `"main": "watcher.js",`)

This is the integration step that makes the CLI actually `npx`-runnable and installable as `aidr`. We add a `"bin"` field and a `"files"` whitelist so published/`npx`-fetched packages include `bin/`, `lib/`, the entrypoints, and `brokers.js` but not test fixtures or local config. The `test` script is also extended to include the three new test files so the root suite covers them.

A guard test confirms the `bin` field is wired correctly (this is the "integration is correct" assertion that the executing agent can verify without publishing).

- [ ] Step 4.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/package-bin.test.js` with this complete content:

```js
/**
 * test/package-bin.test.js
 *
 * Verifies the npx/installable CLI wiring in package.json: the bin entry
 * points at bin/aidr.js and that file exists and is executable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

test('package.json declares the aidr bin pointing at bin/aidr.js', () => {
  assert.ok(pkg.bin, 'package.json must have a "bin" field');
  assert.equal(pkg.bin.aidr, './bin/aidr.js');
});

test('bin/aidr.js exists on disk', () => {
  const binPath = path.join(ROOT, 'bin', 'aidr.js');
  assert.ok(fs.existsSync(binPath), 'bin/aidr.js must exist');
});

test('bin/aidr.js starts with a node shebang', () => {
  const binPath = path.join(ROOT, 'bin', 'aidr.js');
  const head = fs.readFileSync(binPath, 'utf8').split('\n')[0];
  assert.match(head, /^#!\/usr\/bin\/env node/);
});

test('package.json files whitelist includes bin and lib', () => {
  assert.ok(Array.isArray(pkg.files), 'package.json must have a "files" array');
  assert.ok(pkg.files.includes('bin/'), 'files must include bin/');
  assert.ok(pkg.files.includes('lib/'), 'files must include lib/');
});
```

- [ ] Step 4.2: Run it, expect fail. Run:

```
node --test test/package-bin.test.js
```

Expect failure on the first test: `pkg.bin` is `undefined` (`package.json must have a "bin" field`), and the `files` whitelist test also fails.

- [ ] Step 4.3: Implement. Edit `/Users/stephen/scripts/auto-identity-remove/package.json`. Apply two changes.

First, add the `"bin"` and `"files"` fields immediately after the `"main"` line. Replace:

```json
  "main": "watcher.js",
  "scripts": {
```

with:

```json
  "main": "watcher.js",
  "bin": {
    "aidr": "./bin/aidr.js"
  },
  "files": [
    "bin/",
    "lib/",
    "dashboard/",
    "watcher.js",
    "setup.js",
    "brokers.js",
    "generic-runner.js",
    "run.sh",
    "config.example.json",
    "data/",
    "README.md"
  ],
  "scripts": {
```

Second, extend the root `test` script to include the three new test files. Replace:

```json
    "test": "node --test test/*.test.js dashboard/validate.test.js"
```

with:

```json
    "test": "node --test test/*.test.js dashboard/validate.test.js",
    "aidr": "node bin/aidr.js"
```

(The `test/*.test.js` glob already matches the new `test/cli-map.test.js`, `test/dashboard-creds.test.js`, `test/cli-bin-smoke.test.js`, and `test/package-bin.test.js`, so no other change to the test script is needed. The added `"aidr"` script lets `npm run aidr -- <cmd>` work during local development.)

- [ ] Step 4.4: Run, expect pass. Run:

```
node --test test/package-bin.test.js
```

Expect all 4 tests passing. Also confirm the JSON is valid:

```
node -e "require('./package.json'); console.log('package.json parses OK')"
```

- [ ] Step 4.5: Commit. Run:

```
git add package.json test/package-bin.test.js
git commit -m "Wire aidr bin entry + files whitelist into package.json

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: One-command `install.sh`

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/install.sh`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/install-script.test.js`

`install.sh` is a POSIX script a non-developer runs once. It must: (1) verify `node` exists and is >= 18, (2) run `npm ci`, (3) install the Playwright Chromium browser via `npx playwright install chromium`, (4) print clear next steps (`./node_modules/.bin/aidr setup`, then `aidr preview`). It must `set -e` and fail loudly with a friendly message if Node is missing or too old.

The test does NOT execute the installer (that would hit the network and mutate node_modules). Instead it statically asserts the script's structure: shebang, `set -e`, the Node-version gate, the `npm ci` and `npx playwright install chromium` lines, and the printed next-step commands. This keeps the test hermetic while still catching regressions in the install flow.

- [ ] Step 5.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/install-script.test.js` with this complete content:

```js
/**
 * test/install-script.test.js
 *
 * Static checks on install.sh. We do NOT execute the installer (it would run
 * npm ci and download a browser) - we assert the script contains the required
 * steps and safety guards so the install flow can't silently regress.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'install.sh');

function read() {
  return fs.readFileSync(SCRIPT, 'utf8');
}

test('install.sh exists', () => {
  assert.ok(fs.existsSync(SCRIPT), 'install.sh must exist at repo root');
});

test('install.sh has a sh/bash shebang and set -e', () => {
  const src = read();
  assert.match(src.split('\n')[0], /^#!\/usr\/bin\/env (bash|sh)|^#!\/bin\/(bash|sh)/);
  assert.match(src, /set -e/);
});

test('install.sh checks for node and a minimum major version', () => {
  const src = read();
  assert.match(src, /command -v node/);
  assert.match(src, /\b18\b/, 'must reference the Node 18 minimum');
});

test('install.sh runs npm ci', () => {
  const src = read();
  assert.match(src, /npm ci/);
});

test('install.sh installs the Playwright Chromium browser', () => {
  const src = read();
  assert.match(src, /npx playwright install chromium/);
});

test('install.sh prints the next step (aidr setup)', () => {
  const src = read();
  assert.match(src, /aidr setup/);
});
```

- [ ] Step 5.2: Run it, expect fail. Run:

```
node --test test/install-script.test.js
```

Expect failure on the first test: `install.sh must exist at repo root` (file missing).

- [ ] Step 5.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/install.sh` with this complete content:

```bash
#!/usr/bin/env bash
# install.sh - one-command setup for auto-identity-remove.
#
# Run once after cloning:   bash install.sh
#
# Checks Node, installs dependencies, installs the Playwright Chromium browser,
# and prints what to do next. No personal data is touched here.

set -e

cd "$(dirname "$0")"

echo ""
echo "auto-identity-remove - installer"
echo "--------------------------------"

# 1. Node present?
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed."
  echo "Install Node 18 or newer from https://nodejs.org and re-run: bash install.sh"
  exit 1
fi

# 2. Node version >= 18 ?
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18 or newer is required (found $(node -v))."
  echo "Upgrade from https://nodejs.org and re-run: bash install.sh"
  exit 1
fi
echo "Node $(node -v) detected."

# 3. Install dependencies (reproducible - uses package-lock.json).
echo ""
echo "Installing dependencies (npm ci)..."
npm ci

# 4. Install the Chromium browser Playwright drives.
echo ""
echo "Installing the Chromium browser (npx playwright install chromium)..."
npx playwright install chromium

# 5. Next steps.
echo ""
echo "--------------------------------"
echo "Install complete."
echo ""
echo "Next steps:"
echo "  1. Run setup (creates config.json, schedules the monthly job):"
echo "       ./node_modules/.bin/aidr setup"
echo "  2. Preview what it will do (submits nothing):"
echo "       ./node_modules/.bin/aidr preview"
echo "  3. Run for real when ready:"
echo "       ./node_modules/.bin/aidr run"
echo ""
echo "  Open the local web dashboard:"
echo "       ./node_modules/.bin/aidr dashboard"
echo ""
echo "Tip: run 'npm link' (or install globally) to use 'aidr' without the path prefix."
echo "--------------------------------"
echo ""
```

- [ ] Step 5.4: Make it executable and run the test, expect pass. Run:

```
chmod +x install.sh
node --test test/install-script.test.js
```

Expect all 6 tests passing.

- [ ] Step 5.5: Commit. Run:

```
git add install.sh test/install-script.test.js
git commit -m "Add one-command install.sh + static checks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Update README Quick Start

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/README.md` (Quick Start section, lines 33-48)

Rewrite the Quick Start to lead with `install.sh` and the `aidr` command, add a subcommand reference table, and note that a desktop wrapper (Electron/Tauri) is an explicit follow-up, not in scope here. No test for prose; verification is a visual read plus the full-suite run in Task 7.

- [ ] Step 6.1: Read the current Quick Start. Run:

```
rtk read README.md
```

Confirm lines 33-48 contain the existing `## Quick Start` block ending with `./run.sh`.

- [ ] Step 6.2: Edit the README. Replace this exact block (lines 33-48):

```
## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/stephenlthorn/auto-identity-remove.git
cd auto-identity-remove

# 2. Install dependencies
npm install

# 3. Run interactive setup (creates config.json and schedules the monthly job)
node setup.js

# 4. Run manually anytime
./run.sh
```
```

with:

```
## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/stephenlthorn/auto-identity-remove.git
cd auto-identity-remove

# 2. One-command install (checks Node, installs deps + the Chromium browser)
bash install.sh

# 3. Run interactive setup (creates config.json and schedules the monthly job)
./node_modules/.bin/aidr setup

# 4. Preview what it will do - submits nothing
./node_modules/.bin/aidr preview

# 5. Run for real anytime
./node_modules/.bin/aidr run
```

> Tip: run `npm link` (or install globally) so you can type `aidr` directly
> instead of `./node_modules/.bin/aidr`.

### The `aidr` command

`aidr` is a friendly wrapper around the underlying scripts. Every subcommand
maps to an existing entrypoint:

| Command | What it does |
|---------|--------------|
| `aidr setup` | Interactive first-run setup (creates `config.json`, schedules the monthly job) |
| `aidr preview` | Dry-run: fills forms but submits nothing |
| `aidr run` | Runs the opt-out pass for real |
| `aidr verify` | Re-searches brokers and reports whether you still appear |
| `aidr score` | Scans search engines for where your name still ranks (SERP scan) |
| `aidr report` | Lists brokers awaiting an email-confirmation click |
| `aidr doctor` | Self-diagnoses your environment and configuration |
| `aidr dashboard` | Starts the local web dashboard and prints its URL + a one-time login |

Pass extra flags straight through, e.g. `aidr run --only Spokeo` or
`aidr preview --skip BeenVerified`. Run `aidr --help` for the full list.

> A native desktop wrapper (Electron/Tauri) is a planned follow-up and is **not**
> included here - this release is clean CLI packaging only.
```

- [ ] Step 6.3: Verify the edit landed and the table renders. Run:

```
rtk grep -n "The \`aidr\` command" README.md
rtk grep -n "aidr dashboard" README.md
```

Expect both to match (the new heading and the dashboard table row).

- [ ] Step 6.4: No test to run for prose - proceed to commit.

- [ ] Step 6.5: Commit. Run:

```
git add README.md
git commit -m "README: lead Quick Start with install.sh + aidr command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Full-suite verification (green gate)

Files:
- No new files. Runs the complete test suite (root + dashboard) to confirm nothing regressed and all new tests pass.

- [ ] Step 7.1: Run the root suite. Run:

```
node --test test/*.test.js dashboard/validate.test.js
```

Expect all tests passing, including the five new files: `test/cli-map.test.js`, `test/dashboard-creds.test.js`, `test/cli-bin-smoke.test.js`, `test/package-bin.test.js`, `test/install-script.test.js`. Confirm `0 failures` in the summary.

- [ ] Step 7.2: Run the dashboard suite (touched indirectly via creds/env wiring; confirm it still passes). Run:

```
node --test --test-reporter=spec
```

from the dashboard directory using a compound command (cwd resets between Bash calls, so chain it):

```
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```

Expect the dashboard suite (`dashboard/validate.test.js` + `dashboard/server.test.js`) passing with `0 failures`.

- [ ] Step 7.3: Sanity-check the real CLI end to end (non-spawning paths only - hermetic). Run:

```
node bin/aidr.js --help
node bin/aidr.js --version
node bin/aidr.js doctor --help
```

Expect: `--help` prints the usage/command table and exits 0; `--version` prints the package name + version and exits 0; `doctor --help` spawns `watcher.js --doctor --help` (watcher's doctor path handles its own output). If `doctor --help` is undesirable to run live, skip it - the mapping is already proven by Task 1. Do NOT run `aidr run` or `aidr dashboard` in CI/verification (they perform real actions / bind a port).

- [ ] Step 7.4: Confirm `npm test` (the package script) passes as the CI gate sees it. Run:

```
npm test
```

Expect the same green result as Step 7.1 (the script is `node --test test/*.test.js dashboard/validate.test.js`).

- [ ] Step 7.5: Final commit (only if any incidental changes remain; otherwise skip). Run:

```
git status
```

If the working tree is clean, no commit is needed - Tasks 1-6 each committed their own work. If there are stray changes, review and commit:

```
git add -A
git commit -m "Finalize aidr CLI packaging: full suite green

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage:
- bin entry `aidr -> ./bin/aidr.js` in package.json: Task 4 (with guard test `test/package-bin.test.js`).
- Thin `bin/aidr.js` dispatcher mapping subcommands setup/run/preview/verify/dashboard/score/report/doctor to existing entrypoints: Task 3 (executable) backed by Task 1 (pure mapping). All eight subcommands are present in `COMMANDS` and asserted in `test/cli-map.test.js`.
- Mapping extracted into a testable function: `resolveCommand` in `lib/cli-map.js` (Task 1) - pure, no spawning, fully unit-tested.
- `install.sh` checks Node version, runs `npm ci`, runs `npx playwright install chromium`, prints next steps: Task 5 (with static checks in `test/install-script.test.js`).
- `aidr dashboard` boots `dashboard/server.js`, prints a localhost URL + generated creds once: Task 3 `spawnNode` dashboard branch; creds from `lib/dashboard-creds.js` (Task 2). It injects `AIDR_USER`/`AIDR_PASS` env which `dashboard/server.js` reads at lines 57-60.
- README quick-start updated + subcommand table + Electron/Tauri noted as follow-up (not built): Task 6.
- Cross-platform aware: `install.sh` uses POSIX/`bash`; the spawn target is `process.execPath` (the running Node), and `setup.js`/`lib/scheduler.js` already handle launchd/systemd/crontab/schtasks platform selection - `aidr setup` simply delegates to them.
- Integration/wiring task present: Task 4 wires the `bin` field into package.json (the npx-runnable contract) and is verified by a test.
- Final full-suite task present: Task 7 runs `node --test test/*.test.js dashboard/validate.test.js`, the dashboard suite via `cd dashboard && node --test`, and `npm test`.

Signature/API consistency with the real repo (verified by reading the files):
- `dashboard/server.js` reads `process.env.AIDR_PORT` (line 52, default 8080), `AIDR_HOST` (line 53, default `127.0.0.1`), `AIDR_USER`/`AIDR_PASS` (lines 57-60). The dispatcher uses exactly these env var names and the same defaults for the printed URL.
- `watcher.js` flag parsing (lines 26-54): `--preview`, `--verify`, `--doctor`, `--serp-scan`, `--pending`, `--only`, `--skip`, `--dry-run` are all real `process.argv` booleans/value-flags. The chosen subcommand-to-flag mapping (`preview->--preview`, `verify->--verify`, `doctor->--doctor`, `score->--serp-scan`, `report->--pending`, `run-> no flag`) matches them and matches the dashboard's own `MODE_ARGS` (server.js lines 275-286).
- `setup.js` is invoked as `node setup.js` (its `package.json` script and `require.main === module` guard at line 221 both confirm it is a standalone entrypoint).
- Tests use `node:test` + `node:assert/strict` exactly as every existing test file does (e.g. `test/brokers-caldrop.test.js`, `dashboard/validate.test.js`). New test files match the `test/*.test.js` glob already in the root `test` script, so CI (`.github/workflows/test.yml`) picks them up with no workflow change.
- Hermetic guarantees: `test/cli-map.test.js` and `test/dashboard-creds.test.js` call pure functions only. `test/cli-bin-smoke.test.js` spawns the bin only on the `--help`/`--version`/unknown paths, which never spawn watcher.js, never touch the network, and never read/write `config.json`/`state.json`. `test/install-script.test.js` reads the script as text and never executes it. `test/package-bin.test.js` only reads files. No test mutates real `config.json`/`state.json`.

No placeholders: every code block (lib/cli-map.js, lib/dashboard-creds.js, bin/aidr.js, install.sh, all five test files, both package.json edits, the README block) is written out in full with real function bodies. No TBD, no "implement X", no ellipses.

No em dashes were authored in this plan (hyphens only), per repo convention. Existing source files retain their own punctuation and are not reformatted.

New dependencies: none. The implementation uses only Node built-ins (`child_process`, `crypto`, `path`, `process`, `fs`) and the already-present Playwright (installed by `install.sh`, not added to deps).
