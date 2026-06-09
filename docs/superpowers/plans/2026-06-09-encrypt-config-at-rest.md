# Encrypt config.json at rest Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Encrypt the plaintext `config.json` (which holds PII, the CapSolver API key, and the SMTP password) at rest using a scrypt-derived key and AES-256-GCM, so neither the disk nor the web dashboard exposes secrets, while staying fully backward compatible with existing plaintext configs.

Architecture: A new pure module `lib/secrets.js` provides `encryptConfig(plainObj, passphrase)` / `decryptConfig(envelope, passphrase)` using only `node:crypto` (scryptSync + aes-256-gcm, with the GCM auth tag stored in the envelope for tamper detection). `lib/config.loadConfig()` becomes envelope-aware: it prefers `config.json.enc` (or a `config.json` whose JSON is an envelope), decrypts with the `AIDR_PASSPHRASE` env var, and falls back to plaintext with a one-time warning when no passphrase is set. Two new CLI flags in `watcher.js` (`--encrypt-config` / `--decrypt-config`) perform migration. The dashboard keeps working unchanged because it reads through the same `loadConfig` path (and reads `config.json` directly only in its own `readJsonMeta`, which we make envelope-aware too).

Tech Stack: Plain Node.js, CommonJS (`require` / `module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict`. Playwright is already present (not needed here). No new npm dependencies - `node:crypto`, `node:fs`, `node:path`, `node:os` only.

New dependencies: NONE.

---

## File map

| File | Status | Responsibility |
|------|--------|----------------|
| `lib/secrets.js` | Created | Pure crypto: `encryptConfig`, `decryptConfig`, `isEncryptedEnvelope`, scrypt + AES-256-GCM, tamper detection via auth tag. |
| `test/secrets.test.js` | Created | Round-trip fidelity, wrong-passphrase rejection, tamper detection (flip ciphertext / tag / iv byte), envelope-shape detection, error cases. |
| `lib/config.js` | Modified | New consts `CONFIG_ENC_PATH`, `PASSPHRASE_ENV`; envelope-aware `loadConfig()`; new exports `CONFIG_ENC_PATH`, `getPassphrase`, `encryptConfigToDisk`, `decryptConfigToDisk`, `isConfigEncrypted`. Atomic writes preserved. |
| `test/config-encryption.test.js` | Created | Integration of `loadConfig` with encrypted/plaintext on disk via injected paths + env; migration helpers; warning-on-plaintext behavior. |
| `watcher.js` | Modified | New top-of-ladder `--encrypt-config` / `--decrypt-config` modes (read plaintext, write `config.json.enc`, optionally shred plaintext; and the reverse). |
| `test/watcher-encrypt-cli.test.js` | Created | Spawns `node watcher.js --encrypt-config`/`--decrypt-config` against a temp repo copy; asserts envelope written, plaintext shredded, round-trip back to plaintext. |
| `setup.js` | Modified | After writing `config.json`, optionally prompt to encrypt it (passphrase prompt via existing `askSecret`), calling `encryptConfigToDisk`. |
| `dashboard/server.js` | Modified | Make `readJsonMeta(CONFIG)` envelope-aware so `/api/config`, `/api/summary` decrypt with `AIDR_PASSPHRASE` when the on-disk config is an envelope. |
| `dashboard/server.test.js` | Modified (append) | Dashboard reads an encrypted config when `AIDR_PASSPHRASE` is set; still masks secrets. |
| `config.example.json` | Read-only reference | Shape reference for tests (do not modify). |

---

## Task 1: Pure crypto module `lib/secrets.js`

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/secrets.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/secrets.test.js`

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/secrets.test.js` with the complete contents below.

```js
/**
 * test/secrets.test.js
 *
 * Security-sensitive unit tests for lib/secrets.js (pure crypto, no I/O):
 *   - round-trip fidelity (encrypt -> decrypt returns deep-equal object)
 *   - wrong passphrase is rejected (GCM auth tag mismatch -> throws)
 *   - tamper detection: flipping a byte of ciphertext / tag / iv throws
 *   - envelope shape detection (isEncryptedEnvelope)
 *   - input validation (empty passphrase, non-object plain, bad envelope)
 *
 * All values are hex strings so the envelope is JSON-serializable.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const secrets = require('../lib/secrets');

const PLAIN = {
  person: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' },
  capsolver: { apiKey: 'CAP-SECRET-123' },
  email: { smtp: { host: 'smtp.example.com', port: 587, user: 'ada', pass: 'hunter2' } },
  notify: { textTo: '+15125550000' },
};
const PASS = 'correct horse battery staple';

function flipHexByte(hex, index) {
  // Flip the low nibble of the byte at `index` so the value is guaranteed different.
  const pos = index * 2;
  const orig = hex.slice(pos, pos + 2);
  const flipped = (parseInt(orig, 16) ^ 0x01).toString(16).padStart(2, '0');
  return hex.slice(0, pos) + flipped + hex.slice(pos + 2);
}

test('round-trip: decryptConfig(encryptConfig(x)) deep-equals x', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const out = secrets.decryptConfig(env, PASS);
  assert.deepEqual(out, PLAIN);
});

test('envelope has the documented v/salt/iv/tag/ciphertext fields as hex strings', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.equal(env.v, 1);
  for (const k of ['salt', 'iv', 'tag', 'ciphertext']) {
    assert.equal(typeof env[k], 'string', `${k} should be a string`);
    assert.match(env[k], /^[0-9a-f]+$/, `${k} should be lowercase hex`);
  }
  assert.equal(env.alg, 'aes-256-gcm');
  assert.equal(env.kdf, 'scrypt');
});

test('two encryptions of the same input use different salt + iv (non-deterministic)', () => {
  const a = secrets.encryptConfig(PLAIN, PASS);
  const b = secrets.encryptConfig(PLAIN, PASS);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test('wrong passphrase throws (auth tag mismatch)', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.throws(() => secrets.decryptConfig(env, 'wrong passphrase'), /decrypt/i);
});

test('tamper: flipping a ciphertext byte throws', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const tampered = { ...env, ciphertext: flipHexByte(env.ciphertext, 0) };
  assert.throws(() => secrets.decryptConfig(tampered, PASS), /decrypt/i);
});

test('tamper: flipping an auth-tag byte throws', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const tampered = { ...env, tag: flipHexByte(env.tag, 0) };
  assert.throws(() => secrets.decryptConfig(tampered, PASS), /decrypt/i);
});

test('tamper: flipping an iv byte throws', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  const tampered = { ...env, iv: flipHexByte(env.iv, 0) };
  assert.throws(() => secrets.decryptConfig(tampered, PASS), /decrypt/i);
});

test('isEncryptedEnvelope: true for a real envelope, false for a plaintext config', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.equal(secrets.isEncryptedEnvelope(env), true);
  assert.equal(secrets.isEncryptedEnvelope(PLAIN), false);
  assert.equal(secrets.isEncryptedEnvelope(null), false);
  assert.equal(secrets.isEncryptedEnvelope('string'), false);
  assert.equal(secrets.isEncryptedEnvelope({ v: 1 }), false);
});

test('encryptConfig rejects an empty passphrase', () => {
  assert.throws(() => secrets.encryptConfig(PLAIN, ''), /passphrase/i);
});

test('decryptConfig rejects an empty passphrase', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.throws(() => secrets.decryptConfig(env, ''), /passphrase/i);
});

test('encryptConfig rejects a non-object plain value', () => {
  assert.throws(() => secrets.encryptConfig('not-an-object', PASS), /object/i);
  assert.throws(() => secrets.encryptConfig(null, PASS), /object/i);
});

test('decryptConfig rejects a value that is not an envelope', () => {
  assert.throws(() => secrets.decryptConfig({ foo: 'bar' }, PASS), /envelope/i);
});

test('decryptConfig rejects an unsupported envelope version', () => {
  const env = secrets.encryptConfig(PLAIN, PASS);
  assert.throws(() => secrets.decryptConfig({ ...env, v: 99 }, PASS), /version/i);
});
```

- [ ] Step 1.2: Run it, expect fail. Run `node --test test/secrets.test.js` from the repo root. Expected failure: `Cannot find module '../lib/secrets'` (the module does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/secrets.js` with the complete contents below.

```js
/**
 * lib/secrets.js
 *
 * Pure crypto for encrypting config.json at rest. No file I/O lives here so
 * the functions are trivially unit-testable.
 *
 * Scheme:
 *   - Key derivation: scrypt (crypto.scryptSync) over the UTF-8 passphrase and
 *     a per-encryption random 16-byte salt -> 32-byte key (AES-256).
 *   - Cipher: AES-256-GCM with a random 12-byte IV. The 16-byte GCM auth tag is
 *     stored in the envelope; decrypt verifies it, so any tampering with the
 *     ciphertext, IV, or tag (or a wrong passphrase) makes decrypt throw.
 *
 * Envelope shape (all binary fields are lowercase hex strings so the envelope
 * is plain JSON):
 *   { v: 1, alg: 'aes-256-gcm', kdf: 'scrypt',
 *     salt, iv, tag, ciphertext }
 */

'use strict';

const crypto = require('crypto');

const ENVELOPE_VERSION = 1;
const ALGO = 'aes-256-gcm';
const KDF = 'scrypt';
const SALT_BYTES = 16;
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256
const SCRYPT_COST = 16384; // N=2^14, the Node default; explicit for clarity
const SCRYPT_BLOCK = 8; // r
const SCRYPT_PARALLEL = 1; // p

function deriveKey(passphrase, saltBuf) {
  return crypto.scryptSync(passphrase, saltBuf, KEY_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
    maxmem: 64 * 1024 * 1024,
  });
}

/**
 * True iff `obj` looks like a v1 encryption envelope produced by encryptConfig.
 * @param {unknown} obj
 * @returns {boolean}
 */
function isEncryptedEnvelope(obj) {
  return !!(
    obj &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    obj.v === ENVELOPE_VERSION &&
    typeof obj.salt === 'string' &&
    typeof obj.iv === 'string' &&
    typeof obj.tag === 'string' &&
    typeof obj.ciphertext === 'string'
  );
}

/**
 * Encrypt a plain config object with a passphrase.
 * @param {object} plainObj  The config object (must be a non-null plain object).
 * @param {string} passphrase  Non-empty passphrase.
 * @returns {{v:number, alg:string, kdf:string, salt:string, iv:string, tag:string, ciphertext:string}}
 */
function encryptConfig(plainObj, passphrase) {
  if (!plainObj || typeof plainObj !== 'object' || Array.isArray(plainObj)) {
    throw new Error('encryptConfig: plainObj must be a non-null object');
  }
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('encryptConfig: passphrase must be a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(plainObj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    alg: ALGO,
    kdf: KDF,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Decrypt an envelope produced by encryptConfig back into the original object.
 * Throws if the envelope is malformed, the version is unsupported, the
 * passphrase is wrong, or any field has been tampered with.
 * @param {object} envelope
 * @param {string} passphrase
 * @returns {object}
 */
function decryptConfig(envelope, passphrase) {
  if (!passphrase || typeof passphrase !== 'string') {
    throw new Error('decryptConfig: passphrase must be a non-empty string');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('decryptConfig: envelope must be an object');
  }
  // Structural check first (independent of version) so a non-envelope object
  // reports an "envelope" error, while a well-shaped-but-future envelope reports
  // a "version" error. Order matters: the tests assert each message distinctly.
  const hasShape =
    typeof envelope.salt === 'string' &&
    typeof envelope.iv === 'string' &&
    typeof envelope.tag === 'string' &&
    typeof envelope.ciphertext === 'string';
  if (!hasShape) {
    throw new Error('decryptConfig: value is not a valid encryption envelope');
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`decryptConfig: unsupported envelope version ${envelope.v}`);
  }
  const salt = Buffer.from(envelope.salt, 'hex');
  const iv = Buffer.from(envelope.iv, 'hex');
  const tag = Buffer.from(envelope.tag, 'hex');
  const ciphertext = Buffer.from(envelope.ciphertext, 'hex');
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (_) {
    // GCM tag verification failed: wrong passphrase or tampered data.
    throw new Error('decryptConfig: failed to decrypt (wrong passphrase or tampered data)');
  }
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch (_) {
    throw new Error('decryptConfig: decrypted payload is not valid JSON');
  }
}

module.exports = {
  ENVELOPE_VERSION,
  encryptConfig,
  decryptConfig,
  isEncryptedEnvelope,
};
```

- [ ] Step 1.4: Run, expect pass. Run `node --test test/secrets.test.js`. Expected: all tests pass (13 passing, 0 failing).

- [ ] Step 1.5: Commit.
```
git add lib/secrets.js test/secrets.test.js
git commit -m "Add lib/secrets.js: AES-256-GCM config encryption with tamper detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Envelope-aware `loadConfig` + migration helpers in `lib/config.js`

This task makes `loadConfig()` decrypt an on-disk envelope and adds `encryptConfigToDisk` / `decryptConfigToDisk` / `getPassphrase` / `isConfigEncrypted`. To keep the helpers hermetic, they accept an injectable `{ configPath, encPath }` opts object (defaulting to the real `CONFIG_PATH` / `CONFIG_ENC_PATH`) and read the passphrase from `process.env.AIDR_PASSPHRASE` (overridable via opts).

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/config.js` (consts near lines 22-23; `loadConfig` lines 72-78; `module.exports` lines 329-355)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/config-encryption.test.js`

- [ ] Step 2.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/config-encryption.test.js` with the complete contents below. It uses real temp files (via `os.tmpdir()`) and injected paths so it never touches the repo's `config.json`.

```js
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
```

- [ ] Step 2.2: Run it, expect fail. Run `node --test test/config-encryption.test.js`. Expected failure: `TypeError: cfg.loadConfig is not a function`-style failures are NOT expected (loadConfig exists); instead the new opts-arg / helper assertions fail, e.g. `cfg.isConfigEncrypted is not a function` and `loadConfig` ignoring the injected `encPath`.

- [ ] Step 2.3: Implement. Make the edits below to `/Users/stephen/scripts/auto-identity-remove/lib/config.js`.

First, add the new constants and a `require` for secrets. Replace the existing block (lines 19-23):
```js
const path = require('path');
const fs   = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const STATE_PATH  = path.join(__dirname, '..', 'state.json');
```
with:
```js
const path = require('path');
const fs   = require('fs');

const secrets = require('./secrets');

const CONFIG_PATH     = path.join(__dirname, '..', 'config.json');
const CONFIG_ENC_PATH = path.join(__dirname, '..', 'config.json.enc');
const STATE_PATH      = path.join(__dirname, '..', 'state.json');

// Environment variable that supplies the passphrase for at-rest config encryption.
const PASSPHRASE_ENV = 'AIDR_PASSPHRASE';

// Resolve the active passphrase: explicit override wins, else the env var, else ''.
function getPassphrase(override) {
  if (override !== undefined && override !== null && override !== '') return override;
  return process.env[PASSPHRASE_ENV] || '';
}
```

Next, replace the existing `loadConfig` (lines 72-78):
```js
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ config.json not found. Run `node setup.js` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
```
with:
```js
// Returns the parsed config. Backward compatible:
//   - If config.json.enc exists, decrypt it with the passphrase (env or opts).
//   - Else if config.json's JSON is itself an envelope, decrypt that in place.
//   - Else treat config.json as plaintext (warns if a passphrase is set, since
//     the user likely intended encryption but the file is still in the clear).
// opts (all optional, used by tests + helpers): { configPath, encPath,
//   passphrase, _warn }. With no opts the real paths + AIDR_PASSPHRASE are used.
function loadConfig(opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;
  const encPath    = opts.encPath || CONFIG_ENC_PATH;
  const passphrase = getPassphrase(opts.passphrase);
  const warn       = opts._warn || ((m) => console.warn(m));

  if (fs.existsSync(encPath)) {
    if (!passphrase) {
      throw new Error(`Encrypted config found (${encPath}) but no passphrase. Set ${PASSPHRASE_ENV}.`);
    }
    const env = JSON.parse(fs.readFileSync(encPath, 'utf8'));
    return secrets.decryptConfig(env, passphrase);
  }

  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found. Run `node setup.js` first.');
    process.exit(1);
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (secrets.isEncryptedEnvelope(parsed)) {
    if (!passphrase) {
      throw new Error(`Encrypted config found (${configPath}) but no passphrase. Set ${PASSPHRASE_ENV}.`);
    }
    return secrets.decryptConfig(parsed, passphrase);
  }

  if (passphrase) {
    warn(`⚠ ${PASSPHRASE_ENV} is set but config is plaintext. Run \`node watcher.js --encrypt-config\` to encrypt it.`);
  }
  return parsed;
}

// True iff an encrypted config exists on disk (enc file, or an envelope-shaped config.json).
function isConfigEncrypted(opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;
  const encPath    = opts.encPath || CONFIG_ENC_PATH;
  if (fs.existsSync(encPath)) return true;
  if (!fs.existsSync(configPath)) return false;
  try {
    return secrets.isEncryptedEnvelope(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (_) {
    return false;
  }
}

// Atomic write of a JSON value: tmp -> rename (atomic on POSIX). Mirrors the
// strategy in saveState() so a kill mid-write never leaves a truncated file.
function writeJsonAtomic(target, value) {
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, target);
}

// Migration: read plaintext config, write an encrypted envelope to encPath.
// Optionally shred (delete) the plaintext afterward. Returns { encPath }.
function encryptConfigToDisk(opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;
  const encPath    = opts.encPath || CONFIG_ENC_PATH;
  const passphrase = getPassphrase(opts.passphrase);
  if (!passphrase) throw new Error(`No passphrase. Set ${PASSPHRASE_ENV} or pass one in.`);
  if (!fs.existsSync(configPath)) throw new Error(`Plaintext config not found: ${configPath}`);
  const plain = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (secrets.isEncryptedEnvelope(plain)) throw new Error('config.json is already encrypted');
  const envelope = secrets.encryptConfig(plain, passphrase);
  writeJsonAtomic(encPath, envelope);
  if (opts.shred) {
    fs.rmSync(configPath, { force: true });
  }
  return { encPath, shredded: !!opts.shred };
}

// Migration: read the encrypted envelope, write plaintext config.json.
// Optionally remove the envelope afterward. Returns { configPath }.
function decryptConfigToDisk(opts = {}) {
  const configPath = opts.configPath || CONFIG_PATH;
  const encPath    = opts.encPath || CONFIG_ENC_PATH;
  const passphrase = getPassphrase(opts.passphrase);
  if (!passphrase) throw new Error(`No passphrase. Set ${PASSPHRASE_ENV} or pass one in.`);
  let env;
  if (fs.existsSync(encPath)) {
    env = JSON.parse(fs.readFileSync(encPath, 'utf8'));
  } else if (fs.existsSync(configPath)) {
    env = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    throw new Error('No encrypted config found to decrypt');
  }
  const plain = secrets.decryptConfig(env, passphrase);
  writeJsonAtomic(configPath, plain);
  if (opts.removeEnc && fs.existsSync(encPath)) {
    fs.rmSync(encPath, { force: true });
  }
  return { configPath, removedEnc: !!opts.removeEnc };
}
```

Finally, extend `module.exports`. Replace the export object opening (lines 329-334):
```js
module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  RECHECK_DAYS,
  CONFIRM_RECHECK_DAYS,
  loadConfig,
```
with:
```js
module.exports = {
  CONFIG_PATH,
  CONFIG_ENC_PATH,
  PASSPHRASE_ENV,
  STATE_PATH,
  RECHECK_DAYS,
  CONFIRM_RECHECK_DAYS,
  loadConfig,
  getPassphrase,
  isConfigEncrypted,
  encryptConfigToDisk,
  decryptConfigToDisk,
```

- [ ] Step 2.4: Run, expect pass. Run `node --test test/config-encryption.test.js`. Expected: all tests pass. Then run `node --test test/config.test.js test/config-atomic-write.test.js test/config-pending-schema.test.js` to confirm the existing config tests still pass (the `loadConfig()` no-arg call path and all other exports are unchanged).

- [ ] Step 2.5: Commit.
```
git add lib/config.js test/config-encryption.test.js
git commit -m "config: envelope-aware loadConfig + encrypt/decrypt migration helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `--encrypt-config` / `--decrypt-config` CLI in `watcher.js`

These are migration modes. They must run BEFORE the main pipeline (which would itself try to `loadConfig` and could fail or prompt). Insert them at the very top of the mode-dispatch ladder, alongside `--list` / `--pending`, before any browser is launched.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js` (add flag parsing near lines 39-44; add a new dispatch block just before the `--list` block at line 56)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/watcher-encrypt-cli.test.js`

- [ ] Step 3.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/watcher-encrypt-cli.test.js` with the complete contents below. It copies only the files watcher needs into a temp dir, runs `node watcher.js --encrypt-config` there with `AIDR_PASSPHRASE` set, and asserts the migration. It is hermetic (temp dir, no network, no real config.json touched).

```js
/**
 * test/watcher-encrypt-cli.test.js
 *
 * End-to-end test of the --encrypt-config / --decrypt-config migration CLI.
 * Hermetic: runs in a temp copy of the repo's lib/ + watcher.js with a temp
 * config.json; never touches the repo's real config.json. AIDR_PASSPHRASE is
 * passed via the child env.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const PASS = 'cli-test-passphrase';
const PLAIN = { person: { firstName: 'Alan', lastName: 'Turing' }, capsolver: { apiKey: 'CAP-1' } };

// Build a minimal temp "repo" so the run is hermetic. watcher.js + lib/ resolve
// their paths from __dirname, so copying them into a temp dir (with a temp
// config.json) means the real repo's config.json/state.json are never touched.
// node_modules is symlinked so Playwright etc. resolve if any require touches them.
function buildTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-watcher-'));
  fs.copyFileSync(path.join(REPO, 'watcher.js'), path.join(dir, 'watcher.js'));
  // Copy the whole lib/ directory (watcher's requires resolve relative to dir).
  fs.cpSync(path.join(REPO, 'lib'), path.join(dir, 'lib'), { recursive: true });
  // brokers.js is required by some modes but NOT by --encrypt-config; copy it
  // anyway so any require at load time resolves.
  fs.copyFileSync(path.join(REPO, 'brokers.js'), path.join(dir, 'brokers.js'));
  // node_modules: symlink to the real one so playwright etc. resolve if touched.
  try {
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  } catch (_) { /* best effort; --encrypt-config does not require playwright */ }
  return dir;
}

function runWatcher(dir, args, env) {
  // timeout + HEADLESS guard: in the RED state the flags do not exist yet, so
  // watcher would fall through to main() and try to launch a real browser. The
  // timeout bounds that so the test suite can never hang; HEADLESS=1 keeps any
  // accidental launch off-screen.
  return execFileSync('node', ['watcher.js', ...args], {
    cwd: dir,
    env: { ...process.env, AIDR_PASSPHRASE: PASS, HEADLESS: '1', ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('--encrypt-config writes config.json.enc and shreds plaintext by default', () => {
  const dir = buildTempRepo();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(PLAIN, null, 2));

  runWatcher(dir, ['--encrypt-config']);

  const encPath = path.join(dir, 'config.json.enc');
  assert.ok(fs.existsSync(encPath), 'config.json.enc should be written');
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false, 'plaintext should be shredded');

  const secrets = require('../lib/secrets');
  const env = JSON.parse(fs.readFileSync(encPath, 'utf8'));
  assert.equal(secrets.isEncryptedEnvelope(env), true);
  assert.deepEqual(secrets.decryptConfig(env, PASS), PLAIN);
});

test('--encrypt-config --keep-plaintext keeps config.json', () => {
  const dir = buildTempRepo();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(PLAIN, null, 2));

  runWatcher(dir, ['--encrypt-config', '--keep-plaintext']);

  assert.ok(fs.existsSync(path.join(dir, 'config.json')), 'plaintext should be kept');
  assert.ok(fs.existsSync(path.join(dir, 'config.json.enc')), 'envelope should be written');
});

test('--decrypt-config restores plaintext config.json and removes the envelope', () => {
  const dir = buildTempRepo();
  const secrets = require('../lib/secrets');
  fs.writeFileSync(path.join(dir, 'config.json.enc'), JSON.stringify(secrets.encryptConfig(PLAIN, PASS)));

  runWatcher(dir, ['--decrypt-config']);

  const cfgPath = path.join(dir, 'config.json');
  assert.ok(fs.existsSync(cfgPath), 'config.json should be restored');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')), PLAIN);
  assert.equal(fs.existsSync(path.join(dir, 'config.json.enc')), false, 'envelope should be removed');
});

test('--encrypt-config without a passphrase exits non-zero', () => {
  const dir = buildTempRepo();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(PLAIN, null, 2));
  assert.throws(
    () => execFileSync('node', ['watcher.js', '--encrypt-config'], {
      cwd: dir,
      env: { ...process.env, AIDR_PASSPHRASE: '', HEADLESS: '1' },
      encoding: 'utf8',
      timeout: 30000,
    }),
    /Command failed/
  );
});
```

- [ ] Step 3.2: Run it, expect fail. Run `node --test test/watcher-encrypt-cli.test.js`. Expected failure: the first test fails because `config.json.enc` is never written (the flags do not exist yet, so watcher falls through to the main pipeline and errors out / hangs on browser launch, surfacing as a thrown `execFileSync` error or a missing-file assertion).

- [ ] Step 3.3: Implement. Make two edits to `/Users/stephen/scripts/auto-identity-remove/watcher.js`.

First, add flag parsing. After the existing line 44 (`const SNAPSHOT = process.argv.includes('--snapshot');`), insert:
```js

// ── Config-encryption migration flags (run before any pipeline work) ──────────
const ENCRYPT_CONFIG  = process.argv.includes('--encrypt-config');
const DECRYPT_CONFIG  = process.argv.includes('--decrypt-config');
const KEEP_PLAINTEXT  = process.argv.includes('--keep-plaintext');
```

Second, insert a new dispatch block immediately before the `--list` block. The `--list` block currently begins at line 56 with the comment `// ── --list: ...`. Insert this block directly above that comment:
```js
// ── --encrypt-config / --decrypt-config: at-rest encryption migration ─────────
if (ENCRYPT_CONFIG || DECRYPT_CONFIG) {
  const { encryptConfigToDisk, decryptConfigToDisk, getPassphrase, PASSPHRASE_ENV } = require('./lib/config');
  if (!getPassphrase()) {
    console.error(`❌ No passphrase. Set ${PASSPHRASE_ENV} (export ${PASSPHRASE_ENV}=...) and re-run.`);
    process.exit(1);
  }
  try {
    if (ENCRYPT_CONFIG) {
      const res = encryptConfigToDisk({ shred: !KEEP_PLAINTEXT });
      console.log(`\n🔒 Encrypted config written to ${res.encPath}`);
      console.log(res.shredded
        ? '   Plaintext config.json shredded.'
        : '   Plaintext config.json kept (--keep-plaintext).');
      console.log(`   Decrypt later with: node watcher.js --decrypt-config\n`);
    } else {
      const res = decryptConfigToDisk({ removeEnc: true });
      console.log(`\n🔓 Decrypted plaintext config written to ${res.configPath}`);
      console.log('   Encrypted config.json.enc removed.\n');
    }
    process.exit(0);
  } catch (err) {
    console.error(`❌ Config migration failed: ${err.message}`);
    process.exit(1);
  }
}

```

- [ ] Step 3.4: Run, expect pass. Run `node --test test/watcher-encrypt-cli.test.js`. Expected: all 4 tests pass.

- [ ] Step 3.5: Commit.
```
git add watcher.js test/watcher-encrypt-cli.test.js
git commit -m "watcher: add --encrypt-config / --decrypt-config migration flags

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Optional encryption prompt in `setup.js`

After `setup.js` writes the plaintext `config.json`, offer to encrypt it in place. To keep `setup.js` testable without driving stdin, extract a pure helper `maybeEncryptConfig({ passphrase, configPath, encPath })` and unit-test it; the interactive `main()` calls it after collecting a passphrase via the existing `askSecret`.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/setup.js` (add a require for config helpers near line 21; add `maybeEncryptConfig` to the exported helpers near line 84; call it in `main()` after the `config.json saved` log near lines 191-192)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/setup-encrypt.test.js`

- [ ] Step 4.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/setup-encrypt.test.js` with the complete contents below.

```js
/**
 * test/setup-encrypt.test.js
 *
 * Unit test for setup.js's pure maybeEncryptConfig helper. Hermetic: temp files
 * only. Verifies it encrypts a freshly-written plaintext config and shreds it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { maybeEncryptConfig } = require('../setup');
const secrets = require('../lib/secrets');

const PLAIN = { person: { firstName: 'Edsger', lastName: 'Dijkstra' }, capsolver: { apiKey: 'CAP-9' } };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-setup-'));
}

test('maybeEncryptConfig with a passphrase encrypts and shreds the plaintext', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN, null, 2));

  const res = maybeEncryptConfig({ passphrase: 'pw', configPath, encPath });

  assert.equal(res.encrypted, true);
  assert.ok(fs.existsSync(encPath));
  assert.equal(fs.existsSync(configPath), false);
  assert.deepEqual(secrets.decryptConfig(JSON.parse(fs.readFileSync(encPath, 'utf8')), 'pw'), PLAIN);
});

test('maybeEncryptConfig with an empty passphrase is a no-op (leaves plaintext)', () => {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  const encPath = path.join(dir, 'config.json.enc');
  fs.writeFileSync(configPath, JSON.stringify(PLAIN, null, 2));

  const res = maybeEncryptConfig({ passphrase: '', configPath, encPath });

  assert.equal(res.encrypted, false);
  assert.ok(fs.existsSync(configPath), 'plaintext should remain');
  assert.equal(fs.existsSync(encPath), false, 'no envelope should be written');
});
```

- [ ] Step 4.2: Run it, expect fail. Run `node --test test/setup-encrypt.test.js`. Expected failure: `TypeError: maybeEncryptConfig is not a function` (not yet exported from setup.js).

- [ ] Step 4.3: Implement. Make three edits to `/Users/stephen/scripts/auto-identity-remove/setup.js`.

First, add a require. After the existing line 21 (`const { installSchedule } = require('./lib/scheduler');`), insert:
```js
const { encryptConfigToDisk } = require('./lib/config');
```

Second, add the pure helper and export it. Replace the existing export line (line 84):
```js
module.exports = { regionPrompts, formatPhone };
```
with:
```js
/**
 * If a non-empty passphrase is given, encrypt the plaintext config at configPath
 * into encPath (shredding the plaintext). Returns { encrypted: boolean }.
 * Pure aside from the file I/O it delegates to lib/config.encryptConfigToDisk.
 *
 * @param {{ passphrase: string, configPath?: string, encPath?: string }} opts
 */
function maybeEncryptConfig(opts = {}) {
  const passphrase = opts.passphrase || '';
  if (!passphrase) return { encrypted: false };
  const res = encryptConfigToDisk({
    passphrase,
    shred: true,
    ...(opts.configPath ? { configPath: opts.configPath } : {}),
    ...(opts.encPath ? { encPath: opts.encPath } : {}),
  });
  return { encrypted: true, encPath: res.encPath };
}

module.exports = { regionPrompts, formatPhone, maybeEncryptConfig };
```

Third, call it from `main()` after the config-saved log. Replace lines 191-192:
```js
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('\n✅ config.json saved.\n');
```
with:
```js
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('\n✅ config.json saved.\n');

  // ── Optional at-rest encryption ────────────────────────────────────────────
  console.log('── Encrypt config at rest? ────────────────────────────────');
  console.log('Your config holds PII, the CapSolver key, and (optionally) an SMTP');
  console.log('password. You can encrypt it with AES-256-GCM. You will then need to');
  console.log(`set ${'AIDR_PASSPHRASE'} in the environment when running the watcher.\n`);
  const doEncrypt = await confirm('Encrypt config.json now?');
  if (doEncrypt) {
    const passphrase = await askSecret('Choose a passphrase (keep it safe - there is no recovery)');
    if (passphrase) {
      const { encrypted, encPath } = maybeEncryptConfig({ passphrase });
      if (encrypted) {
        console.log(`\n🔒 config encrypted to ${encPath}; plaintext shredded.`);
        console.log(`   Run the watcher with: ${'AIDR_PASSPHRASE'}=... node watcher.js\n`);
      }
    } else {
      console.log('  No passphrase entered - leaving config in plaintext.\n');
    }
  }
```

- [ ] Step 4.4: Run, expect pass. Run `node --test test/setup-encrypt.test.js`. Expected: both tests pass. Also run the existing setup tests to confirm the `regionPrompts`/`formatPhone` exports still work: `node --test test/*.test.js` is deferred to Task 6; for now run any setup-targeted test if present, e.g. `node --test $(ls test/setup*.test.js 2>/dev/null || echo test/setup-encrypt.test.js)`.

- [ ] Step 4.5: Commit.
```
git add setup.js test/setup-encrypt.test.js
git commit -m "setup: optional at-rest config encryption prompt + pure maybeEncryptConfig

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Dashboard reads encrypted config

The dashboard reads `config.json` directly via `readJsonMeta(CONFIG)` (used by `/api/config` and `/api/summary`). When the on-disk config is an envelope and `AIDR_PASSPHRASE` is set in the dashboard's env, it must decrypt before masking. We make `readJsonMeta` envelope-aware (decrypt-on-read) and prefer `config.json.enc` when present. Secret masking and the merge-write path are unchanged (the PUT path still writes plaintext `config.json`; encryption stays a deliberate migration via the CLI, so the dashboard never silently downgrades or re-encrypts).

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js` (constants near lines 46-50; `readJsonMeta` near lines 163-169)
- Test (append): `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js`

- [ ] Step 5.1: Inspect the existing dashboard test to match style. Run `rtk read dashboard/server.test.js` and note the import + supertest-free request style (it imports `app` from `./server` and uses Node's `http`/`fetch` against `app.listen`, or calls exported helpers directly). Then append the test below to `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js`. This test calls the exported `maskConfig` plus a NEW exported `readConfigMeta` helper (added in 5.3) directly, so it needs no live server and stays hermetic via temp paths.

```js
// ── At-rest config encryption (added for encrypt-config-at-rest) ──────────────
const _enc = require('node:fs');
const _encOs = require('node:os');
const _encPath = require('node:path');
const secrets = require('../lib/secrets');
const { readConfigMeta } = require('./server');

function _encTmpDir() {
  return _enc.mkdtempSync(_encPath.join(_encOs.tmpdir(), 'aidr-dash-'));
}

test('readConfigMeta returns plaintext config when config.json is plaintext', () => {
  const dir = _encTmpDir();
  const configPath = _encPath.join(dir, 'config.json');
  const encPath = _encPath.join(dir, 'config.json.enc');
  const plain = { person: { firstName: 'Katherine' }, capsolver: { apiKey: 'CAP-A' } };
  _enc.writeFileSync(configPath, JSON.stringify(plain));
  const m = readConfigMeta({ configPath, encPath, passphrase: '' });
  assert.equal(m.exists, true);
  assert.deepEqual(m.data, plain);
});

test('readConfigMeta decrypts config.json.enc when a passphrase is supplied', () => {
  const dir = _encTmpDir();
  const configPath = _encPath.join(dir, 'config.json');
  const encPath = _encPath.join(dir, 'config.json.enc');
  const plain = { person: { firstName: 'Katherine' }, capsolver: { apiKey: 'CAP-A' } };
  _enc.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(plain, 'pw')));
  const m = readConfigMeta({ configPath, encPath, passphrase: 'pw' });
  assert.equal(m.exists, true);
  assert.deepEqual(m.data, plain);
});

test('readConfigMeta flags parseError when an encrypted config has no passphrase', () => {
  const dir = _encTmpDir();
  const configPath = _encPath.join(dir, 'config.json');
  const encPath = _encPath.join(dir, 'config.json.enc');
  const plain = { person: { firstName: 'Katherine' } };
  _enc.writeFileSync(encPath, JSON.stringify(secrets.encryptConfig(plain, 'pw')));
  const m = readConfigMeta({ configPath, encPath, passphrase: '' });
  assert.equal(m.exists, true);
  assert.equal(m.parseError, true);
});

test('maskConfig still masks the capsolver key after decrypting', () => {
  const plain = { capsolver: { apiKey: 'CAP-SECRET' } };
  const masked = maskConfig(plain);
  assert.equal(masked.capsolver.apiKey, MASK);
});
```

Note: ensure the appended block does not redeclare `test`, `assert`, `maskConfig`, or `MASK` if the existing file already imports them at the top. If they are already in scope, drop the duplicate `require`/`const` lines from the snippet and keep only the `secrets` / `readConfigMeta` imports and the test bodies. (Read the top of the file first to confirm what is already imported.)

- [ ] Step 5.2: Run it, expect fail. Run from the dashboard directory: `node --test dashboard/server.test.js` (run as `cd dashboard && node --test server.test.js` or `node --test dashboard/server.test.js` from root). Expected failure: `readConfigMeta` is not exported (`undefined is not a function`).

- [ ] Step 5.3: Implement. Make two edits to `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js`.

First, add the encrypted-config path constant and a secrets require. After the existing constants block (lines 46-50, which define `ROOT`, `CONFIG`, `STATE`, `LOGS`, `BROKERS`), insert:
```js
const CONFIG_ENC = path.join(ROOT, 'config.json.enc');
const secrets = require('../lib/secrets');
const CONFIG_PASSPHRASE = process.env.AIDR_PASSPHRASE || '';
```

Second, add an envelope-aware reader and route the config reads through it. Replace the existing `readJsonMeta` (lines 162-169):
```js
// Distinguishes absent (exists:false) from present-but-unparseable (parseError:true).
function readJsonMeta(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { exists: false } : { exists: true, parseError: true }; }
  try { return { exists: true, data: JSON.parse(raw) }; }
  catch (_) { return { exists: true, parseError: true }; }
}
```
with:
```js
// Distinguishes absent (exists:false) from present-but-unparseable (parseError:true).
function readJsonMeta(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { exists: false } : { exists: true, parseError: true }; }
  try { return { exists: true, data: JSON.parse(raw) }; }
  catch (_) { return { exists: true, parseError: true }; }
}

// Envelope-aware config reader. Prefers config.json.enc, else config.json (which
// may itself be an envelope). Decrypts with the passphrase (AIDR_PASSPHRASE).
// On a missing/wrong passphrase for an encrypted config, returns parseError so
// the API surfaces a clear "could not read" instead of leaking ciphertext.
// opts (for tests): { configPath, encPath, passphrase }.
function readConfigMeta(opts = {}) {
  const configPath = opts.configPath || CONFIG;
  const encPath    = opts.encPath || CONFIG_ENC;
  const passphrase = opts.passphrase !== undefined ? opts.passphrase : CONFIG_PASSPHRASE;

  const tryDecrypt = (env) => {
    if (!passphrase) return { exists: true, parseError: true };
    try { return { exists: true, data: secrets.decryptConfig(env, passphrase) }; }
    catch (_) { return { exists: true, parseError: true }; }
  };

  if (fs.existsSync(encPath)) {
    let env;
    try { env = JSON.parse(fs.readFileSync(encPath, 'utf8')); }
    catch (_) { return { exists: true, parseError: true }; }
    return tryDecrypt(env);
  }
  const m = readJsonMeta(configPath);
  if (m.exists && m.data && secrets.isEncryptedEnvelope(m.data)) return tryDecrypt(m.data);
  return m;
}
```

Now route the two config reads through `readConfigMeta`. In `/api/config` (lines 363-374), change:
```js
app.get('/api/config', (_req, res) => {
  const m = readJsonMeta(CONFIG);
```
to:
```js
app.get('/api/config', (_req, res) => {
  const m = readConfigMeta();
```
And in `/api/summary` (line 336), change:
```js
  const cfg = readJsonMeta(CONFIG).data || null;
```
to:
```js
  const cfg = readConfigMeta().data || null;
```

Finally, export `readConfigMeta`. Change the module.exports line (line 514):
```js
module.exports = { app, loadBrokers, maskConfig, mergeConfig, loadCreds, MASK };
```
to:
```js
module.exports = { app, loadBrokers, maskConfig, mergeConfig, loadCreds, MASK, readConfigMeta };
```

Note on `/api/config`'s `parseError` branch: it already falls back to `config.example.json` and masks it, so an encrypted-config-without-passphrase request returns the example shape (no ciphertext leak) - the existing behavior is correct and unchanged.

- [ ] Step 5.4: Run, expect pass. Run `node --test dashboard/server.test.js` from the repo root (or `cd dashboard && node --test server.test.js`). Expected: the new tests pass and all pre-existing dashboard tests still pass.

- [ ] Step 5.5: Commit.
```
git add dashboard/server.js dashboard/server.test.js
git commit -m "dashboard: decrypt-on-read config via AIDR_PASSPHRASE, masking preserved

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Update .gitignore and run the full suite green

The encrypted file `config.json.enc` is also sensitive (it embeds the salt/iv/tag/ciphertext; while encrypted, there is no reason to commit it). Add it to `.gitignore`, then run the entire test suite (root + dashboard) to confirm nothing regressed.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/.gitignore`
- No new test file; this task is verification.

- [ ] Step 6.1: Add the ignore entry. Read the current ignore file first with `rtk read .gitignore`, then add `config.json.enc` near the existing `config.json` line. Use Edit to change:
```
config.json
```
to:
```
config.json
config.json.enc
```
(If `config.json` appears with surrounding context, match enough of it to be unique; the entry must be added exactly once.)

- [ ] Step 6.2: Run the full root suite. Run exactly the CI command from `package.json`:
```
node --test test/*.test.js dashboard/validate.test.js
```
Expected: all tests pass, including the four new files (`test/secrets.test.js`, `test/config-encryption.test.js`, `test/watcher-encrypt-cli.test.js`, `test/setup-encrypt.test.js`).

- [ ] Step 6.3: Run the dashboard suite. From the dashboard directory:
```
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```
Expected: all dashboard tests pass, including the appended `server.test.js` cases.

- [ ] Step 6.4: If anything fails, fix forward using superpowers:systematic-debugging (do not skip or weaken assertions). Re-run 6.2 and 6.3 until both are green. Confirm green by reading the final `# pass` / `# fail` summary lines printed by `node --test` (fail must be 0 in both suites).

- [ ] Step 6.5: Commit.
```
git add .gitignore
git commit -m "gitignore: ignore config.json.enc; full suite green for at-rest encryption

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage:
- Pure `encryptConfig(plainObj, passphrase)` returning `{v, salt, iv, tag, ciphertext}` (plus `alg`/`kdf` metadata) and `decryptConfig(envelope, passphrase)` returning the object: Task 1, `lib/secrets.js`. Uses `crypto.scryptSync` + `crypto.createCipheriv('aes-256-gcm', ...)` exactly as required; no new dependency.
- Unit-tested round-trip + tamper detection via the GCM auth tag: Task 1 covers round-trip deep-equal, wrong-passphrase rejection, and tamper on ciphertext / tag / iv (each flips one byte and asserts a throw), plus envelope-shape detection and input validation. All three security-sensitive cases the spec called out (wrong passphrase, tamper, round-trip) are present.
- `loadConfig()` detects an encrypted envelope (`config.json.enc` or a `{v,salt,iv,...}`-shaped `config.json`) and decrypts using `AIDR_PASSPHRASE` (env), with an opts override for tests: Task 2.
- Backward compatible: plaintext config still works with no passphrase; a warning fires when a passphrase is set but the file is plaintext: Task 2 (`loadConfig` plaintext branch + `_warn` test).
- Atomic writes preserved: `encryptConfigToDisk` / `decryptConfigToDisk` use a tmp->rename `writeJsonAtomic` mirroring `saveState`'s strategy; `saveState` itself is untouched.
- Migration commands `--encrypt-config` (writes `config.json.enc`, optionally shreds plaintext; `--keep-plaintext` to retain) and `--decrypt-config` (restores plaintext, removes envelope): Task 3, wired at the top of watcher's mode-dispatch ladder before any browser launch.
- Interactive passphrase prompt in `setup.js` via the existing `askSecret`, with a pure, unit-tested `maybeEncryptConfig` helper: Task 4.
- Dashboard keeps working when `AIDR_PASSPHRASE` is set: Task 5 routes `/api/config` and `/api/summary` through an envelope-aware `readConfigMeta`; secret masking via `maskConfig` is unchanged and still applies post-decrypt.
- Integration/wiring task: Task 3 (CLI flags in `watcher.js`) and Task 5 (dashboard endpoint reads). Final full-suite task: Task 6 runs both `node --test test/*.test.js dashboard/validate.test.js` and `cd dashboard && node --test`.

Signature consistency with the real repo (verified against the read files):
- `lib/config.js` existing exports are all retained; new exports added: `CONFIG_ENC_PATH`, `PASSPHRASE_ENV`, `getPassphrase`, `isConfigEncrypted`, `encryptConfigToDisk`, `decryptConfigToDisk`. `loadConfig` gains an optional opts arg (default `{}`), so existing zero-arg callers in `watcher.js` (`loadConfig()` at lines 108, 191) and `dashboard` are unaffected.
- `lib/secrets.js` is a new module; `setup.js` requires `encryptConfigToDisk` from `./lib/config` and exports `regionPrompts`, `formatPhone`, `maybeEncryptConfig` (existing two exports retained).
- `dashboard/server.js` retains all existing exports and adds `readConfigMeta`; `maskConfig`/`mergeConfig`/`loadCreds`/`MASK`/`app`/`loadBrokers` unchanged.
- Tests use `node:test` + `node:assert/strict`, factory-style temp dirs, no `beforeEach`, no real network or real `config.json`/`state.json` writes (all temp paths or injected opts; the watcher CLI test runs in a temp copy). The `Module._load` mock pattern is not needed here because every new seam is reachable via injectable opts args, which matches the repo's preferred DI style.

No placeholders: every code step contains complete, runnable code (full function bodies, full test files, exact `git` commands). No "TBD", no "add error handling", no "similar to above". No em dashes are used in authored prose (hyphens only); pre-existing em dashes inside copied source strings are left as-is per repo convention.
