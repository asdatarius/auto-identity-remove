/**
 * dashboard/config-status.js
 *
 * Pure helper that decides whether config.json is "configured enough" for the
 * dashboard to skip the first-run wizard. Kept free of any express / fs / network
 * dependency so the logic can be unit-tested by the project's top-level
 * `node --test` run (which does not install the dashboard's express dependency).
 *
 * "Configured" mirrors the real usable-person contract enforced by
 * lib/config.js getPersonsFromConfig(): a non-empty persons[] takes precedence
 * over person, and a usable person must have firstName, lastName and email. The
 * unedited example placeholder (Jane Doe / jane.doe@example.com) is treated as
 * NOT configured so a fresh copy of config.example.json still triggers the wizard.
 */

'use strict';

// The minimum person fields the opt-out engine needs to act on someone.
const REQUIRED_PERSON_FIELDS = ['firstName', 'lastName', 'email'];

// The exact placeholder values shipped in config.example.json. If the saved
// config still carries these verbatim, the user has not really filled it in.
const PLACEHOLDERS = {
  firstName: 'Jane',
  lastName: 'Doe',
  email: 'jane.doe@example.com',
};

function nonEmpty(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// A field is "present" when it is a non-empty string AND not the example
// placeholder value for that field.
function fieldPresent(field, value) {
  if (!nonEmpty(value)) return false;
  if (PLACEHOLDERS[field] !== undefined && value.trim() === PLACEHOLDERS[field]) return false;
  return true;
}

// Pick the person the engine would act on: persons[0] when persons is a
// non-empty array (precedence), else person, else an empty object.
function effectivePerson(cfg) {
  const c = cfg || {};
  if (Array.isArray(c.persons)) {
    return c.persons.length > 0 ? (c.persons[0] || {}) : {};
  }
  return c.person || {};
}

/**
 * @param {object|null|undefined} cfg  Parsed config.json (or null when absent).
 * @returns {{ configured: boolean, missing: string[] }}
 *   `missing` lists dotted field paths (e.g. "person.firstName") that are blank
 *   or still placeholder. `configured` is true iff missing is empty.
 */
function configStatus(cfg) {
  const person = effectivePerson(cfg);
  const missing = [];
  for (const field of REQUIRED_PERSON_FIELDS) {
    if (!fieldPresent(field, person[field])) missing.push(`person.${field}`);
  }
  return { configured: missing.length === 0, missing };
}

module.exports = { configStatus, REQUIRED_PERSON_FIELDS };
