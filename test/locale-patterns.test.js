/**
 * test/locale-patterns.test.js
 *
 * Covers lib/locale-patterns.js:
 *  - langOf(htmlLang): normalizes a raw <html lang> attribute value to a bare
 *    two-letter lowercase ISO code ('es-ES' -> 'es', 'PT-br' -> 'pt'), or ''
 *    for missing / unrecognized input.
 *  - patternsFor(lang): returns { success, failure, confirm } RegExp set for a
 *    supported locale, or null for English / unknown (English handled by the
 *    default patterns in success.js / confirm.js, never duplicated here).
 *
 * Pure functions - no network, no browser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { langOf, patternsFor, SUPPORTED_LANGS } = require('../lib/locale-patterns');

// -- langOf normalization --

test('langOf: strips region subtag and lowercases ("es-ES" -> "es")', () => {
  assert.equal(langOf('es-ES'), 'es');
});
test('langOf: handles uppercase region ("PT-br" -> "pt")', () => {
  assert.equal(langOf('PT-br'), 'pt');
});
test('langOf: passes through a bare code ("de" -> "de")', () => {
  assert.equal(langOf('de'), 'de');
});
test('langOf: trims surrounding whitespace ("  fr  " -> "fr")', () => {
  assert.equal(langOf('  fr  '), 'fr');
});
test('langOf: empty string -> ""', () => {
  assert.equal(langOf(''), '');
});
test('langOf: null -> ""', () => {
  assert.equal(langOf(null), '');
});
test('langOf: undefined -> ""', () => {
  assert.equal(langOf(undefined), '');
});
test('langOf: non-string -> ""', () => {
  assert.equal(langOf(42), '');
});
test('langOf: underscore separator ("it_IT" -> "it")', () => {
  assert.equal(langOf('it_IT'), 'it');
});

// -- patternsFor selection --

test('patternsFor: returns a pattern set for each supported language', () => {
  for (const lang of SUPPORTED_LANGS) {
    const p = patternsFor(lang);
    assert.ok(p, `expected a pattern set for ${lang}`);
    assert.ok(p.success instanceof RegExp, `success regex for ${lang}`);
    assert.ok(p.failure instanceof RegExp, `failure regex for ${lang}`);
    assert.ok(p.confirm instanceof RegExp, `confirm regex for ${lang}`);
  }
});
test('patternsFor: accepts an un-normalized region tag ("es-MX")', () => {
  assert.ok(patternsFor('es-MX'));
});
test('patternsFor: English ("en") returns null (English handled by defaults)', () => {
  assert.equal(patternsFor('en'), null);
});
test('patternsFor: unknown language ("ja") returns null', () => {
  assert.equal(patternsFor('ja'), null);
});
test('patternsFor: empty / missing returns null', () => {
  assert.equal(patternsFor(''), null);
  assert.equal(patternsFor(null), null);
});
test('SUPPORTED_LANGS covers es, fr, de, pt, it', () => {
  for (const lang of ['es', 'fr', 'de', 'pt', 'it']) {
    assert.ok(SUPPORTED_LANGS.includes(lang), `expected ${lang} in SUPPORTED_LANGS`);
  }
});
test('all locale regexes are case-insensitive', () => {
  for (const lang of SUPPORTED_LANGS) {
    const p = patternsFor(lang);
    assert.ok(p.success.flags.includes('i'), `success i-flag for ${lang}`);
    assert.ok(p.failure.flags.includes('i'), `failure i-flag for ${lang}`);
    assert.ok(p.confirm.flags.includes('i'), `confirm i-flag for ${lang}`);
  }
});
