/**
 * lib/relay.js
 *
 * Masked-email relay integration.
 *
 * When config.relay = { provider: 'simplelogin', apiKey } is set, opt-out
 * submissions use a per-person masked alias instead of the person's real
 * email address, so brokers never receive a fresh real address. The alias is
 * created once per person and cached in state.relayAliases[personKey] so a new
 * alias is not minted on every run.
 *
 * getSubmissionEmail is a pure provider-decision function: the only side effect
 * (creating an alias) is injected via createImpl, which defaults to the real
 * SimpleLogin API call. When no relay is configured it returns person.email
 * unchanged (fully backward compatible).
 *
 * Manual fallbacks (Apple Hide My Email, Firefox Relay) are documented in
 * docs/relay.md; they cannot be automated via API here, so users paste the
 * generated alias into config.person.email manually for those providers.
 */

'use strict';

const SIMPLELOGIN_ALIAS_URL = 'https://app.simplelogin.io/api/alias/custom/new';

// Providers supported via API automation. Apple Hide My Email and Firefox Relay
// are documented manual fallbacks (no public alias-creation API), so they are
// intentionally not listed here.
const RELAY_PROVIDERS = ['simplelogin'];

/**
 * Stable, case-insensitive cache key for a person. Prefers the email address
 * (already unique per person); falls back to first+last name when absent.
 *
 * @param {{ email?: string, firstName?: string, lastName?: string }} person
 * @returns {string}
 */
function personKey(person) {
  const email = (person && person.email) ? String(person.email).trim().toLowerCase() : '';
  if (email) return email;
  const first = (person && person.firstName) ? String(person.firstName).trim().toLowerCase() : '';
  const last = (person && person.lastName) ? String(person.lastName).trim().toLowerCase() : '';
  return `${first} ${last}`.trim();
}

/**
 * Create a custom alias via the SimpleLogin API.
 *
 * POST https://app.simplelogin.io/api/alias/custom/new
 * Header: Authentication: <apiKey>
 *
 * @param {object} args
 * @param {string} args.apiKey   - SimpleLogin API key
 * @param {string} args.note     - human-readable note stored on the alias
 * @param {function} [args.fetchImpl] - injected for testing; defaults to global fetch
 * @returns {Promise<string>} the created alias email address
 */
async function createSimpleLoginAlias({ apiKey, note, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(SIMPLELOGIN_ALIAS_URL, {
    method: 'POST',
    headers: {
      'Authentication': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ note }),
  });

  if (!res || !res.ok) {
    const status = res ? res.status : 'no-response';
    let detail = '';
    try {
      const j = await res.json();
      detail = j && j.error ? `: ${j.error}` : '';
    } catch (_) {}
    throw new Error(`SimpleLogin alias creation failed (HTTP ${status})${detail}`);
  }

  const data = await res.json();
  if (!data || !data.alias) {
    throw new Error('SimpleLogin alias creation failed: response missing "alias" field');
  }
  return data.alias;
}

/**
 * Default createImpl: routes to the configured provider's real alias creator.
 * Injected (and overridden) by tests.
 *
 * @param {object} args
 * @param {string} args.provider
 * @param {string} args.apiKey
 * @param {string} args.note
 * @returns {Promise<string>}
 */
async function defaultCreateImpl({ provider, apiKey, note }) {
  if (provider === 'simplelogin') {
    return createSimpleLoginAlias({ apiKey, note });
  }
  throw new Error(`Unsupported relay provider: ${provider}`);
}

/**
 * Resolve the email address to use when submitting an opt-out for `person`.
 *
 * - No config.relay, or no apiKey, or unsupported provider -> person.email.
 * - Relay configured -> a cached alias from state.relayAliases[personKey], or a
 *   freshly created one (via createImpl) cached for subsequent runs.
 *
 * Pure aside from the cache write and the injected createImpl call. On any
 * creation error it logs to console.error and falls back to person.email so a
 * relay outage never blocks the opt-out run.
 *
 * @param {object} args
 * @param {object} args.config       - full config object (reads config.relay)
 * @param {object} args.person       - person whose submission email we resolve
 * @param {object} [args.state]      - shared mutable state; alias cache stored under state.relayAliases
 * @param {function} [args.createImpl] - injected alias creator; defaults to defaultCreateImpl
 * @returns {Promise<string>}
 */
async function getSubmissionEmail({ config, person, state, createImpl }) {
  const relay = config && config.relay;
  const rawEmail = (person && person.email) || '';

  if (!relay || !relay.provider || !RELAY_PROVIDERS.includes(relay.provider) || !relay.apiKey) {
    return rawEmail;
  }

  const key = personKey(person);
  const store = state || {};
  if (!store.relayAliases) store.relayAliases = {};

  const cached = store.relayAliases[key];
  if (cached) return cached;

  const make = createImpl || defaultCreateImpl;
  try {
    const alias = await make({
      provider: relay.provider,
      apiKey: relay.apiKey,
      note: `auto-identity-remove opt-out for ${person.fullName || key}`,
    });
    if (alias) {
      store.relayAliases[key] = alias;
      return alias;
    }
    return rawEmail;
  } catch (err) {
    console.error(`Relay alias creation failed, using real email: ${err.message}`);
    return rawEmail;
  }
}

module.exports = {
  getSubmissionEmail,
  personKey,
  createSimpleLoginAlias,
  defaultCreateImpl,
  RELAY_PROVIDERS,
  SIMPLELOGIN_ALIAS_URL,
};
