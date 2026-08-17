#!/usr/bin/env node
/**
 * scripts/ci/docker-smoke.js
 *
 * Runs inside the built image. Proves Chromium launches with the repo's real
 * launch options and can fill a form.
 *
 * This is the check that would have caught the Playwright client/image version
 * mismatch: the client resolved to 1.60.0 (needs chromium build 1223) while the
 * base image shipped v1.52.0 (build 1169), so every launch died with
 * "Executable doesn't exist at /ms-playwright/chromium-1223/...". No amount of
 * grepping the Dockerfile finds that.
 */

'use strict';

const { chromium } = require('playwright');
const { buildLaunchOptions } = require('/app/lib/browser');

const FORM = 'data:text/html,<form><input name="email"><input name="firstName"></form>';

(async () => {
  const opts = buildLaunchOptions({ headless: true });
  console.log('launch args:', opts.args.join(' '));

  const ctx = await chromium.launchPersistentContext('/tmp/ci-profile', opts);
  try {
    const page = await ctx.newPage();
    await page.goto(FORM);
    await page.fill('input[name="email"]', 'ci@example.com');
    await page.fill('input[name="firstName"]', 'CI');
    const value = await page.inputValue('input[name="email"]');
    if (value !== 'ci@example.com') throw new Error(`form fill did not stick: got "${value}"`);
  } finally {
    await ctx.close().catch(() => {});
  }
  console.log('browser launch + form fill OK');
})().catch((e) => {
  console.error('FAILED:', e.message.split('\n')[0]);
  process.exit(1);
});
