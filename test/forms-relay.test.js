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
