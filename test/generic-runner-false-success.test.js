/**
 * test/generic-runner-false-success.test.js
 *
 * processGenericUrl() used to return status 'success' when it filled a generic
 * opt-out form but could not find any submit control:
 *
 *     if (filled) {
 *       const submitted = await submitForm(page);
 *       if (submitted) return finalize('Form submitted');
 *       return { status: 'success', detail: 'Form filled (no submit button found)' };
 *     }
 *
 * runGenericBrokers() maps 'success' to recordSuccess(), which stamps
 * lastSuccess and puts the broker into the RECHECK_DAYS (90 day) cooldown. So a
 * form that was typed into but never submitted was reported to the user as a
 * completed opt-out and then not retried for three months. For a tool whose
 * entire output is "here is what was removed", claiming a removal that never
 * happened is the worst failure mode available.
 *
 * Correct classification is 'manual' - the page is real and automatable up to a
 * point, but a human has to finish it. classifyOutcome() already buckets
 * 'manual' as no_form_found, and runGenericBrokers does not call recordSuccess
 * for it, so the entry stays due.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  processGenericUrl,
  classifyOutcome,
  _setConfig,
} = require('../generic-runner');

// Selectors fillGenericForm() looks for. The stub reports these present so the
// "form was filled" branch is reached.
const FIELD_SELECTORS = new Set([
  'input[type="email"]', 'input[name*="email" i]', 'input[placeholder*="email" i]',
  'input[name="firstName"]', 'input[name*="first" i]', 'input[placeholder*="first name" i]',
  'input[name="lastName"]', 'input[name*="last" i]', 'input[placeholder*="last name" i]',
  'input[name="name"]', 'input[name*="full" i]',
]);

/**
 * @param {{ hasSubmit: boolean }} opts
 */
function makeStubPage({ hasSubmit }) {
  const filled = [];
  const clicked = [];

  const locator = (sel) => {
    const isSubmitSel = sel.includes('button[type="submit"]');
    const present = isSubmitSel ? hasSubmit : FIELD_SELECTORS.has(sel);
    const self = {
      first: () => self,
      all: async () => [],
      count: async () => (present ? 1 : 0),
      isVisible: async () => present,
      evaluate: async (fn) => fn({ tagName: 'INPUT', type: 'text' }),
      fill: async (v) => { filled.push({ sel, v }); },
      selectOption: async () => {},
      click: async () => { clicked.push(sel); },
      locator: () => self,
      allTextContents: async () => [],
    };
    return self;
  };

  return {
    filled,
    clicked,
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    content: async () => '<html><body>thanks</body></html>',
    locator,
    url: () => 'https://broker.example/opt-out',
  };
}

const BROKER = { name: 'ExampleBroker', url: 'https://broker.example/opt-out', source: 'markup' };

function freshState() {
  return { optOuts: {} };
}

test.before(() => {
  // No allowlist, a single person: enough for getFieldMap() and isAllowlisted().
  _setConfig({
    person: {
      firstName: 'Test', lastName: 'User', fullName: 'Test User',
      email: 'test@example.com', state: 'CA', zip: '90001',
    },
  });
});

