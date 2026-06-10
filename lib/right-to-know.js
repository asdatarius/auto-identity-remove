/**
 * lib/right-to-know.js
 *
 * PURE right-to-know (data access / disclosure) request template builder.
 *
 * Public API:
 *   buildKnowRequest({ person, broker, regime }) -> { subject, body }
 *   pickRegime(country) -> 'GDPR' | 'CCPA'
 *
 * This requests DISCLOSURE of what data a broker holds (a "show me what you
 * have" request), NOT erasure. GDPR path cites Article 15 (right of access);
 * CCPA path cites the consumer right to know (categories + specific pieces of
 * personal information collected, sources, purposes, and third parties).
 *
 * Pure module: no I/O, no config/logger requires, deterministic output. The
 * regime routing mirrors lib/email.js (_pickTemplate) so behaviour is
 * consistent across the codebase.
 */

// EU member states + GB (UK GDPR). Mirrors EU_COUNTRIES in lib/email.js.
const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK',
  'SI', 'ES', 'SE', 'GB',
]);

/**
 * Decide the legal regime for a right-to-know request based on country code.
 * @param {string|undefined} country - ISO 3166-1 alpha-2 country code
 * @returns {'GDPR'|'CCPA'}
 */
function pickRegime(country) {
  if (country && EU_COUNTRIES.has(String(country).toUpperCase())) return 'GDPR';
  return 'CCPA';
}

/**
 * Build the GDPR Article 15 right-of-access body (EU + UK).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyGDPR(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am writing to exercise my right of access under Article 15 of the General',
    'Data Protection Regulation (GDPR). I request that you disclose to me, in a',
    'commonly used electronic format, all personal data you hold about me, along',
    'with: the purposes of processing; the categories of personal data concerned;',
    'the recipients or categories of recipients to whom the data has been or will',
    'be disclosed; the sources from which the data was obtained; and the envisaged',
    'retention period.',
    '',
    `Name: ${person.fullName}`,
    `Location: ${person.city}, ${person.state} ${person.zip}`,
    `Email: ${person.email}`,
    `Phone: ${person.phoneFormatted}`,
    '',
    'Please provide this information within one month of receipt of this request,',
    'as required under Article 12(3) GDPR. This is a request for access and',
    'disclosure only; it is not a request for deletion.',
    '',
    'Thank you,',
    `${person.fullName}`,
  ].join('\n');
}

/**
 * Build the CCPA right-to-know body (US + other non-EU).
 * @param {object} person
 * @returns {string}
 */
function _buildBodyCCPA(person) {
  return [
    'To Whom It May Concern,',
    '',
    'I am exercising my right to know under the California Consumer Privacy Act',
    '(CCPA / CPRA) and applicable privacy laws. Please disclose to me the',
    'categories of personal information you have collected about me, the specific',
    'pieces of personal information you hold, the categories of sources from which',
    'it was collected, the business or commercial purpose for collecting it, and',
    'the categories of third parties with whom you have shared or sold it.',
    '',
    `Name: ${person.fullName}`,
    `Location: ${person.city}, ${person.state} ${person.zip}`,
    `Email: ${person.email}`,
    `Phone: ${person.phoneFormatted}`,
    '',
    'Please respond within 45 days as required under the CCPA. This is a request',
    'for disclosure of the information you hold; it is not a request for deletion.',
    '',
    'Thank you,',
    `${person.fullName}`,
  ].join('\n');
}

/**
 * Build a right-to-know request for one (person, broker) pair.
 *
 * @param {object} opts
 * @param {object} opts.person  - person record (fullName, city, state, zip, email, phoneFormatted, country)
 * @param {object} opts.broker  - broker definition (name; emailTo for email method)
 * @param {'GDPR'|'CCPA'} [opts.regime] - explicit override; default derived from person.country
 * @returns {{ subject: string, body: string }}
 */
function buildKnowRequest({ person, broker, regime } = {}) {
  const chosen = regime || pickRegime(person && person.country);
  const body = chosen === 'GDPR' ? _buildBodyGDPR(person) : _buildBodyCCPA(person);
  const subject = `Right to Know / Data Access Request - ${person.fullName}`;
  return { subject, body };
}

module.exports = {
  buildKnowRequest,
  pickRegime,
  // Internal exports for unit-testing
  _buildBodyGDPR,
  _buildBodyCCPA,
  EU_COUNTRIES,
};
