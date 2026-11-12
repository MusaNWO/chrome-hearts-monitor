/**
 * Waitwhile reCAPTCHA tokens.
 *
 * Waitwhile uses reCAPTCHA v3 with action PUB_CREATE_VISIT and site key
 * 6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio.
 *
 * Tokens should be solved on the SAME IP that POSTs the visit. On Railway,
 * that means a residential proxy for both Playwright and CapSolver.
 *
 * CapSolver task order when proxy is configured:
 *   1) ReCaptchaV3Task (your proxy — IP matches submit)
 *   2) ReCaptchaV3M1TaskProxyLess (premium CapSolver IPs, last resort)
 * Without proxy: browser first, then ProxyLess / M1.
 */
const https = require('https');
const { getContext } = require('./waitwhile');
const { getCapSolverProxyString, hasProxy } = require('./proxy');

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
    req.setTimeout(90_000, () => {
      req.destroy();
      reject(new Error('Captcha API timeout'));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function pollCapSolver(apiKey, taskId) {
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
  throw new Error('CapSolver timed out');
}

async function createCapSolverTask(task) {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return null;
  const created = await httpJson('POST', 'https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task,
  });
  if (created.errorId) {
    throw new Error(`CapSolver create: ${created.errorDescription || JSON.stringify(created)}`);
  }
  const token = await pollCapSolver(apiKey, created.taskId);
  return token;
}

/**
 * Solve via CapSolver. Prefer proxied task so token IP matches our Playwright egress.
 */
async function solveWithCapSolver(locationId) {
  if (!process.env.CAPSOLVER_API_KEY) return null;

  const websiteURL = bookingPageUrl(locationId);
  const forcedType = process.env.CAPSOLVER_TASK_TYPE || '';
  const proxy = getCapSolverProxyString();
  const minScore = Number(process.env.CAPSOLVER_MIN_SCORE || 0.9);
  const errors = [];

  const attempts = [];
  if (forcedType) {
    attempts.push({ type: forcedType, useProxy: !/ProxyLess/i.test(forcedType) });
  } else if (proxy && process.env.CAPSOLVER_USE_PROXY !== '0') {
    // Same residential IP as browser submit
    attempts.push({ type: 'ReCaptchaV3Task', useProxy: true });
    // Premium CapSolver IPs if proxied solve fails
    if (process.env.CAPSOLVER_M1 !== '0') {
      attempts.push({ type: 'ReCaptchaV3M1TaskProxyLess', useProxy: false });
    }
  } else {
    attempts.push({ type: 'ReCaptchaV3TaskProxyLess', useProxy: false });
    if (process.env.CAPSOLVER_M1 !== '0') {
      attempts.push({ type: 'ReCaptchaV3M1TaskProxyLess', useProxy: false });
    }
  }

  for (const a of attempts) {
    try {
      const task = {
        type: a.type,
        websiteURL,
        websiteKey: V3_SITE_KEY,
        pageAction: ACTION,
        minScore,
      };
      if (a.useProxy) {
        if (!proxy) throw new Error('proxy required for ' + a.type);
        task.proxy = proxy;
      }
      const token = await createCapSolverTask(task);
      if (token) return { token, source: `capsolver:${a.type}` };
    } catch (err) {
      errors.push(`${a.type}: ${err.message}`);
    }
  }
  throw new Error(errors.join(' | ') || 'CapSolver failed');
}

/**
 * Generate a v3 token inside a Waitwhile-origin page using the shared Playwright
 * context (same cookies / fingerprint / proxy IP as API calls).
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
        if (/ERR_ABORTED|Timeout|net::/i.test(msg) && i < 5) {
          await page.waitForTimeout(1500);
          continue;
        }
        throw err;
      }
    }
    if (!loaded) throw new Error(`Could not load Waitwhile booking page: ${url}`);

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
        if (t) return { token: t, source: hasProxy() ? 'browser+proxy' : 'browser' };
      } catch (err) {
        errors.push(`browser[${i}]: ${err.message}`);
      }
    }
    return null;
  };

  const tryCap = async () => {
    if (!process.env.CAPSOLVER_API_KEY) return null;
    try {
      return await solveWithCapSolver(locationId);
    } catch (err) {
      errors.push(`capsolver: ${err.message}`);
    }
    return null;
  };

  if (prefer === 'capsolver') {
    return (
      (await tryCap()) ||
      (await tryBrowser()) ||
      Promise.reject(new Error(errors.join(' | ') || 'no token'))
    );
  }
  return (
    (await tryBrowser()) ||
    (await tryCap()) ||
    Promise.reject(new Error(errors.join(' | ') || 'no token'))
  );
}

module.exports = { getRecaptchaToken, RECAPTCHA_SITE_KEY: V3_SITE_KEY, ACTION };