test('filled form with no submit control is NOT reported as success', async () => {
  const page = makeStubPage({ hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.ok(page.filled.length > 0, 'precondition: the stub must let the form be filled');
  assert.notEqual(
    result.status,
    'success',
    'nothing was submitted, so this must not be recorded as a successful opt-out',
  );
});

test('filled form with no submit control is classified manual', async () => {
  const page = makeStubPage({ hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.equal(result.status, 'manual');
  assert.match(result.detail, /submit/i, 'detail should say why it needs a human');
});

test('manual does not land in the submitted bucket', () => {
  assert.equal(classifyOutcome('manual', ''), 'no_form_found');
  assert.notEqual(classifyOutcome('manual', ''), 'submitted');
});

test('a form that IS submitted still reports success', async () => {
  const page = makeStubPage({ hasSubmit: true });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.equal(result.status, 'success', 'the happy path must not regress');
  assert.ok(page.clicked.some(s => s.includes('button[type="submit"]')), 'submit must have been clicked');
});

test('dry-run still short-circuits before any mutation', async () => {
  const page = makeStubPage({ hasSubmit: true });
  const result = await processGenericUrl(page, BROKER, freshState(), true, new Set());

  assert.equal(result.status, 'skipped');
  assert.equal(page.filled.length, 0, 'dry-run must not type PII into the form');
  assert.equal(page.clicked.length, 0, 'dry-run must not click anything');
});

// ── Second false-success path, found by the cross-model review of this diff ───
//
// Strategy 1 clicks a "Do Not Sell" link, then fires fillGenericForm() and
// submitForm() but ignores both return values and unconditionally reports
// success:
//
//     const clicked = await clickDoNotSell(page);
//     if (clicked) {
//       await fillGenericForm(page);
//       await submitForm(page);
//       return finalize('Do Not Sell clicked');
//     }
//
// Very often that link only opens a modal or a follow-up page. Clicking a link
// is not an opt-out, but it earned a recordSuccess() and a 90-day cooldown all
// the same. Same defect class as the "filled but no submit control" case above,
// which is exactly why one fix should not have been made without checking for
// the other.

/** A page where the Do Not Sell link exists but nothing else does. */
function makeDoNotSellPage({ hasForm, hasSubmit }) {
  const clicked = [];
  const filled = [];
  const DNS = ['Do Not Sell', 'Do Not Share', 'Opt Out of Sale', 'donotsell', 'do-not-sell', 'optanon'];

  const locator = (sel) => {
    const isDns = DNS.some(t => sel.includes(t));
    const isSubmit = sel.includes('button[type="submit"]');
    const isField = FIELD_SELECTORS.has(sel);
    const present = isDns ? true : isSubmit ? hasSubmit : (isField && hasForm);
    const self = {
      first: () => self,
      all: async () => [],
      count: async () => (present ? 1 : 0),
      isVisible: async () => present,
      evaluate: async (fn) => fn({ tagName: 'INPUT', type: 'text' }),
      fill: async (v) => { filled.push({ sel, v }); },
      selectOption: async () => {},
      check: async () => {},
      click: async () => { clicked.push(sel); },
      locator: () => self,
      allTextContents: async () => [],
    };
    return self;
  };

  return {
    clicked,
    filled,
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async () => {},
    content: async () => '<html><body>preferences</body></html>',
    url: () => 'https://broker.example/privacy',
    locator,
  };
}

test('clicking Do Not Sell with no submittable form is not a success', async () => {
  const page = makeDoNotSellPage({ hasForm: false, hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());

  assert.ok(page.clicked.length > 0, 'precondition: the Do Not Sell control must have been clicked');
  assert.notEqual(
    result.status,
    'success',
    'a click that submitted nothing must not be recorded as a completed opt-out',
  );
  assert.equal(result.status, 'manual');
});

test('clicking Do Not Sell then filling a form with no submit control is not a success', async () => {
  const page = makeDoNotSellPage({ hasForm: true, hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());
  assert.notEqual(result.status, 'success');
  assert.equal(result.status, 'manual');
});

test('clicking Do Not Sell and actually submitting the follow-up form IS a success', async () => {
  const page = makeDoNotSellPage({ hasForm: true, hasSubmit: true });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());
  assert.equal(result.status, 'success', 'the genuine happy path must not regress');
  assert.ok(page.clicked.some(s => s.includes('button[type="submit"]')));
});

test('the Do Not Sell detail says what actually happened', async () => {
  const page = makeDoNotSellPage({ hasForm: false, hasSubmit: false });
  const result = await processGenericUrl(page, BROKER, freshState(), false, new Set());
  assert.match(result.detail, /Do Not Sell/i, 'keep the diagnostic breadcrumb');
  assert.match(result.detail, /not|no /i, 'and say that nothing was submitted');
});
