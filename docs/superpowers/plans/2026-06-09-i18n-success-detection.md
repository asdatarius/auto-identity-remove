# Internationalized Success / Confirmation Detection Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax.

Goal: Make post-submit success/failure/confirmation detection work for non-English broker pages (Spanish, French, German, Portuguese, Italian) so that non-US users are no longer always classified as `unknown` and left invisible to the verification loop.

Architecture: `lib/success.js` and `lib/confirm.js` are pure string classifiers called from `lib/broker-runner.js` after a form submit. We add per-locale pattern sets (success, failure, check-your-email) keyed by ISO language code, plus a `langOf(htmlLang)` normalizer. The classifier functions gain an optional `lang` argument; when present, the matching locale's patterns are unioned with the English defaults (English always stays active). `broker-runner.js` reads the page's `<html lang>` attribute once after submit and threads it into both classifiers.

Tech Stack: Plain Node.js, CommonJS (`require`/`module.exports`), zero TypeScript. Tests use `node:test` + `node:assert/strict`. Playwright is used only at runtime in `broker-runner.js` (the page-language read); all classification logic and all tests are pure string functions with no network or browser. No new npm dependencies.

New dependencies: NONE.

---

## File map

| File | Status | Responsibility |
|------|--------|----------------|
| `/Users/stephen/scripts/auto-identity-remove/lib/locale-patterns.js` | Created | Per-locale pattern sets (success / failure / confirmation) keyed by ISO code, plus `langOf(htmlLang)` normalizer and `patternsFor(lang)` selector. Single source of truth for all locale strings. |
| `/Users/stephen/scripts/auto-identity-remove/lib/success.js` | Modified | `looksLikeSuccess`, `looksLikeFailure`, `classifyPostSubmit` gain an optional `lang` argument; union locale patterns with English. English default unchanged. |
| `/Users/stephen/scripts/auto-identity-remove/lib/confirm.js` | Modified | `looksLikeConfirmationRequired`, `detectConfirmationRequired` gain optional `lang`; union locale confirmation patterns with English. `detectConfirmationRequired` reads `<html lang>` itself when not supplied. |
| `/Users/stephen/scripts/auto-identity-remove/lib/broker-runner.js` | Modified (lines 164-188) | After submit, read the page `<html lang>` attribute once, pass it to `classifyPostSubmit(body, lang)` and `detectConfirmationRequired(page, lang)`. |
| `/Users/stephen/scripts/auto-identity-remove/test/locale-patterns.test.js` | Created (Test) | Unit tests for `langOf` normalization and `patternsFor` selection. |
| `/Users/stephen/scripts/auto-identity-remove/test/success-i18n.test.js` | Created (Test) | Per-locale success/failure/unknown assertions for `lib/success.js` + English regression. |
| `/Users/stephen/scripts/auto-identity-remove/test/confirm-i18n.test.js` | Created (Test) | Per-locale confirmation assertions for `lib/confirm.js` + English regression. |
| `/Users/stephen/scripts/auto-identity-remove/test/broker-runner-i18n.test.js` | Created (Test) | Wiring test: broker-runner reads `<html lang>` and threads it into the classifiers (Module._load mock). |

---

## Task 1: Locale pattern module (`lib/locale-patterns.js`)

This task builds the data layer: a `langOf(htmlLang)` normalizer and `patternsFor(lang)` selector returning `{ success, failure, confirm }` RegExp objects for a supported locale, or `null` for unknown / English-only.

Files:
- Create: `/Users/stephen/scripts/auto-identity-remove/lib/locale-patterns.js`
- Test: `/Users/stephen/scripts/auto-identity-remove/test/locale-patterns.test.js`

- [ ] Step 1.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/locale-patterns.test.js` with this COMPLETE content:

```js
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

// ── langOf normalization ────────────────────────────────────────────────────

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

// ── patternsFor selection ─────────────────────────────────────────────────────

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
```

- [ ] Step 1.2: Run it, expect fail. Command: `node --test test/locale-patterns.test.js`. Expected failure: `Cannot find module '../lib/locale-patterns'` (the module does not exist yet).

- [ ] Step 1.3: Implement. Create `/Users/stephen/scripts/auto-identity-remove/lib/locale-patterns.js` with this COMPLETE content:

```js
/**
 * lib/locale-patterns.js
 *
 * Per-locale post-submit pattern sets for non-English broker pages.
 *
 * English is NOT represented here: it is the always-on default baked into
 * lib/success.js and lib/confirm.js. These sets are unioned WITH English at
 * classification time, so a German page that happens to contain an English
 * phrase still matches.
 *
 * Each locale exposes three RegExp:
 *   - success: "request received / removed / done" verbatim copy
 *   - failure: "required field / invalid / error / try again" copy
 *   - confirm: "check your email / confirm the link" copy
 *
 * Patterns are deliberately conservative (mirrors the English tuning in
 * success.js): a false-positive success starts a 90-day cooldown that hides a
 * still-live data exposure, and a false-positive confirm freezes a real
 * success into a perpetual "pending" entry.
 *
 * Accents are matched literally; we do NOT strip diacritics, because page
 * innerText preserves them and stripping would broaden the match surface.
 */

