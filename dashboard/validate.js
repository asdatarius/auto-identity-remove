/**
 * dashboard/validate.js
 *
 * Pure request-validation helpers for the dashboard run endpoint. Kept free of
 * any express / child_process dependency so the security-critical logic can be
 * unit-tested by the project's top-level `node --test` run (which does not
 * install the dashboard's express dependency).
 *
 * Two protections live here, both added after a security review of the
 * dashboard PR:
 *
 *  1. Flag-injection guard for --only / --skip filter values. watcher.js detects
 *     several global modes with `process.argv.includes('--flag')`, scanning the
 *     WHOLE argv - including the value passed after --only/--skip. An unvalidated
 *     filter value like "--no-capsolver", "--serp-scan", "--snapshot" or
 *     "--resume" would therefore silently activate that mode. Filter values are
 *     comma-separated broker names; none can legitimately start with "-".
 *
 *  2. Server-side confirmation for "live" modes (real opt-out submission,
 *     retry-failed, snapshot, confirm-emails). These act on real broker sites
 *     with the user's PII, so they must not fire from a stray / forged / replayed
 *     request that merely names the mode - the caller must explicitly pass
 *     `confirm: true`. The browser UI sends this after its confirmation modal.
 */

'use strict';

// Modes that perform real, outward-facing actions (submit PII to brokers, click
// confirmation links, retry live submissions). These require explicit confirm.
const LIVE_MODES = new Set(['real', 'retry', 'snapshot', 'confirm']);

/**
 * Is the given run mode one that performs a real, irreversible action?
 * @param {string} mode
 * @returns {boolean}
 */
function isLiveMode(mode) {
  return LIVE_MODES.has(mode);
}

/**
 * Validate a single --only / --skip filter value.
 *
 * Filter values are a comma-separated list of broker names. No legitimate broker
 * name starts with "-", and allowing one lets the value be reinterpreted by
 * watcher.js as a global flag (argument injection).
 *
 * @param {*} value  Raw value from the request body (may be undefined).
 * @returns {{ ok: true, value: string|undefined } | { ok: false, error: string }}
 */
function validateFilter(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: undefined };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'filter must be a string' };
  }
  const tokens = value.split(',').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: true, value: undefined };
  }
  if (tokens.some(t => t.startsWith('-'))) {
    return { ok: false, error: 'filter values cannot start with "-" (flag injection blocked)' };
  }
  return { ok: true, value: tokens.join(',') };
}

/**
 * Validate a /api/run request body.
 *
 * @param {object} body          Parsed request body ({ mode, only, skip, confirm }).
 * @param {object} modeArgsMap   The MODE_ARGS allow-list ({ modeName: [...flags] }).
 * @returns {{ ok: true, mode: string, only: string|undefined, skip: string|undefined }
 *          | { ok: false, status: number, error: string }}
 */
function validateRunRequest(body, modeArgsMap) {
  const b = body || {};
  const mode = b.mode || 'preview';

  if (!Object.prototype.hasOwnProperty.call(modeArgsMap, mode)) {
    return { ok: false, status: 400, error: `unknown mode: ${mode}` };
  }

  if (isLiveMode(mode) && b.confirm !== true) {
    return {
      ok: false,
      status: 400,
      error: `mode "${mode}" performs a real action and requires "confirm": true`,
    };
  }

  const only = validateFilter(b.only);
  if (!only.ok) return { ok: false, status: 400, error: only.error };
  const skip = validateFilter(b.skip);
  if (!skip.ok) return { ok: false, status: 400, error: skip.error };

  return { ok: true, mode, only: only.value, skip: skip.value };
}

module.exports = { LIVE_MODES, isLiveMode, validateFilter, validateRunRequest };
