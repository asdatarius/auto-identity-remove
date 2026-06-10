/**
 * test/allowlist-generic-runner.test.js
 *
 * Verifies the generic runner short-circuits an allowlisted host:
 *   - the broker is logged with status 'allowlisted'
 *   - page.goto is NEVER called (no network request for an allowlisted host)
 *
 * Strategy: require generic-runner, then call processGenericUrl through the
 * exported runner with injectedBrokers. To make the allowlist visible to the
 * module we stub require('./lib/filter') with Module._load before requiring the runner.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load.bind(Module);

// Allowlist seam: the runner will call isAllowlisted(name, config). We force the
// config the runner sees and assert the predicate is consulted before navigation.
const ALLOWLIST = ['AllowedGeneric'];

function patchedLoad(request, parent, isMain) {
  if (!parent?.filename?.includes('generic-runner')) return originalLoad(request, parent, isMain);
  if (request === './lib/filter') return {
    isAllowlisted: (name) =>
      ALLOWLIST.some(e => String(e).trim().toLowerCase() === String(name).trim().toLowerCase()),
  };
  return originalLoad(request, parent, isMain);
}

Module._load = patchedLoad;
const genericRunnerPath = require.resolve('../generic-runner');
delete require.cache[genericRunnerPath];
const { runGenericBrokers, classifyOutcome } = require('../generic-runner');
Module._load = originalLoad;

test('classifyOutcome maps allowlisted -> allowlisted bucket', () => {
  assert.equal(classifyOutcome('allowlisted', 'on allowlist'), 'allowlisted');
});

test('generic runner: allowlisted host is logged allowlisted and never navigated', async () => {
  const logged = [];
  const logResult = (name, status, detail) => logged.push({ name, status, detail });
  const recordSuccess = () => { throw new Error('recordSuccess must not be called for an allowlisted host'); };

  // A page whose goto throws - proves the allowlist branch returns before navigation.
  const page = {
    goto: async () => { throw new Error('navigation must not happen for an allowlisted host'); },
    waitForTimeout: async () => {},
    isClosed: () => false,
    close: async () => {},
  };
  const context = {
    newPage: async () => page,
    pages: () => [page],
  };

  const state = { optOuts: {} };
  const injectedBrokers = [{ name: 'AllowedGeneric', url: 'https://allowed-generic.example.com/optout', source: 'markup' }];

  const out = await runGenericBrokers(context, new Set(), state, logResult, recordSuccess, { injectedBrokers });

  const entry = logged.find(l => l.name === 'AllowedGeneric');
  assert.ok(entry, 'the allowlisted broker should still be logged');
  assert.equal(entry.status, 'allowlisted');
  assert.equal(out.genericStats.attempted, 1);
});
