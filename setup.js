#!/usr/bin/env node
/**
 * auto-identity-remove - interactive setup
 *
 * Run once: node setup.js
 *
 * Creates config.json from your answers and walks you through:
 *   • Personal info (name, address, email, phone)
 *   • CapSolver API key (for CAPTCHA-protected sites)
 *   • Accounts for sites that require login (one-time)
 *   • macOS launchd scheduling (1st of every month)
 *   • iMessage notification number
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const readline = require('readline');
const { execSync } = require('child_process');

const { installSchedule } = require('./lib/scheduler');
const { encryptConfigToDisk } = require('./lib/config');

// Honour the same AIDR_* overrides as lib/config.js - setup must write the
// config to wherever the watcher will actually read it.
const CONFIG_PATH = process.env.AIDR_CONFIG || path.join(__dirname, 'config.json');
const CONFIG_ENC_PATH = CONFIG_PATH + '.enc';
const STATE_PATH  = process.env.AIDR_STATE  || path.join(__dirname, 'state.json');

/**
 * Read the existing config so setup can offer current values as defaults.
 *
 * Must understand the encrypted layouts. Reading CONFIG_PATH directly meant that
 * on an install where `--encrypt-config` had moved the PII into config.json.enc,
 * setup saw nothing: it showed blank prompts, then wrote a fresh **plaintext**
 * config.json beside the still-active .enc file. Full PII back on disk in the
 * clear, the user's existing values lost, and no effect at runtime either since
 * loadConfig() prefers the .enc.
 *
 * @param {{ configPath?: string, encPath?: string, passphrase?: string }} [opts]
 * @returns {{ exists: boolean, encrypted: boolean, locked: boolean, config: object }}
 *   `locked` means an encrypted config exists but could not be decrypted (no or
 *   wrong passphrase). The caller must refuse to overwrite it rather than
 *   silently starting from scratch.
 */
function readExistingConfig(opts) {
  const o = opts || {};
  const configPath = o.configPath || CONFIG_PATH;
  const encPath = o.encPath || CONFIG_ENC_PATH;
  const passphrase = o.passphrase !== undefined ? o.passphrase : (process.env.AIDR_PASSPHRASE || '');
  const secrets = require('./lib/secrets');

  const decrypt = (envelope) => {
    if (!passphrase) return { exists: true, encrypted: true, locked: true, config: {} };
    try {
      return { exists: true, encrypted: true, locked: false, config: secrets.decryptConfig(envelope, passphrase) };
    } catch (_) {
      return { exists: true, encrypted: true, locked: true, config: {} };
    }
  };

  if (fs.existsSync(encPath)) {
    try {
      return decrypt(JSON.parse(fs.readFileSync(encPath, 'utf8')));
    } catch (_) {
      return { exists: true, encrypted: true, locked: true, config: {} };
    }
  }

  if (!fs.existsSync(configPath)) {
    return { exists: false, encrypted: false, locked: false, config: {} };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {
    return { exists: true, encrypted: false, locked: false, config: {} };
  }

  // In-place encryption leaves the envelope in config.json itself.
  if (secrets.isEncryptedEnvelope(parsed)) return decrypt(parsed);

  return { exists: true, encrypted: false, locked: false, config: parsed };
}

// ─── Prompt helper ────────────────────────────────────────────────────────────
// rl is created lazily inside main() so that requiring this module for its
// exported helpers (regionPrompts, formatPhone) does not open stdin.

let rl;
const ask = (q, def = '') => new Promise(resolve =>
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, ans => resolve(ans.trim() || def))
);
const askSecret = (q) => new Promise(resolve => {
  process.stdout.write(`${q}: `);
  process.stdin.setRawMode?.(true);
  let val = '';
  process.stdin.resume();
  process.stdin.once('data', d => {
    val = d.toString().trim();
    process.stdout.write('\n');
    process.stdin.setRawMode?.(false);
    resolve(val);
  });
});
const confirm = async (q) => {
  const ans = (await ask(`${q} (y/n)`, 'y')).toLowerCase();
  return ans === 'y' || ans === 'yes';
};

// ─── International helpers (pure, exported for unit tests) ───────────────────

/**
 * Return the correct prompt labels for region and postal fields based on country.
 * US uses "State (2-letter)" and "ZIP code"; all others use "Province/Region"
 * and "Postal code" (no format coercion).
 *
 * @param {string} country  2-letter ISO country code (upper-case)
 * @returns {{ regionLabel: string, postalLabel: string }}
 */
function regionPrompts(country) {
  if (country === 'US') {
    return { regionLabel: 'State (2-letter)', postalLabel: 'ZIP code' };
  }
  return { regionLabel: 'Province/Region', postalLabel: 'Postal code (any format, e.g. K1A 0A6)' };
}

/**
 * Format a phone number for display.
 * US 10-digit strings are formatted as (xxx) xxx-xxxx.
 * All other inputs (non-US country or non-10-digit) are returned verbatim.
 *
 * @param {string} phone    Raw phone string
 * @param {string} country  2-letter ISO country code (upper-case)
 * @returns {string}
 */
