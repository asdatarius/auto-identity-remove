/**
 * test/success-i18n.test.js
 *
 * Localized success/failure classification in lib/success.js.
 *
 * For each of es/fr/de/pt/it we assert:
 *  - a native success phrase classifies as 'success' when lang is passed
 *  - a native failure phrase classifies as 'failure' when lang is passed
 *  - neutral native text classifies as 'unknown'
 *  - the SAME native success phrase classifies as 'unknown' WITHOUT lang
 *    (proves the union is opt-in and English-only stays English-only)
 *
 * Plus an English regression block proving the default path is untouched, and
 * that English phrases still match even when a non-English lang is supplied
 * (English is always unioned in).
 *
 * Pure string functions - no network, no browser.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeSuccess, looksLikeFailure, classifyPostSubmit } = require('../lib/success');

// lang -> { success, failure, neutral } sample sentences
const SAMPLES = {
  es: {
    success: 'Hemos recibido su solicitud de eliminación. Sus datos han sido eliminados.',
    failure: 'Este campo es obligatorio. Por favor introduzca un correo electrónico válido.',
    neutral: 'Bienvenido. Complete el siguiente formulario para continuar.',
  },
  fr: {
    success: 'Nous avons bien reçu votre demande de suppression. Vos données ont été supprimées.',
    failure: 'Ce champ est obligatoire. Veuillez saisir une adresse e-mail valide.',
    neutral: 'Bienvenue. Veuillez remplir le formulaire ci-dessous pour continuer.',
  },
  de: {
    success: 'Wir haben ihre Anfrage erhalten. Ihre Daten wurden gelöscht.',
    failure: 'Dieses Feld ist erforderlich. Bitte geben Sie eine gültige E-Mail an.',
    neutral: 'Willkommen. Bitte beachten Sie unsere Datenschutzerklärung.',
  },
  pt: {
    success: 'Recebemos sua solicitação. Seus dados foram excluídos do nosso banco de dados.',
    failure: 'Este campo é obrigatório. Por favor insira um e-mail válido.',
    neutral: 'Bem-vindo. Preencha o formulário abaixo para continuar.',
  },
  it: {
    success: 'Abbiamo ricevuto la tua richiesta. I tuoi dati sono stati eliminati.',
    failure: 'Questo campo è obbligatorio. Per favore inserisci un indirizzo e-mail valido.',
    neutral: 'Benvenuto. Compila il modulo qui sotto per continuare.',
  },
};

for (const [lang, s] of Object.entries(SAMPLES)) {
  test(`[${lang}] looksLikeSuccess true with lang`, () => {
    assert.equal(looksLikeSuccess(s.success, lang), true);
  });
  test(`[${lang}] looksLikeSuccess false WITHOUT lang (opt-in union)`, () => {
    assert.equal(looksLikeSuccess(s.success), false);
  });
  test(`[${lang}] looksLikeFailure true with lang`, () => {
    assert.equal(looksLikeFailure(s.failure, lang), true);
  });
  test(`[${lang}] classifyPostSubmit -> success with lang`, () => {
    const r = classifyPostSubmit(s.success, lang);
    assert.equal(r.outcome, 'success');
    assert.ok(r.snippet.length > 0);
  });
  test(`[${lang}] classifyPostSubmit -> failure with lang`, () => {
    const r = classifyPostSubmit(s.failure, lang);
    assert.equal(r.outcome, 'failure');
  });
  test(`[${lang}] classifyPostSubmit -> unknown for neutral text`, () => {
    const r = classifyPostSubmit(s.neutral, lang);
    assert.equal(r.outcome, 'unknown');
  });
  test(`[${lang}] classifyPostSubmit accepts region tag (${lang}-XX)`, () => {
    const r = classifyPostSubmit(s.success, `${lang}-XX`);
    assert.equal(r.outcome, 'success');
  });
}

// -- English regression - default path must be byte-for-byte unchanged --

test('EN regression: success without lang still works', () => {
  assert.equal(looksLikeSuccess('Your opt-out request has been received.'), true);
});
test('EN regression: failure without lang still works', () => {
  assert.equal(looksLikeFailure('This field is required.'), true);
});
test('EN regression: classifyPostSubmit success without lang', () => {
  assert.equal(classifyPostSubmit('Your opt-out request has been received.').outcome, 'success');
});
test('EN regression: unknown without lang', () => {
  assert.equal(classifyPostSubmit('Please fill in the form.').outcome, 'unknown');
});
test('EN regression: null handled gracefully with a lang', () => {
  assert.equal(classifyPostSubmit(null, 'es').outcome, 'unknown');
});
test('EN regression: lang="en" behaves like no lang', () => {
  assert.equal(classifyPostSubmit('Your opt-out request has been received.', 'en').outcome, 'success');
  assert.equal(classifyPostSubmit('Bienvenido.', 'en').outcome, 'unknown');
});
test('English phrase still matches even when lang is non-English (union)', () => {
  assert.equal(looksLikeSuccess('Your request has been received.', 'de'), true);
});
test('unknown lang ("ja") falls back to English-only', () => {
  assert.equal(looksLikeSuccess('Hemos recibido su solicitud.', 'ja'), false);
  assert.equal(looksLikeSuccess('Your request has been received.', 'ja'), true);
});
