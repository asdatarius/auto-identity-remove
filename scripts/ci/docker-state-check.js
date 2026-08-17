#!/usr/bin/env node
/**
 * scripts/ci/docker-state-check.js
 *
 * Runs inside the built image with state.json bind-mounted as a single FILE -
 * the recipe the README documents. rename() onto a bind mount returns EBUSY, so
 * before the _renameOrRewrite fallback every state write in Docker was silently
 * discarded and each scheduled run resubmitted every broker from scratch.
 */

'use strict';

const fs = require('fs');
const cfg = require('/app/lib/config');

const target = process.env.AIDR_STATE_PATH || '/app/state.json';

cfg.recordSuccess('CiProbe', 'submitted');
cfg.saveState();

const saved = fs.readFileSync(target, 'utf8');
if (!saved.includes('CiProbe')) {
  console.error('state was lost. file contains:', saved);
  process.exit(1);
}
console.log('bind-mount state write OK');
