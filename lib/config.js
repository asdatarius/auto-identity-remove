/**
 * lib/config.js
 *
 * Config + opt-out state management.
 *
 * `state` is a single shared mutable object for the lifetime of the process.
 * `recordSuccess` writes state.json via `saveState()`.
 *
 * Dry-run: call `setDryRun(true)` and `recordSuccess`/`saveState` become
 * no-op-on-disk (in-memory mutation still happens, harmless). This closes the
 * original bug where the notFound/email paths persisted state.json even though
 * `--dry-run` promised "no state will be saved".
 *
 * `resetState()` reloads state from disk *in place* so existing references
 * (e.g. watcher.js's `const state = loadState()`) stay valid — used by tests
 * and the upcoming --verify mode for isolation.
 */

const path = require('path');
const fs   = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const STATE_PATH  = path.join(__dirname, '..', 'state.json');

const RECHECK_DAYS = 90; // how often to re-submit to a broker

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('❌ config.json not found. Run `node setup.js` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// state.json tracks opt-out history so completed opt-outs aren't re-submitted
// every single run (brokers re-add data every ~90 days, so we re-check then).
let state = fs.existsSync(STATE_PATH)
  ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  : { optOuts: {} };

let dryRun = false;

function setDryRun(v) {
  dryRun = !!v;
}

function loadState() {
  return state;
}

// Reload state.json in place so existing references stay valid.
function resetState() {
  const fresh = fs.existsSync(STATE_PATH)
    ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    : { optOuts: {} };
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, fresh);
  return state;
}

function saveState() {
  if (dryRun) return; // dry-run promises no persisted state
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function lastOptOutDaysAgo(brokerName) {
  const entry = state.optOuts[brokerName];
  if (!entry?.lastSuccess) return Infinity;
  return (Date.now() - new Date(entry.lastSuccess).getTime()) / (1000 * 60 * 60 * 24);
}

function recordSuccess(brokerName, detail = '') {
  state.optOuts[brokerName] = {
    lastSuccess: new Date().toISOString(),
    totalRuns: ((state.optOuts[brokerName]?.totalRuns) || 0) + 1,
    detail,
  };
  saveState();
}

module.exports = {
  CONFIG_PATH,
  STATE_PATH,
  RECHECK_DAYS,
  loadConfig,
  loadState,
  resetState,
  setDryRun,
  saveState,
  lastOptOutDaysAgo,
  recordSuccess,
};
