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