function formatPhone(phone, country) {
  if (country === 'US' && phone.length === 10) {
    return `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`;
  }
  return phone;
}

/**
 * If a non-empty passphrase is given, encrypt the plaintext config at configPath
 * into encPath (shredding the plaintext). Returns { encrypted: boolean }.
 * Pure aside from the file I/O it delegates to lib/config.encryptConfigToDisk.
 *
 * @param {{ passphrase: string, configPath?: string, encPath?: string }} opts
 */
function maybeEncryptConfig(opts) {
  const o = opts || {};
  const passphrase = o.passphrase || '';
  if (!passphrase) return { encrypted: false };
  const res = encryptConfigToDisk({
    passphrase,
    shred: true,
    ...(o.configPath ? { configPath: o.configPath } : {}),
    ...(o.encPath ? { encPath: o.encPath } : {}),
  });
  return { encrypted: true, encPath: res.encPath };
}

module.exports = { regionPrompts, formatPhone, maybeEncryptConfig, readExistingConfig };

// ─── Main setup ───────────────────────────────────────────────────────────────

async function main() {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\n🔒 auto-identity-remove - Setup\n');
  console.log('This will create config.json with your personal info (gitignored).');
  console.log('Run this once. Re-run anytime to update.\n');

  // Load existing config if present - including the encrypted layouts.
  const prior = readExistingConfig();
  if (prior.encrypted && prior.locked) {
    // Never overwrite an encrypted config we cannot read. Doing so would write
    // plaintext PII beside the .enc file, lose the user's existing values, and
    // have no runtime effect (loadConfig prefers the .enc).
    console.error('\n❌ An encrypted config exists (config.json.enc) but it could not be decrypted.');
    console.error('   Set the passphrase and re-run so your current values are preserved:\n');
    console.error('     AIDR_PASSPHRASE=... node setup.js\n');
    console.error('   Refusing to continue: writing a plaintext config.json here would put your');
    console.error('   full PII back on disk in the clear and would be ignored at runtime anyway.');
    process.exit(1);
  }
  const existing = prior.config;
  if (prior.exists) {
    console.log(prior.encrypted
      ? 'ℹ  Existing encrypted config found - press Enter to keep current values.\n'
      : 'ℹ  Existing config.json found - press Enter to keep current values.\n');
  }
  const p = existing.person || {};

  // ── Personal info ────────────────────────────────────────────────────────
  console.log('── Personal Info ──────────────────────────────────────────');
  const firstName      = await ask('First name',              p.firstName || '');
  const lastName       = await ask('Last name',               p.lastName  || '');
  const aliasInput     = await ask('Aliases (comma-separated, e.g. "Steve Doe, S Doe")', (p.aliases||[]).join(', '));
  const aliases        = aliasInput ? aliasInput.split(',').map(s => s.trim()).filter(Boolean) : [];
  const city           = await ask('City',                    p.city || '');
  const country        = (await ask('Country (2-letter ISO, e.g. US, CA, GB, AU)', p.country || 'US')).toUpperCase();
  const { regionLabel, postalLabel } = regionPrompts(country);
  const state          = await ask(regionLabel,               p.state || '');
  const zip            = await ask(postalLabel,               p.zip   || '');
  const email          = await ask('Email address',           p.email || '');
  const phone          = await ask('Phone (digits only for US; any format for non-US)', p.phone || '');
  const phoneFormatted = formatPhone(phone, country);

  // ── CapSolver ────────────────────────────────────────────────────────────
  console.log('\n── CAPTCHA Solving ────────────────────────────────────────');
  console.log('Some opt-out forms have CAPTCHAs. CapSolver (capsolver.com)');
  console.log('solves them automatically for ~$0.001 each - pennies per month.');
  console.log('Sign up free at https://capsolver.com and paste your API key below.');
  console.log('Leave blank to skip (those sites go to your manual list instead).\n');
  const capsolverKey = await ask('CapSolver API key', (existing.capsolver||{}).apiKey || '');

  // ── Notification ─────────────────────────────────────────────────────────
  console.log('\n── Notifications ──────────────────────────────────────────');
  const textTo = await ask('iMessage number to text results to (e.g. +15125550000)', (existing.notify||{}).textTo || '');
  // WP2: webhook works on any OS (ntfy.sh, Slack, Discord-style). Optional.
  const webhook = await ask('Notification webhook URL - works on any OS, optional (e.g. https://ntfy.sh/my-topic)', (existing.notify||{}).webhook || '');

  // ── Profile dir ──────────────────────────────────────────────────────────
  const defaultProfileDir = path.join(os.homedir(), '.config', 'auto-identity-remove');
  const profileDir = await ask('Browser profile directory', existing.profileDir || defaultProfileDir);

  // ── Accounts for sites that need login ───────────────────────────────────
  console.log('\n── One-Time Account Setup ─────────────────────────────────');
  console.log('A few high-priority sites require an account to opt out.');
  console.log('Create the accounts now (one-time) and paste credentials here.');
  console.log('They will be stored locally in config.json (gitignored).\n');

  const acctSites = [
    { key: 'spokeo',       url: 'https://www.spokeo.com/signup',       label: 'Spokeo'       },
    { key: 'beenverified', url: 'https://www.beenverified.com/signup', label: 'BeenVerified' },
    { key: 'mylife',       url: 'https://www.mylife.com/signup',       label: 'MyLife'       },
  ];

  const accounts = existing.accounts || {};
  for (const site of acctSites) {
    const hasExisting = accounts[site.key]?.password;
    if (hasExisting) {
      const update = await confirm(`  ${site.label} - account already stored. Update?`);
      if (!update) continue;
    } else {
      const doSetup = await confirm(`  Set up ${site.label} account? (${site.url})`);
      if (!doSetup) {
        accounts[site.key] = { email: email, password: '' };
        continue;
      }
      console.log(`  → Opening ${site.url} in your browser…`);
      try { execSync(`open "${site.url}"`); } catch(_) {}
      console.log('  Create the account, then come back here.\n');
      await ask('  Press Enter when done');
    }
    const acctEmail = await ask(`  ${site.label} login email`, email);
    const acctPass  = await ask(`  ${site.label} password`);
    accounts[site.key] = { email: acctEmail, password: acctPass };
    console.log(`  ✓ ${site.label} credentials saved.\n`);
  }

  // ── Build config ─────────────────────────────────────────────────────────
  const config = {
    person: {
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      aliases,
      city,
      country,
      state,
      zip,
      email,
      phone,
      phoneFormatted,
    },
    capsolver: { apiKey: capsolverKey || 'CAP-YOUR_KEY_HERE' },
    accounts,
    notify: { textTo, ...(webhook ? { webhook } : {}) },
    profileDir,
  };

  // 0600: config.json holds the legal name, home address, phone, DOB, the SMTP
  // password and every API key. The umask default (0644) makes all of that
  // readable by any other local account.
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log('\n✅ config.json saved.\n');

  // -- At-rest encryption ------------------------------------------------------
  //
  // If the install was already encrypted, re-encrypt without asking. Leaving the
  // freshly written plaintext config.json in place would silently downgrade a
  // user who had deliberately turned encryption on, and loadConfig() would keep
  // reading the stale .enc so the edit above would not take effect either.
  if (prior.encrypted && !prior.locked) {
    const encResult = maybeEncryptConfig({ passphrase: process.env.AIDR_PASSPHRASE || '' });
    if (encResult.encrypted) {
      console.log(`🔒 Re-encrypted to ${encResult.encPath}; plaintext shredded.\n`);
    } else {
      console.error('⚠  Could not re-encrypt the config. config.json is currently PLAINTEXT.');
      console.error('   Fix it now with: AIDR_PASSPHRASE=... node watcher.js --encrypt-config\n');
    }
  } else {
    console.log('-- Encrypt config at rest? ----------------------------------------');
    console.log('Your config holds PII, the CapSolver key, and (optionally) an SMTP');
    console.log('password. You can encrypt it with AES-256-GCM. You will then need to');
    console.log('set AIDR_PASSPHRASE in the environment when running the watcher.\n');
    const doEncrypt = await confirm('Encrypt config.json now?');
    if (doEncrypt) {
      const passphrase = await askSecret('Choose a passphrase (keep it safe - there is no recovery)');
      if (passphrase) {
        const encResult = maybeEncryptConfig({ passphrase });
        if (encResult.encrypted) {
          console.log(`\nconfig encrypted to ${encResult.encPath}; plaintext shredded.`);
          console.log('   Run the watcher with: AIDR_PASSPHRASE=... node watcher.js\n');
        }
      } else {
        console.log('  No passphrase entered - leaving config in plaintext.\n');
      }
    }
  }

  // Initialize state.json if not present
  if (!fs.existsSync(STATE_PATH)) {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ optOuts: {}, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    console.log('✅ state.json initialized (tracks opt-out history).\n');
  }

  // ── Cross-platform scheduling ─────────────────────────────────────────────
  console.log('── Monthly Schedule ────────────────────────────────────────');
  const doSchedule = await confirm('Schedule to run automatically on the 1st of every month at 9am?');
  if (doSchedule) {
    const scriptPath = path.join(__dirname, 'run.sh');
    const logDir     = path.join(__dirname, 'logs');
    const result = installSchedule({ scriptPath, logDir });
    console.log(`✅ [${result.method}] ${result.detail}\n`);
  }

  rl.close();

  console.log('─'.repeat(54));
  console.log('✅ Setup complete!\n');
  console.log('  Run now:      node watcher.js');
  console.log('  Manual run:   ./run.sh');
  console.log('  Check state:  cat state.json\n');
  console.log('Your personal info lives only in config.json (gitignored).');
  console.log('─'.repeat(54) + '\n');
}

if (require.main === module) {
  main().catch(err => {
    console.error('Setup error:', err.message);
    process.exit(1);
  });
}
