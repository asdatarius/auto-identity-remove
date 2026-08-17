/**
 * test/file-permissions.test.js
 *
 * config.json holds a legal name, home address, phone, date of birth, the SMTP
 * password and every API key. state.json holds the full per-broker submission
 * history. Both were created with the process umask, which on a default Linux or
 * macOS box means 0644 - readable by every local account.
 *
 * That is a nothing-burger on a single-user laptop and a real exposure on the
 * machines this tool is being asked to run on: a Synology NAS with family
 * accounts, a shared VPS, a box with a media server or a *arr container running
 * as a different uid. The dashboard already writes its own files 0600; the
 * primary PII files did not.
 *
 * 0600 is the correct mode for all of them: only the owner runs this tool.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SKIP_ON_WINDOWS = process.platform === 'win32';

function modeOf(p) {
  // Low 9 bits: owner/group/other rwx.
  return fs.statSync(p).mode & 0o777;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-perm-'));
}

test('OWNER_ONLY is exported as 0600', () => {
  const { OWNER_ONLY } = require('../lib/config');
  assert.equal(OWNER_ONLY, 0o600);
});

test('saveState writes state.json owner-readable only', { skip: SKIP_ON_WINDOWS }, () => {
  const cfg = require('../lib/config');
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');

  cfg.setTestStatePath(target);
  try {
    cfg.resetState();
    cfg.recordSuccess('ExampleBroker', 'submitted');
    cfg.saveState();
  } finally {
    cfg.setTestStatePath(null);
  }

  assert.equal(
    modeOf(target),
    0o600,
    `state.json is ${modeOf(target).toString(8)}; the broker submission history must not be world-readable`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saveState writes the .bak copy owner-readable only', { skip: SKIP_ON_WINDOWS }, () => {
  // The .bak holds exactly the same history as the primary; locking one down and
  // leaving the other open protects nothing.
  const cfg = require('../lib/config');
  const dir = tmpdir();
  const target = path.join(dir, 'state.json');

  cfg.setTestStatePath(target);
  try {
    cfg.resetState();
    cfg.recordSuccess('ExampleBroker', 'submitted');
    cfg.saveState();
    cfg.recordSuccess('SecondBroker', 'submitted');
    cfg.saveState();
  } finally {
    cfg.setTestStatePath(null);
  }

  const bak = target + '.bak';
  assert.ok(fs.existsSync(bak), 'precondition: a .bak should exist after two saves');
  assert.equal(modeOf(bak), 0o600, `state.json.bak is ${modeOf(bak).toString(8)}, expected 600`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the encrypted config envelope is written owner-readable only', { skip: SKIP_ON_WINDOWS }, () => {
  const cfg = require('../lib/config');
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify({ person: { firstName: 'Alice' } }));

  cfg.encryptConfigToDisk({ configPath, encPath, passphrase: 'a-test-passphrase' });

  assert.ok(fs.existsSync(encPath));
  assert.equal(modeOf(encPath), 0o600, `config.json.enc is ${modeOf(encPath).toString(8)}, expected 600`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the decrypted config is written owner-readable only', { skip: SKIP_ON_WINDOWS }, () => {
  // --decrypt-config puts full plaintext PII back on disk. That is exactly the
  // file that must not be 0644.
  const cfg = require('../lib/config');
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify({ person: { firstName: 'Alice' } }));
  cfg.encryptConfigToDisk({ configPath, encPath, passphrase: 'a-test-passphrase' });
  fs.rmSync(configPath, { force: true });

  cfg.decryptConfigToDisk({ configPath, encPath, passphrase: 'a-test-passphrase' });

  assert.ok(fs.existsSync(configPath));
  assert.equal(modeOf(configPath), 0o600, `config.json is ${modeOf(configPath).toString(8)}, expected 600`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setup.js writes config.json owner-readable only', () => {
  // Static check: setup.js is an interactive prompt flow, so assert the write
  // call itself carries the mode rather than driving the whole wizard.
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup.js'), 'utf8');
  const writes = src
    .split('\n')
    .filter(l => /fs\.writeFileSync\(\s*(CONFIG_PATH|STATE_PATH)\b/.test(l));
  assert.ok(writes.length > 0, 'precondition: setup.js writes CONFIG_PATH/STATE_PATH');
  for (const line of writes) {
    assert.match(
      line,
      /mode:\s*(0o600|OWNER_ONLY)/,
      `setup.js writes PII without an explicit owner-only mode: ${line.trim().slice(0, 100)}`,
    );
  }
});
