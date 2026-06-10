/**
 * dashboard/freeze-ui.test.js
 *
 * Structural assertions for the freeze checklist UI. The project has no DOM
 * test harness, so we verify the static assets as text: the Freeze tab, its
 * panel, and the app.js wiring (load function, /freeze fetches, render target).
 * Hermetic - reads files only, no browser, no server.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');

test('index.html has a Freeze tab button wired to the freeze panel', () => {
  assert.match(HTML, /data-tab="freeze"/, 'a tab button with data-tab="freeze" must exist');
  assert.match(HTML, /id="tab-freeze"/, 'a panel with id="tab-freeze" must exist');
});

test('index.html has a container the freeze checklist renders into', () => {
  assert.match(HTML, /id="freezeList"/, 'a #freezeList container must exist');
});

test('app.js loads the freeze checklist from /freeze', () => {
  assert.match(APP, /api\('\/freeze'\)/, "app.js must GET /freeze");
  assert.match(APP, /function loadFreeze/, 'app.js must define loadFreeze()');
});

test('app.js posts done/clear toggles to /freeze', () => {
  assert.match(APP, /'\/freeze',\s*\{\s*method:\s*'POST'/, 'app.js must POST to /freeze');
  assert.match(APP, /action:\s*btn\.dataset\.act/, 'app.js must send an action field from the button');
});

test('app.js calls loadFreeze when the freeze tab is selected', () => {
  assert.match(APP, /dataset\.tab === 'freeze'\)\s*loadFreeze\(\)/, 'loadFreeze must be invoked on tab switch');
});

test('app.js escapes freeze data before rendering it', () => {
  assert.match(APP, /esc\(t\.name\)/, 'broker/target names must be escaped before render');
  assert.match(APP, /safeUrl\(t\.url\)/, 'target urls must pass through safeUrl');
});
