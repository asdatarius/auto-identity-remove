# Masked-Email Relay Integration (SimpleLogin) Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Let users submit data-broker opt-outs from a masked/relay email address so the removal request never hands a broker a fresh real email address.

Architecture: A new pure module `lib/relay.js` exports `getSubmissionEmail({ config, person, createImpl })`. When `config.relay = { provider: 'simplelogin', apiKey }` is set, it returns a per-person cached alias (created once via the SimpleLogin REST API and stored in `state.relayAliases[personKey]`); when no relay is configured it returns `person.email` unchanged (fully backward compatible). The alias-creation side effect is isolated behind an injectable `createImpl` so the provider-decision logic stays pure and unit-testable. `lib/forms.js` and `lib/email.js` consume `getSubmissionEmail` instead of reading `person.email` directly. `watcher.js` resolves the submission email once per person and threads it through `brokerRunner.configure` and `sendOptOutEmails`.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), no TypeScript. Tests use `node:test` + `node:assert/strict`. Network calls use the Node 18+ global `fetch` (no new dependency). Playwright is already present. Tests mock `createImpl` and `fetch` and never touch the network or the real `config.json`/`state.json`.

New dependencies: NONE. (SimpleLogin is called via the global `fetch` shipped with Node >= 18, which `package.json` engines already require.)

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `/Users/stephen/scripts/auto-identity-remove/lib/relay.js` | Create | Pure provider-decision + cached alias resolution. Exports `getSubmissionEmail`, `personKey`, `createSimpleLoginAlias`, `RELAY_PROVIDERS`. |
| `/Users/stephen/scripts/auto-identity-remove/test/relay.test.js` | Create | Hermetic unit tests: no relay -> raw email; SimpleLogin alias creation via injected `createImpl`; per-person caching in `state.relayAliases`; `createSimpleLoginAlias` with injected `fetch`. |
| `/Users/stephen/scripts/auto-identity-remove/lib/forms.js` | Modify (lines 84-127) | `fillForm` accepts an optional `submissionEmail` and uses it for `input[name="email"]`/`input[type="email"]`-style fields instead of the raw value baked into `formFields`. |
| `/Users/stephen/scripts/auto-identity-remove/test/forms-relay.test.js` | Create | Hermetic test of the new `fillForm` email-override behavior using a stub Playwright `page`. |
| `/Users/stephen/scripts/auto-identity-remove/lib/email.js` | Modify (lines 115-203) | `_sendViaSMTP` and `sendOptOutEmails` accept a resolved `submissionEmail` so the GDPR/CCPA body and Reply-To use the masked address. |
| `/Users/stephen/scripts/auto-identity-remove/test/email-relay.test.js` | Create | Hermetic test that the masked address appears in the email body when relay is configured. |
| `/Users/stephen/scripts/auto-identity-remove/lib/broker-runner.js` | Modify (lines 23-46, 99-103) | Accept `submissionEmail` in `configure`/`opts`, pass it to `fillForm`. |
| `/Users/stephen/scripts/auto-identity-remove/test/broker-runner-relay.test.js` | Create | Hermetic `Module._load`-mocked test that `processBrokerWithPerson` forwards `opts.submissionEmail` to `fillForm`. |
| `/Users/stephen/scripts/auto-identity-remove/watcher.js` | Modify (lines 14-19, 364-377) | Resolve the submission email per person via `getSubmissionEmail` and thread it through `brokerRunner.configure` and `sendOptOutEmails`. |
| `/Users/stephen/scripts/auto-identity-remove/config.example.json` | Modify (after line 50) | Document the optional `relay` config block. |
| `/Users/stephen/scripts/auto-identity-remove/docs/relay.md` | Create | Document SimpleLogin setup plus manual fallbacks (Apple Hide My Email, Firefox Relay). |

---

## Task 1: Create `lib/relay.js` - pure provider decision + alias creation

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/relay.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/relay.test.js`

This is the core module. `getSubmissionEmail` is the pure decision function: given `config`, `person`, and an injectable `createImpl`, it returns either `person.email` (no relay) or a cached/created alias. `createSimpleLoginAlias` performs the real HTTP POST but takes an injectable `fetchImpl` so tests never hit the network.

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/relay.test.js` with this complete content:

