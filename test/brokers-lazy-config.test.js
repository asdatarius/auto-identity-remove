/**
 * test/brokers-lazy-config.test.js
 *
 * Verifies that brokers.js does NOT throw when config.json is absent.
 * CRIT-4: lazy-load contract - require('./brokers') must work without config.json.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

test('brokers.js does not throw when config.json is absent', () => {
  const orig = Module._load.bind(Module);

  // Intercept config.json loads to simulate the file being missing
  Module._load = function (req, parent, isMain) {
    if (req === './config.json' || (typeof req === 'string' && req.endsWith('/config.json'))) {
      const err = new Error("Cannot find module './config.json'");
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return orig(req, parent, isMain);
  };

  // Evict cached brokers so the module is re-evaluated
  const brokersPath = require.resolve('../brokers');
  delete require.cache[brokersPath];

  let brokers;
  let threw = false;
  try {
    brokers = require('../brokers');
  } catch (err) {
    threw = true;
  } finally {
    Module._load = orig;
    // Evict again so subsequent tests get fresh state with real config
    delete require.cache[brokersPath];
  }

  assert.ok(!threw, 'require("../brokers") must not throw when config.json is absent');
  assert.ok(
    Array.isArray(brokers) || (brokers !== null && typeof brokers === 'object'),
    'brokers must be an array or object even when config.json is absent'
  );
});

test('brokers array still loads (possibly with empty PII) when config.json is absent', () => {
  const orig = Module._load.bind(Module);

  Module._load = function (req, parent, isMain) {
    if (req === './config.json' || (typeof req === 'string' && req.endsWith('/config.json'))) {
      const err = new Error("Cannot find module './config.json'");
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return orig(req, parent, isMain);
  };

  const brokersPath = require.resolve('../brokers');
  delete require.cache[brokersPath];

  let brokers;
  try {
    brokers = require('../brokers');
  } finally {
    Module._load = orig;
    delete require.cache[brokersPath];
  }

  // We should have a non-empty broker list even without config
  const len = Array.isArray(brokers) ? brokers.length : Object.keys(brokers).length;
  assert.ok(len > 0, 'brokers list must be non-empty even without config.json');
});
