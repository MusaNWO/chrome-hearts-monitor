/**
 * Waitwhile reCAPTCHA tokens.
 *
 * Waitwhile uses reCAPTCHA v3 with action PUB_CREATE_VISIT and site key
 * 6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio. Tokens must be generated from a
 * real browser context on waitwhile.com (headless often gets rejected).
 *
 * CapSolver is optional fallback only.
 */
const https = require('https');
const { RECAPTCHA_SITE_KEY, getContext } = require('./waitwhile');

const V3_SITE_KEY = '6LfGdiEaAAAAAG5g6cu2j-r4SlU_dYRXQix2-jio';
const ACTION = 'PUB_CREATE_VISIT';

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

async function solveWithCapSolver() {
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!apiKey) return null;

  const created = await httpJson('POST', 'https://api.capsolver.com/createTask', {
    clientKey: apiKey,
    task: {
      type: 'ReCaptchaV3TaskProxyLess',
      websiteURL: 'https://waitwhile.com/locations/chromeheartsmiami?registration=booking',
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
 * Generate a v3 token inside a Waitwhile-origin page.
 * Prefer HEADED=1 (or default headed for booking) — headless scores often fail.
 */
async function solveInBrowser() {
  const { chromium } = require('playwright');
  const headed = process.env.HEADED !== '0'; // default headed for captcha quality
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();

    // Booking page sometimes 404s on first load — retry
    for (let i = 0; i < 6; i++) {
      await page.goto('https://waitwhile.com/locations/chromeheartsmiami?registration=booking', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page.waitForTimeout(2500);
      const text = await page.evaluate(() => document.body?.innerText?.slice(0, 80) || '');
      if (!text.includes('404')) break;
    }

    await page.mouse.move(120, 180);
    await page.waitForTimeout(300);
    await page.mouse.move(420, 320);
    await page.waitForTimeout(500);

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
      timeout: 20_000,
    });

    const token = await page.evaluate(async ({ siteKey, action }) => {
      await new Promise((r) => grecaptcha.ready(r));
      return grecaptcha.execute(siteKey, { action });
    }, { siteKey: V3_SITE_KEY, action: ACTION });

    await context.close();
    return token;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function getRecaptchaToken() {
  // Prefer real browser token (proven to work). CapSolver often rejected by Waitwhile.
  if (process.env.CAPTCHA_PROVIDER === 'capsolver' && process.env.CAPSOLVER_API_KEY) {
    const t = await solveWithCapSolver();
    if (t) return { token: t, source: 'capsolver' };
  }
  const t = await solveInBrowser();
  return { token: t, source: 'browser' };
}

module.exports = { getRecaptchaToken, RECAPTCHA_SITE_KEY: V3_SITE_KEY, ACTION };
