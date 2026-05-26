/**
 * lib/imap-confirm.js
 *
 * Email-confirmation auto-click via .eml file processor.
 *
 * Walks a directory for *.eml files, parses each one to extract:
 *   - The From header
 *   - A confirmation URL from the message body
 *
 * For each file where a broker match is found and a confirmation URL is
 * extracted, optionally navigates to the URL using a Playwright context
 * (skipped when dryRun=true) and calls recordSuccess for the broker.
 *
 * No external dependencies - uses Node built-in fs only.
 *
 * @param {object} context     Playwright browser context (or stub in tests)
 * @param {Array}  brokers     Broker definitions with optional `expectedSender`
 * @param {object} opts
 * @param {string}   opts.dir          Directory containing .eml files
 * @param {boolean}  opts.dryRun       When true, skip Playwright + recordSuccess
 * @param {function} opts._readDir     Injection hook for tests (replaces fs.readdirSync)
 * @param {function} opts._readFile    Injection hook for tests (replaces fs.readFileSync)
 * @param {function} opts._moveFile    Injection hook for tests (replaces file move)
 * @param {function} opts._recordSuccess  Injection hook for tests (replaces config.recordSuccess)
 *
 * @returns {{ processed: Array, unmatched: Array, failed: Array }}
 */

const fs   = require('fs');
const path = require('path');

// Matches confirmation-type URLs in an email body.
// Looks for http(s) URLs containing keywords that indicate an opt-out confirmation link.
const CONFIRM_URL_RE = /https?:\/\/[^\s<>"']*?(confirm|verify|optout|opt-out|removal|delete)[^\s<>"']*/i;

/**
 * Parse a minimal RFC 5322 .eml file.
 * Returns { from: string, body: string }.
 */
function parseEml(content) {
  // Normalise line endings
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split headers from body at the first blank line
  const blankLineIdx = text.indexOf('\n\n');
  const headerSection = blankLineIdx === -1 ? text : text.slice(0, blankLineIdx);
  const body = blankLineIdx === -1 ? '' : text.slice(blankLineIdx + 2);

  // Extract From header (case-insensitive, supports folded headers minimally)
  let from = '';
  for (const line of headerSection.split('\n')) {
    const m = line.match(/^From:\s*(.+)/i);
    if (m) {
      from = m[1].trim();
      break;
    }
  }

  return { from, body };
}

/**
 * Find a broker whose expectedSender is a case-insensitive substring of the
 * given From header value.
 *
 * @param {string} fromHeader
 * @param {Array}  brokers
 * @returns {object|null}
 */
function matchBroker(fromHeader, brokers) {
  const fromLower = fromHeader.toLowerCase();
  for (const broker of brokers) {
    if (!broker.expectedSender) continue;
    if (fromLower.includes(broker.expectedSender.toLowerCase())) {
      return broker;
    }
  }
  return null;
}

/**
 * Move a processed .eml file to dir/processed/ (best-effort - errors are swallowed).
 */
function moveToProcessed(filePath, dir) {
  try {
    const processedDir = path.join(dir, 'processed');
    fs.mkdirSync(processedDir, { recursive: true });
    const dest = path.join(processedDir, path.basename(filePath));
    fs.renameSync(filePath, dest);
  } catch (_) {
    // best-effort
  }
}

/**
 * Process confirmation emails in a directory.
 *
 * @param {object} context   Playwright browser context
 * @param {Array}  brokers   Array of broker definition objects
 * @param {object} opts
 * @returns {Promise<{ processed: Array, unmatched: Array, failed: Array }>}
 */
async function processConfirmationEmails(context, brokers, opts = {}) {
  const {
    dir = './inbox/confirms',
    dryRun = false,
    _readDir,
    _readFile,
    _moveFile,
    _recordSuccess,
  } = opts;

  const readDir  = _readDir  || (() => fs.readdirSync(dir));
  const readFile = _readFile || ((f) => fs.readFileSync(f, 'utf8'));
  const moveFile = _moveFile || ((f) => moveToProcessed(f, dir));

  // Load recordSuccess from config unless injected (injection used by tests)
  const doRecordSuccess = _recordSuccess
    || require('./config').recordSuccess;

  const processed = [];
  const unmatched = [];
  const failed = [];

  let fileNames;
  try {
    fileNames = readDir();
  } catch (err) {
    // If dir doesn't exist, return empty result gracefully
    return { processed, unmatched, failed };
  }

  const emlFiles = fileNames.filter(f => f.toLowerCase().endsWith('.eml'));

  for (const fileName of emlFiles) {
    const filePath = path.join(dir, fileName);

    let content;
    try {
      content = readFile(filePath);
    } catch (err) {
      unmatched.push({ file: filePath, reason: 'read_error', error: err.message });
      continue;
    }

    const { from, body } = parseEml(content);

    // Find a matching broker by expectedSender
    const broker = matchBroker(from, brokers);
    if (!broker) {
      unmatched.push({ file: filePath, reason: 'no_broker', from });
      continue;
    }

    // Extract a confirmation URL from the body
    const urlMatch = body.match(CONFIRM_URL_RE);
    if (!urlMatch) {
      unmatched.push({ file: filePath, reason: 'no_url', broker: broker.name });
      continue;
    }

    const url = urlMatch[0];

    if (dryRun) {
      processed.push({ broker, url, file: filePath });
      continue;
    }

    // Open the URL in a headless Playwright page
    let page;
    try {
      page = await context.newPage();
      await page.goto(url, { timeout: 30000 });

      // Best-effort: try to grab a snippet of the final page text
      let finalText = '';
      try {
        finalText = (await page.textContent('body')) || '';
      } catch (_) {}

      processed.push({ broker, url, file: filePath, finalText: finalText.slice(0, 200) });

      // Transition state: mark broker as successfully confirmed
      doRecordSuccess(broker.name, `email-confirm:${url}`);

      // Move processed file out of the inbox
      moveFile(filePath);
    } catch (err) {
      failed.push({ broker, url, file: filePath, error: err.message });
    } finally {
      if (page) {
        try { await page.close(); } catch (_) {}
      }
    }
  }

  return { processed, unmatched, failed };
}

module.exports = { processConfirmationEmails, CONFIRM_URL_RE };