// Spanish
const ES_SUCCESS = /(su (solicitud|petici[oó]n) (de (exclusi[oó]n|eliminaci[oó]n|baja))? ?(ha sido|fue|se ha) (recibida|procesada|completada|enviada|confirmada)|hemos recibido su (solicitud|petici[oó]n)|sus datos han sido (eliminados|borrados|suprimidos)|(solicitud|eliminaci[oó]n) (recibida|completada|procesada|enviada con [eé]xito)|enviad[oa] correctamente|baja (completada|confirmada))/i;
const ES_FAILURE = /(este campo es (obligatorio|requerido)|campo (obligatorio|requerido)|por favor (introduzca|complete|rellene|corrija)|(correo|email|tel[eé]fono|c[oó]digo postal|direcci[oó]n) (electr[oó]nico )?(no v[aá]lido|inv[aá]lido)|algo (sali[oó]|ha salido) mal|se (ha )?produjo un error|int[eé]ntelo de nuevo|no se pudo (procesar|enviar)|env[ií]o (fallido|err[oó]neo))/i;
const ES_CONFIRM = /(revise su (correo|bandeja de entrada|email)|confirme su (correo|email|solicitud)|verifique su (correo|email|solicitud)|le hemos enviado (un|una) (correo|email|enlace)|haga clic en el enlace|enlace de confirmaci[oó]n)/i;

