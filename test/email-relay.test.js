/**
 * test/email-relay.test.js
 *
 * Verifies sendOptOutEmails substitutes a masked submissionEmail into the email
 * body and replyTo when provided, while the rest of the person data is intact.
 * nodemailer is mocked via Module._load so no real SMTP connection occurs.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const PERSON = {
  fullName: 'Jane Doe',
  firstName: 'Jane',
  lastName: 'Doe',
  city: 'Austin',
  state: 'TX',
  zip: '73301',
  email: 'jane.doe@example.com',
  phone: '5125550000',
  phoneFormatted: '(512) 555-0000',
  country: 'US',
};

const EMAIL_BROKER = { name: 'Pipl', method: 'email', emailTo: 'removal@pipl.com' };
const SMTP_CFG = { host: 'smtp.example.com', port: 587, user: 'u@x.com', pass: 'pw', from: 'u@x.com' };

const configMod = require('../lib/config');
const loggerMod = require('../lib/logger');
const origLastOptOut = configMod.lastOptOutDaysAgo;
const origRecordSuccess = configMod.recordSuccess;
const origLogResult = loggerMod.logResult;

function patchDeps() {
  configMod.lastOptOutDaysAgo = () => 999;
  configMod.recordSuccess = () => {};
  loggerMod.logResult = () => {};
}
function restoreDeps() {
  configMod.lastOptOutDaysAgo = origLastOptOut;
  configMod.recordSuccess = origRecordSuccess;
  loggerMod.logResult = origLogResult;
}

function loadFreshEmailWithSmtpMock() {
  const nmCalls = [];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'nodemailer') {
      return {
        createTransport: () => ({
          sendMail: async (opts) => { nmCalls.push(opts); return { messageId: 'mock' }; },
        }),
      };
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve('../lib/email')];
  const freshEmail = require('../lib/email');
  function restore() {
    Module._load = origLoad;
    delete require.cache[require.resolve('../lib/email')];
    require('../lib/email');
  }
  return { freshEmail, nmCalls, restore };
}

test('submissionEmail appears in the body and replyTo, real email is omitted', async () => {
  patchDeps();
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { person: PERSON, email: { smtp: SMTP_CFG } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux', {
    submissionEmailFor: () => 'jane.masked@aliases.simplelogin.io',
  });

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 1);
  assert.equal(nmCalls[0].replyTo, 'jane.masked@aliases.simplelogin.io');
  assert.ok(nmCalls[0].text.includes('jane.masked@aliases.simplelogin.io'), 'body should contain masked email');
  assert.ok(!nmCalls[0].text.includes('jane.doe@example.com'), 'real email must not appear in body');
});

test('without submissionEmailFor, the body uses person.email (backward compatible)', async () => {
  patchDeps();
  const { freshEmail, nmCalls, restore } = loadFreshEmailWithSmtpMock();

  const cfg = { person: PERSON, email: { smtp: SMTP_CFG } };
  await freshEmail.sendOptOutEmails([EMAIL_BROKER], cfg, 'linux');

  restore();
  restoreDeps();

  assert.equal(nmCalls.length, 1);
  assert.ok(nmCalls[0].text.includes('jane.doe@example.com'), 'body should contain real email when no relay');
  assert.equal(nmCalls[0].replyTo, undefined, 'replyTo omitted when no masked email');
});
