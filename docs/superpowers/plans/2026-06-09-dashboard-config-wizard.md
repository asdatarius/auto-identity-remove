# First-run Config Wizard Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Replace hand-editing config.json with a guided multi-step wizard in the dashboard so non-technical users can onboard through the GUI without ever touching JSON.

Architecture: A new server-side helper computes whether config.json is "configured" (the required person identity fields are present and non-placeholder) and exposes it at `GET /api/config/status` returning `{ configured, missing: [...] }`. The browser app boots, calls that endpoint, and when not configured renders a multi-step wizard overlay (Person -> Region/Country -> CapSolver -> Email/SMTP -> Notifications -> Review) that prefills from `config.example.json`, validates required fields client-side, and writes through the EXISTING `PUT /api/config` (which merges, preserves masked secrets, and does an atomic 0600 write). After a successful save the overlay hides and the normal dashboard takes over.

Tech Stack: Plain Node.js CommonJS (`require`/`module.exports`), zero TypeScript, Express 4 (already present in `dashboard/node_modules`), `node:test` + `node:assert/strict` for tests, vanilla browser JS (no framework, no bundler). No new npm dependencies.

New dependencies: NONE.

---

## File map

| File | Status | Responsibility |
| --- | --- | --- |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/config-status.js` | Created | Pure helper `configStatus(cfg)` -> `{ configured, missing }`. No express / fs dependency so it is unit-testable from the root `node --test` suite. |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js` | Modified | Require the helper; add `GET /api/config/status` endpoint (lines ~44 require block, ~363 near `/api/config`). Export `configStatus` for tests. |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/config-status.test.js` | Created | Unit tests for the pure helper, runnable from the root `node --test` suite. |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js` | Modified | Add hermetic endpoint tests for `/api/config/status` (configured vs not), using the existing temp-config build pattern (append after line 327). |
| `/Users/stephen/scripts/auto-identity-remove/package.json` | Modified | Add `dashboard/config-status.test.js` to the root `test` script (line 10). |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/public/index.html` | Modified | Add the wizard overlay markup (hidden by default) before the `<script>` tag (after line 164). |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/public/styles.css` | Modified | Add `.wizard*` styles (append after line 154). |
| `/Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js` | Modified | On boot, call `/config/status`; if not configured, render+drive the wizard, save via `PUT /config`, then reveal the dashboard (insert a wizard module and a boot gate around the existing boot block at lines 357-361). |

---

## Task 1: Pure config-status helper + its unit test

The `/api/summary` `configured` flag is only `!!cfg` (the file merely exists). That is too weak to decide "show the wizard": an empty `{}` or the unedited example (with placeholder `Jane Doe`) would falsely read as configured. This task builds a pure function that reports the required-field gaps. It mirrors the real required-person contract from `lib/config.js` `getPersonsFromConfig` (a usable person needs at least `firstName`, `lastName`, `email`).

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/dashboard/config-status.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/dashboard/config-status.test.js`

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/dashboard/config-status.test.js` with the COMPLETE contents below. It uses `node:test` + `node:assert/strict`, no network, no fs, just the pure helper.

