/**
 * test/confirm-detection.test.js — WP4
 *
 * Covers lib/confirm.js:
 *  - looksLikeConfirmationRequired(text): pure string check against the
 *    canonical confirmation phrasings used by major brokers
 *  - detectConfirmationRequired(page): wraps the above against a Playwright-
 *    like page object (mocked via a stub with `evaluate`)
 *
 * False-positive resistance matters here — a real submission that gets
 * reclassified as pending forever is a worse failure than the original bug.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { looksLikeConfirmationRequired, detectConfirmationRequired, PATTERN } =
  require('../lib/confirm');

// ── Positive cases — must match ──────────────────────────────────────────────

const POSITIVE = [
  'Please check your email to confirm your request.',
  'Check your inbox for the confirmation link.',
  'We have sent you a confirmation email.',
  "We've sent an email to you with a link.",
  'Verify your email address to complete the removal.',
  'Please confirm your email by clicking the link below.',
  'A confirmation link has been sent.',
  'CHECK YOUR EMAIL — UPPERCASE IS FINE',
  'Click the link in the verification email we just sent you.',
];

for (const s of POSITIVE) {
  test(`positive: "${s.slice(0, 40)}..."`, () => {
    assert.equal(looksLikeConfirmationRequired(s), true);
  });
}

// ── Negative cases — must NOT match ───────────────────────────────────────────

const NEGATIVE = [
  '',
  null,
  undefined,
  'Your request has been received.',
  'Thank you for submitting your opt-out request.',
  'Your data has been removed from our database.',
  'Removal complete.',
  'Subscribe to our newsletter via email.', // contains "email" but no confirm/verify/check
  'Email us at privacy@example.com for help.',
  'Successfully unsubscribed.',
  'We do not sell your personal information.',
];

for (const s of NEGATIVE) {
  test(`negative: ${JSON.stringify((s || '').slice(0, 40))}`, () => {
    assert.equal(looksLikeConfirmationRequired(s), false);
  });
}

test('detectConfirmationRequired returns { pending: true, snippet } on match', async () => {
  const page = {
    evaluate: async () => 'Thanks! Please check your email to confirm your opt-out request. Then close this tab.',
  };
  const out = await detectConfirmationRequired(page);
  assert.equal(out.pending, true);
  assert.match(out.snippet, /check your email/i);
});

test('detectConfirmationRequired returns { pending: false } on non-match', async () => {
  const page = { evaluate: async () => 'Your data has been removed.' };
  const out = await detectConfirmationRequired(page);
  assert.equal(out.pending, false);
  assert.equal(out.snippet, '');
});

test('detectConfirmationRequired swallows page.evaluate errors safely', async () => {
  const page = { evaluate: async () => { throw new Error('detached frame'); } };
  const out = await detectConfirmationRequired(page);
  assert.equal(out.pending, false);
});

test('PATTERN is exported (case-insensitive)', () => {
  assert.ok(PATTERN.flags.includes('i'));
});
