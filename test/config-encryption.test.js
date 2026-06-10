/**
 * test/config-encryption.test.js
 *
 * Integration of lib/config.js with at-rest encryption. Hermetic: all reads go
 * to temp files via injected { configPath, encPath } opts; the passphrase is
 * injected via opts (never relies on the ambient AIDR_PASSPHRASE env).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cfg = require('../lib/config');
const secrets = require('../lib/secrets');

const PLAIN = {
  person: { firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com' },
  capsolver: { apiKey: 'CAP-XYZ' },
};
const PASS = 'a-strong-passphrase';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-cfg-'));
}

// Run `fn` with AIDR_PASSPHRASE guaranteed unset, then restore it. Needed for
// the "no passphrase" assertions: passing passphrase:'' falls back to the env
// var (getPassphrase treats '' as "use the env"), so an ambient AIDR_PASSPHRASE
// in the shell/CI would otherwise make those tests non-hermetic.
function withoutEnvPassphrase(fn) {
  const prev = process.env.AIDR_PASSPHRASE;
  delete process.env.AIDR_PASSPHRASE;
  try { fn(); }
  finally {
    if (prev === undefined) delete process.env.AIDR_PASSPHRASE;
    else process.env.AIDR_PASSPHRASE = prev;
  }
}

test('loadConfig reads a plaintext config.json unchanged when no encrypted file exists', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));
  const out = cfg.loadConfig({ configPath, encPath });
  assert.deepEqual(out, PLAIN);
});

test('loadConfig decrypts config.json.enc using the supplied passphrase', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));
  const out = cfg.loadConfig({ configPath, encPath, passphrase: PASS });
  assert.deepEqual(out, PLAIN);
});

test('loadConfig decrypts a config.json whose JSON IS an envelope (in-place encryption)', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc'); // absent
  fs.writeFileSync(configPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));
  const out = cfg.loadConfig({ configPath, encPath, passphrase: PASS });
  assert.deepEqual(out, PLAIN);
});

test('loadConfig prefers config.json.enc over a plaintext config.json', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify({ person: { firstName: 'STALE' } }));
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));
  const out = cfg.loadConfig({ configPath, encPath, passphrase: PASS });
  assert.deepEqual(out, PLAIN);
});

test('loadConfig throws a clear error when an encrypted config has no passphrase', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));
  withoutEnvPassphrase(() => {
    assert.throws(
      () => cfg.loadConfig({ configPath, encPath, passphrase: '' }),
      /AIDR_PASSPHRASE/
    );
  });
});

test('loadConfig throws when the passphrase is wrong for an encrypted config', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));
  assert.throws(
    () => cfg.loadConfig({ configPath, encPath, passphrase: 'nope' }),
    /decrypt/i
  );
});

test('loadConfig warns once on plaintext when AIDR_PASSPHRASE is set but file is plaintext', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));
  const warnings = [];
  const out = cfg.loadConfig({ configPath, encPath, passphrase: PASS, _warn: m => warnings.push(m) });
  assert.deepEqual(out, PLAIN);
  assert.ok(warnings.some(w => /plaintext/i.test(w)), 'should warn about plaintext config');
});

test('isConfigEncrypted reflects which on-disk form exists', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));
  assert.equal(cfg.isConfigEncrypted({ configPath, encPath }), false);
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));
  assert.equal(cfg.isConfigEncrypted({ configPath, encPath }), true);
});

test('encryptConfigToDisk writes an envelope to encPath and can shred plaintext', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));

  const res = cfg.encryptConfigToDisk({ configPath, encPath, passphrase: PASS, shred: true });
  assert.equal(res.encPath, encPath);
  assert.ok(fs.existsSync(encPath), 'envelope file should exist');
  assert.equal(fs.existsSync(configPath), false, 'plaintext should be shredded');

  const env = JSON.parse(fs.readFileSync(encPath, 'utf8'));
  assert.equal(secrets.isEncryptedEnvelope(env), true);
  assert.deepEqual(secrets.decryptConfig(env, PASS), PLAIN);
});

test('encryptConfigToDisk without shred leaves the plaintext in place', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN));
  cfg.encryptConfigToDisk({ configPath, encPath, passphrase: PASS, shred: false });
  assert.ok(fs.existsSync(configPath), 'plaintext should remain when shred is false');
  assert.ok(fs.existsSync(encPath));
});

test('decryptConfigToDisk writes plaintext config.json and removes the envelope', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));

  const res = cfg.decryptConfigToDisk({ configPath, encPath, passphrase: PASS, removeEnc: true });
  assert.equal(res.configPath, configPath);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), PLAIN);
  assert.equal(fs.existsSync(encPath), false, 'envelope should be removed');
});

test('getPassphrase falls back to AIDR_PASSPHRASE env when no override is given', () => {
  const prev = process.env.AIDR_PASSPHRASE;
  process.env.AIDR_PASSPHRASE = 'from-env';
  try {
    assert.equal(cfg.getPassphrase(), 'from-env');
    assert.equal(cfg.getPassphrase('override'), 'override');
  } finally {
    if (prev === undefined) delete process.env.AIDR_PASSPHRASE;
    else process.env.AIDR_PASSPHRASE = prev;
  }
});