```js
/**
 * dashboard/config-status.test.js
 *
 * Unit tests for the pure configStatus() helper that decides whether the
 * dashboard should show the first-run wizard. No fs / express / network: the
 * helper is a pure function of the parsed config object. Runnable from the
 * root `node --test` suite.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configStatus, REQUIRED_PERSON_FIELDS } = require('./config-status');

test('null / undefined config is not configured and reports every required field missing', () => {
  for (const cfg of [null, undefined]) {
    const s = configStatus(cfg);
    assert.equal(s.configured, false);
    for (const f of REQUIRED_PERSON_FIELDS) {
      assert.ok(s.missing.includes(`person.${f}`), `missing should include person.${f}`);
    }
  }
});

test('empty object is not configured and reports all required fields missing', () => {
  const s = configStatus({});
  assert.equal(s.configured, false);
  assert.deepEqual(
    s.missing.slice().sort(),
    REQUIRED_PERSON_FIELDS.map(f => `person.${f}`).sort()
  );
});

test('a fully filled person is configured with no missing fields', () => {
  const cfg = {
    person: { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' },
  };
  const s = configStatus(cfg);
  assert.equal(s.configured, true);
  assert.deepEqual(s.missing, []);
});

test('the unedited example placeholder (Jane Doe / jane.doe@example.com) is treated as NOT configured', () => {
  const cfg = {
    person: { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com' },
  };
  const s = configStatus(cfg);
  assert.equal(s.configured, false);
  assert.ok(s.missing.includes('person.firstName'));
  assert.ok(s.missing.includes('person.lastName'));
  assert.ok(s.missing.includes('person.email'));
});

test('a partial person reports only the blank required fields as missing', () => {
  const cfg = { person: { firstName: 'Bob', lastName: '', email: '   ' } };
  const s = configStatus(cfg);
  assert.equal(s.configured, false);
  assert.deepEqual(s.missing.slice().sort(), ['person.email', 'person.lastName'].sort());
});

test('whitespace-only values count as missing', () => {
  const cfg = { person: { firstName: '   ', lastName: 'X', email: 'x@y.z' } };
  const s = configStatus(cfg);
  assert.equal(s.configured, false);
  assert.deepEqual(s.missing, ['person.firstName']);
});

test('a non-empty persons[] array satisfies configured even when person is absent', () => {
  const cfg = {
    persons: [{ firstName: 'Carol', lastName: 'Jones', email: 'carol@example.com' }],
  };
  const s = configStatus(cfg);
  assert.equal(s.configured, true);
  assert.deepEqual(s.missing, []);
});

test('an empty persons[] array is not configured (matches getPersonsFromConfig contract)', () => {
  const s = configStatus({ persons: [] });
  assert.equal(s.configured, false);
  assert.ok(s.missing.length > 0);
});

test('persons[] takes precedence: a complete persons[0] wins even if person is a placeholder', () => {
  const cfg = {
    person: { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com' },
    persons: [{ firstName: 'Dan', lastName: 'Lee', email: 'dan@example.com' }],
  };
  const s = configStatus(cfg);
  assert.equal(s.configured, true);
  assert.deepEqual(s.missing, []);
});
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test dashboard/config-status.test.js`. Expected failure: `Cannot find module './config-status'` (the helper does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/dashboard/config-status.js` with the COMPLETE contents below.

```js
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
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test dashboard/config-status.test.js`. Expected: all tests in the file pass (9 passing, 0 failing).

- [ ] Step 1.5: Commit. Run:
```
rtk git add dashboard/config-status.js dashboard/config-status.test.js
git commit -m "Add pure configStatus helper for first-run wizard gating

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire the helper into the root test script

The root `package.json` test script enumerates files explicitly (`test/*.test.js dashboard/validate.test.js`). The new `dashboard/config-status.test.js` only needs `node:test` built-ins, so it can join the root suite (it does NOT need express). Add it so CI (the matrix `test` job runs the same command) exercises it on Node 18/20/22.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/package.json` (line 10, the `test` script)
- Modify: `/Users/stephen/scripts/auto-identity-remove/.github/workflows/test.yml` (the matrix `test` job command)
- Test: re-run the root suite to confirm the new file is collected

- [ ] Step 2.1: Write the failing test. No NEW test file is needed; the "failing" condition is that `config-status.test.js` is not yet part of the root suite. Confirm the gap first. Command: `node --test test/*.test.js dashboard/validate.test.js dashboard/config-status.test.js` then compare against the current script `node --test test/*.test.js dashboard/validate.test.js` (the latter does NOT run config-status). The objective: make the committed `npm test` include the new file.

- [ ] Step 2.2: Run it, expect fail (gap demonstration). Command: `rtk read package.json` and confirm line 10 reads exactly:
```
"test": "node --test test/*.test.js dashboard/validate.test.js"
```
Expected: the string does NOT contain `dashboard/config-status.test.js`.

- [ ] Step 2.3: Implement. Edit `/Users/stephen/scripts/auto-identity-remove/package.json`. Replace the test script line:

Old:
```json
    "test": "node --test test/*.test.js dashboard/validate.test.js",
```
New:
```json
    "test": "node --test test/*.test.js dashboard/validate.test.js dashboard/config-status.test.js",
```

Also update CI to match. Edit `/Users/stephen/scripts/auto-identity-remove/.github/workflows/test.yml`: find the `test` job step that runs `node --test test/*.test.js dashboard/validate.test.js` and append ` dashboard/config-status.test.js` to that exact command so the matrix job runs the new file too. (Leave the separate `dashboard` job, which does `node --test` from `working-directory: dashboard`, unchanged; it already discovers `*.test.js` in that dir.)

- [ ] Step 2.4: Run, expect pass. Command: `npm test`. Expected: the run now includes `dashboard/config-status.test.js` and the whole suite is green (config-status tests appear in the output, all passing).

- [ ] Step 2.5: Commit. Run:
```
rtk git add package.json .github/workflows/test.yml
git commit -m "Run config-status unit tests in root and CI suite

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: GET /api/config/status endpoint + hermetic server tests

Add the endpoint that the browser polls on boot. It reuses `readJsonMeta(CONFIG)` (already in server.js, lines 163-169) and the pure `configStatus` helper. When config.json is absent, `configStatus(null)` -> not configured (every field missing) - exactly what triggers the wizard. The endpoint is auth-gated by the existing middleware (server.js lines 115-120), so tests must send Basic auth like the other `/api/config` tests.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js`
  - line 44 region: add `const { configStatus } = require('./config-status');`
  - after the `GET /api/config` handler (ends line 374): add the new `GET /api/config/status` handler
  - line 514 `module.exports`: add `configStatus`
- Test: `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js` (append after line 327)

- [ ] Step 3.1: Write the failing test. Append the COMPLETE block below to the END of `/Users/stephen/scripts/auto-identity-remove/dashboard/server.test.js` (after the last test, which ends at line 327). It reuses the file's existing `buildServer`, `request`, and `basicAuth` helpers and the hermetic temp-config pattern.

```js
test('GET /api/config/status: no config file -> not configured, person fields missing', async () => {
  const { server, close } = await buildServer(); // no cfgContent -> config.json absent
  try {
    const r = await request(server, {
      pathname: '/api/config/status',
      headers: { Authorization: basicAuth('testuser', 'testpass') },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, false);
    assert.ok(Array.isArray(r.json.missing));
    assert.ok(r.json.missing.includes('person.firstName'), 'should report person.firstName missing');
    assert.ok(r.json.missing.includes('person.lastName'), 'should report person.lastName missing');
    assert.ok(r.json.missing.includes('person.email'), 'should report person.email missing');
  } finally {
    await close();
  }
});

test('GET /api/config/status: a complete person -> configured with no missing fields', async () => {
  const cfgContent = {
    person: { firstName: 'Alice', lastName: 'Smith', email: 'alice@example.com' },
  };
  const { server, close } = await buildServer({ cfgContent });
  try {
    const r = await request(server, {
      pathname: '/api/config/status',
      headers: { Authorization: basicAuth('testuser', 'testpass') },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, true);
    assert.deepEqual(r.json.missing, []);
  } finally {
    await close();
  }
});

test('GET /api/config/status: unedited example placeholder -> not configured', async () => {
  const cfgContent = {
    person: { firstName: 'Jane', lastName: 'Doe', email: 'jane.doe@example.com' },
  };
  const { server, close } = await buildServer({ cfgContent });
  try {
    const r = await request(server, {
      pathname: '/api/config/status',
      headers: { Authorization: basicAuth('testuser', 'testpass') },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, false);
    assert.ok(r.json.missing.length > 0);
  } finally {
    await close();
  }
});

test('GET /api/config/status requires auth (401 without credentials)', async () => {
  const { server, close } = await buildServer();
  try {
    const r = await request(server, { pathname: '/api/config/status' });
    assert.equal(r.status, 401);
  } finally {
    await close();
  }
});
```

- [ ] Step 3.2: Run it, expect fail. Command (from the dashboard directory): `npm --prefix dashboard test` (this runs `node --test` inside `dashboard/`, which discovers `server.test.js`). Expected failure: the three authed tests fail because `/api/config/status` returns 404 (no route), so `r.status` is `404` not `200`. (The unauthenticated test gets 401 from the auth middleware before the missing route is reached, so it may already pass; confirm at least the three authed tests fail.)

- [ ] Step 3.3: Implement. Make three edits to `/Users/stephen/scripts/auto-identity-remove/dashboard/server.js`.

Edit A - add the require. Find line 44:
```js
const { validateRunRequest, modeHonorsFilters, classifyStatus, resolveEnvCreds } = require('./validate');
```
Replace with:
```js
const { validateRunRequest, modeHonorsFilters, classifyStatus, resolveEnvCreds } = require('./validate');
const { configStatus } = require('./config-status');
```

Edit B - add the route. Find the end of the `GET /api/config` handler (lines 363-374), which currently ends:
```js
  res.json({ exists: true, config: maskConfig(m.data) });
});
```
Immediately AFTER that closing `});` (and before `app.put('/api/config', ...)` on line 376), insert:
```js

// First-run gate: report whether config.json has the required person identity
// fields filled (mirrors lib/config.js getPersonsFromConfig). The browser uses
// this on boot to decide whether to show the onboarding wizard. Absent or
// unparseable config -> not configured (configStatus(null) flags every field).
app.get('/api/config/status', (_req, res) => {
  const m = readJsonMeta(CONFIG);
  const cfg = m.parseError ? null : (m.data || null);
  res.json(configStatus(cfg));
});
```

Edit C - export the helper for completeness. Find line 514:
```js
module.exports = { app, loadBrokers, maskConfig, mergeConfig, loadCreds, MASK };
```
Replace with:
```js
module.exports = { app, loadBrokers, maskConfig, mergeConfig, loadCreds, MASK, configStatus };
```

- [ ] Step 3.4: Run, expect pass. Command: `npm --prefix dashboard test`. Expected: all `dashboard/server.test.js` tests pass, including the four new `/api/config/status` cases (configured / not configured / placeholder / auth). Also run `node --test dashboard/config-status.test.js` to confirm Task 1 still green.

- [ ] Step 3.5: Commit. Run:
```
rtk git add dashboard/server.js dashboard/server.test.js
git commit -m "Add GET /api/config/status endpoint for first-run wizard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wizard markup (index.html) and styles (styles.css)

Add a hidden overlay that the JS reveals when not configured. The markup is static and inert until app.js drives it; the fields panel is a single form whose inputs reuse the same `name="person.firstName"` dotted-name convention the existing `#configForm` uses, so the same `setPath` serializer works. All visible step panels are toggled by JS via the `.hidden` utility class (which already has `!important` precedence in styles.css line 63).

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/public/index.html` (insert after line 164, the `</div>` closing `#confirmModal`, and before `<script src="app.js"></script>` on line 166)
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/public/styles.css` (append at end, after line 154)

This task has no automated test (static HTML/CSS). Verification is structural: confirm the elements the JS in Task 5 queries exist with the exact ids/names.

- [ ] Step 4.1: Write the markup. In `/Users/stephen/scripts/auto-identity-remove/dashboard/public/index.html`, find these lines (164-166):
```html
    </div>
  </div>

  <script src="app.js"></script>
```
Insert the wizard block BETWEEN the `</div>` that closes `#confirmModal` (line 164) and the `<script>` tag. The result should read:
```html
    </div>
  </div>

  <div class="wizard hidden" id="wizard" role="dialog" aria-modal="true" aria-labelledby="wizTitle">
    <div class="wizard-box">
      <header class="wizard-head">
        <h2 id="wizTitle">Welcome - let's set you up</h2>
        <p class="dim">A few quick questions. Your answers are saved only to this machine's <code>config.json</code> (never sent anywhere else). You can change everything later in the Config tab.</p>
        <ol class="wizard-steps" id="wizSteps" aria-hidden="true"></ol>
      </header>

      <form id="wizardForm" class="wizard-form" autocomplete="off">
        <!-- Step 1: Person -->
        <section class="wiz-step" data-step="0">
          <h3>Who are we removing?</h3>
          <p class="wiz-why dim">Data brokers list people by name and contact details. We need your real name and an email so the opt-out requests can identify and reach you.</p>
          <label>First name <span class="req">*</span> <input name="person.firstName" required /></label>
          <label>Last name <span class="req">*</span> <input name="person.lastName" required /></label>
          <label>Full name <span class="dim">(auto-filled - adjust if you go by something else)</span> <input name="person.fullName" /></label>
          <label>Aliases <span class="dim">(comma-separated maiden / nicknames brokers might use)</span> <input name="person.aliases" /></label>
          <label>Email <span class="req">*</span> <input name="person.email" type="email" required /></label>
          <p class="wiz-err" data-err="0"></p>
        </section>

        <!-- Step 2: Region / Country -->
        <section class="wiz-step hidden" data-step="1">
          <h3>Where are you?</h3>
          <p class="wiz-why dim">Some brokers are US-only and the request wording (CCPA vs GDPR) depends on your country. City/state/ZIP help match the right person on listing pages.</p>
          <label>Country <span class="req">*</span> <input name="person.country" placeholder="US" required /></label>
          <label>City <input name="person.city" /></label>
          <label>State / Region <span class="dim">(e.g. TX, ON, NSW)</span> <input name="person.state" /></label>
          <label>ZIP / Postal <span class="dim">(any format: 73301, K1A 0A6, SW1A 1AA)</span> <input name="person.zip" /></label>
          <label>Phone (digits only) <input name="person.phone" /></label>
          <label>Phone formatted <span class="dim">(auto for US/CA - leave as typed for other countries)</span> <input name="person.phoneFormatted" /></label>
          <p class="wiz-err" data-err="1"></p>
        </section>

        <!-- Step 3: CapSolver (optional) -->
        <section class="wiz-step hidden" data-step="2">
          <h3>CAPTCHA solving <span class="dim">- optional, skip for now</span></h3>
          <p class="wiz-why dim">A few broker sites show a CAPTCHA. A CapSolver key lets the tool solve them automatically. You can skip this and add it later in the Config tab - those brokers will just be logged for manual handling.</p>
          <label>CapSolver API key <input name="capsolver.apiKey" type="password" placeholder="CAP-... (leave blank to skip)" /></label>
        </section>

        <!-- Step 4: Email / SMTP (optional) -->
        <section class="wiz-step hidden" data-step="3">
          <h3>Sending opt-out emails <span class="dim">- optional</span></h3>
          <p class="wiz-why dim">Some brokers only accept removal requests by email. With SMTP set up, the tool sends those for you; without it they are logged as "manual". Gmail: host <code>smtp.gmail.com</code>, port 587, use an App Password.</p>
          <label>SMTP host <input name="email.smtp.host" placeholder="smtp.gmail.com" /></label>
          <label>Port <input name="email.smtp.port" type="number" placeholder="587" /></label>
          <label>User <input name="email.smtp.user" placeholder="you@gmail.com" /></label>
          <label>Password / App-password <input name="email.smtp.pass" type="password" /></label>
          <label>From <input name="email.smtp.from" placeholder="you@gmail.com" /></label>
          <p class="wiz-err" data-err="3"></p>
        </section>

        <!-- Step 5: Notifications (optional) -->
        <section class="wiz-step hidden" data-step="4">
          <h3>Notifications <span class="dim">- optional</span></h3>
          <p class="wiz-why dim">Get a ping when a run finishes. A webhook works on any OS (ntfy.sh, Slack, Discord). iMessage texting is macOS-only. Both are optional.</p>
          <label>Webhook URL <input name="notify.webhook" placeholder="https://ntfy.sh/your-topic" /></label>
          <label>Text to (macOS iMessage) <input name="notify.textTo" placeholder="+15125550000" /></label>
          <p class="wiz-err" data-err="4"></p>
        </section>

        <!-- Step 6: Review -->
        <section class="wiz-step hidden" data-step="5">
          <h3>Review &amp; save</h3>
          <p class="wiz-why dim">Here is what will be written to <code>config.json</code>. Secrets are shown masked. Go back to change anything.</p>
          <dl class="wiz-review" id="wizReview"></dl>
          <p class="wiz-err" data-err="5"></p>
        </section>
      </form>

      <footer class="wizard-actions">
        <button type="button" class="btn" id="wizBack" disabled>Back</button>
        <button type="button" class="btn" id="wizSkip">Skip this step</button>
        <button type="button" class="btn btn-primary" id="wizNext">Next</button>
        <button type="button" class="btn btn-primary hidden" id="wizFinish">Save &amp; finish</button>
      </footer>
    </div>
  </div>

  <script src="app.js"></script>
```

- [ ] Step 4.2: Verify markup structurally (no test runner). Command:
```
rtk grep -n 'id="wizard"\|id="wizardForm"\|id="wizSteps"\|id="wizReview"\|id="wizBack"\|id="wizSkip"\|id="wizNext"\|id="wizFinish"\|data-step=\|data-err=' dashboard/public/index.html
```
Expected: matches for every id above, six `data-step="0".."5"` sections, and `data-err` placeholders. This is the contract Task 5's JS depends on.

- [ ] Step 4.3: Add the styles. Append the COMPLETE block below to the END of `/Users/stephen/scripts/auto-identity-remove/dashboard/public/styles.css` (after line 154). It reuses the existing CSS variables (`--panel`, `--border`, `--accent`, `--danger`, `--dim`) and the existing `.btn` / `.hidden` rules.

```css

/* ---------- first-run wizard ---------- */
.wizard { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex;
  align-items: center; justify-content: center; z-index: 30; padding: 16px; }
.wizard-box { background: var(--panel); border: 1px solid var(--accent); border-radius: 14px;
  padding: 22px; width: 100%; max-width: 560px; max-height: 92vh; overflow: auto; }
.wizard-head h2 { font-size: 20px; margin: 0 0 6px; }
.wizard-steps { display: flex; gap: 6px; list-style: none; padding: 0; margin: 14px 0 6px; flex-wrap: wrap; }
.wizard-steps li { font-size: 11px; color: var(--dim); padding: 3px 8px; border-radius: 999px;
  background: var(--panel2); border: 1px solid var(--border); }
.wizard-steps li.active { color: var(--text); border-color: var(--accent); }
.wizard-steps li.done { color: #7ee787; border-color: #238636; }
.wizard-form { margin: 8px 0 0; }
.wiz-step h3 { margin: 12px 0 4px; font-size: 15px; }
.wiz-why { font-size: 12.5px; margin: 0 0 12px; }
.wiz-step label { display: flex; flex-direction: column; gap: 4px; font-size: 12px;
  color: var(--dim); margin-bottom: 12px; }
.wiz-step input { width: 100%; }
.req { color: var(--danger); }
.wiz-err { color: #ff7b72; font-size: 12.5px; min-height: 16px; margin: 4px 0 0; }
.wiz-review { margin: 8px 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; }
.wiz-review dt { color: var(--dim); font-size: 12px; }
.wiz-review dd { margin: 0; font-size: 13px; word-break: break-word; }
.wizard-actions { display: flex; gap: 8px; align-items: center; margin-top: 18px; }
.wizard-actions #wizSkip { margin-left: auto; }
@media (max-width: 600px) {
  .wizard-box { padding: 16px; }
  .wizard-actions { flex-wrap: wrap; }
  .wizard-actions #wizSkip { margin-left: 0; }
}
```

- [ ] Step 4.4: Verify styles applied. Command: `rtk grep -n '.wizard\b\|.wiz-step\|.wiz-review\|.wizard-actions' dashboard/public/styles.css`. Expected: the new rules are present at the end of the file.

- [ ] Step 4.5: Commit. Run:
```
rtk git add dashboard/public/index.html dashboard/public/styles.css
git commit -m "Add first-run wizard markup and styles to dashboard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wizard controller in app.js (boot gate + steps + save)

Drive the static markup: on boot, fetch `/config/status`; if not configured, prefill the wizard from `config.example.json` (served via `/config` when config.json is absent: the server returns `{ exists:false, config: <example> }`), step through panels with Next/Back/Skip, validate required fields per step, render the masked review, then `PUT /config` with the collected values and hide the overlay on success. All DOM insertion uses the existing `esc()` helper; step-error text uses `textContent`; review uses `esc()` on every interpolated value before `innerHTML` (the established pattern already used throughout app.js, e.g. `renderBrokers` and `loadLogs`). The existing `setPath`/`getPath` helpers (app.js lines 308-309) and `MASK` constant (line 23) are reused.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js`
  - Insert the wizard module just BEFORE the `// ---------- boot ----------` comment (line 357).
  - Replace the boot block (lines 357-361) so the wizard gate runs first.

- [ ] Step 5.1: Write the failing test. The wizard is browser-only DOM code with no Node test harness in this repo (no jsdom dependency, and we are not adding one). The behavioral contract is already covered server-side by Task 3's `/api/config/status` tests and Task 1's `configStatus` unit tests; the client merely consumes them. So the "test" for this task is a structural assertion that the controller wires to the exact element ids/names from Task 4 and uses the safe helpers. Write this verification as an executable check (run in Step 5.2 and again in 5.4) - save it to a temp file first:
```
cat > /tmp/wiz-wiring-check.js <<'CHK'
const s = require('fs').readFileSync('dashboard/public/app.js', 'utf8');
const need = ['initWizard', '#wizard', '#wizardForm', '#wizNext', '#wizBack',
  '#wizSkip', '#wizFinish', '#wizReview', '#wizSteps', '/config/status',
  'EXAMPLE_CONFIG_FALLBACK', 'esc('];
const missing = need.filter(x => !s.includes(x));
if (missing.length) { console.error('MISSING:', missing.join(', ')); process.exit(1); }
console.log('app.js wizard wiring OK');
CHK
node /tmp/wiz-wiring-check.js
```

- [ ] Step 5.2: Run it, expect fail. Command: `node /tmp/wiz-wiring-check.js`. Expected: it prints `MISSING: initWizard, #wizard, ...` and exits 1 (none of the wizard wiring exists yet).

- [ ] Step 5.3: Implement. Two edits to `/Users/stephen/scripts/auto-identity-remove/dashboard/public/app.js`.

Edit A - insert the wizard module. Find this block (lines 357-361):
```js
// ---------- boot ----------
loadSummary(); loadBrokers();
setInterval(loadSummary, 15000);
// Reconnect to an in-progress run if the page was opened/reloaded mid-run
api('/run/status').then(s => { if (s && s.running) { setRunning(true, s.mode); openStream(); startRunPoll(); } }).catch(() => {});
```
Replace that ENTIRE block with the following (the wizard module + a gated boot):
```js
// ---------- first-run wizard ----------
// Required person fields (mirrors dashboard/config-status.js REQUIRED_PERSON_FIELDS
// and lib/config.js getPersonsFromConfig). Keep in sync.
const WIZ_REQUIRED = ['person.firstName', 'person.lastName', 'person.email'];
// Per-step required field paths (index matches data-step). Steps 2/3/4 are optional.
const WIZ_STEP_REQUIRED = [
  ['person.firstName', 'person.lastName', 'person.email'], // step 0: Person
  ['person.country'],                                      // step 1: Region/Country
  [],                                                      // step 2: CapSolver (optional)
  [],                                                      // step 3: SMTP (optional)
  [],                                                      // step 4: Notifications (optional)
  [],                                                      // step 5: Review
];
const WIZ_TOTAL_STEPS = 6;
const WIZ_STEP_NAMES = ['Person', 'Region', 'CapSolver', 'Email', 'Notify', 'Review'];
// Minimal fallback if /config cannot return the example (network/parse issue):
// the wizard must still open with sensible blanks.
const EXAMPLE_CONFIG_FALLBACK = {
  person: { firstName: '', lastName: '', fullName: '', aliases: [], city: '',
    country: 'US', state: '', zip: '', email: '', phone: '', phoneFormatted: '' },
};
// Fields treated as secrets in the review (shown as "(set)" / "(blank)", never the value).
const WIZ_SECRET_PATHS = new Set(['capsolver.apiKey', 'email.smtp.pass', 'notify.webhook']);
// Exact placeholder values shipped in config.example.json. When config.json is
// absent the server returns the raw example (unmasked) from GET /api/config, so
// the wizard must blank these out rather than silently saving the samples as if
// they were real answers. Keyed by the dotted input name. Aliases (an array) is
// handled separately in wizPrefill after the join.
const WIZ_EXAMPLE_PLACEHOLDERS = {
  'person.firstName': 'Jane',
  'person.lastName': 'Doe',
  'person.fullName': 'Jane Doe',
  'person.city': 'Austin',
  'person.state': 'TX',
  'person.zip': '73301',
  'person.email': 'jane.doe@example.com',
  'person.phone': '5125550000',
  'person.phoneFormatted': '(512) 555-0000',
  'capsolver.apiKey': 'CAP-YOUR_KEY_HERE',
  'email.smtp.host': 'smtp.gmail.com',
  'email.smtp.user': 'you@gmail.com',
  'email.smtp.pass': 'YOUR_GMAIL_APP_PASSWORD',
  'email.smtp.from': 'you@gmail.com',
  'notify.textTo': '+15125550000',
};
// The example's sample aliases, blanked the same way (it is an array, so it is
// matched after wizPrefill joins it to a comma string).
const WIZ_EXAMPLE_ALIASES = 'Jan Doe, Jane M Doe';

let wizStep = 0;

function wizEl() {
  return {
    overlay: $('#wizard'), form: $('#wizardForm'), steps: $('#wizSteps'),
    review: $('#wizReview'), back: $('#wizBack'), skip: $('#wizSkip'),
    next: $('#wizNext'), finish: $('#wizFinish'),
  };
}
function wizGetValue(name) {
  const inp = $(`#wizardForm input[name="${name}"]`);
  return inp ? inp.value.trim() : '';
}
// Prefill the wizard inputs from the example config the server returns when
// config.json is absent (or from a partial live config if one exists).
function wizPrefill(cfg) {
  const c = cfg || EXAMPLE_CONFIG_FALLBACK;
  $$('#wizardForm input').forEach(inp => {
    let v = getPath(c, inp.name);
    if (inp.name === 'person.aliases' && Array.isArray(v)) v = v.join(', ');
    // Blank any value that is still the verbatim config.example.json sample so
    // the wizard never silently saves placeholders (Jane Doe, CAP-YOUR_KEY_HERE,
    // YOUR_GMAIL_APP_PASSWORD, the sample phone/city/state/zip, etc.) as answers.
    if (typeof v === 'string' && WIZ_EXAMPLE_PLACEHOLDERS[inp.name] === v) v = '';
    if (inp.name === 'person.aliases' && v === WIZ_EXAMPLE_ALIASES) v = '';
    // Do not prefill masked secrets into the wizard.
    if (typeof v === 'string' && v === MASK) v = '';
    inp.value = v == null ? '' : v;
  });
}
function wizRenderSteps() {
  const { steps } = wizEl();
  steps.innerHTML = WIZ_STEP_NAMES.map((n, i) => {
    const cls = i === wizStep ? 'active' : (i < wizStep ? 'done' : '');
    return `<li class="${cls}">${esc((i + 1) + '. ' + n)}</li>`;
  }).join('');
}
function wizShowStep(n) {
  wizStep = Math.max(0, Math.min(WIZ_TOTAL_STEPS - 1, n));
  $$('#wizardForm .wiz-step').forEach(sec => {
    sec.classList.toggle('hidden', Number(sec.dataset.step) !== wizStep);
  });
  $$('.wiz-err').forEach(e => { e.textContent = ''; });
  const { back, skip, next, finish } = wizEl();
  back.disabled = wizStep === 0;
  const isReview = wizStep === WIZ_TOTAL_STEPS - 1;
  const isOptional = WIZ_STEP_REQUIRED[wizStep].length === 0 && !isReview;
  skip.classList.toggle('hidden', !isOptional);
  next.classList.toggle('hidden', isReview);
  finish.classList.toggle('hidden', !isReview);
  if (isReview) wizRenderReview();
  wizRenderSteps();
}
// Collect the wizard inputs into a nested config object (same convention as the
// Config tab's save: dotted input names -> nested object via setPath).
function wizCollect() {
  const cfg = {};
  $$('#wizardForm input').forEach(inp => {
    let v = inp.value.trim();
    if (v === '') return; // omit blanks so the PUT merge does not clobber anything
    if (inp.name === 'person.aliases') {
      const arr = v.split(',').map(s => s.trim()).filter(Boolean);
      if (arr.length === 0) return;
      v = arr;
    }
    if (inp.name === 'email.smtp.port') v = parseInt(v, 10) || v;
    setPath(cfg, inp.name, v);
  });
  // Default fullName from first+last when the user left it blank.
  const fn = wizGetValue('person.firstName'), ln = wizGetValue('person.lastName');
  if (!wizGetValue('person.fullName') && (fn || ln)) {
    setPath(cfg, 'person.fullName', [fn, ln].filter(Boolean).join(' '));
  }
  return cfg;
}
function wizValidateStep() {
  const required = WIZ_STEP_REQUIRED[wizStep] || [];
  const blank = required.filter(p => wizGetValue(p) === '');
  const errEl = $(`.wiz-err[data-err="${wizStep}"]`);
  if (blank.length) {
    const labels = blank.map(p => p.replace('person.', '')).join(', ');
    if (errEl) errEl.textContent = 'Please fill: ' + labels;
    return false;
  }
  // Light email sanity check on the Person step.
  if (wizStep === 0) {
    const email = wizGetValue('person.email');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      if (errEl) errEl.textContent = 'That email does not look valid.';
      return false;
    }
  }
  if (errEl) errEl.textContent = '';
  return true;
}
function wizRenderReview() {
  const cfg = wizCollect();
  const rows = [];
  const add = (label, path) => {
    let v = getPath(cfg, path);
    if (Array.isArray(v)) v = v.join(', ');
    if (WIZ_SECRET_PATHS.has(path)) v = (v ? '(set)' : '(blank)');
    const display = (v == null || v === '') ? '(blank)' : String(v);
    rows.push(`<dt>${esc(label)}</dt><dd>${esc(display)}</dd>`);
  };
  add('First name', 'person.firstName');
  add('Last name', 'person.lastName');
  add('Full name', 'person.fullName');
  add('Aliases', 'person.aliases');
  add('Email', 'person.email');
  add('Country', 'person.country');
  add('City', 'person.city');
  add('State / Region', 'person.state');
  add('ZIP / Postal', 'person.zip');
  add('Phone', 'person.phone');
  add('CapSolver key', 'capsolver.apiKey');
  add('SMTP host', 'email.smtp.host');
  add('SMTP user', 'email.smtp.user');
  add('SMTP password', 'email.smtp.pass');
  add('Webhook', 'notify.webhook');
  add('Text to', 'notify.textTo');
  $('#wizReview').innerHTML = rows.join('');
}
async function wizFinish() {
  // Final guard: every globally-required field must be present.
  const missing = WIZ_REQUIRED.filter(p => wizGetValue(p) === '');
  const errEl = $('.wiz-err[data-err="5"]');
  if (missing.length) {
    if (errEl) errEl.textContent = 'Missing required: ' + missing.map(p => p.replace('person.', '')).join(', ') + '. Go back to the Person step.';
    return;
  }
  const cfg = wizCollect();
  const { finish } = wizEl();
  finish.disabled = true;
  try {
    const r = await api('/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: cfg }) });
    if (r && r.ok) {
      wizEl().overlay.classList.add('hidden');
      // Reveal the live dashboard now that config exists.
      loadSummary(); loadBrokers();
    } else {
      if (errEl) errEl.textContent = ((r && r.error) || 'save failed');
      finish.disabled = false;
    }
  } catch (err) {
    if (errEl) errEl.textContent = (err && err.message || String(err));
    finish.disabled = false;
  }
}
function wizWire() {
  const { overlay, back, skip, next, finish } = wizEl();
  if (!overlay) return;
  back.addEventListener('click', () => wizShowStep(wizStep - 1));
  skip.addEventListener('click', () => wizShowStep(wizStep + 1));
  next.addEventListener('click', () => { if (wizValidateStep()) wizShowStep(wizStep + 1); });
  finish.addEventListener('click', wizFinish);
}
async function initWizard() {
  let status;
  try { status = await api('/config/status'); } catch (_) { status = null; }
  if (!status || status.configured) return false; // already set up: skip the wizard
  // Prefill from the server (example config when config.json is absent).
  let cfgResp;
  try { cfgResp = await api('/config'); } catch (_) { cfgResp = null; }
  wizPrefill((cfgResp && cfgResp.config) || EXAMPLE_CONFIG_FALLBACK);
  wizWire();
  wizStep = 0;
  wizShowStep(0);
  wizEl().overlay.classList.remove('hidden');
  return true;
}

// ---------- boot ----------
(async () => {
  const wizardShown = await initWizard();
  loadSummary(); loadBrokers();
  setInterval(loadSummary, 15000);
  if (!wizardShown) {
    // Reconnect to an in-progress run if the page was opened/reloaded mid-run.
    api('/run/status').then(s => { if (s && s.running) { setRunning(true, s.mode); openStream(); startRunPoll(); } }).catch(() => {});
  }
})();
```

(Note: `getPath` and `setPath` are defined earlier in app.js at lines 308-309, and `MASK` at line 23, so they are in scope. `$`, `$$`, `esc`, `api`, `loadSummary`, `loadBrokers`, `setRunning`, `openStream`, `startRunPoll` are the existing top-level helpers.)

- [ ] Step 5.4: Run, expect pass. Command: `node /tmp/wiz-wiring-check.js`. Expected: prints `app.js wizard wiring OK` and exits 0. Then run the dashboard test suite to confirm no server-side regression: `npm --prefix dashboard test` (expect green).

- [ ] Step 5.5: Commit. Run:
```
rtk git add dashboard/public/app.js
git commit -m "Drive first-run config wizard from dashboard app.js

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full-suite verification (root + dashboard)

Confirm the whole project is green on both test commands the CI uses: the root matrix command and the dashboard-local command.

Files: none modified (verification only).

- [ ] Step 6.1: Run the root suite. Command: `npm test` (which is now `node --test test/*.test.js dashboard/validate.test.js dashboard/config-status.test.js`). Expected: all tests pass, including the 9 `config-status.test.js` cases. Note the `pass`/`fail` totals from the summary line.

- [ ] Step 6.2: Run the dashboard suite. Command: `npm --prefix dashboard test` (runs `node --test` inside `dashboard/`, discovering `server.test.js`, `validate.test.js`, and `config-status.test.js`). Expected: all pass, including the four new `/api/config/status` cases.

- [ ] Step 6.3: Sanity-check the helper shape by hand (optional but recommended, hermetic). Command:
```
node -e "const {configStatus}=require('./dashboard/config-status'); console.log(JSON.stringify(configStatus(null))); console.log(JSON.stringify(configStatus({person:{firstName:'A',lastName:'B',email:'a@b.co'}})));"
```
Expected output (two lines):
```
{"configured":false,"missing":["person.firstName","person.lastName","person.email"]}
{"configured":true,"missing":[]}
```

- [ ] Step 6.4: Confirm no stray files / no real config touched. Command: `rtk git status`. Expected: only the files in the File map are changed; `config.json` and `state.json` are NOT modified (the server tests restore them, and no step writes to the real ones). If `git status` shows `config.json`/`state.json` as modified, inspect with `rtk git diff config.json state.json`, then `git checkout -- config.json state.json` if the change is test residue.

- [ ] Step 6.5: Final commit (only if Step 6.4 surfaced a doc or whitespace tweak; otherwise skip). If nothing to commit, do nothing. Otherwise:
```
rtk git add -A
git commit -m "Tidy after full-suite verification of config wizard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage:
- "detect no-config / incomplete-config server-side and expose GET /api/config/status returning {configured, missing:[...]}" - Task 1 builds the pure `configStatus(cfg)` -> `{ configured, missing }`; Task 3 wires `GET /api/config/status` returning exactly that shape, gated by the existing auth middleware. `configStatus(null)` (absent/unparseable config) reports not-configured, satisfying both "no-config" and "incomplete-config" (placeholder Jane Doe is rejected).
- "multi-step wizard (Person -> Region/Country -> CapSolver [skip] -> Email/SMTP -> Notifications -> Review)" - Task 4 markup has exactly six `data-step` panels in that order; the CapSolver step shows "skip for now" copy and is optional; Task 5 drives Next/Back/Skip and the review.
- "writes via the EXISTING PUT /api/config (merges + preserves masked secrets + atomic 0600)" - Task 5 `wizFinish()` calls `api('/config', { method:'PUT', body: JSON.stringify({ config: cfg }) })`; no new write path. The wizard omits blank fields so the merge never clobbers, and never sends `MASK` (secrets are re-entered fresh or left blank).
- "Prefill from config.example.json" - Task 5 `initWizard()` calls `/config`, which (per server.js lines 369-372) returns `{ exists:false, config: <example> }` (raw, unmasked) when config.json is absent; `wizPrefill` loads it and blanks EVERY field whose value is still the verbatim example sample (via `WIZ_EXAMPLE_PLACEHOLDERS` + `WIZ_EXAMPLE_ALIASES`), so the user never unknowingly saves placeholders like `CAP-YOUR_KEY_HERE` or `YOUR_GMAIL_APP_PASSWORD`.
- "Validate required fields client-side" - `WIZ_STEP_REQUIRED` + `wizValidateStep()` + the final `wizFinish` guard; required fields mirror `lib/config.js` `getPersonsFromConfig` (firstName/lastName/email).
- "Each step explains in plain English why it is asked" - every `.wiz-why` paragraph in Task 4.
- "After save, transition to the normal dashboard" - `wizFinish` hides `#wizard` and calls `loadSummary()`/`loadBrokers()`; the boot gate only attaches the run-reconnect when the wizard was NOT shown.
- "Keep all DOM insertion escaped" - review rows and step labels use `esc(...)`; step error text uses `textContent`; inputs are set via `.value` (no innerHTML). The existing `esc`/`safeUrl` helpers are reused, matching `renderBrokers`/`loadLogs`.
- "Tests: a dashboard/server.test.js case for /api/config/status (configured vs not) using the hermetic temp-config pattern already there" - Task 3 adds four cases reusing `buildServer`/`request`/`basicAuth`.
- Integration/wiring task - Task 3 adds the dashboard endpoint (the applicable integration point; this feature is dashboard-only, so no watcher.js CLI flag is needed - `setup.js` remains the CLI path per the brief). Task 2 wires the new unit test into both the root `npm test` and CI.
- Final full-suite task - Task 6 runs `npm test` (root) and `npm --prefix dashboard test` (dashboard) and confirms green plus no real config/state mutation.

No placeholders: every code step contains complete, real code (full function bodies, full test files, exact Edit anchors with old/new strings). No "TBD", no "add X", no "similar to above".

Signature consistency with the repo map:
- Reused server.js internals verified against the file: `readJsonMeta(CONFIG)` (lines 163-169), `maskConfig`/`mergeConfig`, `MASK = '••••••••'` (line 62), the auth middleware that exempts only `/api/health` (lines 115-120), and the existing `module.exports` (line 514). New export `configStatus` appended without removing any existing export.
- `PUT /api/config` accepts `{ config }` OR a bare object (server.js line 377: `req.body.config ? req.body.config : req.body`); the wizard sends `{ config: cfg }`, matching the Config tab's save (app.js line 333).
- app.js reused helpers verified present: `$`/`$$` (lines 2-3), `api()` (lines 5-11), `esc()` (lines 16-17), `MASK` (line 23), `getPath`/`setPath` (lines 308-309), `loadSummary` (line 28), `loadBrokers` (line 94), `setRunning`/`openStream`/`startRunPoll` (lines 152, 128, 158). The wizard module is inserted before the boot block and the boot block is rewritten to gate on `initWizard()`.
- config.example.json field set (person.firstName/lastName/fullName/aliases/city/country/state/zip/email/phone/phoneFormatted, capsolver.apiKey, email.smtp.{host,port,user,pass,from}, notify.{webhook,textTo}) matches the wizard inputs one-for-one.
- Required-person contract matches `lib/config.js` `getPersonsFromConfig` (lines 278-289): persons[] non-empty takes precedence over person; both are validated by `configStatus` via `effectivePerson`.
- CommonJS only (`require`/`module.exports`), no TypeScript, no new npm dependencies, no em dashes in authored prose (hyphens used throughout), and `rtk` prefixes used on the bash read/grep/git commands per repo convention.