```js
/**
 * test/relay.test.js
 *
 * Pure unit tests for lib/relay.js.
 * No live network. No real config.json / state.json.
 *
 * Tested behaviours:
 *  1. getSubmissionEmail - no relay configured -> returns person.email unchanged
 *  2. getSubmissionEmail - relay configured but no apiKey -> returns person.email
 *  3. getSubmissionEmail - relay configured -> calls createImpl, caches alias
 *  4. getSubmissionEmail - second call reuses cached alias (createImpl not called again)
 *  5. getSubmissionEmail - distinct persons get distinct cache slots
 *  6. personKey - stable, lowercased email-based key
 *  7. createSimpleLoginAlias - posts to the documented endpoint with Authentication header
 *  8. createSimpleLoginAlias - throws a useful error on non-ok response
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  getSubmissionEmail,
  personKey,
  createSimpleLoginAlias,
  RELAY_PROVIDERS,
} = require('../lib/relay');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PERSON_A = {
  firstName: 'Jane',
  lastName: 'Doe',
  fullName: 'Jane Doe',
  email: 'jane.doe@example.com',
};

const PERSON_B = {
  firstName: 'John',
  lastName: 'Smith',
  fullName: 'John Smith',
  email: 'john.smith@example.com',
};

function makeState() {
  return { optOuts: {} };
}

const RELAY_CFG = { relay: { provider: 'simplelogin', apiKey: 'sl-test-key' } };

// ── Tests ─────────────────────────────────────────────────────────────────────

test('no relay configured returns person.email unchanged', async () => {
  const state = makeState();
  let createCalls = 0;
  const createImpl = async () => { createCalls += 1; return 'should-not-be-used@aliases.test'; };

  const out = await getSubmissionEmail({ config: {}, person: PERSON_A, state, createImpl });

  assert.equal(out, 'jane.doe@example.com');
  assert.equal(createCalls, 0, 'createImpl must not be called when relay is absent');
  assert.equal(state.relayAliases, undefined, 'state must not be mutated when relay is absent');
});

test('relay configured but missing apiKey falls back to person.email', async () => {
  const state = makeState();
  let createCalls = 0;
  const createImpl = async () => { createCalls += 1; return 'x@aliases.test'; };

  const out = await getSubmissionEmail({
    config: { relay: { provider: 'simplelogin' } },
    person: PERSON_A,
    state,
    createImpl,
  });

  assert.equal(out, 'jane.doe@example.com');
  assert.equal(createCalls, 0, 'createImpl must not be called without an apiKey');
});

test('relay configured creates an alias via createImpl and caches it', async () => {
  const state = makeState();
  const createArgs = [];
  const createImpl = async (args) => { createArgs.push(args); return 'jane.alias@aliases.simplelogin.io'; };

  const out = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_A, state, createImpl });

  assert.equal(out, 'jane.alias@aliases.simplelogin.io');
  assert.equal(createArgs.length, 1, 'createImpl should be called exactly once');
  assert.equal(createArgs[0].apiKey, 'sl-test-key');
  assert.equal(createArgs[0].note.includes('Jane Doe'), true, 'note should reference the person');
  const key = personKey(PERSON_A);
  assert.equal(state.relayAliases[key], 'jane.alias@aliases.simplelogin.io');
});

test('second call reuses the cached alias without calling createImpl again', async () => {
  const state = makeState();
  let createCalls = 0;
  const createImpl = async () => { createCalls += 1; return 'cached@aliases.simplelogin.io'; };

  const first = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_A, state, createImpl });
  const second = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_A, state, createImpl });

  assert.equal(first, 'cached@aliases.simplelogin.io');
  assert.equal(second, 'cached@aliases.simplelogin.io');
  assert.equal(createCalls, 1, 'createImpl should run only on the first call');
});

test('distinct persons get distinct cached aliases', async () => {
  const state = makeState();
  const createImpl = async ({ note }) => (note.includes('Jane Doe') ? 'jane@a.io' : 'john@a.io');

  const a = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_A, state, createImpl });
  const b = await getSubmissionEmail({ config: RELAY_CFG, person: PERSON_B, state, createImpl });

  assert.equal(a, 'jane@a.io');
  assert.equal(b, 'john@a.io');
  assert.notEqual(personKey(PERSON_A), personKey(PERSON_B));
});

test('personKey is stable and case-insensitive on email', () => {
  const upper = personKey({ email: 'Jane.Doe@Example.com', firstName: 'Jane', lastName: 'Doe' });
  const lower = personKey({ email: 'jane.doe@example.com', firstName: 'Jane', lastName: 'Doe' });
  assert.equal(upper, lower);
});

test('RELAY_PROVIDERS lists simplelogin', () => {
  assert.equal(RELAY_PROVIDERS.includes('simplelogin'), true);
});

test('createSimpleLoginAlias posts to the documented endpoint with Authentication header', async () => {
  const fetchCalls = [];
  const fetchImpl = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 201,
      json: async () => ({ alias: 'generated.alias@aliases.simplelogin.io' }),
    };
  };

  const alias = await createSimpleLoginAlias({ apiKey: 'sl-test-key', note: 'opt-out for Jane Doe', fetchImpl });

  assert.equal(alias, 'generated.alias@aliases.simplelogin.io');
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://app.simplelogin.io/api/alias/custom/new');
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.equal(fetchCalls[0].init.headers.Authentication, 'sl-test-key');
  assert.equal(fetchCalls[0].init.headers['Content-Type'], 'application/json');
  const sentBody = JSON.parse(fetchCalls[0].init.body);
  assert.equal(sentBody.note, 'opt-out for Jane Doe');
});

test('createSimpleLoginAlias throws a useful error on a non-ok response', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Wrong api key' }),
  });

  await assert.rejects(
    () => createSimpleLoginAlias({ apiKey: 'bad', note: 'x', fetchImpl }),
    /SimpleLogin alias creation failed.*401/
  );
});
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test test/relay.test.js`. Expected failure: `Cannot find module '../lib/relay'` (the module does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/relay.js` with this complete content:

```js
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
    console.error(`⚠️  Relay alias creation failed, using real email: ${err.message}`);
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
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test test/relay.test.js`. Expect all tests pass (`# pass 9`, `# fail 0`). The "relay configured but missing apiKey" test exercises the early-return path; no test reaches the `getSubmissionEmail` catch branch, so no `console.error` line is printed (the error-path test injects a rejecting `fetchImpl` directly into `createSimpleLoginAlias`, which `assert.rejects` consumes).

- [ ] Step 1.5: Commit. Run:
```bash
git -C /Users/stephen/scripts/auto-identity-remove add lib/relay.js test/relay.test.js
git -C /Users/stephen/scripts/auto-identity-remove commit -m "Add lib/relay.js masked-email relay (SimpleLogin) with pure decision fn

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Thread submission email through `lib/forms.js` `fillForm`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/forms.js` (function `fillForm`, lines 84-127; `module.exports`, line 144)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/forms-relay.test.js`

`fillForm` currently writes the values baked into `broker.formFields` verbatim. We add an optional `submissionEmail`: when present, any field whose selector targets an email input gets the masked address instead of the value in the map. This is the single point where the real email would otherwise reach a broker form.

- [ ] Step 2.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/forms-relay.test.js` with this complete content:

```js
/**
 * test/forms-relay.test.js
 *
 * Verifies fillForm() substitutes a masked submissionEmail for email fields
 * while leaving non-email fields untouched. No real Playwright - a stub page
 * records every fill() call.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fillForm } = require('../lib/forms');

/**
 * Build a stub Playwright page whose locator() returns a visible text input
 * and records fill() values keyed by the selector used.
 */
function makeStubPage(fills) {
  return {
    locator(selector) {
      return {
        first() {
          return {
            async count() { return 1; },
            async isVisible() { return true; },
            async evaluate(fn) {
              // Emulate node.tagName / node.type lookups used by fillForm.
              const fakeNode = { tagName: 'INPUT', type: 'text' };
              return fn(fakeNode);
            },
            async fill(value) { fills.push({ selector, value }); },
            async selectOption() {},
            async check() {},
          };
        },
      };
    },
    getByLabel() {
      return { first() { return { async fill() {} }; } };
    },
  };
}

const PERSON = { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', email: 'jane.doe@example.com', country: 'US' };

test('fillForm uses submissionEmail for email selectors when provided', async () => {
  const fills = [];
  const page = makeStubPage(fills);
  const formFields = {
    'input[name="name"]': 'Jane Doe',
    'input[name="email"]': 'jane.doe@example.com',
  };

  await fillForm(page, formFields, PERSON, 'masked.alias@aliases.simplelogin.io');

  const emailFill = fills.find(f => f.selector === 'input[name="email"]');
  const nameFill = fills.find(f => f.selector === 'input[name="name"]');
  assert.equal(emailFill.value, 'masked.alias@aliases.simplelogin.io', 'email field should get the masked alias');
  assert.equal(nameFill.value, 'Jane Doe', 'non-email field must be untouched');
});

test('fillForm matches input[type="email"] selectors too', async () => {
  const fills = [];
  const page = makeStubPage(fills);
  const formFields = { 'input[type="email"]': 'jane.doe@example.com' };

  await fillForm(page, formFields, PERSON, 'masked@aliases.io');

  assert.equal(fills[0].value, 'masked@aliases.io');
});

test('fillForm without submissionEmail leaves email value unchanged (backward compatible)', async () => {
  const fills = [];
  const page = makeStubPage(fills);
  const formFields = { 'input[name="email"]': 'jane.doe@example.com' };

  await fillForm(page, formFields, PERSON);

  assert.equal(fills[0].value, 'jane.doe@example.com', 'no relay -> original email preserved');
});
```

- [ ] Step 2.2: Run it, expect fail. Command: `node --test test/forms-relay.test.js`. Expected failure: the first test fails its assertion `email field should get the masked alias` (current `fillForm` ignores any 4th argument, so `emailFill.value` is still `jane.doe@example.com`).

- [ ] Step 2.3: Implement. Edit `/Users/stephen/scripts/auto-identity-remove/lib/forms.js`. Replace the `fillForm` function (current lines 84-127, beginning with the JSDoc comment `/**\n * Fill every field...`) with this complete version:

```js
/**
 * Returns true when a CSS selector targets an email input field.
 * Matches name/id/placeholder substrings of "email" and type="email".
 * @param {string} selector
 * @returns {boolean}
 */
function isEmailSelector(selector) {
  return /type=["']?email|\bemail\b/i.test(selector || '');
}

/**
 * Fill every field in `formFields` on `page`. When `person` is provided,
 * applyRegionAliases() is called first so non-US province/postal selectors are
 * also attempted. For US users there is zero overhead - the map is returned as-is.
 *
 * When `submissionEmail` is provided, any field whose selector targets an email
 * input is filled with that masked/relay address instead of the value baked
 * into `formFields`. This keeps a real email address out of broker submissions.
 *
 * @param {import('playwright').Page} page
 * @param {Record<string,string>} formFields
 * @param {{ country?: string, state?: string, zip?: string }} [person]
 * @param {string} [submissionEmail]  Masked/relay email to use for email fields
 */
async function fillForm(page, formFields, person, submissionEmail) {
  const fields = person ? applyRegionAliases(formFields, person) : formFields;

  for (const [selector, rawValue] of Object.entries(fields)) {
    const value = (submissionEmail && isEmailSelector(selector)) ? submissionEmail : rawValue;
    const selectors = selector.split(',').map(s => s.trim());
    let filled = false;
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && (await el.isVisible())) {
          const tag  = await el.evaluate(n => n.tagName.toLowerCase());
          const type = await el.evaluate(n => n.type || '');
          if (tag === 'select') {
            await el.selectOption({ label: value }).catch(() => el.selectOption(value));
          } else if (type === 'checkbox' || type === 'radio') {
            await el.check();
          } else {
            await el.fill(value);
          }
          filled = true;
          break;
        }
      } catch(_) {}
    }
    if (!filled) {
      const kw = extractKeyword(selector);
      if (kw && !isAmbiguousKeyword(kw)) {
        // Escape regex metacharacters before constructing the RegExp so that
        // keywords like "na(me" do not cause a SyntaxError.
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await page.getByLabel(new RegExp(escaped, 'i')).first().fill(value).catch(() => {});
      }
    }
  }
}
```

- [ ] Step 2.4: Update the `module.exports` line of `/Users/stephen/scripts/auto-identity-remove/lib/forms.js` (currently line 144) to also export `isEmailSelector`. Replace:

```js
module.exports = { fillForm, findListingUrl, applyRegionAliases, isAmbiguousKeyword, extractKeyword };
```

with:

```js
module.exports = { fillForm, findListingUrl, applyRegionAliases, isAmbiguousKeyword, extractKeyword, isEmailSelector };
```

- [ ] Step 2.5: Run, expect pass. Commands: `node --test test/forms-relay.test.js` then `node --test test/forms-bugs.test.js test/forms-intl.test.js test/forms-intl-postal.test.js test/forms-selector.test.js test/find-listing-url.test.js`. Expect all green (the new optional 4th parameter is backward compatible, so existing form tests still pass).

- [ ] Step 2.6: Commit. Run:
```bash
git -C /Users/stephen/scripts/auto-identity-remove add lib/forms.js test/forms-relay.test.js
git -C /Users/stephen/scripts/auto-identity-remove commit -m "Thread masked submissionEmail through fillForm email fields

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Use submission email in `lib/email.js` opt-out bodies

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/email.js` (`_sendViaSMTP` lines 115-146; `sendOptOutEmails` lines 178-203)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/email-relay.test.js`

Email-method brokers receive the address in the body and as the `replyTo`. When a relay is configured we want the masked address there too. We pass a resolved `submissionEmail` into `sendOptOutEmails`; when absent it stays `person.email` (backward compatible).

- [ ] Step 3.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/email-relay.test.js` with this complete content:

```js
/**
 * test/email-relay.test.js
 *
 * Verifies sendOptOutEmails substitutes a masked submissionEmail into the email
 * body and replyTo when provided, while the rest of the person data is intact.
 * nodemailer is mocked via Module._load so no real SMTP connection occurs.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const PERSON = {
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'jane.doe@example.com',
  phone: '5125550000',
  phoneFormatted: '(512) 555-0000',
  country: 'US',
};

const EMAIL_BROKER = { name: 'Pipl', method: 'email', emailTo: 'removal@pipl.com' };
const SMTP_CFG = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');
const origLastOptOut = configMod.lastOptOutDaysAgo;
const origRecordSuccess = configMod.recordSuccess;
const origLogResult = loggerMod.logResult;

function patchDeps() {
  configMod.lastOptOutDaysAgo = () => 999;
  configMod.recordSuccess = () => {};
  loggerMod.logResult = () => {};
}
function restoreDeps() {
  configMod.lastOptOutDaysAgo = origLastOptOut;
  configMod.recordSuccess = origRecordSuccess;
  loggerMod.logResult = origLogResult;
}

function loadFreshEmailWithSmtpMock() {
  const nmCalls = [];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'nodemailer') {
      return {
        createTransport: () => ({
          sendMail: async (opts) => { nmCalls.push(opts); return { messageId: 'mock' }; },
        }),
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  const freshEmail = require('../lib/email');
  function restore() {
    Module._load = origLoad;
    delete require.cache[require.resolve('../lib/email')];
    require('../lib/email');
  }
  return { freshEmail, nmCalls, restore };
}

test('submissionEmail appears in the body and replyTo, real email is omitted', async () => {
  patchDeps();
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { person: PERSON, email: { smtp: SMTP_CFG } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux', {
    submissionEmailFor: () => 'jane.masked@aliases.simplelogin.io',
  });

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 1);
  assert.equal(nmCalls[0].replyTo, 'jane.masked@aliases.simplelogin.io');
  assert.ok(nmCalls[0].text.includes('jane.masked@aliases.simplelogin.io'), 'body should contain masked email');
  assert.ok(!nmCalls[0].text.includes('jane.doe@example.com'), 'real email must not appear in body');
});

test('without submissionEmailFor, the body uses person.email (backward compatible)', async () => {
  patchDeps();
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { person: PERSON, email: { smtp: SMTP_CFG } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux');

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 1);
  assert.ok(nmCalls[0].text.includes('jane.doe@example.com'), 'body should contain real email when no relay');
  assert.equal(nmCalls[0].replyTo, undefined, 'replyTo omitted when no masked email');
});
```

- [ ] Step 3.2: Run it, expect fail. Command: `node --test test/email-relay.test.js`. Expected failure: first test fails on `body should contain masked email` (current `sendOptOutEmails` ignores the 4th argument and the body uses `person.email`).

- [ ] Step 3.3: Implement. Edit `/Users/stephen/scripts/auto-identity-remove/lib/email.js`.

First, replace the `_sendViaSMTP` function (current lines 108-146, starting at the JSDoc `/**\n * Send a single opt-out email via SMTP...`) with this version that takes an explicit `submissionEmail`:

```js
/**
 * Send a single opt-out email via SMTP using nodemailer (lazy-required).
 *
 * @param {object} broker
 * @param {object} person
 * @param {object} smtpCfg          - { host, port, user, pass, from }
 * @param {string} [submissionEmail] - masked/relay address to advertise to the
 *   broker; when set it replaces person.email in the body and sets replyTo.
 */
async function _sendViaSMTP(broker, person, smtpCfg, submissionEmail) {
  // Lazy require - nodemailer is optional; avoids startup error when absent.
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    loggerMod.logResult(broker.name, 'error', 'nodemailer not installed - run: npm install nodemailer');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: smtpCfg.host,
    port: smtpCfg.port || 587,
    secure: (smtpCfg.port || 587) === 465,
    auth: { user: smtpCfg.user, pass: smtpCfg.pass },
  });

  const contactEmail = submissionEmail || person.email;
  const bodyPerson = contactEmail === person.email ? person : { ...person, email: contactEmail };
  const body = _pickTemplate(bodyPerson.country)(bodyPerson);

  const mail = {
    from: smtpCfg.from || smtpCfg.user,
    to: broker.emailTo,
    subject: `Personal Data Removal Request - ${person.fullName}`,
    text: body,
  };
  if (submissionEmail) mail.replyTo = submissionEmail;

  try {
    await transporter.sendMail(mail);
    loggerMod.logResult(broker.name, 'success', `Email → ${broker.emailTo}`);
    configMod.recordSuccess(broker.name, `email to ${broker.emailTo}`);
  } catch (err) {
    loggerMod.logResult(broker.name, 'error', `SMTP failed: ${err.message.slice(0, 60)}`);
  }
}
```

- [ ] Step 3.4: Replace the `sendOptOutEmails` function (current lines 167-203, starting at the JSDoc `/**\n * Send opt-out emails for all brokers...`) with this version that accepts and forwards a `submissionEmailFor` resolver:

```js
/**
 * Send opt-out emails for all brokers with method:'email'.
 *
 * Supports both single-person (cfg.person) and multi-person (cfg.persons)
 * configuration. When cfg.persons is a non-empty array, one email is sent
 * per (broker, person) pair. Falls back to cfg.person for backward compat.
 *
 * @param {object[]} brokers   - Full broker list (filtered internally)
 * @param {object}   cfg       - Full config object (cfg.person/cfg.persons, cfg.email.smtp)
 * @param {string}   [_platform] - Injected for testing; defaults to process.platform
 * @param {object}   [opts]
 * @param {(person: object) => (string|undefined)} [opts.submissionEmailFor]
 *   Resolver returning a masked/relay email for a person; when it returns a
 *   value, that address is advertised to the broker instead of person.email.
 */
async function sendOptOutEmails(brokers, cfg, _platform, opts = {}) {
  const platform = getPlatform(_platform || process.platform);
  const persons = _getPersons(cfg);
  const smtpCfg = cfg?.email?.smtp;
  const submissionEmailFor = opts.submissionEmailFor || (() => undefined);

  const emailBrokers = brokers.filter(b => b.method === 'email');

  for (const broker of emailBrokers) {
    if (configMod.lastOptOutDaysAgo(broker.name) < configMod.RECHECK_DAYS) {
      loggerMod.logResult(broker.name, 'skipped', 'Email already sent recently');
      continue;
    }

    for (const person of persons) {
      const submissionEmail = submissionEmailFor(person);
      if (smtpCfg) {
        await _sendViaSMTP(broker, person, smtpCfg, submissionEmail);
      } else {
        loggerMod.logResult(
          broker.name,
          'manual',
          `${broker.emailTo} - add email.smtp to config.json to send automatically`
        );
      }
    }
  }
}
```

- [ ] Step 3.5: Run, expect pass. Commands: `node --test test/email-relay.test.js` then `node --test test/email.test.js test/email-multi-person.test.js`. Expect all green (existing email tests call `sendOptOutEmails` with 2-3 args; the new `opts` defaults to `{}` so they keep using `person.email`).

- [ ] Step 3.6: Commit. Run:
```bash
git -C /Users/stephen/scripts/auto-identity-remove add lib/email.js test/email-relay.test.js
git -C /Users/stephen/scripts/auto-identity-remove commit -m "Use masked submissionEmail in email-method opt-out bodies and replyTo

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Pass submission email through `lib/broker-runner.js`

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/broker-runner.js` (`opts` default line 23; `fillForm` call lines 100-103)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/broker-runner-relay.test.js`

The broker-runner owns the `fillForm` call for search-form / direct-form brokers. We add `submissionEmail` to the injected `opts` and forward it as the 4th argument to `fillForm`. This is verified with the established `Module._load` mocking pattern.

- [ ] Step 4.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/broker-runner-relay.test.js` with this complete content:

```js
/**
 * test/broker-runner-relay.test.js
 *
 * Verifies processBrokerWithPerson forwards opts.submissionEmail to fillForm.
 * All of broker-runner's relative deps are stubbed via Module._load so no real
 * Playwright, config, captcha, or network is touched.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const PERSON = { firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe', email: 'jane.doe@example.com', country: 'US' };
const DIRECT_BROKER = {
  name: 'TruePeopleSearch',
  method: 'direct-form',
  optOutUrl: 'https://example.test/removal',
  formFields: { 'input[type="email"]': 'jane.doe@example.com' },
  submitSelector: 'button[type="submit"]',
};

// Minimal Playwright page/context stub. fillForm is stubbed separately so we
// only need the page object to exist and close cleanly.
function makeContext() {
  const page = {
    async goto() {},
    locator() { return { first() { return { async count() { return 0; }, async isVisible() { return false; }, async click() {}, async fill() {} }; } }; },
    async evaluate() { return ''; },
    async close() {},
  };
  return { async newPage() { return page; } };
}

/**
 * Load a fresh broker-runner with all relative deps stubbed. fillFormCalls
 * captures every (formFields, person, submissionEmail) tuple.
 */
function loadRunnerWithStubs() {
  const fillFormCalls = [];
  const logCalls = [];
  const originalLoad = Module._load.bind(Module);

  function patchedLoad(request, parent, isMain) {
    if (!parent || !parent.filename || !parent.filename.includes('broker-runner')) {
      return originalLoad(request, parent, isMain);
    }
    if (request === './config') {
      return {
        recordSuccess: () => {},
        recordPendingConfirmation: () => {},
        recordFailure: () => {},
        shouldSkip: () => null,
        saveCheckpoint: () => {},
        stateKey: (name) => name,
      };
    }
    if (request === './logger') {
      return { logResult: (broker, status, detail) => logCalls.push({ broker, status, detail }), STATUS_BUCKET: {} };
    }
    if (request === './forms') {
      return {
        fillForm: async (page, formFields, person, submissionEmail) => {
          fillFormCalls.push({ formFields, person, submissionEmail });
        },
        findListingUrl: async () => null,
      };
    }
    if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
    if (request === './confirm') return { detectConfirmationRequired: async () => ({ pending: false }) };
    if (request === './success') return { classifyPostSubmit: () => ({ outcome: 'success', snippet: 'removed' }) };
    if (request === './retry') return { withRetry: (fn) => fn() };
    if (request === './timing') return { jitterSleep: async () => {} };
    if (request === './snapshot') return { captureSubmitSnapshot: async () => null };
    return originalLoad(request, parent, isMain);
  }

  Module._load = patchedLoad;
  delete require.cache[require.resolve('../lib/broker-runner')];
  const runner = require('../lib/broker-runner');
  Module._load = originalLoad;
  delete require.cache[require.resolve('../lib/broker-runner')];

  return { runner, fillFormCalls, logCalls };
}

test('processBrokerWithPerson forwards opts.submissionEmail to fillForm', async () => {
  const { runner, fillFormCalls } = loadRunnerWithStubs();
  runner.configure({ dryRun: false, person: PERSON, personCount: 1, submissionEmail: 'masked@aliases.simplelogin.io' });

  await runner.processBrokerWithPerson(makeContext(), DIRECT_BROKER, PERSON);

  assert.equal(fillFormCalls.length, 1, 'fillForm should be called once');
  assert.equal(fillFormCalls[0].submissionEmail, 'masked@aliases.simplelogin.io');
});

test('processBrokerWithPerson passes undefined submissionEmail when none configured', async () => {
  const { runner, fillFormCalls } = loadRunnerWithStubs();
  runner.configure({ dryRun: false, person: PERSON, personCount: 1 });

  await runner.processBrokerWithPerson(makeContext(), DIRECT_BROKER, PERSON);

  assert.equal(fillFormCalls.length, 1);
  assert.equal(fillFormCalls[0].submissionEmail, undefined);
});
```

- [ ] Step 4.2: Run it, expect fail. Command: `node --test test/broker-runner-relay.test.js`. Expected failure: first test fails `fillFormCalls[0].submissionEmail` is `undefined` (current `processBrokerWithPerson` calls `fillForm(page, broker.formFields, person)` with no 4th argument).

- [ ] Step 4.3: Implement. Edit `/Users/stephen/scripts/auto-identity-remove/lib/broker-runner.js`. First, add `submissionEmail` to the `opts` default object (current line 23). Replace:

```js
let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false, snapshot: false, personCount: 1 };
```

with:

```js
let opts = { dryRun: false, person: null, capsolver: null, noCapsolver: false, snapshot: false, personCount: 1, submissionEmail: null };
```

- [ ] Step 4.4: Forward `opts.submissionEmail` to `fillForm`. In `processBrokerWithPerson` (current lines 100-103), replace:

```js
    if (broker.formFields) {
      await fillForm(page, broker.formFields, person);
      await jitterSleep(400, 800);
    }
```

with:

```js
    if (broker.formFields) {
      await fillForm(page, broker.formFields, person, opts.submissionEmail || undefined);
      await jitterSleep(400, 800);
    }
```

- [ ] Step 4.5: Run, expect pass. Commands: `node --test test/broker-runner-relay.test.js` then `node --test test/broker-runner-buckets.test.js test/broker-runner-pending.test.js test/broker-runner-preview.test.js test/broker-runner-submit-scope.test.js test/broker-runner-timeout.test.js test/broker-runner-usonly.test.js`. Expect all green (the new `opts.submissionEmail` defaults to `null` -> `undefined` forwarded, preserving existing behavior).

- [ ] Step 4.6: Commit. Run:
```bash
git -C /Users/stephen/scripts/auto-identity-remove add lib/broker-runner.js test/broker-runner-relay.test.js
git -C /Users/stephen/scripts/auto-identity-remove commit -m "Forward opts.submissionEmail from broker-runner to fillForm

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire relay into `watcher.js` (per-person resolution + threading)

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/watcher.js` (requires at lines 14-19; persons loop at lines 364-377)
- Test: covered indirectly by the unit tests above; watcher.js is the thin orchestrator and is not unit-tested directly in this repo (see existing convention - no `watcher.test.js`). Manual smoke check via `--list` is the verification step.

`watcher.js` resolves the submission email once per person (caching writes land in the live `state` object, which is persisted by `saveState()` later in the run), then threads it through `brokerRunner.configure` and `sendOptOutEmails`. Because `getSubmissionEmail` returns `person.email` when no relay is configured, behavior is unchanged for existing users.

- [ ] Step 5.1: Add the require. Edit `/Users/stephen/scripts/auto-identity-remove/watcher.js`. After the `sendOptOutEmails` require (current line 19), add the relay require. Replace:

```js
const { sendOptOutEmails } = require('./lib/email');
const lock = require('./lib/lock');
```

with:

```js
const { sendOptOutEmails } = require('./lib/email');
const { getSubmissionEmail } = require('./lib/relay');
const lock = require('./lib/lock');
```

- [ ] Step 5.2: Resolve the submission email inside the persons loop. In the persons loop (current lines 364-377), replace:

```js
  for (const person of persons) {
    if (persons.length > 1) {
      console.log(`\n${'='.repeat(54)}`);
      console.log(`Running for: ${person.firstName} ${person.lastName}`);
      console.log('='.repeat(54));
    }

    brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length });

    // Email opt-outs (no browser needed — skipped in verify mode)
    if (!VERIFY) {
      console.log('── Email opt-outs ─────────────────────────────────────────');
      await sendOptOutEmails(brokers, config);
    }
```

with:

```js
  for (const person of persons) {
    if (persons.length > 1) {
      console.log(`\n${'='.repeat(54)}`);
      console.log(`Running for: ${person.firstName} ${person.lastName}`);
      console.log('='.repeat(54));
    }

    // Resolve a masked/relay submission email for this person (cached in
    // state.relayAliases by lib/relay). Returns person.email unchanged when no
    // relay is configured, so existing setups are unaffected. Persisted later
    // by the run's saveState().
    const submissionEmail = await getSubmissionEmail({ config, person, state });
    if (submissionEmail && submissionEmail !== person.email) {
      console.log(`   🛡️  Using masked email for submissions: ${submissionEmail}`);
    }

    brokerRunner.configure({ dryRun: DRY_RUN, preview: PREVIEW, person, capsolver: config.capsolver, noCapsolver: NO_CAPSOLVER, snapshot: SNAPSHOT, personCount: persons.length, submissionEmail });

    // Email opt-outs (no browser needed - skipped in verify mode)
    if (!VERIFY) {
      console.log('── Email opt-outs ─────────────────────────────────────────');
      await sendOptOutEmails(brokers, config, undefined, { submissionEmailFor: (p) => (p === person ? submissionEmail : undefined) });
    }
```

- [ ] Step 5.3: Verify watcher still parses and loads. Because watcher.js is not unit-tested, run a syntax/load smoke check that does not execute `main()` and does not touch the network. Command:
```bash
node -e "require('/Users/stephen/scripts/auto-identity-remove/lib/relay'); console.log('relay ok'); const src = require('fs').readFileSync('/Users/stephen/scripts/auto-identity-remove/watcher.js','utf8'); new (require('vm').Script)(src, { filename: 'watcher.js' }); console.log('watcher parses ok');"
```
Expected output: `relay ok` then `watcher parses ok`. (`vm.Script` compiles the file to catch syntax errors without running it.)

- [ ] Step 5.4: Smoke-check the no-relay default path still lists brokers without error. Command:
```bash
node /Users/stephen/scripts/auto-identity-remove/watcher.js --list
```
Expected: prints the broker list and exits 0 (the `--list` branch never reaches the persons loop, confirming the requires resolve cleanly).

- [ ] Step 5.5: Commit. Run:
```bash
git -C /Users/stephen/scripts/auto-identity-remove add watcher.js
git -C /Users/stephen/scripts/auto-identity-remove commit -m "Wire masked-email relay into watcher per-person submission flow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Document config + manual fallbacks

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/config.example.json` (after the `email` block, before `profileDir`, current line 50-52)
- Create: `/Users/stephen/scripts/auto-identity-remove/docs/relay.md`

- [ ] Step 6.1: Document the optional `relay` block in `config.example.json`. Edit `/Users/stephen/scripts/auto-identity-remove/config.example.json`. Replace:

```json
  "email": {
    "_comment": "SMTP config for sending opt-out emails. Required — without this, email brokers are logged as 'manual'. Gmail: host=smtp.gmail.com, port=587, use an App Password (myaccount.google.com/apppasswords). Outlook/Office365: host=smtp-mail.outlook.com, port=587.",
    "smtp": {
      "host": "smtp.gmail.com",
      "port": 587,
      "user": "you@gmail.com",
      "pass": "YOUR_GMAIL_APP_PASSWORD",
      "from": "you@gmail.com"
    }
  },

  "profileDir": "~/.config/auto-identity-remove"
```

with:

```json
  "email": {
    "_comment": "SMTP config for sending opt-out emails. Required - without this, email brokers are logged as 'manual'. Gmail: host=smtp.gmail.com, port=587, use an App Password (myaccount.google.com/apppasswords). Outlook/Office365: host=smtp-mail.outlook.com, port=587.",
    "smtp": {
      "host": "smtp.gmail.com",
      "port": 587,
      "user": "you@gmail.com",
      "pass": "YOUR_GMAIL_APP_PASSWORD",
      "from": "you@gmail.com"
    }
  },

  "relay": {
    "_comment": "OPTIONAL masked-email relay. When set, opt-out submissions use a per-person alias instead of person.email so brokers never get your real address. Currently supports provider 'simplelogin' via API. Apple Hide My Email and Firefox Relay are manual-only - see docs/relay.md. Omit this block entirely to submit with your real email (default).",
    "provider": "simplelogin",
    "apiKey": "YOUR_SIMPLELOGIN_API_KEY"
  },

  "profileDir": "~/.config/auto-identity-remove"
```

- [ ] Step 6.2: Create the docs file. Create `/Users/stephen/scripts/auto-identity-remove/docs/relay.md` with this complete content:

```markdown
# Masked-Email Relay

By default, auto-identity-remove submits opt-outs using `config.person.email`.
That hands every broker a fresh real address. A masked/relay email lets each
removal request go out under a per-person alias you control, which you can
disable later if a broker abuses it.

When `config.relay` is set, the tool resolves one alias per person, caches it in
`state.json` under `relayAliases`, and uses it for both form-based and
email-based opt-outs. Without `config.relay`, behavior is unchanged.

## SimpleLogin (automated, via API)

1. Create a SimpleLogin account at https://simplelogin.io and verify it.
2. Generate an API key: Account Settings -> API Keys -> Create.
3. Add to `config.json`:

   ```json
   "relay": {
     "provider": "simplelogin",
     "apiKey": "YOUR_SIMPLELOGIN_API_KEY"
   }
   ```

4. Run the tool normally. On the first run per person it POSTs to
   `https://app.simplelogin.io/api/alias/custom/new` (with header
   `Authentication: <apiKey>`) to mint a custom alias, then caches it in
   `state.json` so no new alias is created on later runs. If the API call fails,
   the run falls back to your real email so opt-outs are never blocked.

