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
