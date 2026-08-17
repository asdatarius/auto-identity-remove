/**
 * test/forms-empty-values.test.js
 *
 * fillForm() used to attempt every entry in the formFields map regardless of
 * value. With a partially-filled config (no middle name, no city, or the
 * persons[]-vs-person mismatch that used to blank every value) that meant
 * either page.fill(undefined) - which throws into a swallowing catch, then
 * hands `undefined` to the semantic field resolver - or page.fill('') on a
 * field the broker had already prefilled, wiping it.
 *
 * A field with nothing to say should be left alone.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fillForm } = require('../lib/forms');

function makeStubPage() {
  const filled = [];
  const locator = (sel) => {
    const self = {
      first: () => self,
      count: async () => 1,
      isVisible: async () => true,
      evaluate: async (fn) => fn({ tagName: 'INPUT', type: 'text' }),
      fill: async (v) => { filled.push({ sel, v }); },
      selectOption: async () => {},
      check: async () => {},
      locator: () => self,
    };
    return self;
  };
  return {
    filled,
    locator,
    getByLabel: () => ({ count: async () => 0, first: () => ({ fill: async () => {} }) }),
  };
}

test('a populated field is filled', async () => {
  const page = makeStubPage();
  await fillForm(page, { 'input[name="email"]': 'a@example.com' });
  assert.deepEqual(page.filled.map(f => f.v), ['a@example.com']);
});

test('an undefined value is skipped, not filled', async () => {
  const page = makeStubPage();
  await fillForm(page, { 'input[name="middleName"]': undefined });
  assert.deepEqual(page.filled, [], 'nothing to say means nothing typed');
});

test('a null value is skipped', async () => {
  const page = makeStubPage();
  await fillForm(page, { 'input[name="city"]': null });
  assert.deepEqual(page.filled, []);
});

test('an empty string is skipped so a prefilled field is not wiped', async () => {
  const page = makeStubPage();
  await fillForm(page, { 'input[name="zip"]': '' });
  assert.deepEqual(page.filled, []);
});

test('a whitespace-only value is skipped', async () => {
  const page = makeStubPage();
  await fillForm(page, { 'input[name="city"]': '   ' });
  assert.deepEqual(page.filled, []);
});

test('the literal string "undefined" is never typed into a broker form', async () => {
  // Belt and braces: brokers.js coerces missing fields to '' now, but if a
  // template ever regresses, this is PII-adjacent garbage going to a third
  // party and should be dropped at the last gate.
  const page = makeStubPage();
  await fillForm(page, { 'input[name="name"]': 'undefined' });
  assert.deepEqual(page.filled, []);
});

test('skipping one empty field does not stop the others', async () => {
  const page = makeStubPage();
  await fillForm(page, {
    'input[name="firstName"]': 'Alice',
    'input[name="middleName"]': '',
    'input[name="lastName"]': 'Anderson',
  });
  assert.deepEqual(page.filled.map(f => f.v), ['Alice', 'Anderson']);
});
