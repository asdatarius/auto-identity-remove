/**
 * test/setup-encrypted-rerun.test.js
 *
 * Found by the cross-model review of this change set (P1 #4).
 *
 * setup.js reads its "keep current values" defaults with a raw
 * `fs.existsSync(CONFIG_PATH)` + `JSON.parse(fs.readFileSync(CONFIG_PATH))`.
 * After `--encrypt-config` there is no config.json - the PII lives in
 * config.json.enc - so re-running setup on an encrypted install:
 *
 *   1. shows blank prompts, as though the user had never configured anything;
 *   2. writes a fresh **plaintext** config.json next to the still-active
 *      config.json.enc; and
 *   3. has no effect at runtime anyway, because loadConfig() prefers the .enc
 *      file.
 *
 * So the user's full PII lands back on disk in the clear, they lose their
 * existing values, and the edit they just made is silently ignored. Identical
 * defect class to the dashboard `PUT /api/config` plaintext spill fixed earlier
 * in this change set - which is the tell that the first fix should have prompted
 * a search for siblings.
 *
 * setup.js is an interactive wizard, so these are checks on the helper it uses
 * to read existing config plus a static check on the guard.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/secrets');
const { readExistingConfig } = require('../setup');

const ALICE = {
  firstName: 'Alice', lastName: 'Anderson', fullName: 'Alice Anderson',
  email: 'alice@example.com', city: 'Oakland', state: 'CA', zip: '94601',
};
const PASSPHRASE = 'a-real-passphrase';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-'));
}

test('readExistingConfig is exported so the encrypted path is testable', () => {
  assert.equal(typeof readExistingConfig, 'function');
});

test('a plaintext config is read as before', () => {
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ person: ALICE }));

  const r = readExistingConfig({ configPath, encPath: path.join(dir, 'config.json.enc') });
  assert.equal(r.encrypted, false);
  assert.deepEqual(r.config.person, ALICE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an encrypted config is decrypted, so existing values are offered as defaults', () => {
  const dir = tmpdir();
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig({ person: ALICE }, PASSPHRASE)));

  const r = readExistingConfig({ configPath: path.join(dir, 'config.json'), encPath, passphrase: PASSPHRASE });
  assert.equal(r.encrypted, true);
  assert.deepEqual(
    r.config.person,
    ALICE,
    're-running setup on an encrypted install must not present blank prompts',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an encrypted config with no passphrase reports it rather than silently emptying', () => {
  const dir = tmpdir();
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig({ person: ALICE }, PASSPHRASE)));

  const r = readExistingConfig({ configPath: path.join(dir, 'config.json'), encPath, passphrase: '' });
  assert.equal(r.encrypted, true, 'the encrypted install must still be detected');
  assert.equal(r.locked, true, 'and flagged as unreadable so the caller can refuse to overwrite it');
  assert.deepEqual(r.config, {}, 'no values are available without the passphrase');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no config at all reports absent', () => {
  const dir = tmpdir();
  const r = readExistingConfig({
    configPath: path.join(dir, 'config.json'),
    encPath: path.join(dir, 'config.json.enc'),
  });
  assert.equal(r.exists, false);
  assert.equal(r.encrypted, false);
  assert.deepEqual(r.config, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an envelope-shaped config.json is treated as encrypted, not as plaintext', () => {
  // In-place encryption leaves the envelope in config.json itself. Parsing that
  // as a normal config would offer the ciphertext fields as "current values".
  const dir = tmpdir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(secrets.encryptConfig({ person: ALICE }, PASSPHRASE)));

  const r = readExistingConfig({ configPath, encPath: path.join(dir, 'config.json.enc'), passphrase: PASSPHRASE });
  assert.equal(r.encrypted, true);
  assert.deepEqual(r.config.person, ALICE);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setup.js refuses to write plaintext over an encrypted install', () => {
  // Static check: the write path must be guarded. Driving the whole interactive
  // wizard is not worth it, but an unguarded write here puts full PII back on
  // disk in the clear.
  const src = fs.readFileSync(path.join(__dirname, '..', 'setup.js'), 'utf8');
  assert.match(
    src,
    /readExistingConfig/,
    'setup.js must read config through readExistingConfig so the encrypted case is handled',
  );
  assert.doesNotMatch(
    src,
    /existing = JSON\.parse\(fs\.readFileSync\(CONFIG_PATH/,
    'setup.js must not parse CONFIG_PATH directly - that misses config.json.enc entirely',
  );
  assert.match(
    src,
    /locked/,
    'setup.js must act on the locked flag rather than overwriting an unreadable encrypted config',
  );
});
