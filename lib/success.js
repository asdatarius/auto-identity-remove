/**
 * lib/success.js
 *
 * Post-submit page text analysis. Classifies whether an opt-out form submission
 * appears to have succeeded, failed, or is ambiguous.
 *
 * Patterns are deliberately conservative: false positives (logging a failed
 * submission as success) cause a 90-day cooldown that hides live data exposure.
 */

const SUCCESS_PATTERN = /(your (opt-?out( request)?|removal|deletion|request) (is |has been |was )?(complete|received|submitted|processed|confirmed)|you('ve| have) been (removed|deleted|opted out)|we('ve| have) received your (request|opt-?out|deletion)|successfully (submitted|removed|processed|opted out)|removal (complete|confirmed|processed)|request (received|confirmed|submitted))/i;

const FAILURE_PATTERN = /(this field is required|please (enter|provide|fill out|correct)|invalid (email|phone|zip|postal|address)|something went wrong|an error (has occurred|occurred)|please try again|submission failed|could not (process|submit)|required field)/i;

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
