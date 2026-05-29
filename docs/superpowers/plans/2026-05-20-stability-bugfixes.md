# Stability Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four real automation bugs: false success logging, bot detection blocks, unsolved hCAPTCHAs, and accidental wrong-field fills.

**Architecture:** Each fix is an isolated module change. Tasks 1-3 each create one new file plus tests. Task 4 modifies one existing file. All tasks are independent - no shared state between them.

**Tech Stack:** Node.js 18+, Playwright, node:test, node:assert/strict

---

## File map

| Task | Creates | Modifies |
|---|---|---|
| 1 (success detection) | `lib/success.js`, `test/success.test.js` | `lib/broker-runner.js` |
| 2 (stealth) | `lib/stealth.js`, `test/stealth.test.js` | `watcher.js` |
| 3 (CapSolver robustness) | `test/captcha.test.js` | `lib/captcha.js` |
| 4 (selector collision) | `test/forms-selector.test.js` | `lib/forms.js` |

---

## Task 1: Post-submit success verification

**The bug:** After clicking submit, `broker-runner.js` checks only for "check your email" text. If that phrase is absent, it logs `success` and starts a 90-day cooldown - even when the form silently 400'd or JS validation blocked the submit entirely. `state.json` accumulates false successes.

**Fix:** New `lib/success.js` with `classifyPostSubmit(text)` that scans post-submit page body text for explicit success/failure signals. `broker-runner.js` uses the outcome to decide whether to log `success`, `error`, or the existing `pending_confirm`.

**Files:**
- Create: `lib/success.js`
- Create: `test/success.test.js`
- Modify: `lib/broker-runner.js` (lines 146-157, the confirm/success block)

---

- [ ] **Step 1.1: Write failing tests for `lib/success.js`**

Create `test/success.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeSuccess, looksLikeFailure, classifyPostSubmit } = require('../lib/success');

test('looksLikeSuccess: true for "request received"', () => {
  assert.ok(looksLikeSuccess('Your opt-out request has been received.'));
});
test('looksLikeSuccess: true for "successfully submitted"', () => {
  assert.ok(looksLikeSuccess('Your request was successfully submitted.'));
});
test('looksLikeSuccess: true for "you have been removed"', () => {
  assert.ok(looksLikeSuccess('You have been removed from our database.'));
});
test('looksLikeSuccess: true for "removal complete"', () => {
  assert.ok(looksLikeSuccess('Removal complete. Allow 7 days for processing.'));
});
test('looksLikeSuccess: true for "opt-out complete"', () => {
  assert.ok(looksLikeSuccess('Your opt-out is complete.'));
});
test('looksLikeSuccess: true for "we have received your request"', () => {
  assert.ok(looksLikeSuccess('We have received your deletion request.'));
});
test('looksLikeSuccess: false for generic page text', () => {
  assert.ok(!looksLikeSuccess('Welcome. Please fill out the form below.'));
});
test('looksLikeSuccess: false for empty string', () => {
  assert.ok(!looksLikeSuccess(''));
});
test('looksLikeFailure: true for "required field"', () => {
  assert.ok(looksLikeFailure('This field is required. Please correct the errors below.'));
});
test('looksLikeFailure: true for "invalid email"', () => {
  assert.ok(looksLikeFailure('Please enter a valid email address.'));
});
test('looksLikeFailure: true for "something went wrong"', () => {
  assert.ok(looksLikeFailure('Something went wrong. Please try again later.'));
});
test('looksLikeFailure: false for success text', () => {
  assert.ok(!looksLikeFailure('Your request was successfully submitted.'));
});
test('classifyPostSubmit: success when success phrase present', () => {
  const r = classifyPostSubmit('Your opt-out request has been received.');
  assert.equal(r.outcome, 'success');
  assert.ok(r.snippet.length > 0);
});
test('classifyPostSubmit: failure when error phrase present', () => {
  const r = classifyPostSubmit('This field is required.');
  assert.equal(r.outcome, 'failure');
});
test('classifyPostSubmit: unknown when neither phrase present', () => {
  const r = classifyPostSubmit('Please fill in the form.');
  assert.equal(r.outcome, 'unknown');
  assert.equal(r.snippet, '');
});
test('classifyPostSubmit: handles null gracefully', () => {
  assert.equal(classifyPostSubmit(null).outcome, 'unknown');
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
node --test test/success.test.js
```

Expected: all 16 tests fail with `Cannot find module '../lib/success'`

