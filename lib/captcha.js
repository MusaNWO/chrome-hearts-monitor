/**
 * reCAPTCHA token helpers.
 * CapSolver (optional): set CAPSOLVER_API_KEY for reliable tokens.
 * Fallback: generate a token in a real Waitwhile-origin browser page (often scored too low).
 */
const https = require('https');
const { RECAPTCHA_SITE_KEY, getContext } = require('./waitwhile');

function httpJson(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Bad JSON from captcha API: ${raw.substring(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy();
      reject(new Error('Captcha API timeout'));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function solveWithCapSolver(siteKey = RECAPTCHA_SITE_KEY) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return null;

  // Prefer v2 invisible (matches Waitwhile widget size=invisible)
  const created = await httpJson('POST', 'https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL: 'https://waitwhile.com/',
      websiteKey: siteKey,
      isInvisible: true,
    },
  });
  if (created.errorId) {
    throw new Error(`CapSolver create: ${created.errorDescription || JSON.stringify(created)}`);
  }

  const taskId = created.taskId;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const result = await httpJson('POST', 'https://api.capsolver.com/getTaskResult', {
      clientKey: apiKey,
      taskId,
    });
    if (result.status === 'ready') {
      return result.solution?.gRecaptchaResponse;
    }
    if (result.errorId) {
      throw new Error(`CapSolver result: ${result.errorDescription || JSON.stringify(result)}`);
    }
  }
  throw new Error('CapSolver timed out waiting for token');
}

async function solveInBrowser(siteKey = RECAPTCHA_SITE_KEY) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    await page.goto('https://waitwhile.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.addScriptTag({ url: 'https://www.google.com/recaptcha/api.js' });
    await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.render, {
      timeout: 20_000,
    });
    await page.evaluate((sk) => {
      const div = document.createElement('div');
      div.id = 'ww-recaptcha';
      document.body.appendChild(div);
      window.__wwToken = null;
      window.__wwWidgetId = grecaptcha.render('ww-recaptcha', {
        sitekey: sk,
        size: 'invisible',
        callback: (t) => {
          window.__wwToken = t;
        },
      });
    }, siteKey);
    await page.waitForTimeout(1000);
    await page.evaluate(() => grecaptcha.execute(window.__wwWidgetId));
    for (let i = 0; i < 20; i++) {
      const token = await page.evaluate(() => window.__wwToken);
      if (token) return token;
      await page.waitForTimeout(500);
    }
    // Fallback: try v3 execute on same key
    await page.addScriptTag({
      url: `https://www.google.com/recaptcha/api.js?render=${siteKey}`,
    });
    await page.waitForTimeout(1500);
    return page.evaluate(async (sk) => {
      await new Promise((r) => grecaptcha.ready(r));
      return grecaptcha.execute(sk, { action: 'submit' });
    }, siteKey);
  } finally {
    await page.close().catch(() => {});
  }
}

async function getRecaptchaToken() {
  if (process.env.CAPSOLVER_API_KEY) {
    const t = await solveWithCapSolver();
    if (t) return { token: t, source: 'capsolver' };
  }
  const t = await solveInBrowser();
  return { token: t, source: 'browser' };
}

module.exports = { getRecaptchaToken, RECAPTCHA_SITE_KEY };
