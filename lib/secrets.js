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