- [ ] **Step 1.3: Create `lib/success.js`**

```js
/**
 * lib/success.js
 *
 * Post-submit page text analysis. Classifies whether an opt-out form submission
 * appears to have succeeded, failed, or is ambiguous.
 *
 * Patterns are deliberately conservative: false positives (logging a failed
 * submission as success) cause a 90-day cooldown that hides live data exposure.
 */

const SUCCESS_PATTERN = /(your (opt-?out|removal|deletion|request) (is |has been |was )?(complete|received|submitted|processed|confirmed)|you('ve| have) been (removed|deleted|opted out)|we('ve| have) received your (request|opt-?out|deletion)|successfully (submitted|removed|processed|opted out)|removal (complete|confirmed|processed)|request (received|confirmed|submitted))/i;

const FAILURE_PATTERN = /(this field is required|please (enter|provide|fill|correct)|invalid (email|phone|zip|postal|address)|something went wrong|an error (has occurred|occurred)|please try again|submission failed|could not (process|submit)|required field)/i;

function looksLikeSuccess(text) {
  if (!text || typeof text !== 'string') return false;
  return SUCCESS_PATTERN.test(text);
}

function looksLikeFailure(text) {
  if (!text || typeof text !== 'string') return false;
  return FAILURE_PATTERN.test(text);
}

/**
 * @param {string|null|undefined} text  Page body innerText after submit
 * @returns {{ outcome: 'success'|'failure'|'unknown', snippet: string }}
 */
function classifyPostSubmit(text) {
  if (!text || typeof text !== 'string') return { outcome: 'unknown', snippet: '' };

  if (looksLikeSuccess(text)) {
    const m = text.match(SUCCESS_PATTERN);
    const snippet = m
      ? text.slice(Math.max(0, m.index - 20), m.index + 100).replace(/\s+/g, ' ').trim()
      : '';
    return { outcome: 'success', snippet };
  }

  if (looksLikeFailure(text)) {
    const m = text.match(FAILURE_PATTERN);
    const snippet = m
      ? text.slice(Math.max(0, m.index - 20), m.index + 100).replace(/\s+/g, ' ').trim()
      : '';
    return { outcome: 'failure', snippet };
  }

  return { outcome: 'unknown', snippet: '' };
}

module.exports = { looksLikeSuccess, looksLikeFailure, classifyPostSubmit, SUCCESS_PATTERN, FAILURE_PATTERN };
```

- [ ] **Step 1.4: Run tests to confirm they pass**

```bash
node --test test/success.test.js
```

Expected: all 16 tests pass.

- [ ] **Step 1.5: Modify `lib/broker-runner.js` - add require and update the confirm block**

Add after the existing requires at the top:

```js
const { classifyPostSubmit } = require('./success');
```

Replace the block starting at `// Step 6` (currently lines 146-157):

```js
    // Step 6: check post-submit page. First check for email-confirmation
    // requirement, then verify success via DOM text. Click-then-assume is a
    // false-positive source - forms can fail silently on the client side.
    const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const confirm = await detectConfirmationRequired(page);
    if (confirm.pending) {
      logResult(broker.name, 'pending_confirm', confirm.snippet || 'check your email to confirm');
      recordPendingConfirmation(broker.name, confirm.snippet);
    } else {
      const { outcome, snippet } = classifyPostSubmit(body);
      if (outcome === 'failure') {
        // Form validation error or server error - do NOT start 90-day cooldown
        logResult(broker.name, 'error', snippet || 'form submission may have failed');
        recordFailure(broker.name, 'error');
      } else {
        // 'success' = explicit confirmation text found
        // 'unknown' = no feedback text (common on many brokers) - record success,
        //             tagged so audit reports can flag for manual verification
        const detail = outcome === 'success' ? snippet : 'no explicit confirmation - assumed ok';
        logResult(broker.name, 'success', detail);
        recordSuccess(broker.name);
      }
    }
```

- [ ] **Step 1.6: Run full test suite**

```bash
node --test
```

Expected: all existing tests pass plus 16 new success tests.

- [ ] **Step 1.7: Commit**

```bash
git add lib/success.js test/success.test.js lib/broker-runner.js
git commit -m "fix: post-submit success verification via DOM text scan"
git push
```

---

## Task 2: Playwright stealth - mask navigator.webdriver

