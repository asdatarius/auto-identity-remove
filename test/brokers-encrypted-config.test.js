/**
 * test/brokers-encrypted-config.test.js
 *
 * brokers.js read the config with a bare `require('./config.json')`. After
 * `node watcher.js --encrypt-config` there is no config.json - the PII lives in
 * config.json.enc - so that require threw, the catch substituted
 * `{ person: {}, persons: [], email: {} }`, and every interpolated value went
 * empty. Measured on the real module: 107 formFields values, 0 non-empty, and
 * search URLs collapsed to "https://www.spokeo.com/search?q=&type=pp&state=".
 *
 * Turning on at-rest encryption therefore disabled the entire browser opt-out
 * path in silence. Every broker came back notFound and the run reported "not
 * listed", which a user would reasonably read as good news. The security
 * feature and the core feature were mutually exclusive, and nothing failed
 * loudly enough to notice.
 *
 * Loading through lib/config.js loadConfig() handles the encrypted envelope,
 * the plaintext file, and the envelope-shaped config.json equally.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const secrets = require('../lib/secrets');

const ALICE = {
  firstName: 'Alice', lastName: 'Anderson', fullName: 'Alice Anderson',
  email: 'alice@example.com', city: 'Oakland', state: 'CA', zip: '94601',
};
const PASSPHRASE = 'correct horse battery staple';

/**
 * Stand up an isolated copy of brokers.js plus the lib/ it needs, so CONFIG_PATH
 * resolves inside the sandbox instead of at the real repo root.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidr-enc-'));
  fs.copyFileSync(path.join(__dirname, '..', 'brokers.js'), path.join(dir, 'brokers.js'));
  // Copy all of lib/: config.js lazily requires siblings (./secrets, ./defunct),
  // and a partial copy would make the require fail and fall through to the
  // plaintext path, silently passing the test for the wrong reason.
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(dir, 'lib'), { recursive: true });
  return dir;
}

function loadBrokers(dir) {
  const modPath = path.join(dir, 'brokers.js');
  for (const p of Object.keys(require.cache)) {
    if (p.startsWith(dir)) delete require.cache[p];
  }
  const mod = require(modPath);
  delete require.cache[modPath];
  return mod;
}

function nonEmptyValues(brokers) {
  return brokers
    .flatMap(b => Object.values(b.formFields || {}))
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '');
}

test('an encrypted-only config still populates broker form fields', () => {
  const dir = sandbox();
  const envelope = secrets.encryptConfig({ person: ALICE }, PASSPHRASE);
  fs.writeFileSync(path.join(dir, 'config.json.enc'), JSON.stringify(envelope));
  // --encrypt-config removes the plaintext; reproduce that exactly.
  assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);

  const prev = process.env.AIDR_PASSPHRASE;
  process.env.AIDR_PASSPHRASE = PASSPHRASE;
  let brokers;
  try {
    brokers = loadBrokers(dir);
  } finally {
    if (prev === undefined) delete process.env.AIDR_PASSPHRASE;
    else process.env.AIDR_PASSPHRASE = prev;
  }

  const values = nonEmptyValues(brokers);
  assert.ok(
    values.length > 0,
    'encrypting the config must not blank every broker form field',
  );
  assert.ok(values.includes(ALICE.email), "the decrypted person's email should reach the form fields");
  assert.ok(values.includes(ALICE.fullName), "the decrypted person's name should reach the form fields");

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an encrypted-only config still populates search URLs', () => {
  const dir = sandbox();
  fs.writeFileSync(
    path.join(dir, 'config.json.enc'),
    JSON.stringify(secrets.encryptConfig({ person: ALICE }, PASSPHRASE)),
  );

  const prev = process.env.AIDR_PASSPHRASE;
  process.env.AIDR_PASSPHRASE = PASSPHRASE;
  let brokers;
  try { brokers = loadBrokers(dir); } finally {
    if (prev === undefined) delete process.env.AIDR_PASSPHRASE;
    else process.env.AIDR_PASSPHRASE = prev;
  }

  const urls = brokers.filter(b => b.searchUrl).map(b => b.searchUrl).join(' ');
  assert.ok(urls.includes('Alice') || urls.includes('alice'), 'search URLs must reference the decrypted person');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('an envelope-shaped config.json (in-place encryption) also works', () => {
  const dir = sandbox();
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(secrets.encryptConfig({ person: ALICE }, PASSPHRASE)),
  );

  const prev = process.env.AIDR_PASSPHRASE;
  process.env.AIDR_PASSPHRASE = PASSPHRASE;
  let brokers;
  try { brokers = loadBrokers(dir); } finally {
    if (prev === undefined) delete process.env.AIDR_PASSPHRASE;
    else process.env.AIDR_PASSPHRASE = prev;
  }

  assert.ok(nonEmptyValues(brokers).includes(ALICE.email));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a plaintext config.json still works unchanged', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ person: ALICE }));
  const brokers = loadBrokers(dir);
  assert.ok(nonEmptyValues(brokers).includes(ALICE.email));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no config at all still loads without throwing or exiting', () => {
  // loadConfig() calls process.exit(1) on a missing config; brokers.js must not
  // reach that path, or `require('./brokers')` would kill any tool that only
  // wants the broker metadata (setup, --list, the test suite itself).
  const dir = sandbox();
  let brokers;
  assert.doesNotThrow(() => { brokers = loadBrokers(dir); });
  assert.ok(Array.isArray(brokers) && brokers.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an encrypted config with no passphrase does not throw at require time', () => {
  // watcher.js surfaces the missing-passphrase error itself, loudly. Requiring
  // brokers.js must not be the thing that explodes.
  const dir = sandbox();
  fs.writeFileSync(
    path.join(dir, 'config.json.enc'),
    JSON.stringify(secrets.encryptConfig({ person: ALICE }, PASSPHRASE)),
  );
  const prev = process.env.AIDR_PASSPHRASE;
  delete process.env.AIDR_PASSPHRASE;
  try {
    assert.doesNotThrow(() => loadBrokers(dir));
  } finally {
    if (prev !== undefined) process.env.AIDR_PASSPHRASE = prev;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
