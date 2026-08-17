#!/usr/bin/env node
/**
 * scripts/ci/docker-shm-check.js
 *
 * Runs inside the built image with the default 64MB /dev/shm. Asserts the launch
 * args do not depend on a larger one, so a plain `docker run` (no --shm-size, no
 * compose) is a supported way to run this.
 */

'use strict';

const fs = require('fs');
const { buildLaunchArgs } = require('/app/lib/browser');

const mount = (fs.readFileSync('/proc/mounts', 'utf8').split('\n').find(l => l.includes('/dev/shm')) || '').trim();
console.log('/dev/shm:', mount || 'not found');

const args = buildLaunchArgs();
if (!args.includes('--disable-dev-shm-usage')) {
  console.error('missing --disable-dev-shm-usage. args were:', args.join(' '));
  process.exit(1);
}
console.log('shm flags OK');