**The bug:** Vanilla Playwright sets `navigator.webdriver = true` and presents an empty `navigator.plugins` array. Modern WAFs (Cloudflare, Akamai, PerimeterX) detect these signals and serve a 403 or infinite Turnstile loop before the opt-out form is reachable. `--disable-blink-features=AutomationControlled` in watcher.js is set but does not fully mask `navigator.webdriver`.

**Fix:** New `lib/stealth.js` that exports `buildStealthScript()` - a plain string of JS that `context.addInitScript()` injects on every page before any page script runs. Overrides `navigator.webdriver`, adds a realistic plugins stub, and ensures `navigator.languages` is set.

**Files:**
- Create: `lib/stealth.js`
- Create: `test/stealth.test.js`
- Modify: `watcher.js` (add one `await context.addInitScript(...)` line after `launchPersistentContext`)

---

- [ ] **Step 2.1: Write failing tests for `lib/stealth.js`**

Create `test/stealth.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildStealthScript } = require('../lib/stealth');

test('buildStealthScript returns a non-empty string', () => {
  const script = buildStealthScript();
  assert.ok(typeof script === 'string' && script.length > 0);
});
test('buildStealthScript contains webdriver override', () => {
  assert.ok(buildStealthScript().includes('webdriver'));
});
test('buildStealthScript contains plugins stub', () => {
  assert.ok(buildStealthScript().includes('plugins'));
});
test('buildStealthScript contains navigator.languages', () => {
  assert.ok(buildStealthScript().includes('languages'));
});
test('buildStealthScript does not throw when called twice (pure function)', () => {
  const a = buildStealthScript();
  const b = buildStealthScript();
  assert.equal(a, b);
});
```

- [ ] **Step 2.2: Run tests to confirm they fail**

```bash
node --test test/stealth.test.js
```

Expected: all 5 tests fail with `Cannot find module '../lib/stealth'`

- [ ] **Step 2.3: Create `lib/stealth.js`**

```js
/**
 * lib/stealth.js
 *
 * Returns a JavaScript string to inject via context.addInitScript() that masks
 * the most common Playwright automation fingerprints.
 *
 * This runs before any page JavaScript so the overrides are in place before
 * the WAF fingerprint probe executes. No new npm dependencies required.
 *
 * Does NOT guarantee bypass of enterprise-grade WAFs - it removes the trivially
 * detectable signals (navigator.webdriver = true, empty plugins, missing
 * languages) that cause instant blocks on many broker sites.
 */

const STEALTH_SCRIPT = `
(function () {
  // 1. Mask navigator.webdriver - the most common Playwright automation tell
  Object.defineProperty(navigator, 'webdriver', {
    get: function() { return undefined; },
    configurable: true,
  });

  // 2. Populate navigator.plugins with a minimal realistic stub.
  //    Empty plugins array is a strong headless signal.
  if (!navigator.plugins || navigator.plugins.length === 0) {
    var pluginData = [
      ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
      ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
      ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'],
    ];
    try {
      var fakePlugins = pluginData.map(function(d) {
        var p = { name: d[0], filename: d[1], description: d[2], length: 0 };
        return p;
      });
      Object.defineProperty(navigator, 'plugins', {
        get: function() { return fakePlugins; },
        configurable: true,
      });
    } catch(e) {}
  }

  // 3. Ensure navigator.languages is set (empty array is a headless signal)
  try {
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', {
        get: function() { return ['en-US', 'en']; },
        configurable: true,
      });
    }
  } catch(e) {}

  // 4. Add minimal chrome.runtime stub if missing (headless Chrome lacks it)
  try {
    if (window.chrome && !window.chrome.runtime) {
      window.chrome.runtime = {
        onMessage: { addListener: function() {}, removeListener: function() {} },
      };
    }
  } catch(e) {}
})();
`;

function buildStealthScript() {
  return STEALTH_SCRIPT;
}

module.exports = { buildStealthScript };
```

- [ ] **Step 2.4: Run stealth tests to confirm they pass**

```bash
node --test test/stealth.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 2.5: Wire stealth into `watcher.js`**

Add a require near the top of `watcher.js` alongside the other lib requires:

```js
const { buildStealthScript } = require('./lib/stealth');
```

Find the `launchPersistentContext` block. It currently ends with:

```js
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
```

Add one line immediately after:

```js
  await context.addInitScript(buildStealthScript());
