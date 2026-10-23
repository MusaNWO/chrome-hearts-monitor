/**
 * Waitwhile reCAPTCHA tokens.
 *
 * Waitwhile uses reCAPTCHA v3 with action PUB_CREATE_VISIT and site key
 * 6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio. Tokens must be generated from a
 * real browser context on waitwhile.com (headless / datacenter often rejected).
 *
 * CapSolver is automatic fallback when browser tokens fail.
 */
const https = require('https');
const { getContext } = require('./waitwhile');

const V3_SITE_KEY = '6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio';
const ACTION = 'PUB_CREATE_VISIT';

function bookingPageUrl(locationId) {
  const id = locationId || 'chromeheartsmiami';
  return `https://waitwhile.com/locations/${id}?registration=booking`;
}

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

async function solveWithCapSolver(locationId) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return null;

  const created = await httpJson('POST', 'https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'ReCaptchaV3TaskProxyLess',
      websiteURL: bookingPageUrl(locationId),
      websiteKey: V3_SITE_KEY,
      pageAction: ACTION,
      minScore: 0.9,
    },
  });
  if (created.errorId) {
    throw new Error(`CapSolver create: ${created.errorDescription || JSON.stringify(created)}`);
  }

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const result = await httpJson('POST', 'https://api.capsolver.com/getTaskResult', {
      clientKey: apiKey,
      taskId: created.taskId,
    });
    if (result.status === 'ready') {
      return result.solution?.gRecaptchaResponse;
    }
    if (result.errorId) {
      throw new Error(`CapSolver result: ${result.errorDescription || JSON.stringify(result)}`);
    }
  }
  throw new Error('CapSolver timed out');
}

/**
 * Generate a v3 token inside a Waitwhile-origin page using the shared Playwright
 * context (same cookies / fingerprint as API calls).
 */
async function solveInBrowser(locationId) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  const url = bookingPageUrl(locationId);
  try {
    let loaded = false;
    for (let i = 0; i < 6; i++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForTimeout(2000 + Math.floor(Math.random() * 1500));
        const text = await page.evaluate(() => document.body?.innerText?.slice(0, 80) || '');
        if (text.includes('404')) {
          await page.waitForTimeout(1000);
          continue;
        }
        loaded = true;
        break;
      } catch (err) {
        const msg = err.message || '';
        // Railway often hits net::ERR_ABORTED on first navigation — retry
        if (/ERR_ABORTED|Timeout|net::/i.test(msg) && i < 5) {
          await page.waitForTimeout(1500);
          continue;
        }
        throw err;
      }
    }
    if (!loaded) throw new Error(`Could not load Waitwhile booking page: ${url}`);

    // Light humanization before token
    await page.mouse.move(80 + Math.random() * 200, 120 + Math.random() * 160);
    await page.waitForTimeout(400);
    await page.mouse.move(300 + Math.random() * 220, 280 + Math.random() * 180);
    await page.evaluate(() => window.scrollBy(0, 180 + Math.floor(Math.random() * 120)));
    await page.waitForTimeout(800 + Math.floor(Math.random() * 700));

    const hasRender = await page.evaluate(
      () => !!document.querySelector('script[src*="recaptcha/api.js?render="]')
    );
    if (!hasRender) {
      await page.addScriptTag({
        url: `https://www.google.com/recaptcha/api.js?render=${V3_SITE_KEY}`,
      });
      await page.waitForTimeout(2500);
    }

    await page.waitForFunction(() => window.grecaptcha && window.grecaptcha.execute, {
      timeout: 25_000,
    });

    const token = await page.evaluate(
      async ({ siteKey, action }) => {
        await new Promise((r) => grecaptcha.ready(r));
        return grecaptcha.execute(siteKey, { action });
      },
      { siteKey: V3_SITE_KEY, action: ACTION }
    );

    if (!token) throw new Error('grecaptcha.execute returned empty token');
    return token;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * @param {{ locationId?: string, prefer?: 'browser'|'capsolver' }} [opts]
 */
async function getRecaptchaToken(opts = {}) {
  const locationId = opts.locationId || 'chromeheartsmiami';
  const prefer = opts.prefer || process.env.CAPTCHA_PROVIDER || 'browser';
  const errors = [];

  const tryBrowser = async () => {
    for (let i = 0; i < 2; i++) {
      try {
        const t = await solveInBrowser(locationId);
        if (t) return { token: t, source: 'browser' };
      } catch (err) {
        errors.push(`browser[${i}]: ${err.message}`);
      }
    }
    return null;
  };

  const tryCap = async () => {
    if (!process.env.CAPSOLVER_API_KEY) return null;
    try {
      const t = await solveWithCapSolver(locationId);
      if (t) return { token: t, source: 'capsolver' };
    } catch (err) {
      errors.push(`capsolver: ${err.message}`);
    }
    return null;
  };

  if (prefer === 'capsolver') {
    return (await tryCap()) || (await tryBrowser()) || Promise.reject(new Error(errors.join(' | ') || 'no token'));
  }
  return (await tryBrowser()) || (await tryCap()) || Promise.reject(new Error(errors.join(' | ') || 'no token'));
}

module.exports = { getRecaptchaToken, RECAPTCHA_SITE_KEY: V3_SITE_KEY, ACTION };
