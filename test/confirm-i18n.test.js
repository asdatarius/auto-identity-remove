/**
 * test/confirm-i18n.test.js
 *
 * Localized "check your email to confirm" detection in lib/confirm.js.
 *
 * For each of es/fr/de/pt/it:
 *  - a native confirmation phrase matches WITH lang
 *  - the same phrase does NOT match WITHOUT lang (opt-in union)
 *  - native success copy does NOT match (false-positive resistance)
 *
 * detectConfirmationRequired:
 *  - uses an explicit lang argument when provided
 *  - otherwise reads <html lang> from the page via the injected getLang hook
 *
 * Pure / mocked - no real browser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeConfirmationRequired, detectConfirmationRequired } = require('../lib/confirm');

const SAMPLES = {
  es: { confirm: 'Por favor revise su correo para confirmar su solicitud.', success: 'Sus datos han sido eliminados.' },
  fr: { confirm: 'Veuillez vérifier votre e-mail pour confirmer votre demande.', success: 'Vos données ont été supprimées.' },
  de: { confirm: 'Bitte überprüfen Sie Ihre E-Mail, um Ihre Anfrage zu bestätigen.', success: 'Ihre Daten wurden gelöscht.' },
  pt: { confirm: 'Por favor verifique o seu e-mail para confirmar o seu pedido.', success: 'Seus dados foram excluídos.' },
  it: { confirm: 'Controlla la tua e-mail per confermare la tua richiesta.', success: 'I tuoi dati sono stati eliminati.' },
};

for (const [lang, s] of Object.entries(SAMPLES)) {
  test(`[${lang}] confirmation matches WITH lang`, () => {
    assert.equal(looksLikeConfirmationRequired(s.confirm, lang), true);
  });
  test(`[${lang}] confirmation does NOT match WITHOUT lang (opt-in)`, () => {
    assert.equal(looksLikeConfirmationRequired(s.confirm), false);
  });
  test(`[${lang}] native success copy is NOT a confirmation`, () => {
    assert.equal(looksLikeConfirmationRequired(s.success, lang), false);
  });
}

// -- English regression --

test('EN regression: confirmation without lang still matches', () => {
  assert.equal(looksLikeConfirmationRequired('Please check your email to confirm.'), true);
});
test('EN regression: non-confirmation without lang stays false', () => {
  assert.equal(looksLikeConfirmationRequired('Your data has been removed.'), false);
});
test('English confirmation still matches under a non-English lang (union)', () => {
  assert.equal(looksLikeConfirmationRequired('Please check your email.', 'fr'), true);
});

// -- detectConfirmationRequired language threading --

test('detectConfirmationRequired: uses explicit lang argument', async () => {
  const page = {
    evaluate: async () => 'Gracias. Por favor revise su correo para confirmar su solicitud.',
  };
  const out = await detectConfirmationRequired(page, 'es');
  assert.equal(out.pending, true);
  assert.match(out.snippet, /revise su correo/i);
});

test('detectConfirmationRequired: reads <html lang> when no explicit lang', async () => {
  // First evaluate() returns the lang code, second returns body text.
  const calls = ['de', 'Bitte überprüfen Sie Ihre E-Mail, um fortzufahren.'];
  let i = 0;
  const page = { evaluate: async () => calls[i++] };
  const out = await detectConfirmationRequired(page);
  assert.equal(out.pending, true);
});

test('detectConfirmationRequired: explicit lang overrides page lang read', async () => {
  // body is Italian; explicit lang 'it' should match even if page lang differs.
  const page = { evaluate: async () => 'Controlla la tua e-mail per confermare la tua richiesta.' };
  const out = await detectConfirmationRequired(page, 'it');
  assert.equal(out.pending, true);
});

test('detectConfirmationRequired: still false for non-confirmation foreign text', async () => {
  const page = { evaluate: async () => 'Sus datos han sido eliminados de nuestra base de datos.' };
  const out = await detectConfirmationRequired(page, 'es');
  assert.equal(out.pending, false);
  assert.equal(out.snippet, '');
});

test('detectConfirmationRequired: swallows evaluate errors safely (with lang)', async () => {
  const page = { evaluate: async () => { throw new Error('detached frame'); } };
  const out = await detectConfirmationRequired(page, 'es');
  assert.equal(out.pending, false);
});