```

- [ ] **Step 2.6: Run full test suite**

```bash
node --test
```

Expected: all existing tests pass plus 5 new stealth tests.

- [ ] **Step 2.7: Commit**

```bash
git add lib/stealth.js test/stealth.test.js watcher.js
git commit -m "fix: inject stealth init script to mask navigator.webdriver and plugins"
git push
```

---

## Task 3: CapSolver robustness - hCAPTCHA support + callback hardening

**The bug:** `detectAndSolveCaptcha` detects both reCAPTCHA and hCAPTCHA elements, but `solveRecaptcha` always submits a `ReCaptchaV2TaskProxyless` task regardless. hCAPTCHA brokers always fail silently. Additionally, the callback path `window.___grecaptcha_cfg.clients[0].aa.l.callback(t)` in the current code is hardcoded and works on roughly 30% of reCAPTCHA integrations.

**Fix:** Add `solveHcaptcha` for hCAPTCHA, route based on detected type in `detectAndSolveCaptcha`, and harden reCAPTCHA callback injection to try multiple known accessor paths. Export `findRecaptchaCallback` and `buildHcaptchaScript` so they can be tested without a real browser.

**Files:**
- Create: `test/captcha.test.js`
- Modify: `lib/captcha.js`

---

- [ ] **Step 3.1: Write failing tests**

Create `test/captcha.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findRecaptchaCallback, buildHcaptchaScript } = require('../lib/captcha');

test('findRecaptchaCallback: returns a string containing the token', () => {
  const script = findRecaptchaCallback('TEST_TOKEN_123');
  assert.ok(typeof script === 'string' && script.length > 0);
  assert.ok(script.includes('TEST_TOKEN_123'));
});
test('findRecaptchaCallback: includes ___grecaptcha_cfg traversal', () => {
  assert.ok(findRecaptchaCallback('X').includes('___grecaptcha_cfg'));
});
test('findRecaptchaCallback: includes g-recaptcha-response input injection', () => {
  assert.ok(findRecaptchaCallback('X').includes('g-recaptcha-response'));
});
test('buildHcaptchaScript: returns a string containing the token', () => {
  const script = buildHcaptchaScript('HTOKEN_ABC');
  assert.ok(typeof script === 'string');
  assert.ok(script.includes('HTOKEN_ABC'));
});
test('buildHcaptchaScript: includes h-captcha-response', () => {
  assert.ok(buildHcaptchaScript('X').includes('h-captcha-response'));
});
```

- [ ] **Step 3.2: Run tests to confirm they fail**

```bash
node --test test/captcha.test.js
```

Expected: fail with `findRecaptchaCallback is not a function` (not yet exported)

- [ ] **Step 3.3: Rewrite `lib/captcha.js`**

```js
/**
 * lib/captcha.js
 *
 * CapSolver-backed CAPTCHA detection and solving.
 * Supports: reCAPTCHA v2, hCAPTCHA.
 *
 * Exported for testing: findRecaptchaCallback, buildHcaptchaScript
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Builds a JavaScript string that injects a reCAPTCHA token and fires known
 * callback paths. The original single-path approach only worked on roughly
 * 30% of integrations. This tries multiple known accessor shapes.
 * @param {string} token
 * @returns {string}
 */
function findRecaptchaCallback(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  // 1. Set hidden input (required by all reCAPTCHA v2 integrations)
  var el = document.querySelector('#g-recaptcha-response');
  if (el) { el.value = token; el.style.display = 'block'; }
  document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(function(e) {
    e.value = token;
  });

  // 2. Traverse ___grecaptcha_cfg.clients to find and call all callback functions
  try {
    var clients = window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients;
    if (clients) {
      Object.keys(clients).forEach(function(key) {
        var client = clients[key];
        Object.keys(client).forEach(function(k) {
          var obj = client[k];
          if (obj && typeof obj.callback === 'function') {
            try { obj.callback(token); } catch(e) {}
          }
          if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach(function(k2) {
              if (obj[k2] && typeof obj[k2].callback === 'function') {
                try { obj[k2].callback(token); } catch(e) {}
              }
            });
          }
        });
      });
    }
  } catch(e) {}

  // 3. Dispatch change + input events so React/Vue/Angular bindings fire
  try {
    if (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }
  } catch(e) {}
})(${t});
`;
}

/**
 * Builds a JavaScript string that injects an hCAPTCHA solution token.
 * @param {string} token
 * @returns {string}
 */
function buildHcaptchaScript(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  var el = document.querySelector('[name="h-captcha-response"]');
  if (!el) el = document.querySelector('textarea[name="h-captcha-response"]');
  if (el) { el.value = token; }
  try {
    if (window.hcaptcha) {
      var widget = document.querySelector('[data-hcaptcha-widget-id]');
      var widgetId = widget ? widget.getAttribute('data-hcaptcha-widget-id') : null;
      if (widgetId !== null) { window.hcaptcha.execute(widgetId); }
    }
  } catch(e) {}
  try {
    if (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }
  } catch(e) {}
})(${t});
`;
}