## Apple Hide My Email (manual fallback)

Apple has no public alias-creation API, so this is manual:

1. On an Apple device: Settings -> your name -> iCloud -> Hide My Email ->
   Create new address.
2. Label it (e.g. "data-broker opt-outs") and copy the generated
   `@icloud.com` alias.
3. Paste it into `config.person.email` in `config.json`.
4. Leave `config.relay` unset so the tool uses that email directly.

## Firefox Relay (manual fallback)

Firefox Relay's alias API is not integrated here, so this is manual:

1. Sign in at https://relay.firefox.com and create a new mask.
2. Copy the generated `@mozmail.com` alias.
3. Paste it into `config.person.email` in `config.json`.
4. Leave `config.relay` unset.

## Notes

- Aliases are cached per person in `state.json` (`relayAliases` keyed by the
  person's lowercased email). Delete that key to force a fresh alias.
- The alias is used in form email fields, in the email body, and as the
  `Reply-To` on email-method submissions, so broker confirmations route back to
  the alias inbox.
```

- [ ] Step 6.3: Verify the JSON is still valid. Command:
```bash
node -e "JSON.parse(require('fs').readFileSync('/Users/stephen/scripts/auto-identity-remove/config.example.json','utf8')); console.log('config.example.json valid')"
```
Expected output: `config.example.json valid`.

- [ ] Step 6.4: Commit. Run:
```bash
git -C /Users/stephen/scripts/auto-identity-remove add config.example.json docs/relay.md
git -C /Users/stephen/scripts/auto-identity-remove commit -m "Document relay config block and manual masked-email fallbacks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Run the full suite green

Files:
- Test only: the entire root suite. No dashboard files were touched, so the dashboard suite is not required to change - but we run it as a sanity check since CI runs both.

- [ ] Step 7.1: Run the exact root-suite command from `package.json` `test` script. Command:
```bash
cd /Users/stephen/scripts/auto-identity-remove && node --test test/*.test.js dashboard/validate.test.js
```
Expected: `# fail 0`. This includes the four new test files (`relay`, `forms-relay`, `email-relay`, `broker-runner-relay`) plus all 57 pre-existing files in `test/`.

- [ ] Step 7.2: Run the dashboard suite as a sanity check (no dashboard files changed, but CI runs it). Command:
```bash
cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test
```
Expected: `# fail 0` (unchanged from before this work).

- [ ] Step 7.3: If any test fails, do NOT proceed. Read the failing assertion, fix the offending file from the relevant task, re-run that file in isolation with `node --test test/<file>.test.js`, then re-run Step 7.1. Only continue once both suites report `# fail 0`.

- [ ] Step 7.4: Final verification commit (only if Step 7.3 required fixes; otherwise skip - Tasks 1-6 are already committed). If fixes were made, run:
```bash
git -C /Users/stephen/scripts/auto-identity-remove add -A
git -C /Users/stephen/scripts/auto-identity-remove commit -m "Fix test failures surfaced by full suite run for masked-email relay

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage:
- New `lib/relay.js` exports `getSubmissionEmail({ config, person, createImpl })` (plus `state`, used for caching) - Task 1. It is a PURE provider-decision function: the only side effect (alias creation) is injected via `createImpl`, and the cache write goes to the caller-supplied `state` object. Unit-tested with an injected `createImpl` (Task 1 tests 3-5) and with an injected `fetchImpl` for `createSimpleLoginAlias` (Task 1 tests 7-8). Confirmed.
- SimpleLogin: POST to `https://app.simplelogin.io/api/alias/custom/new` with header `Authentication: <apiKey>` using global `fetch` (no new dependency) - Task 1 `createSimpleLoginAlias`, asserted in test 7. Confirmed.
- Per-person caching in `state.relayAliases[personKey]` so a new alias is not created each run - Task 1 tests 3-5; `personKey` is email-based and case-insensitive. Confirmed.
- `forms.js` and `email.js` use `getSubmissionEmail` output instead of raw `person.email` - Task 2 (`fillForm` email-field override), Task 3 (email body + `replyTo`), wired in Task 5 where watcher computes the value and threads it. Confirmed.
- `person.email` remains the default when no relay is configured - verified by Task 1 test 1, Task 2 test 3, Task 3 test 2, and `getSubmissionEmail`'s early return. Confirmed backward compatible.
- Integration/wiring task present - Task 5 wires watcher.js (the orchestrator, where the persons loop and `brokerRunner.configure`/`sendOptOutEmails` live). Confirmed.
- Final full-suite task present - Task 7 runs `node --test test/*.test.js dashboard/validate.test.js` (the package.json test script) plus the dashboard suite. Confirmed.

No placeholders: every code step contains complete, runnable code - full function bodies for `lib/relay.js`, the rewritten `fillForm`, `_sendViaSMTP`, `sendOptOutEmails`, the broker-runner edits, the watcher edits, the full docs/relay.md, and complete test files. No "TBD", no "similar to above", no "add error handling" stubs.

Signature consistency with the real repo (verified against the read files):
- `lib/config.js` exports used: `loadConfig`, `loadState`, `getPersonsFromConfig`, `saveState`, `recordSuccess` - all present in the real `module.exports` (lines 329-355). The new `state.relayAliases` key is additive and serialized by the existing `saveState()` `JSON.stringify(state, ...)` (line 121); nothing else in config.js reads or validates state keys, so no config.js change is needed.
- `lib/forms.js` `fillForm(page, formFields, person)` real signature (line 93) extended with an optional 4th `submissionEmail` arg; existing callers (broker-runner line 102) keep working; `module.exports` (line 144) extended with `isEmailSelector`. Confirmed.
- `lib/email.js` `sendOptOutEmails(brokers, cfg, _platform)` real signature (line 178) extended with an optional 4th `opts` arg defaulting to `{}`; `_sendViaSMTP(broker, person, smtpCfg)` (line 115) extended with optional `submissionEmail`. Existing tests call with 2-3 args and still pass. Confirmed.
- `lib/broker-runner.js` `configure(o)` merges into module-level `opts` (lines 25-27); adding `submissionEmail` to the default `opts` (line 23) and forwarding it in the `fillForm` call (line 102) matches the real DI pattern. Test uses the verbatim `Module._load` scoping (`parent.filename.includes('broker-runner')`), cache-bust, restore-after-require pattern from `test/broker-runner-buckets.test.js`, and stubs `./config ./logger ./forms ./captcha ./confirm ./success ./retry ./timing ./snapshot` exactly as the real module requires them (lines 13-21). Confirmed.
- `watcher.js` real require list (line 19) and persons loop (lines 364-377) match the edited anchors exactly, including the existing `brokerRunner.configure({...})` call shape. Confirmed.

Hermeticity: no test makes a real network call (SimpleLogin uses injected `fetchImpl`; nodemailer is `Module._load`-mocked), no test spawns a process, and no test writes to the real `config.json`/`state.json` (relay tests build state via `makeState()`; email/forms/broker-runner tests use stubs and patched module references). The single non-test network site is `createSimpleLoginAlias`'s default `globalThis.fetch`, only reached when a real `apiKey` is configured at runtime - never in tests. Confirmed.

No em dashes were introduced in authored prose (this plan, docs/relay.md, JSON `_comment`, JSDoc); hyphens are used throughout. (Pre-existing source comments/strings in forms.js, email.js, broker-runner.js contain em dashes; per repo rule those are left as-is and only the text we author uses hyphens - the new code blocks above use hyphens.)
