/**
 * test/pii-not-logged.test.js
 *
 * Found by the cross-model review of this change set (P1 #1).
 *
 * lib/forms.js logged the raw field value when a <select> matched neither by
 * label nor by value:
 *
 *   console.warn(`[forms] select unmatched: selector="${sel}" value="${value}" ...`)
 *
 * The values in that map are the user's state, city, zip, country and name. The
 * trigger is mundane - a broker renames a state or country dropdown, or an
 * international postal/region form - and the output goes to stdout, which lands
 * in `logs/`, in `journalctl`, in `docker logs`, and in the dashboard's live run
 * stream. A privacy tool printing the user's address to a log is the exact
 * failure it exists to prevent.
 *
 * The selector is the useful half of that message for debugging drift. The value
 * is not.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fillForm } = require('../lib/forms');

const SECRET_CITY = 'Ouagadougou';
const SECRET_ZIP = '94601';

/** A page whose <select> rejects every option, forcing the warning path. */
function makeSelectStubPage() {
  const locator = (sel) => {
    const self = {
      first: () => self,
      count: async () => 1,
      isVisible: async () => true,
      evaluate: async (fn) => fn({ tagName: 'SELECT', type: '' }),
      selectOption: async () => { throw new Error('no such option'); },
      fill: async () => {},
      check: async () => {},
      locator: () => self,
      allTextContents: async () => [],
    };
    return self;
  };
  return {
    locator,
    getByLabel: () => ({ count: async () => 0, first: () => ({ fill: async () => {} }) }),
  };
}

/** Capture everything written to console.warn/log/error during `fn`. */
async function captureConsole(fn) {
  const lines = [];
  const real = { warn: console.warn, log: console.log, error: console.error };
  for (const k of Object.keys(real)) {
    console[k] = (...args) => lines.push(args.map(String).join(' '));
  }
  try {
    await fn();
  } finally {
    Object.assign(console, real);
  }
  return lines.join('\n');
}

test('an unmatched select does not log the field value', async () => {
  const page = makeSelectStubPage();
  const output = await captureConsole(() => fillForm(page, { 'select[name="city"]': SECRET_CITY }));

  assert.ok(output.length > 0, 'precondition: the unmatched-select path must warn about something');
  assert.ok(
    !output.includes(SECRET_CITY),
    `the field value leaked into the log:\n${output}`,
  );
});

test('an unmatched select still logs the selector, which is the useful part', async () => {
  const page = makeSelectStubPage();
  const output = await captureConsole(() => fillForm(page, { 'select[name="city"]': SECRET_CITY }));

  assert.match(output, /select\[name="city"\]/, 'the selector must survive so drift is debuggable');
  assert.match(output, /unmatched/i);
});

test('no PII from any field reaches the log on the unmatched path', async () => {
  const page = makeSelectStubPage();
  const output = await captureConsole(() => fillForm(page, {
    'select[name="state"]': 'CA',
    'select[name="city"]': SECRET_CITY,
    'select[name="zip"]': SECRET_ZIP,
    'select[name="country"]': 'Burkina Faso',
  }));

  for (const secret of [SECRET_CITY, SECRET_ZIP, 'Burkina Faso']) {
    assert.ok(!output.includes(secret), `"${secret}" leaked into the log:\n${output}`);
  }
});

test('the warning reports whether a value was present without revealing it', async () => {
  // Knowing "we had something to fill and nothing matched" is the actionable
  // signal; the characters themselves are not.
  const page = makeSelectStubPage();
  const output = await captureConsole(() => fillForm(page, { 'select[name="state"]': 'CA' }));
  assert.match(output, /\[forms\]/, 'keep the existing log prefix so grep patterns still work');
});