async function solveRecaptcha(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - add one to config.json to auto-solve CAPTCHAs');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() =>
      document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null
    );
    if (!siteKey) return false;

    console.log('     Solving reCAPTCHA via CapSolver...');
    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: { type: 'ReCaptchaV2TaskProxyless', websiteURL: pageUrl, websiteKey: siteKey },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        await page.evaluate(findRecaptchaCallback(data.solution.gRecaptchaResponse));
        console.log('     reCAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver reCAPTCHA error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

async function solveHcaptcha(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - cannot solve hCAPTCHA automatically');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() => {
      return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ||
        (document.querySelector('iframe[src*="hcaptcha"]')?.src || '').match(/sitekey=([^&]+)/)?.[1] || null;
    });
    if (!siteKey) return false;

    console.log('     Solving hCAPTCHA via CapSolver...');
    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: { type: 'HCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: siteKey },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        const token = data.solution.gRecaptchaResponse || '';
        await page.evaluate(buildHcaptchaScript(token));
        console.log('     hCAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver hCAPTCHA error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

async function detectAndSolveCaptcha(page, capsolver) {
  const captchaType = await page.evaluate(() => {
    if (document.querySelector('.g-recaptcha,[data-sitekey],#recaptcha,iframe[src*="recaptcha"]')) {
      return 'recaptcha';
    }
    if (document.querySelector('iframe[src*="hcaptcha"],[data-hcaptcha-widget-id]')) {
      return 'hcaptcha';
    }
    return null;
  });
  if (!captchaType) return true;
  if (captchaType === 'hcaptcha') return solveHcaptcha(page, capsolver);
  return solveRecaptcha(page, capsolver);
}

module.exports = { solveRecaptcha, solveHcaptcha, detectAndSolveCaptcha, findRecaptchaCallback, buildHcaptchaScript };
```

- [ ] **Step 3.4: Run captcha tests**

```bash
node --test test/captcha.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 3.5: Run full test suite**

```bash
node --test
```

Expected: all existing tests pass.

- [ ] **Step 3.6: Commit**

```bash
git add lib/captcha.js test/captcha.test.js
git commit -m "fix: add hCAPTCHA support and harden reCAPTCHA callback injection"
git push
```

---

## Task 4: Selector collision prevention in forms.js

**The bug:** The `getByLabel` fallback in `fillForm` extracts a keyword from `input[name*="first" i]` and calls `page.getByLabel(/first/i).first().fill(value)`. This matches any label containing "first": "First Observed Date", "First Login", "First Name on Account". The `.first()` call takes whichever label appears first in DOM order, which is not always the First Name field.

**Fix:** A deny-list of keywords too generic for safe `getByLabel` fallback. When the keyword is in the deny-list, skip the fallback entirely. Extract the keyword via a named helper `extractKeyword()` so it is testable.

**Files:**
- Create: `test/forms-selector.test.js`
- Modify: `lib/forms.js`

---

- [ ] **Step 4.1: Write failing tests**

Create `test/forms-selector.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAmbiguousKeyword, extractKeyword } = require('../lib/forms');

test('extractKeyword: extracts from *="..." selector', () => {
  assert.equal(extractKeyword('input[name*="first" i]'), 'first');
});
test('extractKeyword: extracts from id*="..." selector', () => {
  assert.equal(extractKeyword('input[id*="email" i]'), 'email');
});
test('extractKeyword: returns null when no *="..." pattern', () => {
  assert.equal(extractKeyword('input[type="text"]'), null);
});
test('extractKeyword: returns null for submit button', () => {
  assert.equal(extractKeyword('button[type="submit"]'), null);
});
test('isAmbiguousKeyword: "first" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('first'));
});
test('isAmbiguousKeyword: "last" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('last'));
});
test('isAmbiguousKeyword: "name" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('name'));
});
test('isAmbiguousKeyword: "address" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('address'));
});
test('isAmbiguousKeyword: "email" is NOT ambiguous', () => {
  assert.ok(!isAmbiguousKeyword('email'));
});
test('isAmbiguousKeyword: "zip" is NOT ambiguous', () => {
  assert.ok(!isAmbiguousKeyword('zip'));
});
test('isAmbiguousKeyword: "phone" is NOT ambiguous', () => {
  assert.ok(!isAmbiguousKeyword('phone'));
});
test('isAmbiguousKeyword: case-insensitive - "First" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('First'));
});
test('isAmbiguousKeyword: case-insensitive - "LAST" is ambiguous', () => {
  assert.ok(isAmbiguousKeyword('LAST'));
});
```

- [ ] **Step 4.2: Run tests to confirm they fail**

```bash
node --test test/forms-selector.test.js
```

Expected: fail with `isAmbiguousKeyword is not a function`

- [ ] **Step 4.3: Modify `lib/forms.js`**

Read the file first. Add these two functions before `fillForm` (after the imports):

```js
/**
 * Keywords too generic for safe getByLabel() fallback.
 * 'first' matches 'First Observed Date', 'first_name_on_account', etc.
 * 'last'  matches 'Last Modified', 'Last Login', etc.
 * 'name'  matches 'Username', 'Company Name', 'File Name', etc.
 * 'address' matches 'Billing Address', 'IP Address', etc.
 * 'number' matches 'Order Number', 'Phone Number (hidden field)', etc.
 * Specific keywords like 'email', 'zip', 'phone', 'city' are safe to keep.
 */
const AMBIGUOUS_KEYWORDS = new Set(['first', 'last', 'name', 'middle', 'address', 'number']);

/**
 * Returns true when a keyword is too generic for a safe getByLabel() fallback.
 * @param {string} kw
 */
function isAmbiguousKeyword(kw) {
  return AMBIGUOUS_KEYWORDS.has((kw || '').toLowerCase());
}

/**
 * Extracts the substring-match keyword from a CSS attribute selector.
 * Returns null when no *="..." pattern is found.
 * @param {string} selector
 * @returns {string|null}
 */
function extractKeyword(selector) {
  const m = selector.match(/\*="([^"]+)"/);
  return m ? m[1] : null;
}
```

Inside `fillForm`, find the `if (!filled)` block:

```js
    if (!filled) {
      const kw = selector.match(/\*="([^"]+)"/)?.[1];
      if (kw) {
        await page.getByLabel(new RegExp(kw, 'i')).first().fill(value).catch(() => {});
      }
    }
```

Replace it with:

```js
    if (!filled) {
      const kw = extractKeyword(selector);
      if (kw && !isAmbiguousKeyword(kw)) {
        await page.getByLabel(new RegExp(kw, 'i')).first().fill(value).catch(() => {});
      }
    }
```

Update `module.exports` at the bottom to export the new helpers:

```js
module.exports = { fillForm, findListingUrl, applyRegionAliases, isAmbiguousKeyword, extractKeyword };
```

- [ ] **Step 4.4: Run new tests**

```bash
node --test test/forms-selector.test.js
```

Expected: all 13 tests pass.

- [ ] **Step 4.5: Run full test suite**

```bash
node --test
```

Expected: all existing tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add lib/forms.js test/forms-selector.test.js
git commit -m "fix: prevent getByLabel selector collision with ambiguous keyword deny-list"
git push
```

---

## Self-review

**Spec coverage:**

| Audit item | Task |
|---|---|
| click = success false positive | Task 1: classifyPostSubmit DOM scan |
| navigator.webdriver exposed | Task 2: addInitScript stealth masking |
| hCAPTCHA detected but never solved | Task 3: solveHcaptcha + routing |
| reCAPTCHA callback brittle path | Task 3: multi-path callback traversal |
| getByLabel selector collision | Task 4: AMBIGUOUS_KEYWORDS deny-list |
| Atomic state writes | Already done (WP-S1) - not in scope |
| Process lock / race condition | Already done (lock.js) - not in scope |
| Memory leak / page.close() | Already done (finally block) - not in scope |
| macOS coupling | Already done (Docker + scheduler) - not in scope |

**Placeholder scan:** No TBD, no "implement later". All steps have complete code.

**Type consistency:** All exports used in later steps match definitions - `classifyPostSubmit`, `buildStealthScript`, `findRecaptchaCallback`, `buildHcaptchaScript`, `isAmbiguousKeyword`, `extractKeyword`.
