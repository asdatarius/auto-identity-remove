/**
 * lib/captcha.js
 *
 * CapSolver-backed CAPTCHA detection and solving.
 * Supports: reCAPTCHA v2, hCAPTCHA.
 *
 * Exported for testing: findRecaptchaCallback, buildHcaptchaScript
 */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Builds a JavaScript string that injects a reCAPTCHA token and fires known
 * callback paths. The original single-path approach only worked on roughly
 * 30% of integrations. This tries multiple known accessor shapes.
 * @param {string} token
 * @returns {string}
 */
function findRecaptchaCallback(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  // 1. Set hidden input (required by all reCAPTCHA v2 integrations)
  var el = document.querySelector('#g-recaptcha-response');
  if (el) { el.value = token; el.style.display = 'block'; }
  document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(function(e) {
    e.value = token;
  });

  // 2. Traverse ___grecaptcha_cfg.clients to find and call all callback functions
  try {
    var clients = window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients;
    if (clients) {
      Object.keys(clients).forEach(function(key) {
        var client = clients[key];
        Object.keys(client).forEach(function(k) {
          var obj = client[k];
          if (obj && typeof obj.callback === 'function') {
            try { obj.callback(token); } catch(e) {}
          }
          if (obj && typeof obj === 'object') {
            Object.keys(obj).forEach(function(k2) {
              if (obj[k2] && typeof obj[k2].callback === 'function') {
                try { obj[k2].callback(token); } catch(e) {}
              }
            });
          }
        });
      });
    }
  } catch(e) {}

  // 3. Dispatch change + input events so React/Vue/Angular bindings fire
  try {
    if (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }
  } catch(e) {}
})(${t});
`;
}

/**
 * Builds a JavaScript string that injects an hCAPTCHA solution token.
 * @param {string} token
 * @returns {string}
 */
function buildHcaptchaScript(token) {
  const t = JSON.stringify(String(token));
  return `
(function(token) {
  var el = document.querySelector('[name="h-captcha-response"]');
  if (!el) el = document.querySelector('textarea[name="h-captcha-response"]');
  if (el) { el.value = token; }
  try {
    if (window.hcaptcha) {
      var widget = document.querySelector('[data-hcaptcha-widget-id]');
      var widgetId = widget ? widget.getAttribute('data-hcaptcha-widget-id') : null;
      if (widgetId !== null) { window.hcaptcha.execute(widgetId); }
    }
  } catch(e) {}
  try {
    if (el) {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
    }
  } catch(e) {}
})(${t});
`;
}

async function solveRecaptcha(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - add one to config.json to auto-solve CAPTCHAs');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() =>
      document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null
    );
    if (!siteKey) return false;

    console.log('     Solving reCAPTCHA via CapSolver...');
    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: { type: 'ReCaptchaV2TaskProxyless', websiteURL: pageUrl, websiteKey: siteKey },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        await page.evaluate(findRecaptchaCallback(data.solution.gRecaptchaResponse));
        console.log('     reCAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver reCAPTCHA error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

async function solveHcaptcha(page, capsolver) {
  const key = capsolver?.apiKey;
  if (!key || key.startsWith('CAP-YOUR') || key === 'CAP-YOUR_KEY_HERE') {
    console.log('     info  No CapSolver key - cannot solve hCAPTCHA automatically');
    return false;
  }
  try {
    const axios   = require('axios');
    const pageUrl = page.url();
    const siteKey = await page.evaluate(() => {
      return document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') ||
        (document.querySelector('iframe[src*="hcaptcha"]')?.src || '').match(/sitekey=([^&]+)/)?.[1] || null;
    });
    if (!siteKey) return false;

    console.log('     Solving hCAPTCHA via CapSolver...');
    const { data: createData } = await axios.post('https://api.capsolver.com/createTask', {
      clientKey: key,
      task: { type: 'HCaptchaTaskProxyless', websiteURL: pageUrl, websiteKey: siteKey },
    });
    const taskId = createData.taskId;
    if (!taskId) return false;

    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const { data } = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: key, taskId });
      if (data.status === 'ready') {
        const token = data.solution.gRecaptchaResponse || '';
        await page.evaluate(buildHcaptchaScript(token));
        console.log('     hCAPTCHA solved');
        return true;
      }
      if (data.status === 'failed') return false;
    }
    return false;
  } catch (err) {
    console.log(`     CapSolver hCAPTCHA error: ${err.message.slice(0, 60)}`);
    return false;
  }
}

async function detectAndSolveCaptcha(page, capsolver) {
  const captchaType = await page.evaluate(() => {
    if (document.querySelector('.g-recaptcha,[data-sitekey],#recaptcha,iframe[src*="recaptcha"]')) {
      return 'recaptcha';
    }
    if (document.querySelector('iframe[src*="hcaptcha"],[data-hcaptcha-widget-id]')) {
      return 'hcaptcha';
    }
    return null;
  });
  if (!captchaType) return true;
  if (captchaType === 'hcaptcha') return solveHcaptcha(page, capsolver);
  return solveRecaptcha(page, capsolver);
}

module.exports = { solveRecaptcha, solveHcaptcha, detectAndSolveCaptcha, findRecaptchaCallback, buildHcaptchaScript };