// French
const FR_SUCCESS = /(votre demande (de (suppression|d[eé]sinscription|retrait))? ?(a [eé]t[eé]|est) ?(re[cç]ue|trait[eé]e|envoy[eé]e|enregistr[eé]e|confirm[eé]e|termin[eé]e)|nous avons (bien )?re[cç]u votre demande|vos donn[eé]es ont [eé]t[eé] (supprim[eé]es|effac[eé]es)|(demande|suppression) (re[cç]ue|trait[eé]e|envoy[eé]e avec succ[eè]s)|envoy[eé]e? avec succ[eè]s|d[eé]sinscription (r[eé]ussie|confirm[eé]e))/i;
const FR_FAILURE = /(ce champ est (obligatoire|requis)|champ (obligatoire|requis)|veuillez (saisir|compl[eé]ter|corriger)|(adresse e-?mail|courriel|t[eé]l[eé]phone|code postal|adresse) (invalide|non valide)|une erreur (s'est produite|est survenue)|quelque chose s'est mal pass[eé]|veuillez r[eé]essayer|impossible de (traiter|envoyer)|[eé]chec de l'envoi)/i;
const FR_CONFIRM = /(v[eé]rifie[rz] votre (e-?mail|bo[iî]te de r[eé]ception|courriel)|consultez votre (e-?mail|bo[iî]te)|confirmez votre (e-?mail|courriel|demande)|nous (vous )?avons envoy[eé] (un|une) (e-?mail|courriel|lien)|cliquez sur le lien|lien de confirmation)/i;

// German
const DE_SUCCESS = /(ihre? (anfrage|antrag|l[oö]schanfrage|abmeldung) (wurde|ist|ist erfolgreich) ?(eingegangen|erhalten|bearbeitet|gesendet|best[aä]tigt|abgeschlossen)|wir haben ihre (anfrage|anforderung) erhalten|ihre daten wurden (gel[oö]scht|entfernt)|(anfrage|l[oö]schung) (eingegangen|abgeschlossen|erfolgreich (gesendet|[uü]bermittelt))|erfolgreich (gesendet|[uü]bermittelt|abgemeldet))/i;
const DE_FAILURE = /(dieses feld ist (erforderlich|ein pflichtfeld)|pflichtfeld|bitte (geben sie|f[uü]llen sie|korrigieren sie)|(ung[uü]ltige|ung[uü]ltiges) (e-?mail|telefon|postleitzahl|adresse)|etwas ist schief ?(gelaufen|gegangen)|ein fehler ist (aufgetreten|passiert)|bitte versuchen sie es erneut|konnte nicht (verarbeitet|gesendet) werden|[uü]bermittlung fehlgeschlagen)/i;
const DE_CONFIRM = /([uü]berpr[uü]fen sie ihre? (e-?mail|posteingang)|pr[uü]fen sie ihr postfach|best[aä]tigen sie ihre? (e-?mail|anfrage)|verifizieren sie ihre? (e-?mail|anfrage)|wir haben ihnen (eine|einen) (e-?mail|link) (gesendet|geschickt)|klicken sie auf den link|best[aä]tigungslink)/i;

// Portuguese
const PT_SUCCESS = /(sua (solicita[cç][aã]o|pedido) (de (exclus[aã]o|remo[cç][aã]o|cancelamento))? ?(foi|est[aá]|foi recebid[oa]) ?(recebid[oa]|processad[oa]|enviad[oa]|conclu[ií]d[oa]|confirmad[oa])|recebemos sua (solicita[cç][aã]o|pedido)|seus dados foram (exclu[ií]dos|removidos|apagados)|(solicita[cç][aã]o|remo[cç][aã]o) (recebid[oa]|conclu[ií]d[oa]|enviad[oa] com sucesso)|enviad[oa] com sucesso|cancelamento (conclu[ií]do|confirmado))/i;
const PT_FAILURE = /(este campo [eé] obrigat[oó]rio|campo obrigat[oó]rio|por favor (insira|preencha|complete|corrija)|(e-?mail|telefone|c[oó]digo postal|cep|endere[cç]o) (inv[aá]lido|n[aã]o v[aá]lido)|algo deu errado|ocorreu um erro|tente novamente|n[aã]o foi poss[ií]vel (processar|enviar)|falha no envio)/i;
const PT_CONFIRM = /(verifique (o )?seu (e-?mail|caixa de entrada)|confirme (o )?seu (e-?mail|solicita[cç][aã]o|pedido)|enviamos (um|uma) (e-?mail|link) para voc[eê]|clique no link|link de confirma[cç][aã]o)/i;

// Italian
const IT_SUCCESS = /(la tua richiesta (di (cancellazione|rimozione|disiscrizione))? ?([eè] stata|[eè]) ?(ricevuta|elaborata|inviata|completata|confermata)|abbiamo ricevuto la tua richiesta|i tuoi dati sono stati (eliminati|rimossi|cancellati)|(richiesta|rimozione) (ricevuta|completata|inviata con successo)|inviat[ao] con successo|disiscrizione (completata|confermata))/i;
const IT_FAILURE = /(questo campo [eè] obbligatorio|campo obbligatorio|(per favore|si prega di) (inserisci|inserire|compila|completa|correggi)|(e-?mail|telefono|codice postale|cap|indirizzo) (non valido|invalido)|qualcosa [eè] andato storto|si [eè] verificato un errore|riprova(re)?|impossibile (elaborare|inviare)|invio non riuscito)/i;
const IT_CONFIRM = /(controlla la tua (e-?mail|casella di posta)|verifica la tua (e-?mail|posta)|conferma (la tua )?(e-?mail|richiesta)|ti abbiamo inviato (un|una) (e-?mail|link)|clicca sul link|link di conferma)/i;

const LOCALE_PATTERNS = {
  es: { success: ES_SUCCESS, failure: ES_FAILURE, confirm: ES_CONFIRM },
  fr: { success: FR_SUCCESS, failure: FR_FAILURE, confirm: FR_CONFIRM },
  de: { success: DE_SUCCESS, failure: DE_FAILURE, confirm: DE_CONFIRM },
  pt: { success: PT_SUCCESS, failure: PT_FAILURE, confirm: PT_CONFIRM },
  it: { success: IT_SUCCESS, failure: IT_FAILURE, confirm: IT_CONFIRM },
};

const SUPPORTED_LANGS = Object.keys(LOCALE_PATTERNS);

/**
 * Normalize a raw <html lang> attribute value to a bare two-letter lowercase
 * ISO code. 'es-ES' -> 'es', 'PT-br' -> 'pt', 'it_IT' -> 'it'. Returns '' for
 * missing / non-string input.
 *
 * @param {string|null|undefined} htmlLang
 * @returns {string}
 */
function langOf(htmlLang) {
  if (!htmlLang || typeof htmlLang !== 'string') return '';
  return htmlLang.trim().toLowerCase().split(/[-_]/)[0];
}

/**
 * Return the locale pattern set for a language code, or null when the language
 * is English / unknown / missing (English is handled by the default patterns).
 * Accepts un-normalized region tags (e.g. 'es-MX').
 *
 * @param {string|null|undefined} lang
 * @returns {{ success: RegExp, failure: RegExp, confirm: RegExp }|null}
 */
function patternsFor(lang) {
  const code = langOf(lang);
  return LOCALE_PATTERNS[code] || null;
}

module.exports = { langOf, patternsFor, SUPPORTED_LANGS, LOCALE_PATTERNS };
```

- [ ] Step 1.4: Run, expect pass. Command: `node --test test/locale-patterns.test.js`. Expected: all tests pass (0 failures).

- [ ] Step 1.5: Commit. Run:
```
rtk git add lib/locale-patterns.js test/locale-patterns.test.js
git commit -m "Add locale pattern module for i18n post-submit detection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Localize `lib/success.js`

Thread an optional `lang` argument through `looksLikeSuccess`, `looksLikeFailure`, and `classifyPostSubmit`. When a supported locale is supplied, test the locale pattern OR the English default. English-only behavior (no `lang`, or `lang === 'en'`) is unchanged.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/success.js` (lines 15-51)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/success-i18n.test.js`

- [ ] Step 2.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/success-i18n.test.js` with this COMPLETE content:

```js
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

// ── English regression - default path must be byte-for-byte unchanged ─────────

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
```

- [ ] Step 2.2: Run it, expect fail. Command: `node --test test/success-i18n.test.js`. Expected failure: the `[es] looksLikeSuccess true with lang` and sibling locale tests fail because the current `looksLikeSuccess` ignores its second argument and tests only `SUCCESS_PATTERN` (English), so the Spanish/French/etc phrases return `false` / `unknown`.

- [ ] Step 2.3: Implement. Edit `/Users/stephen/scripts/auto-identity-remove/lib/success.js`. Replace the body from line 15 (`function looksLikeSuccess`) through the end of file (the `module.exports`) with this COMPLETE content (leave lines 1-13, the header comment and the two `const ... PATTERN` declarations, exactly as they are):

```js
const { patternsFor } = require('./locale-patterns');

function looksLikeSuccess(text, lang) {
  if (!text || typeof text !== 'string') return false;
  if (SUCCESS_PATTERN.test(text)) return true;
  const locale = patternsFor(lang);
  return locale ? locale.success.test(text) : false;
}

function looksLikeFailure(text, lang) {
  if (!text || typeof text !== 'string') return false;
  if (FAILURE_PATTERN.test(text)) return true;
  const locale = patternsFor(lang);
  return locale ? locale.failure.test(text) : false;
}

function _snippet(text, pattern) {
  const m = text.match(pattern);
  if (!m) return '';
  return text.slice(Math.max(0, m.index - 20), m.index + 100).replace(/\s+/g, ' ').trim();
}

/**
 * @param {string|null|undefined} text  Page body innerText after submit
 * @param {string} [lang]               Normalized or raw <html lang> code (e.g. 'es', 'fr-FR')
 * @returns {{ outcome: 'success'|'failure'|'unknown', snippet: string }}
 */
function classifyPostSubmit(text, lang) {
  if (!text || typeof text !== 'string') return { outcome: 'unknown', snippet: '' };

  const locale = patternsFor(lang);

  if (SUCCESS_PATTERN.test(text)) return { outcome: 'success', snippet: _snippet(text, SUCCESS_PATTERN) };
  if (locale && locale.success.test(text)) return { outcome: 'success', snippet: _snippet(text, locale.success) };

  if (FAILURE_PATTERN.test(text)) return { outcome: 'failure', snippet: _snippet(text, FAILURE_PATTERN) };
  if (locale && locale.failure.test(text)) return { outcome: 'failure', snippet: _snippet(text, locale.failure) };

  return { outcome: 'unknown', snippet: '' };
}

module.exports = { looksLikeSuccess, looksLikeFailure, classifyPostSubmit, SUCCESS_PATTERN, FAILURE_PATTERN };
```

- [ ] Step 2.4: Run, expect pass. Commands: `node --test test/success-i18n.test.js` then `node --test test/success.test.js`. Expected: both pass (0 failures). The original `test/success.test.js` proves English behavior is unchanged.

- [ ] Step 2.5: Commit. Run:
```
rtk git add lib/success.js test/success-i18n.test.js
git commit -m "Localize success/failure detection with opt-in lang union

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Localize `lib/confirm.js`

Thread an optional `lang` through `looksLikeConfirmationRequired` and `detectConfirmationRequired`. `detectConfirmationRequired` reads the page `<html lang>` itself when a `lang` is not supplied, so callers that already have the language (broker-runner) can pass it, and direct callers still work.

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/confirm.js` (lines 26-47)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/confirm-i18n.test.js`

- [ ] Step 3.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/confirm-i18n.test.js` with this COMPLETE content:

```js
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

// ── English regression ────────────────────────────────────────────────────────

test('EN regression: confirmation without lang still matches', () => {
  assert.equal(looksLikeConfirmationRequired('Please check your email to confirm.'), true);
});
test('EN regression: non-confirmation without lang stays false', () => {
  assert.equal(looksLikeConfirmationRequired('Your data has been removed.'), false);
});
test('English confirmation still matches under a non-English lang (union)', () => {
  assert.equal(looksLikeConfirmationRequired('Please check your email.', 'fr'), true);
});

// ── detectConfirmationRequired language threading ─────────────────────────────

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
```

- [ ] Step 3.2: Run it, expect fail. Command: `node --test test/confirm-i18n.test.js`. Expected failure: the `[es] confirmation matches WITH lang` and sibling locale tests fail because `looksLikeConfirmationRequired` currently ignores the second argument and tests only the English `PATTERN`, so foreign phrases return `false`.

- [ ] Step 3.3: Implement. Edit `/Users/stephen/scripts/auto-identity-remove/lib/confirm.js`. Replace the body from line 26 (`function looksLikeConfirmationRequired`) through the end of file (the `module.exports`) with this COMPLETE content (leave lines 1-24, the header comment and the `const PATTERN` declaration, exactly as they are):

```js
const { patternsFor, langOf } = require('./locale-patterns');

function looksLikeConfirmationRequired(text, lang) {
  if (!text || typeof text !== 'string') return false;
  if (PATTERN.test(text)) return true;
  const locale = patternsFor(lang);
  return locale ? locale.confirm.test(text) : false;
}

function _confirmSnippet(text, pattern) {
  const m = text.match(pattern);
  if (!m) return '';
  return text.slice(Math.max(0, m.index - 30), m.index + 120).replace(/\s+/g, ' ').trim();
}

/**
 * @param {object} page             Playwright-like page with async evaluate()
 * @param {string} [lang]           Page language code. When omitted, the
 *                                   <html lang> attribute is read from the page.
 * @returns {Promise<{ pending: boolean, snippet: string }>}
 */
async function detectConfirmationRequired(page, lang) {
  try {
    let effectiveLang = lang;
    if (!effectiveLang) {
      const rawLang = await page.evaluate(
        () => (document.documentElement && document.documentElement.getAttribute('lang')) || ''
      ).catch(() => '');
      effectiveLang = langOf(rawLang);
    }
    const body = await page.evaluate(() => document.body && document.body.innerText || '');
    if (looksLikeConfirmationRequired(body, effectiveLang)) {
      const locale = patternsFor(effectiveLang);
      const matchPattern = PATTERN.test(body) ? PATTERN : (locale ? locale.confirm : PATTERN);
      return { pending: true, snippet: _confirmSnippet(body, matchPattern) };
    }
  } catch (_) {}
  return { pending: false, snippet: '' };
}

module.exports = {
  PATTERN,
  looksLikeConfirmationRequired,
  detectConfirmationRequired,
};
```

- [ ] Step 3.4: Run, expect pass. Commands: `node --test test/confirm-i18n.test.js` then `node --test test/confirm-detection.test.js`. Expected: both pass (0 failures). The original `test/confirm-detection.test.js` proves English behavior and the single-`evaluate` mock still work, because when no `lang` is passed the new code calls `evaluate` twice (lang read then body); the original test mocks return the body string for every `evaluate` call, so the lang read yields the body text, `langOf(body)` produces a harmless bare token, `patternsFor` returns null, and the English `PATTERN` still drives the result.

- [ ] Step 3.5: Commit. Run:
```
rtk git add lib/confirm.js test/confirm-i18n.test.js
git commit -m "Localize confirmation detection; read html lang when not supplied

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Wire page language through `lib/broker-runner.js`

After submit, read the page `<html lang>` attribute once and thread the normalized code into both `detectConfirmationRequired(page, lang)` and `classifyPostSubmit(body, lang)`. This is the runtime integration point; no CLI flag is needed because the language is auto-detected from the page itself (this is the natural integration surface for this feature, matching the plan brief's "Detect page language from an html lang attribute when available").

Files:
- Modify: `/Users/stephen/scripts/auto-identity-remove/lib/broker-runner.js` (lines 18, 164-188)
- Test: `/Users/stephen/scripts/auto-identity-remove/test/broker-runner-i18n.test.js`

- [ ] Step 4.1: Write the failing test. Create `/Users/stephen/scripts/auto-identity-remove/test/broker-runner-i18n.test.js` with this COMPLETE content (Module._load interception, mirroring `test/broker-runner-buckets.test.js`):

```js
/**
 * test/broker-runner-i18n.test.js
 *
 * Verifies broker-runner reads the page <html lang> attribute after submit and
 * threads it into classifyPostSubmit(body, lang) and
 * detectConfirmationRequired(page, lang).
 *
 * A Spanish success page (which the English-only classifier would mark
 * 'unverified') must be logged 'success' and recorded once the lang is wired.
 *
 * Uses the Module._load interception pattern from broker-runner-buckets.test.js.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

const logged = [];
const recorded = { success: [], failure: [], pending: [] };

// Capture the lang argument the runner passes into each classifier.
const seen = { classifyLang: undefined, confirmLang: undefined, classifyBody: undefined };

const SPANISH_BODY = 'Hemos recibido su solicitud de eliminación. Sus datos han sido eliminados.';

const configMock = {
  RECHECK_DAYS: 90,
  CONFIRM_RECHECK_DAYS: 14,
  lastOptOutDaysAgo: () => Infinity,
  shouldSkip: () => null,
  isPendingConfirmation: () => false,
  recordSuccess: (name, detail) => recorded.success.push({ name, detail }),
  recordPendingConfirmation: (name, snippet) => recorded.pending.push({ name, snippet }),
  recordFailure: (name, kind) => recorded.failure.push({ name, kind }),
  loadState: () => ({ optOuts: {} }),
  saveCheckpoint: () => {},
  stateKey: (brokerName) => brokerName,
};

// Real locale patterns + real success classifier so the union is exercised
// end to end. We only stub the language-detection / confirm modules to record
// what the runner passes, and forms/captcha/etc to avoid a real browser.
const realSuccess = originalLoad('../lib/success', module, false);

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('broker-runner')) return originalLoad(request, parent, isMain);
  if (request === './config') return configMock;
  if (request === './logger') return {
    logResult: (name, status, detail) => logged.push({ name, status, detail }),
    STATUS_BUCKET: {},
  };
  if (request === './forms') return {
    fillForm: async () => {},
    findListingUrl: async () => 'https://example.com/listing/123',
  };
  if (request === './captcha') return { detectAndSolveCaptcha: async () => true };
  if (request === './confirm') return {
    detectConfirmationRequired: async (_page, lang) => {
      seen.confirmLang = lang;
      return { pending: false, snippet: '' };
    },
  };
  if (request === './success') return {
    classifyPostSubmit: (body, lang) => {
      seen.classifyLang = lang;
      seen.classifyBody = body;
      return realSuccess.classifyPostSubmit(body, lang);
    },
  };
  if (request === './retry') return { withRetry: fn => fn() };
  if (request === './timing') return { jitterSleep: async () => {} };
  if (request === './snapshot') return { captureSubmitSnapshot: async () => null };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const brokerRunnerPath = require.resolve('../lib/broker-runner');
delete require.cache[brokerRunnerPath];
const { configure, processBrokerWithPerson } = require('../lib/broker-runner');
Module._load = originalLoad;

// ── Page / context mocks ──────────────────────────────────────────────────────

function makePage(body, htmlLang) {
  return {
    async goto() {},
    locator() {
      return {
        first() { return this; },
        async fill() {},
        async count() { return 1; },
        async isVisible() { return true; },
        async click() {},
      };
    },
    async evaluate(fn) {
      // The runner calls evaluate twice in the relevant region: once for the
      // <html lang> attribute, once for document.body.innerText. We dispatch by
      // running the supplied function against a tiny fake DOM.
      const fakeDoc = {
        documentElement: { getAttribute: (name) => (name === 'lang' ? htmlLang : null) },
        body: { innerText: body },
        querySelectorAll: () => [],
      };
      const globalDocument = global.document;
      global.document = fakeDoc;
      try {
        return fn();
      } finally {
        global.document = globalDocument;
      }
    },
    async close() {},
  };
}

function makeContext(page) {
  return { async newPage() { return page; } };
}

const PERSON = { firstName: 'Ana', lastName: 'Lopez', fullName: 'Ana Lopez', country: 'ES' };

const SPANISH_BROKER = {
  name: 'SitioES',
  method: 'search-form',
  searchUrl: 'https://example.com/search',
  optOutUrl: 'https://example.com/opt-out',
  submitSelector: 'button[type="submit"]',
  formFields: { 'input[name="name"]': 'Ana Lopez' },
};

function reset() {
  logged.length = 0;
  recorded.success.length = 0;
  recorded.failure.length = 0;
  recorded.pending.length = 0;
  seen.classifyLang = undefined;
  seen.confirmLang = undefined;
  seen.classifyBody = undefined;
  configure({ dryRun: false, person: PERSON, capsolver: null, noCapsolver: true, snapshot: false, personCount: 1 });
}

test('broker-runner threads normalized html lang into classifyPostSubmit', async () => {
  reset();
  const page = makePage(SPANISH_BODY, 'es-ES');
  await processBrokerWithPerson(makeContext(page), SPANISH_BROKER, PERSON);
  assert.equal(seen.classifyLang, 'es');
  assert.equal(seen.classifyBody, SPANISH_BODY);
});

test('broker-runner threads normalized html lang into detectConfirmationRequired', async () => {
  reset();
  const page = makePage(SPANISH_BODY, 'es-ES');
  await processBrokerWithPerson(makeContext(page), SPANISH_BROKER, PERSON);
  assert.equal(seen.confirmLang, 'es');
});

test('Spanish success page is logged success and recorded (was unverified before wiring)', async () => {
  reset();
  const page = makePage(SPANISH_BODY, 'es-ES');
  await processBrokerWithPerson(makeContext(page), SPANISH_BROKER, PERSON);
  assert.equal(recorded.success.length, 1, 'recordSuccess should be called once');
  assert.equal(recorded.success[0].name, 'SitioES');
  const successLog = logged.find(l => l.status === 'success');
  assert.ok(successLog, 'expected a success log entry');
});

test('missing html lang yields empty string lang (English-only path)', async () => {
  reset();
  const page = makePage('Your request has been received.', null);
  await processBrokerWithPerson(makeContext(page), { ...SPANISH_BROKER, name: 'SiteEN' }, PERSON);
  assert.equal(seen.classifyLang, '');
  assert.equal(recorded.success.length, 1);
});
```

- [ ] Step 4.2: Run it, expect fail. Command: `node --test test/broker-runner-i18n.test.js`. Expected failure: `broker-runner threads normalized html lang into classifyPostSubmit` fails with `seen.classifyLang` being `undefined` (the current runner calls `classifyPostSubmit(body)` with no second arg), and `Spanish success page is logged success` fails because the Spanish body classifies as `unverified` (so `recorded.success.length` is 0).

- [ ] Step 4.3: Implement. Two edits to `/Users/stephen/scripts/auto-identity-remove/lib/broker-runner.js`.

  First edit - add the `langOf` import. Change line 18 from:
```js
const { classifyPostSubmit } = require('./success');
```
to:
```js
const { classifyPostSubmit } = require('./success');
const { langOf } = require('./locale-patterns');
```

  Second edit - replace the post-submit block (current lines 164-188, starting at the `// Step 6:` comment and ending at the closing `}` before the `} catch (err) {`) with this COMPLETE content:
```js
    // Step 6: check post-submit page. First detect the page language from
    // <html lang> so non-English brokers classify correctly, then check for an
    // email-confirmation requirement, then verify success via DOM text.
    // Click-then-assume is a false-positive source - forms can fail silently.
    const pageLang = langOf(
      await page.evaluate(
        () => (document.documentElement && document.documentElement.getAttribute('lang')) || ''
      ).catch(() => '')
    );
    const body = await Promise.resolve().then(() => page.evaluate(() => document.body?.innerText || '')).catch(() => '');
    const confirm = await detectConfirmationRequired(page, pageLang);
    const snapshotSuffix = snapshotFile ? ` [snapshot: ${snapshotFile}]` : '';
    if (confirm.pending) {
      logResult(broker.name, 'pending_confirm', (confirm.snippet || 'check your email to confirm') + snapshotSuffix);
      recordPendingConfirmation(key, confirm.snippet);
    } else {
      const { outcome, snippet } = classifyPostSubmit(body, pageLang);
      if (outcome === 'failure') {
        // Form validation error or server error - do NOT start 90-day cooldown
        logResult(broker.name, 'error', (snippet || 'form submission may have failed') + snapshotSuffix);
        recordFailure(key, 'error');
      } else if (outcome === 'success') {
        // Explicit confirmation text found - start 90-day cooldown
        logResult(broker.name, 'success', snippet + snapshotSuffix);
        recordSuccess(key);
      } else {
        // 'unknown' = no confirmation text found - do NOT start 90-day cooldown;
        // next run will re-check so we don't hide silent failures
        logResult(broker.name, 'unverified', 'no explicit confirmation - re-check next run' + snapshotSuffix);
      }
    }
```

- [ ] Step 4.4: Run, expect pass. Commands: `node --test test/broker-runner-i18n.test.js` then `node --test test/broker-runner-buckets.test.js`. Expected: both pass. The existing buckets test still passes because its `./confirm` and `./success` mocks accept (and ignore) extra arguments, and its page mock returns a controllable body for every `evaluate` call (the new lang read just returns that body, which `langOf` reduces to a harmless token; the mocked `classifyPostSubmit` ignores it).

- [ ] Step 4.5: Commit. Run:
```
rtk git add lib/broker-runner.js test/broker-runner-i18n.test.js
git commit -m "Thread page html lang into post-submit classifiers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full suite green

Run the complete root test suite (and the dashboard suite, untouched here, as a sanity check) to confirm no regressions across all 56+ test files.

Files: none (verification only).

- [ ] Step 5.1: Run the root suite exactly as CI does. Command: `node --test test/*.test.js dashboard/validate.test.js`. Expected: 0 failures. Pay special attention to `test/success.test.js`, `test/confirm-detection.test.js`, and `test/broker-runner-buckets.test.js` (the regression guards) all passing.

- [ ] Step 5.2: Run the dashboard suite as a sanity check (it is unmodified by this feature). Command: `cd /Users/stephen/scripts/auto-identity-remove/dashboard && node --test`. Expected: 0 failures (this feature does not touch the dashboard, so this only confirms nothing was disturbed).

- [ ] Step 5.3: If both suites are green, the feature is complete. If any test fails, read the failure, fix the offending file (not the test, unless the test itself encodes a wrong expectation), and re-run from Step 5.1. Do NOT proceed to commit until green.

- [ ] Step 5.4: Final commit (only if Steps 5.1-5.2 surfaced and you fixed any incidental issues; otherwise skip). Run:
```
rtk git add -A
git commit -m "Verify full suite green after i18n detection wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review

Spec coverage:
- Localized detection for Spanish, French, German, Portuguese, Italian: Task 1 defines `success`, `failure`, and `confirm` (check-your-email) RegExp sets for all five locales in `lib/locale-patterns.js`. Tasks 2 and 3 union them with English in `lib/success.js` and `lib/confirm.js`. Task 4 wires them at runtime.
- Detect page language from an `<html lang>` attribute when available, passed in: `langOf()` (Task 1) normalizes `es-ES`/`PT-br`/`it_IT`/whitespace/null. `detectConfirmationRequired` reads `document.documentElement.getAttribute('lang')` when no `lang` is passed (Task 3). `broker-runner.js` reads the same attribute once and passes it to both classifiers (Task 4).
- Union matching locale patterns with English; English stays the default: every classifier tests the English pattern FIRST and only falls through to the locale pattern; with no `lang` (or `lang === 'en'`) `patternsFor` returns null and behavior is byte-for-byte the original English path. Regression tests in Tasks 2 and 3 assert this, and the pre-existing `test/success.test.js` / `test/confirm-detection.test.js` are re-run unmodified in Step 2.4 / 3.4 / 5.1.
- Pure functions, exhaustively unit-tested per locale: `langOf` and `patternsFor` are pure; `looksLikeSuccess`/`looksLikeFailure`/`classifyPostSubmit`/`looksLikeConfirmationRequired` are pure string functions. Per-locale success/failure/unknown/confirmation assertions plus opt-in-union and English-regression cases are in Tasks 1-3. No test touches the network, a real browser, or the real `config.json`/`state.json` (broker-runner test uses Module._load mocks and an in-memory fake document).
- Integration/wiring task: Task 4 threads the language through `broker-runner.js`. (No CLI flag or dashboard endpoint is added: the language is auto-detected from the page `<html lang>`, which is the correct integration surface for this feature and matches the brief; the dashboard does not classify post-submit text.)
- Final full-suite task: Task 5 runs `node --test test/*.test.js dashboard/validate.test.js` and `cd dashboard && node --test`.

Signature consistency with the real repo (verified against the read files):
- `lib/success.js` exports stay `{ looksLikeSuccess, looksLikeFailure, classifyPostSubmit, SUCCESS_PATTERN, FAILURE_PATTERN }` (unchanged export shape; functions gain an OPTIONAL second `lang` arg, so all existing callers and tests keep working).
- `lib/confirm.js` exports stay `{ PATTERN, looksLikeConfirmationRequired, detectConfirmationRequired }`; `detectConfirmationRequired(page, lang)` adds an OPTIONAL second arg and self-reads `<html lang>` when omitted, preserving the existing single-arg `test/confirm-detection.test.js` contract.
- `lib/broker-runner.js` keeps its `{ configure, processBroker, processBrokerWithPerson }` exports; the only edits are the `langOf` import (new line after line 18) and the post-submit block (lines 164-188), matching the exact lines read from the file. The calls changed are `detectConfirmationRequired(page, pageLang)` and `classifyPostSubmit(body, pageLang)` - both still real functions with compatible signatures.
- New module `lib/locale-patterns.js` exports `{ langOf, patternsFor, SUPPORTED_LANGS, LOCALE_PATTERNS }`, all consumed by the tests in Task 1 and by `success.js`/`confirm.js`/`broker-runner.js`.

No placeholders: every test and implementation step contains complete, runnable code. No "TBD", no "add error handling", no "similar to above". CommonJS throughout (`require`/`module.exports`), no TypeScript, no new npm dependencies, no em dashes (hyphens only). RTK prefix used on the `git add` read-adjacent commands per repo convention.
