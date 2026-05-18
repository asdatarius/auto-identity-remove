/**
 * lib/confirm.js — WP4 email-confirmation detection
 *
 * Many brokers respond to a submitted opt-out form with "check your email to
 * confirm." The script previously logged `success` and moved on. We now scan
 * the post-submit page text for confirmation-required phrasing and classify
 * those as `pending_confirm` instead.
 *
 * `detectConfirmationRequired(page)` — async, returns `{ pending: bool, snippet }`.
 * `looksLikeConfirmationRequired(text)` — pure string check, exported for tests.
 *
 * Pattern set was tuned conservatively: false positives turn real successes
 * into perpetual "pending" entries. Phrases that match are all common
 * verbatim copy returned by Pipl, Spokeo, BeenVerified, OneTrust modals,
 * and the OneTrust DSAR portal.
 */

// Single combined regex. Each alternative is well-known opt-out flow copy.
//   - "check your email" / "check your inbox"
//   - "confirm your email" / "confirmation email" / "confirmation link" / "confirm your request"
//   - "verify your email" / "verify your request"
//   - "we've sent" / "we have sent" (almost always followed by "an email to ...")
//   - "click the link" (in conjunction with email-ish context handled by the above)
const PATTERN = /(check your (e-?mail|inbox)|confirm(ation)? (your )?(e-?mail|link|request)|verif(y|ication) (your )?(e-?mail|link|request)|we('| ha)ve sent (you )?(a|an) (confirmation |verification )?(e-?mail|link))/i;

function looksLikeConfirmationRequired(text) {
  if (!text || typeof text !== 'string') return false;
  return PATTERN.test(text);
}

async function detectConfirmationRequired(page) {
  try {
    const body = await page.evaluate(() => document.body && document.body.innerText || '');
    if (looksLikeConfirmationRequired(body)) {
      const m = body.match(PATTERN);
      const snippet = m ? body.slice(Math.max(0, m.index - 30), m.index + 120).replace(/\s+/g, ' ').trim() : '';
      return { pending: true, snippet };
    }
  } catch (_) {}
  return { pending: false, snippet: '' };
}

module.exports = {
  PATTERN,
  looksLikeConfirmationRequired,
  detectConfirmationRequired,
};
